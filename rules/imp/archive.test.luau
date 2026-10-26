local core = require("@imp/core")
local archive = require("@imp/rules/imp/archive")
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

local function same_list(actual, expected)
	if #actual ~= #expected then
		return false
	end
	for index, value in ipairs(expected) do
		if actual[index] ~= value then
			return false
		end
	end
	return true
end

local function fake_download(name)
	return core.task({
		outputs = { archive = output.artifact() },
		run = function(exec)
			local result = exec.action({
				display = "download tool",
				argv = { "true" },
				outputs = { archive = output.file(name or "tool.tar.gz") },
			})
			return { archive = result.outputs.archive }
		end,
	}).outputs.archive
end

--- Resolve an extraction in a toolchain host fake, and return the extract
--- run and the recorder.
local function extract(options)
	return core.test.with_fake_toolchain_host(function(host)
		core.test.resolve(archive.extract_archive(options))
		for _, run in ipairs(host.runs) do
			if run.argv[1] == "sh" then
				return run, host
			end
		end
		error("no extract run")
	end)
end

-- The JavaScript module also reads the named cache back with `cacheGet`.
-- Luau has no named-cache read API yet; the Luau toolchain module will add
-- it. These tests check the named-cache declaration that the fake records.
return {
	core.test.suite("archive", {
		core.test.case("extract_archive_tools lists the decompressors of each format", function()
			assert(same_list(archive.extract_archive_tools("tar.gz"), { "mkdir", "tar", "gzip" }))
			assert(same_list(archive.extract_archive_tools("tar.xz"), { "mkdir", "tar", "xz" }))
			assert(same_list(archive.extract_archive_tools("tar"), { "mkdir", "tar" }))
			assert(same_list(archive.extract_archive_tools("zip"), { "mkdir", "unzip", "mv" }))
			assert(same_list(archive.extract_archive_tools("zip-unix"), { "mkdir", "unzip", "mv" }))
			local text = error_text(archive.extract_archive_tools, "rar")
			assert(contains(text, "unsupported archive format 'rar'"), text)
		end),

		core.test.case("extract_archive uses unzip for a Unix zip archive", function()
			local run =
				extract({ archive = fake_download("a.zip"), dest = "out", format = "zip-unix", display = "unzip" })
			assert(contains(run.argv[3], "unzip -q"), run.argv[3])
			assert(run.display == "unzip")
			assert(same_list(run.tools, { "mkdir", "mv", "sh", "unzip" }))
		end),

		core.test.case("extract_archive runs tar with format flags into a named-cache output", function()
			local run, host = extract({
				archive = fake_download(),
				dest = ".imp/toolchains/1.0.0",
				format = "tar.gz",
				strip_components = 1,
				named_cache = { name = "tool-toolchains", key = "1.0.0/linux-x86_64" },
				display = "install tool",
			})
			assert(contains(run.argv[3], "tar -xzf"), run.argv[3])
			assert(contains(run.argv[3], "--strip-components=1"), run.argv[3])
			assert(run.argv[4] == "extract-archive")
			assert(run.argv[5] == "tool.tar.gz")
			assert(run.argv[6] == ".imp/toolchains/1.0.0")
			assert(run.outputs.directory == ".imp/toolchains/1.0.0")
			assert(run.input_count == 1)
			assert(same_list(run.tools, { "gzip", "mkdir", "sh", "tar" }))
			local found = false
			for _, call in ipairs(host.calls) do
				if call[1] == "named_cache" then
					found = call[2] == "tool-toolchains" and call[3] == "1.0.0/linux-x86_64"
				end
			end
			assert(found, "the extract output declares the named cache")
		end),

		core.test.case("extract_archive omits strip-components and the named cache when not asked", function()
			local run, host = extract({ archive = fake_download("a.zip"), dest = "out", format = "zip" })
			assert(contains(run.argv[3], "unzip -q"), run.argv[3])
			assert(not contains(run.argv[3], "--strip-components"), run.argv[3])
			assert(not contains(run.argv[3], ".stage"), run.argv[3])
			assert(run.display == "extract archive")
			for _, call in ipairs(host.calls) do
				assert(call[1] ~= "named_cache")
			end
		end),

		core.test.case("extract_archive strips the top-level directory of a zip with a staging directory", function()
			local run =
				extract({ archive = fake_download("a.zip"), dest = "out", format = "zip", strip_components = 1 })
			assert(contains(run.argv[3], "unzip -q"), run.argv[3])
			assert(contains(run.argv[3], '"$2.stage"'), run.argv[3])
			assert(contains(run.argv[3], 'mv "$2.stage"/*/* "$2"'), run.argv[3])
		end),

		core.test.case("extract_archive rejects a zip strip_components value other than 1", function()
			local text = error_text(archive.extract_archive, {
				archive = fake_download("a.zip"),
				dest = "out",
				format = "zip",
				strip_components = 2,
			})
			assert(contains(text, "only supports strip_components of 1"), text)
		end),

		core.test.case("extract_archive treats a strip_components of 0 as no strip", function()
			local zip =
				extract({ archive = fake_download("a.zip"), dest = "out", format = "zip", strip_components = 0 })
			assert(not contains(zip.argv[3], ".stage"), zip.argv[3])
			local tar = extract({ archive = fake_download(), dest = "out", format = "tar.gz", strip_components = 0 })
			assert(not contains(tar.argv[3], "--strip-components"), tar.argv[3])
		end),

		core.test.case("extract_archive returns a directory handle and does not run", function()
			core.test.with_fake_toolchain_host(function(host)
				local extracted =
					archive.extract_archive({ archive = fake_download(), dest = "tool", format = "tar.gz" })
				assert(type(extracted) == "userdata")
				assert(#host.runs == 0)
			end)
		end),

		core.test.case("extract_archive rejects caller tools", function()
			local text = error_text(archive.extract_archive, {
				archive = fake_download(),
				dest = "tool",
				format = "tar.gz",
				tools = {},
			})
			assert(contains(text, "extract_archive owns its tools"), text)
		end),

		core.test.case("extract_archive requires a dest", function()
			local text = error_text(archive.extract_archive, { archive = fake_download(), format = "tar.gz" })
			assert(contains(text, "requires a non-empty dest"), text)
		end),

		core.test.case("extract_archive rejects unknown formats", function()
			local text =
				error_text(archive.extract_archive, { archive = fake_download(), dest = "tool", format = "rar" })
			assert(contains(text, "unsupported archive format 'rar'"), text)
		end),
	}),
}
