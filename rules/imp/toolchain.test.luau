local core = require("@imp/core")
local toolchain = require("@imp/rules/imp/toolchain")
local output = core.output

--- Call `fn`, require that it fails, and return the error text.
local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

local DEMO_CACHE = "toolchain-helper-demo"

-- The shape of each toolchain install: one task that installs the toolchain
-- and publishes it into a named cache, and a tool handle on its output.
local function install_tool(key, publish)
	local install = core.task({
		display = `install demo {key}`,
		outputs = { directory = output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = { "install", key },
				display = `install demo {key}`,
				outputs = {
					directory = if publish == false
						then output.directory("demo")
						else output.directory("demo", { named_cache = { name = DEMO_CACHE, key = key } }),
				},
			})
			return { directory = result.outputs.directory }
		end,
	})
	return core.tool(install.outputs.directory, { name = "demo", bin_dirs = { "bin" } })
end

--- A task that returns `fn(exec, tool)` for the tool input.
local function with_tool(tool, fn)
	return core.task({
		inputs = { tool = tool },
		outputs = { value = output.value() },
		run = function(exec, inputs)
			return { value = fn(exec, inputs.tool) }
		end,
	}).outputs.value
end

-- The CLI registry uses graph outputs instead of JavaScript products.
return {
	core.test.suite("CLI tool registry", {
		core.test.case("registration validates names and callbacks", function()
			assert(contains(error_text(toolchain.register, "", function() end), "non-empty name"))
			assert(contains(error_text(toolchain.register, "invalid", true), "resolver function"))
			toolchain.register("duplicate", function() end)
			assert(contains(error_text(toolchain.register, "duplicate", function() end), "already registered"))
			assert(contains(error_text(toolchain.resolve, "missing-tool"), "unknown tool '@missing-tool'"))
		end),
		core.test.case("resolution reads the final default", function()
			local kind = toolchain.define("cli-fixture")
			kind.declare("1", { default = true })
			toolchain.register("cli-fixture", function()
				local version = kind.require_version()
				return core.task({ outputs = { value = output.value() }, run = function()
					return { value = "/fixture/" .. version }
				end }).outputs.value
			end)
			kind.declare("2", { default = true })
			assert(core.test.resolve(toolchain.resolve("cli-fixture")) == "/fixture/2")
		end),
	}),
	core.test.suite("toolchain kinds", {
		core.test.case("defaults are tracked per kind", function()
			local alpha = toolchain.define("alpha")
			local beta = toolchain.define("beta")
			local declared = alpha.declare("1.0.0", { default = true })
			beta.declare("9.9.9")

			assert(alpha.default() == declared)
			assert(alpha.default_version() == "1.0.0")
			-- Beta declared no default; the default of alpha must not leak over.
			assert(beta.default() == nil)
			assert(beta.default_version() == nil)
		end),

		core.test.case("resolve_version prefers an explicit version over the default", function()
			local alpha = toolchain.define("alpha")
			assert(alpha.resolve_version("2.0.0") == "2.0.0")
			assert(alpha.resolve_version(nil) == nil)

			alpha.declare("1.0.0", { default = true })
			assert(alpha.resolve_version(nil) == "1.0.0")
			assert(alpha.resolve_version("2.0.0") == "2.0.0")
		end),

		core.test.case("require_version fails without a version or a default", function()
			local alpha = toolchain.define("alpha")
			local text = error_text(alpha.require_version, nil)
			assert(contains(text, "no alpha toolchain version specified and no default set"), text)
			alpha.declare("1.0.0", { default = true })
			assert(alpha.require_version(nil) == "1.0.0")
		end),

		core.test.case("clear_default drops the default and the declared versions", function()
			local alpha = toolchain.define("alpha")
			alpha.declare("1.0.0", { default = true })
			alpha.clear_default()
			assert(alpha.default() == nil)
			assert(alpha.instance_for_version("1.0.0") == nil)
		end),

		core.test.case("instance_for_version prefers the declaring instance over the default", function()
			local alpha = toolchain.define("alpha")
			local default = alpha.declare("1.0.0", { default = true })
			local other = alpha.declare("2.0.0", { lockfile = "@workspace/alpha.lock" })
			assert(alpha.instance_for_version("2.0.0") == other)
			assert(other.lockfile == "@workspace/alpha.lock")
			assert(alpha.instance_for_version("3.0.0") == default)
			assert(alpha.instance_for_version(nil) == default)
		end),

		core.test.case("resolve_unverified reads the instance of the version", function()
			local alpha = toolchain.define("alpha")
			alpha.declare("1.0.0", { default = true, unverified = true })
			alpha.declare("2.0.0")
			assert(alpha.resolve_unverified("1.0.0") == true)
			assert(alpha.resolve_unverified("2.0.0") == false)
			assert(alpha.resolve_unverified("3.0.0") == true)
			assert(toolchain.define("beta").resolve_unverified("1.0.0") == false)
		end),

		core.test.case("define and declare require names", function()
			assert(contains(error_text(toolchain.define, ""), "requires a non-empty name"))
			local alpha = toolchain.define("alpha")
			assert(contains(error_text(alpha.declare, ""), "alpha toolchain declaration requires a non-empty version"))
		end),
	}),

	core.test.suite("installed toolchain paths", {
		core.test.case("bin joins the executable onto the named cache directory", function()
			core.test.with_fake_toolchain_host(function(host)
				local tool = install_tool("2.0/linux-x86_64")
				-- An archive that puts its binaries in bin/, and one that puts
				-- them at the root: the two layouts of each toolchain.
				local in_bin = with_tool(tool, function(exec, input)
					return toolchain.bin(exec, input, { sub_dir = "bin", exe = "demo" })
				end)
				local at_root = with_tool(tool, function(exec, input)
					return toolchain.bin(exec, input, { exe = "demo.exe" })
				end)
				assert(core.test.resolve(in_bin) == `/cache/{DEMO_CACHE}/2.0/linux-x86_64/bin/demo`)
				assert(core.test.resolve(at_root) == `/cache/{DEMO_CACHE}/2.0/linux-x86_64/demo.exe`)
				assert(#host.runs == 1, "the install runs once")
			end)
		end),

		core.test.case("bin requires an executable name", function()
			core.test.with_fake_toolchain_host(function()
				local value = with_tool(install_tool("3.0/linux-x86_64"), function(exec, input)
					return toolchain.bin(exec, input, {})
				end)
				local text = error_text(core.test.resolve, value)
				assert(contains(text, "requires an executable name"), text)
			end)
		end),

		-- The likely mistake when adding a toolchain: the install task extracts
		-- the archive but does not publish it, so nothing outside the sandbox
		-- can reach the result. Say so, rather than return a broken path.
		core.test.case("an install that publishes no named cache fails by name", function()
			core.test.with_fake_toolchain_host(function()
				local value = with_tool(install_tool("4.0/linux-x86_64", false), function(exec, input)
					return toolchain.bin(exec, input, { exe = "demo" })
				end)
				local text = error_text(core.test.resolve, value)
				assert(contains(text, "must come from an output with named_cache"), text)
			end)
		end),
	}),
}
