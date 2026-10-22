import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { importLibArgs, importLibPath } from "//rules/c/toolchain";

const WINDOWS = { os: "windows", arch: "x86_64" };
const LINUX = { os: "linux", arch: "x86_64" };
const INVALID_PATHS = ["out/m", "out/m.so", "out/m.DLL", "out/m.lib"];

describe("Windows import-library paths", () => {
	test("the import library sits beside the DLL", () => {
		return withFakeToolchainHost(WINDOWS, () => {
			expect(importLibPath("out/m.dll", true)).toBe("out/m.lib");
			expect(importLibArgs("out/m.dll", true)).toEqual([
				"'-Wl,--out-implib,out/m.lib'",
			]);
		});
	});

	test("shared-library paths require the lowercase .dll suffix", () => {
		return withFakeToolchainHost(WINDOWS, () => {
			for (const path of INVALID_PATHS) {
				const message = `Windows shared-library output path must end in .dll: ${path}`;
				for (const helper of [importLibPath, importLibArgs]) {
					expect(() => helper(path, true)).toThrow(message);
				}
			}
		});
	});

	test("static outputs and non-Windows outputs need no import library", async () => {
		for (const platform of [WINDOWS, LINUX]) {
			await withFakeToolchainHost(platform, () => {
				for (const path of ["out/m.dll", ...INVALID_PATHS]) {
					expect(importLibPath(path, false)).toBe(null);
					expect(importLibArgs(path, false)).toEqual([]);
					if (platform.os !== "windows") {
						expect(importLibPath(path, true)).toBe(null);
						expect(importLibArgs(path, true)).toEqual([]);
					}
				}
			});
		}
	});
});
