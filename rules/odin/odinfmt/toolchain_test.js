import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	__resetOdinToolchainStateForTest,
	odinToolchain,
} from "//rules/odin/toolchain";
import {
	__resetOdinfmtToolchainStateForTest,
	acquireOdinfmt,
	odinfmtArtifactName,
	odinfmtBin,
	odinfmtDownloadUrl,
	odinfmtTool,
	odinfmtToolchain,
	olsTriple,
	OdinfmtToolchain,
} from "//rules/odin/odinfmt/toolchain";

function withOdinHost(platOrFn, maybeFn) {
	const fn = typeof platOrFn === "function" ? platOrFn : maybeFn;
	const run = async (host) => {
		__resetOdinToolchainStateForTest();
		__resetOdinfmtToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetOdinfmtToolchainStateForTest();
			__resetOdinToolchainStateForTest();
		}
	};
	return typeof platOrFn === "function"
		? withFakeToolchainHost(run)
		: withFakeToolchainHost(platOrFn, run);
}

function lockFixture(version, plat, entry) {
	return JSON.stringify({
		tool: "odinfmt",
		versions: {
			[version]: {
				[`${plat.os}/${plat.arch}`]: entry,
			},
		},
	});
}

describe("odinfmt toolchain", () => {
	test("maps platforms to OLS release triples", () => {
		expect(olsTriple({ os: "linux", arch: "x86_64" })).toBe(
			"x86_64-unknown-linux-gnu",
		);
		expect(olsTriple({ os: "linux", arch: "aarch64" })).toBe(
			"arm64-unknown-linux-gnu",
		);
		expect(olsTriple({ os: "macos", arch: "aarch64" })).toBe("arm64-darwin");
		expect(olsTriple({ os: "windows", arch: "x86_64" })).toBe(
			"x86_64-pc-windows-msvc",
		);
		expect(() => olsTriple({ os: "freebsd", arch: "x86_64" })).toThrow();
	});

	test("formats release artifact names / download URLs", () => {
		expect(
			odinfmtArtifactName("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe("ols-x86_64-unknown-linux-gnu.zip");
		expect(
			odinfmtDownloadUrl("dev-2026-03", { os: "linux", arch: "x86_64" }),
		).toBe(
			"https://github.com/DanielGavin/ols/releases/download/dev-2026-03/ols-x86_64-unknown-linux-gnu.zip",
		);
	});

	test("uses the default Odin version for odinfmt binary lookup", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			host.addFile(
				"//rules/odin/odinfmt/odinfmt.lock",
				lockFixture(
					"dev-2026-03",
					{ os: "linux", arch: "x86_64" },
					{
						url: "https://locked.example/ols-x86_64-unknown-linux-gnu.zip",
						artifact: "ols-x86_64-unknown-linux-gnu.zip",
						size: 1,
						sha256: "deadbeef",
					},
				),
			);

			expect(await odinfmtBin()).toBe(
				"/cache/odinfmt-toolchains/dev-2026-03/linux-x86_64/odinfmt-x86_64-unknown-linux-gnu",
			);
		});
	});

	test("installs a missing odinfmt from the OLS release zip via two sandboxed runs", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			host.addFile(
				"//rules/odin/odinfmt/odinfmt.lock",
				lockFixture(
					"dev-2026-03",
					{ os: "linux", arch: "x86_64" },
					{
						url: "https://locked.example/ols-x86_64-unknown-linux-gnu.zip",
						artifact: "ols-x86_64-unknown-linux-gnu.zip",
						size: 1,
						sha256: "deadbeef",
					},
				),
			);

			const dir = await acquireOdinfmt("dev-2026-03");

			expect(dir).toBe("/cache/odinfmt-toolchains/dev-2026-03/linux-x86_64");
			expect(host.runs.length).toBe(2);
			const [download, extract] = host.runs;
			expect(download.argv).toContain(
				"https://locked.example/ols-x86_64-unknown-linux-gnu.zip",
			);
			expect(download.argv).toContain("deadbeef");
			expect(extract.outputs[0].namedCache.name).toBe("odinfmt-toolchains");
		});
	});

	test("describes the named-cache-backed odinfmt tool", async () => {
		await withOdinHost(async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			const key = "dev-2026-03/linux-x86_64";
			host.install(
				"odinfmt-toolchains",
				key,
				"/cache/odinfmt-toolchains/" + key,
			);

			const { tool, command } = await odinfmtTool();

			expect(tool.kind).toBe("tool");
			expect(tool.name).toBe("odinfmt");
			expect(tool.cache).toBe("odinfmt-toolchains");
			expect(tool.key).toBe(key);
			expect(tool.binDirs.join(",")).toBe(".");
			expect(command).toBe("odinfmt-x86_64-unknown-linux-gnu");
		});
	});

	test("suffixes the odinfmt command with .exe on windows", async () => {
		await withOdinHost({ os: "windows", arch: "x86_64" }, async (host) => {
			odinToolchain("dev-2026-03", { default: true });
			const key = "dev-2026-03/windows-x86_64";
			host.install(
				"odinfmt-toolchains",
				key,
				"/cache/odinfmt-toolchains/" + key,
			);

			expect((await odinfmtTool()).command).toBe(
				"odinfmt-x86_64-pc-windows-msvc.exe",
			);
		});
	});

	test("odinfmtToolchain() declares a toolchain-shaped target", () => {
		return withOdinHost(() => {
			const handle = odinfmtToolchain();

			expect(handle instanceof OdinfmtToolchain).toBe(true);
			expect(handle.kind).toBe("odinfmt-toolchain");
			expect(handle.attrs.version).toBe(null);
		});
	});

	test("odinfmtToolchain(version) records the explicit version", () => {
		return withOdinHost(() => {
			const handle = odinfmtToolchain("dev-2026-04");

			expect(handle.attrs.version).toBe("dev-2026-04");
		});
	});
});
