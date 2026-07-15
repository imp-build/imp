import { describe, expect, test } from "//rules/imp/test";
import {
	generateToolLockfile,
	generateBuiltinLockfile,
	builtinLockfiles,
} from "//rules/workflows/lockfiles";
// Load-bearing: pulls in every toolchain module so their
// registerBuiltinLockfile() calls run — the registry assertions below verify
// the goal module's import list stays complete.
import "//rules/workflows/builtin_lockfiles";
import { odinSupportedPlatforms } from "//rules/odin/toolchain";
import { cmakeSupportedPlatforms } from "//rules/c/cmake/toolchain";
import { gccSupportedPlatforms } from "//rules/c/gcc/toolchain";
import { moldSupportedPlatforms } from "//rules/c/mold/toolchain";
import { zigSupportedPlatforms } from "//rules/c/zig/toolchain";
import { zolaSupportedPlatforms } from "//rules/zola/toolchain";
import { rustSupportedPlatforms } from "//rules/rust/toolchain";

// Records every download/sha256/file_size and captures the run() that writes
// the lockfile, so a lockfile can be generated without touching the network
// or the sandbox. Seed `files` to simulate an existing lockfile at an address.
function fakeHost(files = {}) {
	const writes = [];
	return {
		writes,
		download(url) {
			return `/dl/${url}`;
		},
		sha256(path) {
			return `sha256:${path}`;
		},
		file_size(path) {
			return path.length;
		},
		readAddressedFile(address) {
			return address in files ? files[address] : null;
		},
		output(path) {
			return { __output: path };
		},
		output_path(path) {
			return `/ws/${path}`;
		},
		run(opts) {
			writes.push(opts);
			return Promise.resolve({});
		},
	};
}

describe("generateToolLockfile", () => {
	test("pins version + per-platform url/artifact/size/sha256", async () => {
		const host = fakeHost();
		const handle = { attrs: { version: "1.2.3" } };
		const platforms = [
			{ os: "linux", arch: "x86_64" },
			{ os: "macos", arch: "aarch64" },
		];
		const downloadUrl = (v, p) => `https://ex/${v}/${p.os}-${p.arch}`;
		const artifactName = (v, p) => `tool-${v}-${p.os}-${p.arch}.tar`;

		const lock = await generateToolLockfile(
			{ handle, name: "tool", platforms, downloadUrl, artifactName },
			host,
		);

		expect(lock).toEqual({
			tool: "tool",
			versions: {
				"1.2.3": {
					"linux/x86_64": {
						url: "https://ex/1.2.3/linux-x86_64",
						artifact: "tool-1.2.3-linux-x86_64.tar",
						size: "/dl/https://ex/1.2.3/linux-x86_64".length,
						sha256: "sha256:/dl/https://ex/1.2.3/linux-x86_64",
					},
					"macos/aarch64": {
						url: "https://ex/1.2.3/macos-aarch64",
						artifact: "tool-1.2.3-macos-aarch64.tar",
						size: "/dl/https://ex/1.2.3/macos-aarch64".length,
						sha256: "sha256:/dl/https://ex/1.2.3/macos-aarch64",
					},
				},
			},
		});
	});

	test("merging preserves other locked versions, sorted", async () => {
		const existing = {
			tool: "tool",
			versions: {
				"2.0.0": {
					"linux/x86_64": { url: "u2", artifact: "a2", size: 2, sha256: "s2" },
				},
				"0.9.0": {
					"linux/x86_64": { url: "u0", artifact: "a0", size: 0, sha256: "s0" },
				},
			},
		};
		const host = fakeHost({ "//tool.lock": JSON.stringify(existing) });
		const lock = await generateToolLockfile(
			{
				handle: { attrs: { version: "1.2.3" } },
				name: "tool",
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: () => "https://ex/a",
				artifactName: () => "a.tar",
			},
			host,
		);

		expect(Object.keys(lock.versions)).toEqual(["0.9.0", "1.2.3", "2.0.0"]);
		expect(lock.versions["0.9.0"]).toEqual(existing.versions["0.9.0"]);
		expect(lock.versions["2.0.0"]).toEqual(existing.versions["2.0.0"]);
	});

	test("re-locking an existing version replaces that version's entries", async () => {
		const existing = {
			tool: "tool",
			versions: {
				"1.2.3": {
					"linux/x86_64": {
						url: "stale",
						artifact: "stale.tar",
						size: 1,
						sha256: "stale",
					},
					"macos/aarch64": {
						url: "gone",
						artifact: "gone.tar",
						size: 1,
						sha256: "gone",
					},
				},
			},
		};
		const host = fakeHost({ "//tool.lock": JSON.stringify(existing) });
		const lock = await generateToolLockfile(
			{
				handle: { attrs: { version: "1.2.3" } },
				name: "tool",
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: () => "https://ex/a",
				artifactName: () => "a.tar",
			},
			host,
		);

		// Fresh downloads win; platforms not regenerated for this version drop out.
		expect(Object.keys(lock.versions["1.2.3"])).toEqual(["linux/x86_64"]);
		expect(lock.versions["1.2.3"]["linux/x86_64"].url).toBe("https://ex/a");
	});

	test("legacy single-version lockfile folds in additively", async () => {
		const legacy = {
			tool: "tool",
			version: "0.9.0",
			artifacts: {
				"linux/x86_64": { url: "u0", artifact: "a0", sha256: "s0" },
			},
		};
		const host = fakeHost({ "//tool.lock": JSON.stringify(legacy) });
		const lock = await generateToolLockfile(
			{
				handle: { attrs: { version: "1.2.3" } },
				name: "tool",
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: () => "https://ex/a",
				artifactName: () => "a.tar",
			},
			host,
		);

		expect(Object.keys(lock.versions)).toEqual(["0.9.0", "1.2.3"]);
		// Migrated entries keep their pinned data (no size — predates the field).
		expect(lock.versions["0.9.0"]).toEqual(legacy.artifacts);
	});

	test("existing lock for a different tool or invalid JSON is ignored", async () => {
		for (const contents of [
			JSON.stringify({ tool: "other", versions: { x: {} } }),
			"not json",
		]) {
			const host = fakeHost({ "//tool.lock": contents });
			const lock = await generateToolLockfile(
				{
					handle: { attrs: { version: "1.2.3" } },
					name: "tool",
					platforms: [{ os: "linux", arch: "x86_64" }],
					downloadUrl: () => "https://ex/a",
					artifactName: () => "a.tar",
				},
				host,
			);
			expect(Object.keys(lock.versions)).toEqual(["1.2.3"]);
		}
	});

	test("writes <name>.lock as a cacheable run() with the lock as content", async () => {
		const host = fakeHost();
		const handle = { attrs: { version: "9" } };
		const lock = await generateToolLockfile(
			{
				handle,
				name: "widget",
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: () => "https://ex/a",
				artifactName: () => "a.tar",
			},
			host,
		);

		expect(host.writes.length).toBe(1);
		const write = host.writes[0];
		expect(write.display).toBe("write widget.lock");
		expect(write.outputs).toEqual([{ __output: "widget.lock" }]);
		// The JSON content rides in the final positional argv slot.
		expect(JSON.parse(write.argv[write.argv.length - 1])).toEqual(lock);
	});

	test("writes to the lockfile address when one is given, merging from it", async () => {
		const existing = {
			tool: "widget",
			versions: {
				8: {
					"linux/x86_64": { url: "u8", artifact: "a8", size: 8, sha256: "s8" },
				},
			},
		};
		const host = fakeHost({
			"//rules/widgets/widget.lock": JSON.stringify(existing),
		});
		const handle = { attrs: { version: "9" } };
		const lock = await generateToolLockfile(
			{
				handle,
				name: "widget",
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: () => "https://ex/a",
				artifactName: () => "a.tar",
				lockfile: "//rules/widgets/widget.lock",
			},
			host,
		);

		expect(host.writes.length).toBe(1);
		expect(host.writes[0].outputs).toEqual([
			{ __output: "rules/widgets/widget.lock" },
		]);
		expect(Object.keys(lock.versions)).toEqual(["8", "9"]);
	});
});

describe("generateBuiltinLockfile", () => {
	test("writes exactly the registered versions, ignoring existing contents", async () => {
		const existing = {
			tool: "tool",
			versions: {
				"0.1.0": {
					"linux/x86_64": {
						url: "stale",
						artifact: "stale.tar",
						size: 1,
						sha256: "stale",
					},
				},
			},
		};
		const host = fakeHost({ "//rules/t/tool.lock": JSON.stringify(existing) });
		const lock = await generateBuiltinLockfile(
			{
				name: "tool",
				versions: ["2.0.0", "1.0.0"],
				platforms: [{ os: "linux", arch: "x86_64" }],
				downloadUrl: (v) => `https://ex/${v}`,
				artifactName: (v) => `tool-${v}.tar`,
				lockfile: "//rules/t/tool.lock",
			},
			host,
		);

		// Authoritative: 0.1.0 is dropped, and versions come out sorted.
		expect(Object.keys(lock.versions)).toEqual(["1.0.0", "2.0.0"]);
		expect(lock.versions["1.0.0"]["linux/x86_64"].url).toBe("https://ex/1.0.0");
		expect(host.writes[0].outputs).toEqual([{ __output: "rules/t/tool.lock" }]);
	});

	test("every toolchain module registers its shipped lockfile", () => {
		const registered = builtinLockfiles()
			.map((spec) => spec.name)
			.sort();
		expect(registered).toEqual([
			"biome-toolchain",
			"cmake",
			"crane",
			"gcc",
			"mold",
			"node-toolchain",
			"odin",
			"pex-toolchain",
			"pnpm-toolchain",
			"ruff-toolchain",
			"rust",
			"sccache",
			"uv-toolchain",
			"zig",
			"zola",
		]);
		for (const spec of builtinLockfiles()) {
			expect(spec.versions.length > 0).toBe(true);
			expect(spec.lockfile.startsWith("//rules/")).toBe(true);
		}
	});
});

describe("toolchain supported-platform matrices", () => {
	test("odin: linux/macos x86_64+aarch64, windows x86_64 only", () => {
		expect(odinSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
			{ os: "macos", arch: "x86_64" },
			{ os: "macos", arch: "aarch64" },
			{ os: "windows", arch: "x86_64" },
		]);
	});

	test("cmake: linux + windows, x86_64+aarch64 (no macos)", () => {
		expect(cmakeSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
			{ os: "windows", arch: "x86_64" },
			{ os: "windows", arch: "aarch64" },
		]);
	});

	test("gcc: linux x86_64 only", () => {
		expect(gccSupportedPlatforms()).toEqual([{ os: "linux", arch: "x86_64" }]);
	});

	test("mold: linux x86_64+aarch64", () => {
		expect(moldSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
		]);
	});

	test("zig: linux + windows, x86_64+aarch64", () => {
		expect(zigSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
			{ os: "windows", arch: "x86_64" },
			{ os: "windows", arch: "aarch64" },
		]);
	});

	test("zola: linux/macos x86_64+aarch64, windows x86_64", () => {
		expect(zolaSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
			{ os: "macos", arch: "x86_64" },
			{ os: "macos", arch: "aarch64" },
			{ os: "windows", arch: "x86_64" },
		]);
	});

	test("rust: linux/macos x86_64+aarch64, windows x86_64", () => {
		expect(rustSupportedPlatforms()).toEqual([
			{ os: "linux", arch: "x86_64" },
			{ os: "linux", arch: "aarch64" },
			{ os: "macos", arch: "x86_64" },
			{ os: "macos", arch: "aarch64" },
			{ os: "windows", arch: "x86_64" },
		]);
	});
});
