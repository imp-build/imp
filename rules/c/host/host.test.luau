-- Tests of `@imp/rules/c/host`.
local core = require("@imp/core")
local host = require("@imp/rules/c/host")

local MACOS = { os = "macos", arch = "aarch64" }

return {
	core.test.case("the host compiler exists only on macOS", function()
		core.test.with_fake_toolchain_host(MACOS, function()
			local record = host.default_graph_toolchain()
			assert(host.is_host_toolchain(record) and table.isfrozen(record))
			for _, field in ipairs({ "tool", "clang_tool", "ar_tool" }) do
				assert(type(record[field]) == "userdata", field)
			end
		end)
		for _, plat in ipairs({ { os = "linux", arch = "x86_64" }, { os = "windows", arch = "x86_64" } }) do
			core.test.with_fake_toolchain_host(plat, function()
				assert(host.default_graph_toolchain() == nil, plat.os)
			end)
		end
		assert(not host.is_host_toolchain(nil) and not host.is_host_toolchain({ kind = "gcc" }))
	end),
	core.test.case("rust_link_driver_env links with cc and runs CC and CXX through kache when active", function()
		local plain = host.rust_link_driver_env(false)
		assert(table.concat(plain.rustflags, " ") == "-C linker=cc")
		assert(plain.env.CC == "cc" and plain.env.CXX == nil and #plain.path_dirs == 0)
		local cached = host.rust_link_driver_env(true)
		assert(cached.env.CC == "kache cc" and cached.env.CXX == "kache c++")
	end),
}
