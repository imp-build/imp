import { productFor } from "imp:core";
import { RUST_BUILD_CACHE } from "//rules/rust/products";
import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetKacheToolchainStateForTest,
	defaultKacheToolchain,
	defaultKacheToolchainVersion,
	installKacheToolchain,
	kacheCacheKey,
	kacheDataCacheKey,
	kacheBin,
	kacheDataDir,
	kacheGraphTool,
	kacheTool,
	kacheToolchain,
} from "//rules/rust/kache/toolchain";

function withKacheHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetKacheToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetKacheToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

async function withKacheConfig(config, fn) {
	const original = globalThis.__host_configuration;
	globalThis.__host_configuration = (namespace) =>
		namespace === "kache" ? JSON.stringify(config) : original(namespace);
	try {
		return await fn();
	} finally {
		globalThis.__host_configuration = original;
	}
}

describe("kache toolchain", () => {
	test("declares a default kache toolchain", () => {
		return withKacheHost((host) => {
			const toolchain = kacheToolchain("0.11.0", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("0.11.0");
			expect(
				kacheCacheKey(toolchain.attrs.version, {
					os: "linux",
					arch: "x86_64",
				}),
			).toBe("0.11.0/linux-x86_64");
			expect(defaultKacheToolchainVersion()).toBe("0.11.0");
			expect(defaultKacheToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "kache-toolchains",
				),
			).toBe(true);
		});
	});

	test("installKacheToolchain publishes a local toolchain into the named cache", async () => {
		await withKacheHost(async (host) => {
			const key = kacheCacheKey("0.11.0", { os: "linux", arch: "x86_64" });

			expect(installKacheToolchain("0.11.0", "/tmp/kache-0.11.0")).toBe(
				"/cache/kache-toolchains/0.11.0/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "kache-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/kache-0.11.0",
				),
			).toBe(true);
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withKacheHost(async (host) => {
			const key = kacheCacheKey("0.11.0", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/rust/kache/kache.lock",
				JSON.stringify({
					tool: "kache",
					versions: {
						"0.11.0": {
							"linux/x86_64": {
								url: "https://locked.example/kache-x86_64-unknown-linux-musl.tar.gz",
								artifact: "kache-x86_64-unknown-linux-musl.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			kacheToolchain("0.11.0", { default: true });

			expect(await kacheBin("0.11.0")).toBe(
				"/cache/kache-toolchains/0.11.0/linux-x86_64/kache",
			);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/kache-x86_64-unknown-linux-musl.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.outputs[0].namedCache.name).toBe("kache-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("describes the named-cache-backed kache tool", async () => {
		await withKacheHost(async () => {
			kacheToolchain("0.11.0", { default: true, unverified: true });
			const tool = await kacheTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("kache");
			expect(tool.cache).toBe("kache-toolchains");
			expect(tool.key).toBe("0.11.0/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});

	test("seeds the kache data directory into its named cache", async () => {
		await withKacheHost(async (host) => {
			kacheToolchain("0.11.0", { default: true });

			const first = await kacheDataDir();
			expect(first).toBe("/cache/kache-data/linux-x86_64");
			expect(host.runs.length).toBe(1);
			expect(host.runs[0].outputs[0].namedCache.name).toBe("kache-data");
			expect(host.runs[0].outputs[0].namedCache.key).toBe("linux-x86_64");

			// Same seed task, so the same directory. Re-running it is harmless:
			// a named-cache slot is immutable by key, so the accumulated object
			// cache survives (crates/imp-store/src/cache.rs).
			expect(await kacheDataDir()).toBe(first);
		});
	});

	test("registers a rust-build-cache product exposing RUSTC_WRAPPER/KACHE_CACHE_DIR and tools", async () => {
		await withKacheHost(async (host) => {
			const toolchain = kacheToolchain("0.11.0", { unverified: true });

			const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);

			expect(await wrapper.env()).toEqual([
				"KACHE_CACHE_DIR=/cache/kache-data/linux-x86_64",
				"RUSTC_WRAPPER=kache",
				"KACHE_MAX_SIZE=4GiB",
				"KACHE_CACHE_EXECUTABLES=0",
				"KACHE_LOCAL_ONLY=1",
				"CARGO_INCREMENTAL=0",
			]);
			const tools = await wrapper.tools();
			expect(tools.some((t) => t.name === "kache")).toBe(true);
			expect(wrapper.scriptPreamble()).toBe(
				'export KACHE_BASE_DIR="$imp_sandbox_root"; ',
			);
		});
	});

	test("kacheConfig enables executable caching for both client and daemon", async () => {
		await withKacheHost(async (host) => {
			const toolchain = kacheToolchain("0.11.0", { unverified: true });

			await withKacheConfig({ cacheExecutables: true }, async () => {
				const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);
				const clientEnv = await wrapper.env();
				expect(clientEnv).toContain("KACHE_CACHE_EXECUTABLES=1");

				const [, opts] = host.calls
					.find((call) => call[0] === "workerStart")
					.slice(1);
				expect(opts.env).toContain("KACHE_CACHE_EXECUTABLES=1");
			});
		});
	});

	test("cacheSize opts into a custom KACHE_MAX_SIZE on both the client and daemon env", async () => {
		await withKacheHost(async (host) => {
			installKacheToolchain("0.11.0", "/tmp/kache-0.11.0");
			const toolchain = kacheToolchain("0.11.0", {
				cacheSize: "1GiB",
				unverified: true,
			});

			const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);
			const clientEnv = await wrapper.env();

			// Unlike sccache's cache-size cap (server-only — each individual
			// compile doesn't need it), kache's own docs describe
			// size-pressure GC as triggered by each client wrapper
			// invocation, so KACHE_MAX_SIZE has to be in the client-facing
			// env too.
			expect(clientEnv).toContain("KACHE_MAX_SIZE=1GiB");

			const [, opts] = host.calls
				.find((call) => call[0] === "workerStart")
				.slice(1);
			// The daemon is a singleton per workspace: whichever caller starts
			// it first fixes its env for the process's lifetime, so the
			// configured limit must reach the daemon's own start env too, not
			// just the client-facing one above.
			expect(opts.env).toContain("KACHE_MAX_SIZE=1GiB");
			expect(opts.env).toContain("KACHE_LOCAL_ONLY=1");
		});
	});

	test("env() starts the kache daemon via the host worker registry", async () => {
		await withKacheHost(async (host) => {
			const toolchain = kacheToolchain("0.11.0", { unverified: true });

			const wrapper = await productFor(toolchain, RUST_BUILD_CACHE);
			await wrapper.env();

			const [name, opts] = host.calls
				.find((call) => call[0] === "workerStart")
				.slice(1);
			expect(name).toBe("kache");
			expect(opts.argv.some((arg) => arg.endsWith("/kache"))).toBe(true);
			expect(opts.argv).toContain("daemon");
			expect(opts.argv).toContain("run");
			expect(opts.healthCheckArgv).toContain("daemon");
			expect(opts.healthCheckArgv).toContain("status");
			expect(opts.env.some((e) => e.startsWith("KACHE_CACHE_DIR="))).toBe(true);
			expect(opts.env).toContain("KACHE_MAX_SIZE=4GiB");
			expect(opts.env).toContain("KACHE_CACHE_EXECUTABLES=0");
			expect(opts.env).toContain("KACHE_LOCAL_ONLY=1");
		});
	});

	test("namedCache details callback returns null when neither cache is seeded yet", async () => {
		await withKacheHost(async (host) => {
			kacheToolchain("0.11.0", { default: true });

			const details = host.namedCacheDetails.get("kache-data");
			expect(await details()).toBe(null);
			expect(host.runs.length).toBe(0);
		});
	});

	test("declares a graph-native kache tool without touching the host run()", () => {
		return withKacheHost((host) => {
			kacheToolchain("0.11.0", { default: true });
			const tool = kacheGraphTool("0.11.0");

			expect(tool.__imp_graph_handle).toBe(true);
			// Building the graph is pure node construction — nothing executes
			// until a workflow resolves the task, matching Odin's precedent.
			expect(host.runs.length).toBe(0);
		});
	});

	test("namedCache details callback starts the daemon, then shells out to kache stats once both caches are seeded", async () => {
		await withKacheHost(async (host) => {
			const toolKey = kacheCacheKey("0.11.0", {
				os: "linux",
				arch: "x86_64",
			});
			const dataKey = kacheDataCacheKey({ os: "linux", arch: "x86_64" });
			host.install(
				"kache-toolchains",
				toolKey,
				"/cache/kache-toolchains/0.11.0/linux-x86_64",
			);
			host.install("kache-data", dataKey, "/cache/kache-data/linux-x86_64");
			host.setRunStdout("kache stats", "Compile requests  10\nCache hits  8\n");

			kacheToolchain("0.11.0", { default: true });

			const details = host.namedCacheDetails.get("kache-data");
			const result = await details();

			expect(result).toBe("Compile requests  10\nCache hits  8");
			// Requires the daemon running (see toolchain.js's details
			// callback doc comment) — assert it's started before stats runs,
			// and that it carries the configured limit even when this is the
			// first caller to spawn the (singleton) daemon.
			expect(
				host.calls.some(
					(call) =>
						call[0] === "workerStart" &&
						call[1] === "kache" &&
						call[2].argv.some((arg) => arg.endsWith("/kache")) &&
						call[2].env.includes("KACHE_MAX_SIZE=4GiB"),
				),
			).toBe(true);
			expect(host.runs.length).toBe(1);
			expect(host.runs[0].argv).toEqual([
				"/cache/kache-toolchains/0.11.0/linux-x86_64/kache",
				"stats",
			]);
			expect(host.runs[0].env).toContain(
				"KACHE_CACHE_DIR=/cache/kache-data/linux-x86_64",
			);
			expect(host.runs[0].impure).toBe(true);
			expect(host.runs[0].sandbox).toBe(false);
		});
	});
});
