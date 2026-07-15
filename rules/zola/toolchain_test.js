import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetZolaToolchainStateForTest,
	acquireZolaToolchain,
	defaultZolaToolchain,
	defaultZolaToolchainVersion,
	installZolaToolchain,
	zolaBin,
	zolaArtifactName,
	zolaCacheKey,
	zolaDownloadUrl,
	zolaTool,
	zolaToolchain,
} from "//rules/zola/toolchain";

function withZolaHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetZolaToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetZolaToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

describe("zola toolchain", () => {
	test("builds artifact name / download URL per platform", () => {
		expect(zolaArtifactName("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(zolaArtifactName("0.22.1", { os: "macos", arch: "aarch64" })).toBe(
			"zola-v0.22.1-aarch64-apple-darwin.tar.gz",
		);
		expect(zolaArtifactName("0.22.1", { os: "windows", arch: "x86_64" })).toBe(
			"zola-v0.22.1-x86_64-pc-windows-msvc.zip",
		);
		expect(zolaDownloadUrl("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"https://github.com/getzola/zola/releases/download/v0.22.1/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
		);
		expect(zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" })).toBe(
			"0.22.1/linux-x86_64",
		);
	});

	test("declares a default zola toolchain", () => {
		return withZolaHost((host) => {
			const toolchain = zolaToolchain("0.22.1", { default: true });

			expect(toolchain.__imp).toBe(true);
			expect(toolchain.attrs.version).toBe("0.22.1");
			expect(defaultZolaToolchainVersion()).toBe("0.22.1");
			expect(defaultZolaToolchain()).toBe(toolchain);
			expect(host.calls[0][0]).toBe("namedCache");
		});
	});

	test("throws when no toolchain has been declared", async () => {
		await withZolaHost(async () => {
			let message = null;

			try {
				await acquireZolaToolchain("0.22.1");
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no zola toolchain declared");
		});
	});

	test("throws when no version is given and no default is set", async () => {
		await withZolaHost(async () => {
			zolaToolchain("0.22.1");
			let message = null;

			try {
				await zolaBin();
			} catch (error) {
				message = error.message;
			}

			expect(message).toContain("no zola toolchain version specified");
		});
	});

	test("installs and acquires a toolchain from the named cache", async () => {
		await withZolaHost(async (host) => {
			const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });

			expect(installZolaToolchain("0.22.1", "/tmp/zola-0.22.1")).toBe(
				"/cache/zola-toolchains/0.22.1/linux-x86_64",
			);
			expect(
				host.calls.some(
					(call) =>
						call[0] === "cachePut" &&
						call[1] === "zola-toolchains" &&
						call[2] === key &&
						call[3] === "/tmp/zola-0.22.1",
				),
			).toBe(true);

			expect(await acquireZolaToolchain("0.22.1")).toBe(
				"/cache/zola-toolchains/0.22.1/linux-x86_64",
			);
			expect(await zolaBin("0.22.1")).toBe(
				"/cache/zola-toolchains/0.22.1/linux-x86_64/zola",
			);
			// Already cached, so no download/extract run() should have happened.
			expect(host.runs.length).toBe(0);
		});
	});

	test("describes the named-cache-backed zola tool", async () => {
		await withZolaHost(async () => {
			installZolaToolchain("0.22.1", "/tmp/zola-0.22.1");
			zolaToolchain("0.22.1", { default: true });
			const tool = await zolaTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("zola");
			expect(tool.cache).toBe("zola-toolchains");
			expect(tool.key).toBe("0.22.1/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});

	test("downloads, verifies, and extracts a toolchain via two sandboxed runs", async () => {
		await withZolaHost(async (host) => {
			const key = zolaCacheKey("0.22.1", { os: "linux", arch: "x86_64" });
			host.addFile(
				"//rules/zola/zola.lock",
				JSON.stringify({
					tool: "zola",
					versions: {
						"0.22.1": {
							"linux/x86_64": {
								url: "https://locked.example/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
								artifact: "zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
								size: 12345,
								sha256: "deadbeef",
							},
						},
					},
				}),
			);

			zolaToolchain("0.22.1", { default: true });
			const path = await acquireZolaToolchain("0.22.1");

			expect(path).toBe("/cache/zola-toolchains/0.22.1/linux-x86_64");
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv[0]).toBe("sh");
			expect(download.argv).toContain(
				"https://locked.example/zola-v0.22.1-x86_64-unknown-linux-gnu.tar.gz",
			);
			expect(download.argv).toContain("deadbeef");
			expect(download.argv[2]).toContain("sha256sum -c -");
			expect(extract.outputs[0].namedCache.name).toBe("zola-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);

			expect(
				host.calls.some(
					(call) => call[0] === "nativeTool" && call[1] === "curl",
				),
			).toBe(true);
		});
	});

	test("throws for an unsupported platform", () => {
		let message = null;
		try {
			zolaArtifactName("0.22.1", { os: "freebsd", arch: "x86_64" });
		} catch (error) {
			message = error.message;
		}
		expect(message).toContain("unsupported zola toolchain platform");
	});
});
