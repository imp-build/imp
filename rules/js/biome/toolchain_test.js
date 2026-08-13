import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetBiomeToolchainStateForTest,
	biomeArtifactName,
	biomeBin,
	biomeCacheKey,
	biomeDownloadUrl,
	biomeToolchain,
	defaultBiomeToolchain,
	defaultBiomeToolchainVersion,
	installBiomeToolchain,
} from "//rules/js/biome/toolchain";

function withBiomeHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetBiomeToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetBiomeToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

// The graph install always runs its download task, so any test that reaches
// bin() needs a lock entry — the legacy acquire path used to short-circuit on
// a warm named cache and never look.
function seedLockfile(host) {
	host.addFile(
		"//rules/js/biome/biome-toolchain.lock",
		JSON.stringify({
			tool: "biome-toolchain",
			versions: {
				"2.5.4": {
					"linux/x86_64": {
						url: "https://locked.example/biome-linux-x64",
						artifact: "biome-linux-x64",
						size: 12345,
						sha256: "deadbeef",
					},
				},
			},
		}),
	);
}

describe("biome toolchain", () => {
	test("declares a default biome toolchain", () => {
		return withBiomeHost((host) => {
			const toolchain = biomeToolchain("2.5.4", { default: true });

			expect(toolchain.__imp_graph_handle).toBe(true);
			expect(defaultBiomeToolchainVersion()).toBe("2.5.4");
			expect(defaultBiomeToolchain()).toBe(toolchain);
			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "biome-toolchains",
				),
			).toBe(true);
		});
	});

	test("computes artifact name and download URL per platform", () => {
		return withBiomeHost(() => {
			const plat = { os: "linux", arch: "x86_64" };
			expect(biomeArtifactName(plat)).toBe("biome-linux-x64");
			expect(biomeDownloadUrl("2.5.4", plat)).toBe(
				"https://github.com/biomejs/biome/releases/download/@biomejs/biome@2.5.4/biome-linux-x64",
			);
			expect(biomeCacheKey("2.5.4", plat)).toBe("2.5.4/linux-x86_64");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withBiomeHost(async () => {
			biomeToolchain("2.5.4");
			let message = null;
			try {
				await biomeBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no biome toolchain version specified");
		});
	});

	test("installBiomeToolchain publishes a local build into the named cache", async () => {
		await withBiomeHost(async () => {
			const key = biomeCacheKey("2.5.4", { os: "linux", arch: "x86_64" });

			expect(installBiomeToolchain("2.5.4", "/tmp/biome")).toBe(
				`/cache/biome-toolchains/${key}`,
			);
		});
	});

	test("downloads and installs biome via two sandboxed runs, with no archive extraction", async () => {
		await withBiomeHost(async (host) => {
			seedLockfile(host);
			biomeToolchain("2.5.4", { default: true });
			const key = biomeCacheKey("2.5.4", { os: "linux", arch: "x86_64" });

			expect(await biomeBin("2.5.4")).toBe(
				`/cache/biome-toolchains/${key}/biome`,
			);
			expect(host.runs.length).toBe(2);

			const [download, install] = host.runs;
			// The lock entry pins both the URL and the expected digest.
			expect(download.argv).toContain("https://locked.example/biome-linux-x64");
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			// No archive to extract — the install script just cp's and chmod's.
			expect(install.argv[2]).toContain("cp ");
			expect(install.argv[2]).toContain("chmod +x");
			expect(install.argv[2]).not.toContain("--strip-components");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withBiomeHost(async () => {
			biomeToolchain("2.5.4", { default: true });
			let message = null;
			try {
				await biomeBin("2.5.4");
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});

	test("unverified: true downloads without a sha check", async () => {
		await withBiomeHost(async (host) => {
			biomeToolchain("2.5.4", { default: true, unverified: true });
			await biomeBin("2.5.4");

			expect(host.runs.length).toBe(2);
			const [download] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/biomejs/biome/releases/download/@biomejs/biome@2.5.4/biome-linux-x64",
			);
			expect(download.argv[2]).not.toContain("sha256sum");
		});
	});

	test("uses the windows artifact naming and skips chmod", () => {
		return withBiomeHost({ os: "windows", arch: "x86_64" }, () => {
			const plat = { os: "windows", arch: "x86_64" };
			expect(biomeArtifactName(plat)).toBe("biome-win32-x64.exe");
		});
	});

	test("uses macos darwin artifact naming", () => {
		return withBiomeHost({ os: "macos", arch: "aarch64" }, () => {
			const plat = { os: "macos", arch: "aarch64" };
			expect(biomeArtifactName(plat)).toBe("biome-darwin-arm64");
		});
	});
});
