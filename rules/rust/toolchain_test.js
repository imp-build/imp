import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetRustToolchainStateForTest,
	defaultRustToolchain,
	defaultRustToolchainVersion,
	installRustToolchain,
	rustBin,
	rustCacheKey,
	rustGraphToolchain,
	rustGraphToolEnv,
	rustTool,
	rustToolchain,
} from "//rules/rust/toolchain";

function withRustHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

const SEED = { rustupHome: "/tmp/rustup", cargoHome: "/tmp/cargo" };

describe("rust toolchain", () => {
	test("declares a default rust toolchain and both caches", () => {
		return withRustHost((host) => {
			const toolchain = rustToolchain("1.79.0", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("1.79.0");
			expect(
				rustCacheKey(toolchain.attrs.version, { os: "linux", arch: "x86_64" }),
			).toBe("1.79.0/linux-x86_64");
			expect(defaultRustToolchainVersion()).toBe("1.79.0");
			expect(defaultRustToolchain()).toBe(toolchain);
			// Both RUSTUP_HOME and CARGO_HOME caches are declared up front.
			const declared = new Set(
				host.calls
					.filter((call) => call[0] === "namedCache")
					.map((call) => call[1]),
			);
			expect([...declared].sort().join(",")).toBe("cargo-home,rustup-home");
		});
	});

	test("rejects channel versions, requiring an exact pin", () => {
		return withRustHost(() => {
			let message = null;

			try {
				rustToolchain("stable", { default: true });
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("must be an exact version");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withRustHost(async () => {
			rustToolchain("1.79.0");
			let message = null;

			try {
				await rustBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no rust toolchain version specified");
		});
	});

	test("installRustToolchain publishes a local layout into both named caches", async () => {
		await withRustHost(async (host) => {
			const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });

			const seeded = installRustToolchain("1.79.0", SEED);
			expect(seeded.rustupHome).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
			expect(seeded.cargoHome).toBe("/cache/cargo-home/1.79.0/linux-x86_64");
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "rustup-home" &&
						call[2] === key &&
						call[3] === "/tmp/rustup",
				),
			).toBe(true);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "cargo-home" &&
						call[2] === key &&
						call[3] === "/tmp/cargo",
				),
			).toBe(true);
		});
	});

	test("describes the two-cache tool with RUSTUP_HOME/CARGO_HOME mount paths", async () => {
		await withRustHost(async () => {
			rustToolchain("1.79.0", { default: true, unverified: true });
			const tool = await rustTool();

			expect(tool.tools.length).toBe(2);
			const [rustup, cargo] = tool.tools;
			expect(rustup.cache).toBe("rustup-home");
			expect(rustup.binDirs).toEqual([
				"toolchains/1.79.0-x86_64-unknown-linux-gnu/bin",
			]);
			expect(cargo.cache).toBe("cargo-home");
			expect(cargo.binDirs).toEqual(["bin"]);
			expect(tool.rustupHome).toBe(".imp/tools/rustup-home");
			expect(tool.cargoHome).toBe(".imp/tools/cargo-home");
			expect(tool.rustupHomeAbs).toBe("/cache/rustup-home/1.79.0/linux-x86_64");
			expect(tool.cargoHomeAbs).toBe("/cache/cargo-home/1.79.0/linux-x86_64");
			expect(tool.toolchainId).toBe("1.79.0-x86_64-unknown-linux-gnu");
		});
	});

	test("downloads rustup-init verified, then installs into both caches", async () => {
		await withRustHost(async (host) => {
			const key = rustCacheKey("1.79.0", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/rust/rust.lock",
				JSON.stringify({
					tool: "rust",
					versions: {
						"1.79.0": {
							"linux/x86_64": {
								url: "https://locked.example/x86_64-unknown-linux-gnu/rustup-init",
								artifact: "rustup-init",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			rustToolchain("1.79.0", { default: true });

			expect(await rustBin("1.79.0")).toBe(
				"/cache/rustup-home/1.79.0/linux-x86_64/toolchains/1.79.0-x86_64-unknown-linux-gnu/bin/cargo",
			);
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/x86_64-unknown-linux-gnu/rustup-init",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");

			expect(install.argv[0]).toBe("sh");
			expect(install.argv.some((arg) => arg.includes("rustup-init"))).toBe(
				true,
			);

			// The install run wires RUSTUP_HOME/CARGO_HOME from $PWD in-script
			// and pins the toolchain, then commits both directories to their
			// caches.
			const script = install.argv[2];
			expect(script).toContain('RUSTUP_HOME="$PWD/rustup-home"');
			expect(script).toContain('CARGO_HOME="$PWD/cargo-home"');
			expect(script).toContain("--default-toolchain");
			expect(install.argv).toContain("1.79.0");
			// One install action commits both directories; slot order is the
			// task's own, so compare as a set.
			const outCaches = install.outputs
				.map((out) => `${out.namedCache.name}/${out.namedCache.key}`)
				.sort();
			expect(outCaches).toEqual(
				[`rustup-home/${key}`, `cargo-home/${key}`].sort(),
			);
		});
	});

	test("declares a graph-native toolchain with both PATH roots and raw home handles", () => {
		return withRustHost((host) => {
			rustToolchain("1.79.0", { default: true });
			const graph = rustGraphToolchain("1.79.0");

			expect(graph.tool.__imp_graph_handle).toBe(true);
			expect(graph.cargoHomeTool.__imp_graph_handle).toBe(true);
			expect(graph.rustupHome.__imp_graph_handle).toBe(true);
			expect(graph.cargoHome.__imp_graph_handle).toBe(true);
			expect(graph.toolchainId).toBe("1.79.0-x86_64-unknown-linux-gnu");
			expect(Object.isFrozen(graph)).toBe(true);
		});
	});

	test("graph toolchain construction does not touch the host run()", () => {
		return withRustHost((host) => {
			rustToolchain("1.79.0", { default: true });
			rustGraphToolchain("1.79.0");

			// Building the graph is pure node construction — nothing executes
			// until a workflow resolves the task, matching Odin's precedent.
			expect(host.runs.length).toBe(0);
		});
	});

	test("rustGraphToolEnv resolves RUSTUP_HOME/CARGO_HOME through atomic tool mounts in non-kache mode", () => {
		return withRustHost(() => {
			const { env } = rustGraphToolEnv(
				{},
				{},
				{},
				"1.79.0-x86_64-unknown-linux-gnu",
				"1.79.0",
				false,
			);
			expect(env).toEqual([
				"RUSTUP_HOME=.imp/tools/rustup-home",
				"CARGO_HOME=.imp/tools/cargo-home",
			]);
		});
	});

	test("rustGraphToolEnv resolves real absolute named-cache paths when kache is active", () => {
		return withRustHost(() => {
			installRustToolchain("1.79.0", SEED);
			const exec = { path: () => "/unused" };
			const { env } = rustGraphToolEnv(
				exec,
				{},
				{},
				"1.79.0-x86_64-unknown-linux-gnu",
				"1.79.0",
				true,
			);
			expect(env).toEqual([
				"RUSTUP_HOME=/cache/rustup-home/1.79.0/linux-x86_64",
				"CARGO_HOME=/cache/cargo-home/1.79.0/linux-x86_64",
				"PATH=/cache/rustup-home/1.79.0/linux-x86_64/toolchains/1.79.0-x86_64-unknown-linux-gnu/bin:/cache/cargo-home/1.79.0/linux-x86_64/bin",
			]);
		});
	});
});

describe("rust workspace lockfile selection", () => {
	const BUNDLED = "//rules/rust/rust.lock";

	function rustLock(version, sha256) {
		return JSON.stringify({
			tool: "rust",
			versions: {
				[version]: {
					"linux/x86_64": {
						url: "https://locked.example/tool.tar.gz",
						artifact: "tool.tar.gz",
						size: 42,
						sha256,
					},
				},
			},
		});
	}

	const readAddresses = (host) =>
		host.calls.filter((c) => c[0] === "readAddressedFile").map((c) => c[1]);

	test("the bundled lockfile is the default", async () => {
		await withRustHost(async (host) => {
			host.addFile(BUNDLED, rustLock("1.93.0", "cafe"));
			rustToolchain("1.93.0", { default: true });

			await rustBin("1.93.0");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withRustHost(async (host) => {
			host.addFile("//locks/rust.lock", rustLock("1.79.0", "beef"));
			rustToolchain("1.79.0", { default: true, lockfile: "//locks/rust.lock" });

			await rustBin("1.79.0");

			expect(readAddresses(host)).toContain("//locks/rust.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withRustHost(async () => {
			rustToolchain("1.79.0", { default: true, lockfile: "//locks/rust.lock" });
			let message = null;
			try {
				await rustBin("1.79.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/rust.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withRustHost(() => {
			expect(() =>
				rustToolchain("1.79.0", { lockfile: "locks/rust.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withRustHost(async (host) => {
			const toolchain = rustToolchain("1.79.0", {
				default: true,
				lockfile: "//locks/rust.lock",
			});
			await host.resolve(toolchain[GEN_LOCKFILES]);
			expect(host.runs.some((r) => r.display === "write locks/rust.lock")).toBe(
				true,
			);
		});
	});
});
