local core = require("@imp/core")
local oci = require("@imp/rules/oci")
local crane = require("@imp/rules/oci/toolchain")
local DIGEST = "sha256:" .. string.rep("a", 64)
local function fails(fn, text)
	local ok, err = pcall(fn)
	assert(not ok, "expected failure")
	assert(string.find(tostring(err), text, 1, true), tostring(err))
end
local function scratch(extra)
	local options = { base = "scratch", source_base = ".", layers = { { srcs = { "rules/oci/index.js" }, path = "/app" } } }
	for key, value in pairs(extra or {}) do options[key] = value end
	return oci.oci_build(options)
end
local function fake(fn)
	return core.test.with_fake_toolchain_host(function(host)
		crane.reset_for_test()
		crane.crane_toolchain("0.22.1", { default = true })
		return fn(host)
	end)
end
local function find(host, display)
	for _, run in ipairs(host.runs) do if run.display == display then return run end end
	error("missing action " .. display)
end
return {
	core.test.case("validates image declarations and source paths", function()
		fails(function() oci.oci_pull({}) end, "repo")
		fails(function() oci.oci_pull({ repo = "alpine" }) end, "exactly one")
		fails(function() oci.oci_pull({ repo = "alpine", tag = "latest", digest = DIGEST }) end, "exactly one")
		fails(function() oci.oci_pull({ repo = "alpine", tag = "" }) end, "must not be empty")
		fails(function() oci.oci_build({ layers = {} }) end, "image object")
		fails(function() scratch({ layers = {} }) end, "one or more")
		fails(function() scratch({ layers = { { srcs = {}, path = "/app" } } }) end, "non-empty")
		fails(function() scratch({ layers = { { srcs = { "*" }, path = "/app/../escape" } } }) end, "must not contain")
		for _, path in ipairs({ "../escape", "/absolute", "C:/absolute", "a\\b" }) do
			fails(function() scratch({ path = path }) end, "within the workspace")
			fails(function() scratch({ source_base = path }) end, "within the workspace")
		end
		fails(function() oci.oci_push({ image = {} }) end, "image object")
		fails(function() oci.oci_mirror({}) end, "from:")
		fails(function() oci.oci_mirror({ from = { repo = "alpine", tag = "x" } }) end, "to:")
	end),
	core.test.case("pull resolves tags uncached and passes the digest downstream", function()
		fake(function(host)
			host.set_run_stdout("resolve alpine:latest", DIGEST .. "\n")
			local image = oci.oci_pull({ repo = "alpine", tag = "latest" })
			assert(table.isfrozen(image) and table.isfrozen(image.image))
			assert(image.BUILD == image.image.layout and type(image.PACKAGE) == "userdata")
			assert(core.test.resolve(image.image.digest) == DIGEST)
			core.test.resolve(image.BUILD)
			assert(not find(host, "resolve alpine:latest").cache)
			local pull = find(host, "pull alpine")
			assert(pull.cache and pull.argv[2] == "pull" and pull.argv[3] == "--format=oci")
			assert(pull.argv[4] == "alpine@" .. DIGEST)
		end)
	end),
	core.test.case("pinned pulls skip digest lookup and publication is explicit", function()
		fake(function(host)
			local image = oci.oci_pull({ repo = "alpine", digest = DIGEST })
			local push = oci.oci_push({ image = image, repo = "registry.example/app", tag = "v1" })
			local mirror = oci.oci_mirror({ from = { repo = "alpine", digest = DIGEST }, to = { repo = "registry.example/base", tag = "v1" } })
			assert(push.BUILD == nil and push.PACKAGE == nil and mirror.BUILD == nil)
			core.test.resolve(push.PUBLISH)
			core.test.resolve(mirror.PUBLISH)
			local p = find(host, "push registry.example/app:v1")
			assert(not p.cache and p.input_count == 1 and p.argv[2] == "push")
			assert(p.argv[3] == "oci-layout" and p.argv[4] == "registry.example/app:v1")
			local m = find(host, "mirror alpine@" .. DIGEST .. " -> registry.example/base:v1")
			assert(not m.cache and m.argv[2] == "copy" and m.argv[3] == "alpine@" .. DIGEST)
			for _, run in ipairs(host.runs) do assert(run.argv[2] ~= "digest") end
		end)
	end),
	core.test.case("stages layers and encodes configuration without Crane", function()
		core.test.with_fake_run(function(host)
			host.set_run_stdout("compose OCI image", DIGEST .. "\n")
			local image = scratch({ entrypoint = "/app/server", cmd = { "one", "two" }, env = { Z = "last", A = "first" }, labels = { z = "é\n\t\0\31", a = '"\\' }, user = "1000", workdir = "/app" })
			assert(core.test.resolve(image.image.digest) == DIGEST)
			core.test.resolve(image.PACKAGE)
			assert(#host.runs == 3)
			local layer, compose, package = host.runs[1], host.runs[2], host.runs[3]
			assert(layer.input_count == 1 and compose.input_count == 1 and package.input_count == 1)
			assert(layer.argv[8] == "app" and layer.argv[10] == "0" and layer.argv[11] == "0")
			assert(compose.argv[7] == '["/app/server"]' and compose.argv[8] == '["one","two"]')
			assert(compose.argv[9] == '["A=first","Z=last"]')
			local labels = core.json_decode(compose.argv[10])
			assert(labels.z == "é\n\t\0\31" and labels.a == '"\\')
			assert(string.sub(compose.argv[10], 1, 5) == '{"a":')
			assert(compose.argv[11] == "1000" and compose.argv[12] == "/app")
			assert(package.outputs.archive == "package")
		end)
	end),
	core.test.case("empty collections retain JSON types and invalid values fail", function()
		core.test.with_fake_run(function(host)
			core.test.resolve(scratch().BUILD)
			local argv = find(host, "compose OCI image").argv
			assert(argv[7] == "[]" and argv[8] == "[]" and argv[9] == "[]" and argv[10] == "{}")
		end)
		for _, extra in ipairs({ { env = false }, { labels = false }, { user = false }, { workdir = false }, { env = { A = 1 } }, { labels = { [1] = "x" } }, { cmd = { true } }, { entrypoint = { [2] = "gap" } }, { cmd = 42 } }) do
			fails(function() scratch(extra) end, "must be")
		end
	end),
	core.test.case("uses separate layer artifacts and stages a local base", function()
		core.test.with_fake_run(function(host)
			local base = scratch()
			local derived = scratch({ base = base, layers = {
				{ srcs = { "rules/oci/index.js" }, path = "/one", mode = "0755", uid = 12, gid = 34 },
				{ srcs = { "rules/oci/DOC.md" }, path = "/two" },
			} })
			core.test.resolve(derived.BUILD)
			local first, second = find(host, "stage OCI layer 1 (/one)"), find(host, "stage OCI layer 2 (/two)")
			assert(first.outputs.tarball ~= second.outputs.tarball)
			assert(first.argv[9] == "0755" and first.argv[10] == "12" and first.argv[11] == "34")
			local compose = host.runs[#host.runs]
			assert(compose.input_count == 3 and compose.argv[5] ~= compose.argv[6])
		end)
	end),
	core.test.case("empty source matches and action failures propagate", function()
		core.test.with_fake_run(function(host)
			fails(function() core.test.resolve(scratch({ layers = { { srcs = { "rules/oci/does-not-exist-*" }, path = "/app" } } }).BUILD) end, "no files matched")
			host.set_run_exit_code("compose OCI image", 7)
			fails(function() core.test.resolve(scratch().BUILD) end, "7")
		end)
	end),
	core.test.case("registry command failures fail their selected roots", function()
		for _, operation in ipairs({ "digest", "pull", "push", "copy" }) do
			fake(function(host)
				local pinned = oci.oci_pull({ repo = "alpine", digest = DIGEST })
				local root, display
				if operation == "digest" then
					root = oci.oci_pull({ repo = "alpine", tag = "latest" }).BUILD
					display = "resolve alpine:latest"
				elseif operation == "pull" then
					root, display = pinned.BUILD, "pull alpine"
				elseif operation == "push" then
					root = oci.oci_push({ image = pinned, repo = "example/app", tag = "v1" }).PUBLISH
					display = "push example/app:v1"
				else
					root = oci.oci_mirror({ from = { repo = "alpine", tag = "latest" }, to = { repo = "example/app", tag = "v1" } }).PUBLISH
					display = "mirror alpine:latest -> example/app:v1"
				end
				host.set_run_exit_code(display, 9)
				fails(function() core.test.resolve(root) end, "9")
			end)
		end
	end),

}
