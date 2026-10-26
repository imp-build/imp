local core = require("@imp/core")
local kache = require("@imp/rules/rust/kache")
local function contains(text, part)
	return string.find(text, part, 1, true) ~= nil
end
local function acquire(options, run)
	local declaration = kache.kache_toolchain("0.22.0", options)
	local graph = kache.graph_toolchain("0.22.0")
	return core.test.resolve(core.task({
		inputs = { tool = graph.tool, data = graph.data_tool },
		outputs = { value = core.output.value() },
		run = function(exec, input)
			return { value = run(exec, input, declaration) }
		end,
	}).outputs.value)
end
local function env(exec, input, declaration)
	return kache.build_cache_env(exec, input.tool, input.data, declaration)
end
return {
	core.test.case("Empty-input statistics callbacks disable caching and permit failure", function()
		core.test.with_fake_toolchain_host(function(host)
			core.named_cache_details({
				name = "empty-input-statistics",
				inputs = {},
				caches = {},
				run = function(exec)
					local result = exec.action({ argv = { "sh", "-c", "exit 9" }, display = "empty statistics" })
					return tostring(result.exit_code)
				end,
			})
			host.set_run_exit_code("empty statistics", 9)
			assert(core.test.cache_details("empty-input-statistics", true) == "9")
			assert(host.runs[1].cache == false and host.runs[1].allow_failure == true)
			core.test.resolve(core.task({
				outputs = { value = core.output.value() },
				run = function(exec)
					local result = exec.action({ argv = { "sh", "-c", "exit 0" }, display = "ordinary action" })
					return { value = result.exit_code }
				end,
			}))
			assert(host.runs[2].cache == true and host.runs[2].allow_failure == false)
		end)
	end),
	core.test.case("Cache-details callback errors restore its bindings", function()
		core.test.with_fake_toolchain_host(function(host)
			kache.kache_toolchain("0.22.0")
			host.worker_error = "details failure"
			local ok, err = pcall(core.test.cache_details, "kache-data", true)
			assert(not ok and contains(tostring(err), "details failure"))
			host.worker_error = nil
			host.set_run_stdout("kache stats", "restored")
			assert(core.test.cache_details("kache-data", true) == "restored")
		end)
	end),
	core.test.case("Kache custom lockfile supplies the checksum", function()
		core.test.with_fake_toolchain_host(function(host)
			acquire({ lockfile = "@imp/rules/rust/testdata/kache-custom.json" }, env)
			local found = false
			for _, action in ipairs(host.runs) do
				if contains(table.concat(action.argv, " "), string.rep("ab", 32)) then
					found = true
				end
			end
			assert(found)
		end)
	end),
	core.test.case("Kache missing selected lockfile fails by address", function()
		core.test.with_fake_toolchain_host(function()
			local ok, err = pcall(acquire, { lockfile = "@workspace/missing-kache.lock" }, env)
			assert(not ok and contains(tostring(err), "missing-kache.lock"))
		end)
	end),
	core.test.case("Kache executable caching reaches both client and daemon", function()
		core.configure("kache", { cache_executables = true })
		core.test.with_fake_toolchain_host(function(host)
			local value = acquire({}, env)
			assert(value.KACHE_CACHE_EXECUTABLES == "1" and value.KACHE_MAX_SIZE == "4GiB")
			for _, call in ipairs(host.calls) do
				if call[1] == "worker_start" then
					assert(call[3].env.KACHE_CACHE_EXECUTABLES == "1")
				end
			end
		end)
	end),
	core.test.case("Worker fakes restore after a failing scope", function()
		local ok = pcall(core.test.with_fake_toolchain_host, function(host)
			host.worker_error = "scope failure"
			acquire({}, env)
		end)
		assert(not ok)
		core.test.with_fake_toolchain_host(function()
			acquire({}, env)
		end)
	end),
	core.test.case("Saved worker methods cannot run outside a callback", function()
		core.test.with_fake_toolchain_host(function()
			local saved
			acquire({}, function(exec)
				saved = exec.worker_start
				return true
			end)
			local ok, err = pcall(saved, "bad", { argv = { "/tmp/undeclared" } })
			assert(not ok and contains(tostring(err), "running task"))
		end)
	end),
	core.test.case("Run fakes also prevent daemon startup", function()
		core.test.with_fake_run(function(host)
			acquire({}, env)
			assert(#host.workers == 1)
		end)
	end),
	core.test.case("Kache declares its pinned default", function()
		assert(kache.default_version() == "0.22.0")
	end),
	core.test.case("Kache maps supported archives and rejects unknown platforms", function()
		for _, plat in ipairs(kache.supported_platforms()) do
			local name = kache.artifact_name("0.22.0", plat)
			assert(contains(name, if plat.os == "windows" then ".zip" else ".tar.gz"))
		end
		assert(not pcall(kache.artifact_name, "0.22.0", { os = "bad", arch = "bad" }))
		assert(kache.data_cache_key({ os = "linux", arch = "x86_64" }) == "linux-x86_64")
	end),
	core.test.case("Kache acquisition and daemon share cache settings", function()
		core.test.with_fake_toolchain_host(function(host)
			local value = acquire({ cache_size = "1GiB" }, env)
			assert(value.KACHE_CACHE_DIR == "/cache/kache-data/linux-x86_64")
			assert(value.KACHE_MAX_SIZE == "1GiB" and value.KACHE_LOCAL_ONLY == "1" and value.CARGO_INCREMENTAL == "0")
			assert(value.KACHE_CACHE_EXECUTABLES == "0" and value.RUSTC_WRAPPER == "kache")
			local worker
			for _, call in ipairs(host.calls) do
				if call[1] == "worker_start" then
					worker = call[3]
				end
			end
			assert(worker and worker.env.KACHE_MAX_SIZE == "1GiB")
			assert(worker.argv[2] == "daemon" and worker.health_check_argv[3] == "status")
			assert(#host.runs == 3)
		end)
	end),
	core.test.case("Kache starts no worker at declaration", function()
		core.test.with_fake_toolchain_host(function(host)
			kache.kache_toolchain("0.22.0")
			assert(#host.runs == 0)
			for _, call in ipairs(host.calls) do
				assert(call[1] ~= "worker_start")
			end
		end)
	end),
	core.test.case("Kache daemon startup errors reach the caller", function()
		core.test.with_fake_toolchain_host(function(host)
			host.worker_error = "test worker failure"
			local ok, err = pcall(acquire, {}, env)
			assert(not ok and contains(tostring(err), "test worker failure"))
		end)
	end),
	core.test.case("Kache statistics skip missing caches and do not acquire tools", function()
		core.test.with_fake_toolchain_host(function(host)
			kache.kache_toolchain("0.22.0")
			assert(core.test.cache_details("kache-data", false) == nil and #host.runs == 0)
			host.set_run_stdout("kache stats", "  cache hits: 7\n")
			assert(core.test.cache_details("kache-data", true) == "cache hits: 7")
			assert(#host.runs == 1 and host.runs[1].cache == false and host.runs[1].allow_failure)
			host.set_run_exit_code("kache stats", 2)
			assert(core.test.cache_details("kache-data", true) == nil)
		end)
	end),
	core.test.case("Worker executable must belong to a declared tool", function()
		core.test.with_fake_toolchain_host(function()
			local ok, err = pcall(acquire, {}, function(exec)
				return exec.worker_start("bad", { argv = { "/tmp/undeclared-program" } })
			end)
			assert(not ok and contains(tostring(err), "declared tool input"))
		end)
	end),
	core.test.case("Kache rejects a malformed lockfile address", function()
		assert(not pcall(kache.kache_toolchain, "0.22.0", { lockfile = "bad.lock" }))
	end),
}
