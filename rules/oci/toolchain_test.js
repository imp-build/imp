import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { GEN_LOCKFILES } from "//rules/workflows/lockfiles";
import {
	__resetCraneToolchainStateForTest,
	craneArtifactName,
	craneBin,
	craneCacheKey,
	craneDownloadUrl,
	craneGenLockfiles,
	craneGraphTool,
	craneSupportedPlatforms,
	craneToolchain,
	defaultCraneToolchain,
} from "//rules/oci/toolchain";

function withCraneHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetCraneToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetCraneToolchainStateForTest();
		}
	});
}

test("Crane release helpers are platform-specific", () => {
	const plat = { os: "linux", arch: "x86_64" };
	expect(craneArtifactName("0.20.6", plat)).toBe(
		"go-containerregistry_Linux_x86_64.tar.gz",
	);
	expect(craneDownloadUrl("0.20.6", plat)).toContain("/v0.20.6/");
	expect(craneCacheKey("0.20.6", plat)).toBe("0.20.6/linux-x86_64");
	expect(craneSupportedPlatforms().length).toBe(5);
});

test("Crane declarations return graph tools", () => {
	const tool = craneToolchain("0.20.6", { default: true });
	expect(tool.__imp_graph_handle).toBe(true);
	expect(defaultCraneToolchain()).toBe(tool);
});

describe("crane workspace lockfile selection", () => {
	const BUNDLED = "//rules/oci/crane.lock";

	function craneLock(version, sha256) {
		return JSON.stringify({
			tool: "crane",
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

	test("the graph crane tool is a named-cache mount, not a staged tree", async () => {
		await withCraneHost(async (host) => {
			craneToolchain("0.20.6", { default: true, unverified: true });
			const key = craneCacheKey("0.20.6", { os: "linux", arch: "x86_64" });

			const binding = await host.resolve(craneGraphTool("0.20.6"));

			expect(binding.type).toBe("tool");
			expect(binding.mountName).toBe("crane");
			expect(binding.cache).toBe("crane-toolchains");
			expect(binding.key).toBe(key);
			expect(binding.binDirs.join(",")).toBe(".");
		});
	});

	test("the bundled lockfile is the default", async () => {
		await withCraneHost(async (host) => {
			host.addFile(BUNDLED, craneLock("0.20.6", "cafe"));
			craneToolchain("0.20.6", { default: true });

			await craneBin("0.20.6");

			expect(readAddresses(host)).toContain(BUNDLED);
			expect(host.runs[0].argv).toContain("cafe");
		});
	});

	test("a custom lockfile address is consulted instead of the bundled one", async () => {
		await withCraneHost(async (host) => {
			host.addFile("//locks/crane.lock", craneLock("0.19.0", "beef"));
			craneToolchain("0.19.0", {
				default: true,
				lockfile: "//locks/crane.lock",
			});

			await craneBin("0.19.0");

			expect(readAddresses(host)).toContain("//locks/crane.lock");
			expect(readAddresses(host).includes(BUNDLED)).toBe(false);
			expect(host.runs[0].argv).toContain("beef");
		});
	});

	test("a missing selected lockfile fails naming it and gen-lockfiles", async () => {
		await withCraneHost(async () => {
			craneToolchain("0.19.0", {
				default: true,
				lockfile: "//locks/crane.lock",
			});
			let message = null;
			try {
				await craneBin("0.19.0");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("//locks/crane.lock");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("a malformed lockfile address fails at declaration", () => {
		return withCraneHost(() => {
			expect(() =>
				craneToolchain("0.19.0", { lockfile: "locks/crane.lock" }),
			).toThrow("must start with //");
		});
	});

	test("gen-lockfiles writes the address declared on the toolchain", async () => {
		await withCraneHost(async (host) => {
			craneToolchain("0.19.0", {
				default: true,
				lockfile: "//locks/crane.lock",
			});
			await host.resolve(craneGenLockfiles("0.19.0")[GEN_LOCKFILES]);
			expect(
				host.runs.some((r) => r.display === "write locks/crane.lock"),
			).toBe(true);
		});
	});

	test("gen-lockfiles takes an explicit lockfile override", async () => {
		await withCraneHost(async (host) => {
			craneToolchain("0.19.0", {
				default: true,
				lockfile: "//locks/crane.lock",
			});
			await host.resolve(
				craneGenLockfiles("0.19.0", { lockfile: "//other/crane.lock" })[
					GEN_LOCKFILES
				],
			);
			expect(
				host.runs.some((r) => r.display === "write other/crane.lock"),
			).toBe(true);
		});
	});
});
