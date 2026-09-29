//! Lune embeds a sandboxed Luau VM with async execution. This spike verifies
//! the public host-module seam that an Imp adapter would need for `imp:core`.
//!
//! `Runtime` exposes custom modules through `with_lib`, which accepts
//! `@`-prefixed names. Its callback receives the underlying `mlua::Lua`, where
//! `Lua::create_require_function` accepts a host-owned `Require` resolver.

use lune::Runtime;
use mlua::prelude::*;
use mlua::{NavigateError, Require};
use std::cell::RefCell;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::{fs, sync::Arc};

#[derive(Default)]
struct ImpRequirer {
    path: Vec<String>,
}

struct Node(String);

impl LuaUserData for Node {}

impl Require for ImpRequirer {
    fn is_require_allowed(&self, chunk_name: &str) -> bool {
        chunk_name.starts_with('@')
    }

    fn reset(&mut self, chunk_name: &str) -> Result<(), NavigateError> {
        self.path = chunk_name
            .trim_start_matches('@')
            .split('/')
            .map(str::to_owned)
            .collect();
        self.path.pop();
        Ok(())
    }

    fn jump_to_alias(&mut self, _path: &str) -> Result<(), NavigateError> {
        Err(NavigateError::NotFound)
    }

    fn to_parent(&mut self) -> Result<(), NavigateError> {
        self.path.pop().ok_or(NavigateError::NotFound)?;
        Ok(())
    }

    fn to_child(&mut self, name: &str) -> Result<(), NavigateError> {
        self.path.push(name.to_owned());
        Ok(())
    }

    fn has_module(&self) -> bool {
        matches!(self.path.as_slice(), [.., rules, example] if rules == "rules" && example == "example")
    }

    fn cache_key(&self) -> String {
        format!("//{}", self.path.join("/"))
    }

    fn has_config(&self) -> bool {
        false
    }

    fn config(&self) -> io::Result<Vec<u8>> {
        unreachable!("mlua calls config only when has_config is true")
    }

    fn loader(&self, lua: &Lua) -> LuaResult<LuaFunction> {
        let module = lua.create_table()?;
        module.set("answer", 42)?;
        lua.create_async_function(move |_, ()| {
            let module = module.clone();
            async move {
                tokio::task::yield_now().await;
                Ok(module)
            }
        })
    }
}

struct GraphHandle(Arc<()>);

impl LuaUserData for GraphHandle {}

struct ActionNode {
    run: LuaFunction,
}

impl LuaUserData for ActionNode {}

fn workspace_module(root: &Path, address: &str) -> LuaResult<(PathBuf, String)> {
    let suffix = address
        .strip_prefix("@workspace/")
        .ok_or_else(|| LuaError::external(format!("unsupported module address '{address}'")))?;
    let mut relative = PathBuf::new();
    for component in Path::new(suffix).components() {
        use std::path::Component;
        match component {
            Component::Normal(value) => relative.push(value),
            Component::CurDir => {}
            Component::ParentDir => {
                if !relative.pop() {
                    return Err(LuaError::external("workspace import escapes its root"));
                }
            }
            Component::RootDir | Component::Prefix(_) => {
                return Err(LuaError::external("workspace import must be relative"));
            }
        }
    }
    if relative
        .extension()
        .is_some_and(|extension| extension == "luau")
    {
        relative.set_extension("");
    }

    let candidates = if relative.as_os_str().is_empty() {
        vec![root.join("BUILD.luau")]
    } else {
        vec![
            root.join(relative.with_extension("luau")),
            root.join(&relative).join("index.luau"),
            root.join(&relative).join("BUILD.luau"),
        ]
    };
    let path = candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| LuaError::external(format!("workspace module '{address}' was not found")))?;
    let source_path = path
        .strip_prefix(root)
        .map_err(LuaError::external)?
        .to_string_lossy()
        .replace('\\', "/");
    let canonical = source_path.strip_suffix(".luau").unwrap_or(&source_path);
    Ok((path, format!("@workspace/{canonical}")))
}

fn install_test_require(lua: &Lua, root: PathBuf) -> LuaResult<()> {
    let original_require = lua.globals().get::<LuaFunction>("require")?;
    let core = original_require.call::<LuaTable>("@imp/core")?;
    let cache = Rc::new(RefCell::new(HashMap::<String, LuaValue>::new()));
    let require = lua.create_function(move |lua, address: String| {
        if address == "@imp/core" {
            return Ok(LuaValue::Table(core.clone()));
        }
        let (path, canonical) = workspace_module(&root, &address)?;
        if let Some(value) = cache.borrow().get(&canonical).cloned() {
            return Ok(value);
        }
        let source = fs::read_to_string(path).map_err(LuaError::external)?;
        let values = lua
            .load(source)
            .set_name(canonical.clone())
            .call::<LuaMultiValue>(())?;
        let value = values.front().cloned().unwrap_or(LuaValue::Nil);
        cache.borrow_mut().insert(canonical, value.clone());
        Ok(value)
    })?;
    lua.globals().set("require", require)
}

#[tokio::test]
async fn lune_custom_library_exports_opaque_host_values_to_luau() {
    let mut runtime = Runtime::new()
        .unwrap()
        .with_lib("@imp/core", |lua| {
            let core = lua.create_table()?;
            core.set(
                "node",
                lua.create_function(|lua, name: String| lua.create_userdata(Node(name)))?,
            )?;
            core.set(
                "name",
                lua.create_function(|_, node: LuaAnyUserData| {
                    Ok(node.borrow::<Node>()?.0.clone())
                })?,
            )?;
            Ok(LuaValue::Table(core))
        })
        .unwrap();

    let result = runtime
        .run_custom(
            "imp-lune-spike",
            r#"
                local imp = require("@imp/core")
                local node = imp.node("app")
                assert(type(node) == "userdata")
                return imp.name(node)
            "#,
        )
        .await
        .unwrap();

    assert!(result.success());
    assert_eq!(
        result
            .values
            .front()
            .unwrap()
            .as_string()
            .unwrap()
            .to_str()
            .unwrap(),
        "app"
    );
}

#[tokio::test]
async fn lune_can_install_an_imp_addressed_module_loader() {
    let workspace = tempfile::tempdir().unwrap();
    fs::create_dir(workspace.path().join("rules")).unwrap();
    fs::write(
        workspace.path().join("BUILD.luau"),
        r#"
            local first = require("./rules/example")
            local second = require("./rules/example")
            assert(first == second)
            return first.answer
        "#,
    )
    .unwrap();

    let mut runtime = Runtime::new()
        .unwrap()
        .with_lib("@imp/bootstrap", |lua| {
            let require = lua.create_require_function(ImpRequirer::default())?;
            lua.globals().raw_set("require", require)?;

            Ok(LuaValue::Nil)
        })
        .unwrap();

    let result = runtime
        .run_file(Path::new(workspace.path()).join("BUILD.luau"))
        .await
        .unwrap();

    assert!(result.success());
    assert_eq!(result.values.front().unwrap().as_integer(), Some(42));
}

#[tokio::test]
async fn lune_drives_async_host_functions_from_luau() {
    let mut runtime = Runtime::new()
        .unwrap()
        .with_lib("@imp/core", |lua| {
            let core = lua.create_table()?;
            core.set(
                "action",
                lua.create_async_function(|_, name: String| async move {
                    tokio::task::yield_now().await;
                    Ok(format!("action:{name}"))
                })?,
            )?;
            Ok(LuaValue::Table(core))
        })
        .unwrap();

    let result = runtime
        .run_custom(
            "imp-lune-async-spike",
            r#"
                local imp = require("@imp/core")
                return imp.action("app")
            "#,
        )
        .await
        .unwrap();

    assert!(result.success());
    assert_eq!(
        result
            .values
            .front()
            .unwrap()
            .as_string()
            .unwrap()
            .to_str()
            .unwrap(),
        "action:app"
    );
}

#[tokio::test]
async fn lune_loads_a_physical_workspace_and_executes_a_graph_node() {
    let workspace = tempfile::tempdir().unwrap();
    fs::write(
        workspace.path().join("launcher.luau"),
        r#"
local core = require("@imp/core")
local build = require("@workspace/BUILD")
local output = core.execute(build.action)
local ok, diagnostic = pcall(function()
    return core.execute(build.failure)
end)
assert(not ok)
return { build = build, output = output, diagnostic = tostring(diagnostic) }
"#,
    )
    .unwrap();
    fs::write(
        workspace.path().join("shared.luau"),
        r#"
local core = require("@imp/core")
return { graph = core.node() }
"#,
    )
    .unwrap();
    fs::write(
        workspace.path().join("BUILD.luau"),
        r#"
local core = require("@imp/core")
local first = require("@workspace/shared")
local second = require("@workspace/shared")
assert(rawequal(first, second))
assert(core.same_node(first.graph, second.graph))
return {
    graph = first.graph,
    action = core.task(function()
        return core.async_operation("complete")
    end),
    failure = core.task(function()
        return core.async_operation("fail")
    end),
}
"#,
    )
    .unwrap();

    let mut runtime = Runtime::new()
        .unwrap()
        .with_lib("@imp/core", |lua| {
            let core = lua.create_table()?;
            core.set(
                "node",
                lua.create_function(|lua, ()| lua.create_userdata(GraphHandle(Arc::new(()))))?,
            )?;
            core.set(
                "same_node",
                lua.create_function(|_, (first, second): (LuaAnyUserData, LuaAnyUserData)| {
                    let first = first.borrow::<GraphHandle>()?;
                    let second = second.borrow::<GraphHandle>()?;
                    Ok(Arc::ptr_eq(&first.0, &second.0))
                })?,
            )?;
            core.set(
                "task",
                lua.create_function(|lua, run: LuaFunction| {
                    lua.create_userdata(ActionNode { run })
                })?,
            )?;
            core.set(
                "execute",
                lua.create_async_function(|_, node: LuaAnyUserData| async move {
                    let run = node.borrow::<ActionNode>()?.run.clone();
                    run.call_async::<String>(()).await
                })?,
            )?;
            core.set(
                "async_operation",
                lua.create_async_function(|_, value: String| async move {
                    tokio::task::yield_now().await;
                    if value == "fail" {
                        return Err(LuaError::external("async operation failed"));
                    }
                    Ok(format!("completed:{value}"))
                })?,
            )?;
            Ok(LuaValue::Table(core))
        })
        .unwrap()
        .with_lib("@imp/bootstrap", {
            let root = workspace.path().to_path_buf();
            move |lua| {
                install_test_require(lua, root)?;
                Ok(LuaValue::Nil)
            }
        })
        .unwrap();

    let result = runtime
        .run_file(workspace.path().join("launcher.luau"))
        .await
        .unwrap();
    assert!(result.success());

    let exports = result.values.front().unwrap().as_table().unwrap();
    let build = exports.get::<LuaTable>("build").unwrap();
    let graph = build.get::<LuaAnyUserData>("graph").unwrap();
    let _graph_handle = graph.borrow::<GraphHandle>().unwrap();
    assert_eq!(
        exports.get::<String>("output").unwrap(),
        "completed:complete"
    );
    let diagnostic = exports.get::<String>("diagnostic").unwrap();
    assert!(diagnostic.contains("workspace/BUILD:13"), "{diagnostic}");
    assert!(
        diagnostic.contains("async operation failed"),
        "{diagnostic}"
    );
}
