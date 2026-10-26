local core = require("@imp/core")
local package = require("@imp/rules/workflows/package")
local output = core.output

--- A task with one artifact output that an action makes at `path`.
local function built(path)
	return core.task({
		outputs = { artifact = output.artifact() },
		run = function(exec)
			local result = exec.action({
				argv = { "true" },
				outputs = { artifact = output.file(path) },
				display = `build {path}`,
			})
			return { artifact = result.outputs.artifact }
		end,
	}).outputs.artifact
end

local function artifact(path)
	return { type = "artifact", digest = "digest", path = path }
end

--- Run the package goal with fake workspace writes, and return the written
--- paths and the report.
local function publish(roots)
	return core.test.with_fake_write_workspace(function(write)
		local report = package.graph_package_goal(roots)
		local paths = {}
		for _, call in ipairs(write.calls) do
			table.insert(paths, call.path)
		end
		return paths, report, write.calls
	end)
end

return {
	core.test.suite("binary_product", {
		core.test.case("a binary without shared libraries keeps its artifact", function()
			local executable = built("build/c/app")
			local plan = package.binary_product({ namespace = "c", target_slug = "app", executable_name = "app" })
			local product = plan.finish(executable)
			assert(plan.bundled == false)
			assert(product.artifact == executable)
			assert(product.run == executable)
			assert(product.executable_path == nil)
		end),

		core.test.case("a binary with shared libraries is bundled with its run descriptor", function()
			core.test.with_fake_toolchain_host(function(host)
				local plan = package.binary_product({
					namespace = "odin",
					target_slug = "app",
					executable_name = "output",
					shared_libraries = { built("build/odin/libfoo.so") },
					bundle_display = "odin bundle app",
				})
				local product = plan.finish(built("build/odin/output"))
				assert(plan.bundled == true)
				assert(plan.bundle_dir == "build/odin/app.d")
				assert(plan.executable_path == "build/odin/app.d/output")

				local run = core.test.resolve(product.run)
				assert(run.executable_path == "build/odin/app.d/output", tostring(run.executable_path))
				assert(run.executable == core.test.resolve(product.artifact), "run starts the bundle artifact")
				local bundle = host.runs[#host.runs]
				assert(bundle.display == "odin bundle app", bundle.display)
				assert(bundle.tools[1] == "cp")
				assert(bundle.input_count == 2)
				assert(bundle.outputs.artifact == "build/odin/app.d")
				local argv = table.concat(bundle.argv, " ")
				assert(argv == "cp build/odin/output build/odin/libfoo.so build/odin/app.d/", argv)
			end)
		end),
	}),

	core.test.suite("graph_package_goal", {
		core.test.case("a root is published under dist/ at the workflow boundary", function()
			local paths, report, calls = publish({ { address = "//images:app", result = artifact("package") } })
			assert(paths[1] == "dist/images/app", paths[1])
			assert(calls[1].digest == "digest" and calls[1].from == "package")
			assert(report == "Packaged 1 target:\n  //images:app -> dist/images/app", report)
		end),

		-- A consumer finds a shared library by the filename in its own
		-- DT_NEEDED entry. A library published under the target name cannot
		-- satisfy its consumer.
		core.test.case("a shared library is published under its own filename", function()
			local paths = publish({ { address = "//native/hello:hello", result = artifact("build/c/libhello.so") } })
			assert(paths[1] == "dist/native/hello/libhello.so", paths[1])
		end),

		core.test.case("versioned sonames and the extensions of other platforms are recognized", function()
			local paths = publish({
				{ address = "//a:x", result = artifact("build/libfoo.so.1") },
				{ address = "//b:y", result = artifact("build/libfoo.so.1.2.3") },
				{ address = "//c:z", result = artifact("build/libfoo.dylib") },
				{ address = "//d:w", result = artifact("build/foo.DLL") },
			})
			local text = table.concat(paths, " ")
			assert(text == "dist/a/libfoo.so.1 dist/b/libfoo.so.1.2.3 dist/c/libfoo.dylib dist/d/foo.DLL", text)
		end),

		-- An executable keeps the target name. A `.sofa` file ends in the
		-- same three letters as a shared library, but it is not one.
		core.test.case("an executable, a subtree, and a near match keep the target name", function()
			local paths, report = publish({
				{ address = "//native/hello:hello", result = artifact("build/c/hello") },
				{ address = "//images:app", result = { type = "artifact", digest = "d" } },
				{ address = "//data:couch", result = artifact("build/couch.sofa") },
				{ address = "//:root", result = artifact("build/root") },
			})
			local text = table.concat(paths, " ")
			assert(text == "dist/native/hello/hello dist/images/app dist/data/couch dist/root", text)
			assert(string.find(report, "Packaged 4 targets:", 1, true) == 1, report)
		end),

		core.test.case("a root that is not an artifact fails the goal", function()
			local ok, err = pcall(publish, { { address = "//pkg:a", result = { value = 1 } } })
			assert(not ok)
			assert(
				string.find(tostring(err), "//pkg:a: package graph root must resolve to an artifact handle", 1, true)
			)
		end),

		core.test.case("no roots give no report", function()
			local paths, report = publish({})
			assert(#paths == 0 and report == nil)
		end),
	}),
}
