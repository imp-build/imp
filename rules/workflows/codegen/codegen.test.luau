local core = require("@imp/core")
local codegen = require("@imp/rules/workflows/codegen")

local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end

--- A `codegen()` root result with one artifact for each `{ path, digest }`.
local function codegen_root(address, files)
	local result = {}
	for index, file in ipairs(files) do
		result[`out{index}`] = { type = "artifact", path = file[1], digest = file[2] }
	end
	return { address = address, result = result }
end

--- Run the codegen goal with fake workspace writes, and return the write
--- calls and the report.
local function export(roots)
	return core.test.with_fake_write_workspace(function(writes)
		local report = codegen.graph_codegen_goal(roots)
		return writes.calls, report
	end)
end

--- Run the codegen goal with fake workspace writes, require that it fails
--- before it writes a file, and return the error text.
local function rejected(roots)
	return core.test.with_fake_write_workspace(function(writes)
		local ok, err = pcall(codegen.graph_codegen_goal, roots)
		assert(not ok, "expected a goal error")
		assert(#writes.calls == 0, "the goal wrote a file before it failed")
		return tostring(err)
	end)
end

return {
	core.test.suite("graph_codegen_goal", {
		core.test.case("publishes selected codegen files under dist/codegen at declared paths", function()
			local calls, report = export({
				codegen_root("//app:bindings", {
					{ "app/generated/bindings.odin", "bindings-digest" },
					{ "app/generated/types.odin", "types-digest" },
				}),
			})
			assert(#calls == 2, tostring(#calls))
			assert(calls[1].path == "dist/codegen/app/generated/bindings.odin", calls[1].path)
			assert(calls[1].digest == "bindings-digest" and calls[1].from == "app/generated/bindings.odin")
			assert(calls[2].path == "dist/codegen/app/generated/types.odin", calls[2].path)
			assert(calls[2].digest == "types-digest" and calls[2].from == "app/generated/types.odin")
			assert(contains(report, "Exported 2 codegen files:"), report)
			assert(
				contains(report, "//app:bindings: app/generated/types.odin -> dist/codegen/app/generated/types.odin"),
				report
			)
		end),

		core.test.case("publishes outputs from more than one selected producer", function()
			local calls = export({
				codegen_root("//app:bindings", { { "app/bindings.odin", "a" } }),
				codegen_root("//app:schema", { { "app/schema.odin", "b" } }),
			})
			assert(#calls == 2, tostring(#calls))
			assert(calls[1].path == "dist/codegen/app/bindings.odin", calls[1].path)
			assert(calls[2].path == "dist/codegen/app/schema.odin", calls[2].path)
		end),

		core.test.case("the report for one file uses the singular form", function()
			local _, report = export({ codegen_root("//app:one", { { "app/one.txt", "a" } }) })
			assert(report == "Exported 1 codegen file:\n  //app:one: app/one.txt -> dist/codegen/app/one.txt", report)
		end),

		core.test.case("no roots give no report", function()
			local calls, report = export({})
			assert(#calls == 0 and report == nil)
		end),

		core.test.case("rejects duplicate destinations before writing any output", function()
			local text = rejected({
				codegen_root("//app:first", { { "app/shared.odin", "a" } }),
				codegen_root("//app:second", { { "app/shared.odin", "b" } }),
			})
			assert(contains(text, "dist/codegen/app/shared.odin"), text)
			assert(contains(text, "//app:first"), text)
			assert(contains(text, "//app:second"), text)
		end),

		core.test.case("rejects case-only destination aliases before writing", function()
			local text = rejected({
				-- A single artifact is also a codegen root result.
				{ address = "//app:lower", result = { type = "artifact", path = "app/Readme.txt", digest = "a" } },
				codegen_root("//app:upper", { { "app/README.txt", "b" } }),
			})
			assert(contains(text, "codegen output path conflict at 'dist/codegen/app/README.txt'"), text)
		end),

		core.test.case("rejects file and directory destination conflicts before writing", function()
			for _, paths in ipairs({
				{ "app/generated", "app/generated/types.odin" },
				{ "app/generated/types.odin", "app/generated" },
			}) do
				local text = rejected({
					codegen_root("//app:producer1", { { paths[1], "d1" } }),
					codegen_root("//app:producer2", { { paths[2], "d2" } }),
				})
				assert(contains(text, "path conflict"), text)
			end
		end),

		core.test.case("rejects paths that escape dist/codegen before writing", function()
			local text = rejected({ codegen_root("//app:bad", { { "../outside.txt", "a" } }) })
			assert(contains(text, "workspace-relative path"), text)
		end),

		core.test.case("rejects a root that is not a codegen result", function()
			-- An artifact without a path, and a table without artifacts.
			for _, result in ipairs({ { type = "artifact" }, { x = 1 } }) do
				local text = rejected({ { address = "//app:other", result = result } })
				assert(contains(text, "//app:other: codegen root must resolve to a codegen() result"), text)
			end
		end),
	}),
}
