-- Tests of `@imp/rules/c/toolchain`.
local core = require("@imp/core")
local c_toolchain = require("@imp/rules/c/toolchain")

local LINUX = { os = "linux", arch = "x86_64" }
local WINDOWS = { os = "windows", arch = "x86_64" }

local function same(actual, expected)
	assert(#actual == #expected, `expected {#expected} values, got {#actual}: {table.concat(actual, " ")}`)
	for index, value in ipairs(expected) do
		assert(actual[index] == value, `value {index}: expected {value}, got {actual[index]}`)
	end
end

local function error_text(fn, ...)
	local ok, err = pcall(fn, ...)
	assert(not ok, "expected an error")
	return tostring(err)
end

return {
	core.test.suite("shared C toolchain helpers", {
		core.test.case("shell_quote quotes one sh token", function()
			assert(c_toolchain.shell_quote("a b") == "'a b'")
			assert(c_toolchain.shell_quote("it's") == "'it'\\''s'")
			assert(c_toolchain.shell_quote(3) == "'3'")
		end),

		core.test.case("clang_opt_flags selects release or debug flags", function()
			same(c_toolchain.clang_opt_flags("release"), { "-O2", "-DNDEBUG" })
			same(c_toolchain.clang_opt_flags("debug"), { "-O0", "-g" })
		end),

		core.test.case("ELF link arguments apply only to shared or bundled outputs off Windows", function()
			core.test.with_fake_toolchain_host(LINUX, function()
				same(c_toolchain.soname_args("build/c/libm.so", true), { "'-Wl,-soname,libm.so'" })
				same(c_toolchain.soname_args("build/c/libm.a", false), {})
				same(c_toolchain.rpath_origin_args(true), { "'-Wl,-rpath,$ORIGIN'" })
				same(c_toolchain.rpath_origin_args(false), {})
				assert(c_toolchain.import_lib_path("m.dll", true) == nil)
				same(c_toolchain.import_lib_args("m.dll", true), {})
			end)
			core.test.with_fake_toolchain_host(WINDOWS, function()
				same(c_toolchain.soname_args("build/c/m.dll", true), {})
				same(c_toolchain.rpath_origin_args(true), {})
			end)
		end),

		core.test.case("the Windows import library sits beside the DLL", function()
			core.test.with_fake_toolchain_host(WINDOWS, function()
				assert(c_toolchain.import_lib_path("out/m.dll", true) == "out/m.lib")
				assert(c_toolchain.import_lib_path("out/m.dll", false) == nil)
				same(c_toolchain.import_lib_args("out/m.dll", true), { "'-Wl,--out-implib,out/m.lib'" })
			end)
		end),
		core.test.case("Windows shared-library paths require the lowercase .dll suffix", function()
			local paths = { "out/m", "out/m.so", "out/m.DLL", "out/m.lib" }
			core.test.with_fake_toolchain_host(WINDOWS, function()
				for _, path in ipairs(paths) do
					local expected = `Windows shared-library output path must end in .dll: {path}`
					for _, helper in ipairs({ c_toolchain.import_lib_path, c_toolchain.import_lib_args }) do
						local text = error_text(helper, path, true)
						assert(string.find(text, expected, 1, true), text)
					end
					assert(c_toolchain.import_lib_path(path, false) == nil)
					same(c_toolchain.import_lib_args(path, false), {})
				end
			end)
			core.test.with_fake_toolchain_host(LINUX, function()
				for _, path in ipairs(paths) do
					assert(c_toolchain.import_lib_path(path, true) == nil)
					same(c_toolchain.import_lib_args(path, true), {})
				end
			end)
		end),
	}),

	core.test.suite("cc toolchain union", {
		core.test.case("selects the provider of the target OS", function()
			local gcc_provider = { kind = "gcc" }
			local union = c_toolchain.cc_toolchain_for_platform({
				linux = gcc_provider,
				windows = function()
					return { kind = "msvc-host-toolchain" }
				end,
			})
			assert(c_toolchain.is_cc_toolchain_union(union))
			assert(table.isfrozen(union))
			assert(union.select(LINUX) == gcc_provider)
			assert(union.select(WINDOWS).kind == "msvc-host-toolchain")
			assert(c_toolchain.select_cc_toolchain(union, LINUX) == gcc_provider)
		end),

		core.test.case("selects for the host platform by default", function()
			core.test.with_fake_toolchain_host(WINDOWS, function()
				local union = c_toolchain.cc_toolchain_for_platform({ windows = { kind = "msvc-host-toolchain" } })
				assert(union.select().kind == "msvc-host-toolchain")
			end)
		end),

		core.test.case("a missing OS fails and names the configured ones", function()
			local union = c_toolchain.cc_toolchain_for_platform({ windows = {}, linux = {} })
			local text = error_text(union.select, { os = "macos", arch = "aarch64" })
			assert(
				string.find(
					text,
					"no cc toolchain configured for platform 'macos' (configured: linux, windows)",
					1,
					true
				),
				text
			)
			local empty = c_toolchain.cc_toolchain_for_platform({})
			text = error_text(empty.select, LINUX)
			assert(string.find(text, "(configured: none)", 1, true), text)
		end),

		core.test.case("a provider or nil passes through select_cc_toolchain", function()
			local provider = { kind = "gcc" }
			assert(not c_toolchain.is_cc_toolchain_union(provider))
			assert(c_toolchain.select_cc_toolchain(provider) == provider)
			assert(c_toolchain.select_cc_toolchain(nil) == nil)
		end),
	}),
}
