import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetOdinToolchainStateForTest,
	odinArtifactName,
	odinBin,
	odinCacheKey,
	odinGraphTool,
	odinTool,
	odinToolchain,
} from "//rules/odin/toolchain";

function withOdinHost(fn) {
	return withFakeToolchainHost(async (host) => {
		__resetOdinToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetOdinToolchainStateForTest();
		}
	});
}

describe("Odin graph toolchain", () => {
	test("formats release identity", () => {
		expect(
			odinArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe("odin-linux-amd64-dev-2026-03.tar.gz");
		expect(odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" })).toBe(
			"dev-2026-03/linux-x86_64",
		);
	});

	test("declares verified graph tools", () => {
		expect(
			odinToolchain("dev-2026-03", { default: true }).__imp_graph_handle,
		).toBe(true);
		expect(odinGraphTool("dev-2026-03").__imp_graph_handle).toBe(true);
	});

	test("declares the shared named cache the install task publishes into", () => {
		return withOdinHost((host) => {
			odinToolchain("dev-2026-03", { default: true });

			expect(
				host.calls.some(
					(call) => call[0] === "namedCache" && call[1] === "odin-toolchains",
				),
			).toBe(true);
		});
	});

	test("resolves the odin binary out of the install task's named cache", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true, unverified: true });
			const key = odinCacheKey("dev-2026-03", { os: "linux", arch: "x86_64" });

			expect(await odinBin()).toBe(`/cache/odin-toolchains/${key}/odin`);
			expect(host.runs.length).toBe(2);

			const [download, extract] = host.runs;
			expect(download.argv).toContain(
				"https://github.com/odin-lang/Odin/releases/download/dev-2026-03/odin-linux-amd64-dev-2026-03.tar.gz",
			);
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("odin-toolchains");
			expect(extract.outputs[0].namedCache.key).toBe(key);
		});
	});

	test("describes the named-cache-backed odin tool", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-03", { default: true, unverified: true });
			const tool = await odinTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("odin");
			expect(tool.cache).toBe("odin-toolchains");
			expect(tool.key).toBe("dev-2026-03/linux-x86_64");
			expect(tool.binDirs.join(",")).toBe(".");
		});
	});

	test("cold acquire without a lockfile fails pointing at gen-lockfiles", async () => {
		await withOdinHost(async () => {
			odinToolchain("dev-2026-03", { default: true });
			let message = null;
			try {
				await odinBin();
			} catch (error) {
				message = error.message;
			}
			expect(message).toContain("no lockfile found");
			expect(message).toContain("gen-lockfiles");
		});
	});
});
