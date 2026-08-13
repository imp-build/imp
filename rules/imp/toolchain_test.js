import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	Toolchain,
	TOOLCHAIN,
	output,
	productFor,
	task,
	toolName,
	__resetToolchainDefaultsForTest,
} from "imp:core";
import {
	toolchainBin,
	toolchainDir,
	toolchainToolSpec,
} from "//rules/imp/toolchain";

const ALPHA_TOOL = toolName("toolchain-test-alpha");
const BETA_TOOL = toolName("toolchain-test-beta");

class AlphaToolchain extends Toolchain {
	static kind = "toolchain-test-alpha";
	static tool = ALPHA_TOOL;
	constructor({ version }, opts) {
		super({ kind: AlphaToolchain.kind, attrs: { version } }, opts);
	}

	bin() {
		return `/alpha/${this.attrs.version}/bin/alpha`;
	}
}

class BetaToolchain extends Toolchain {
	static kind = "toolchain-test-beta";
	static tool = BETA_TOOL;
	constructor({ version }, opts) {
		super({ kind: BetaToolchain.kind, attrs: { version } }, opts);
	}
}

describe("Toolchain", () => {
	test("defaults are tracked per subclass", () => {
		__resetToolchainDefaultsForTest();
		const alpha = new AlphaToolchain({ version: "1.0.0" }, { default: true });
		new BetaToolchain({ version: "9.9.9" });

		expect(AlphaToolchain.default()).toBe(alpha);
		expect(AlphaToolchain.defaultVersion()).toBe("1.0.0");
		// Beta never declared a default; alpha's must not leak over.
		expect(BetaToolchain.default()).toBe(null);
		expect(BetaToolchain.defaultVersion()).toBe(null);
	});

	test("resolveVersion prefers an explicit version over the default", () => {
		__resetToolchainDefaultsForTest();
		expect(AlphaToolchain.resolveVersion("2.0.0")).toBe("2.0.0");
		expect(AlphaToolchain.resolveVersion(undefined)).toBe(null);

		new AlphaToolchain({ version: "1.0.0" }, { default: true });
		expect(AlphaToolchain.resolveVersion(undefined)).toBe("1.0.0");
		expect(AlphaToolchain.resolveVersion("2.0.0")).toBe("2.0.0");
	});

	test("clearDefault and the reset hook drop defaults", () => {
		__resetToolchainDefaultsForTest();
		new AlphaToolchain({ version: "1.0.0" }, { default: true });
		AlphaToolchain.clearDefault();
		expect(AlphaToolchain.default()).toBe(null);

		new AlphaToolchain({ version: "1.1.0" }, { default: true });
		__resetToolchainDefaultsForTest();
		expect(AlphaToolchain.default()).toBe(null);
	});

	test("construction registers the kind's toolchain product backed by bin()", async () => {
		const handle = new AlphaToolchain({ version: "3.0.0" });
		expect(await productFor(handle, TOOLCHAIN)).toBe("/alpha/3.0.0/bin/alpha");
	});

	test("bin() is abstract by default", () => {
		const handle = new BetaToolchain({ version: "1.0.0" });
		expect(() => handle.bin()).toThrow("must implement bin()");
	});

	test("subclasses must declare a tool token", () => {
		class NoTool extends Toolchain {
			static kind = "toolchain-test-no-tool";
		}
		expect(() => new NoTool({ kind: NoTool.kind, attrs: {} })).toThrow(
			"must declare 'static tool",
		);
	});
});

const DEMO_CACHE = "toolchain-helper-demo";

describe("installed toolchain resolution", () => {
	let installs = 0;

	// The shape every migrated toolchain declares: one task that installs the
	// toolchain and publishes the result into a named cache, so callers
	// outside a sandbox can read it back at an absolute path.
	function installTask(key, { publish = true } = {}) {
		return task({
			display: `install demo ${key}`,
			inputs: { key },
			outputs: { directory: output.artifact() },
			async run(exec, inputs) {
				installs += 1;
				const result = await exec.action({
					argv: ["install", inputs.key],
					outputs: {
						directory: publish
							? output.directory("demo", {
									namedCache: { name: DEMO_CACHE, key: inputs.key },
								})
							: output.directory("demo"),
					},
				});
				return { directory: result.outputs.directory };
			},
		}).outputs.directory;
	}

	test("toolchainDir runs the install once and returns the cache path", async () => {
		await withFakeToolchainHost(async (host) => {
			installs = 0;
			const handle = installTask("1.0/linux-x86_64");

			const dir = await toolchainDir(handle, {
				name: DEMO_CACHE,
				key: "1.0/linux-x86_64",
			});

			expect(dir).toBe(`/cache/${DEMO_CACHE}/1.0/linux-x86_64`);
			expect(installs).toBe(1);
			expect(host.runs.length).toBe(1);
		});
	});

	test("toolchainBin joins the executable onto the installed directory", async () => {
		await withFakeToolchainHost(async () => {
			const handle = installTask("2.0/linux-x86_64");
			const cache = { name: DEMO_CACHE, key: "2.0/linux-x86_64" };

			// An archive that puts its binaries in bin/, and one that puts them
			// at the root — the two layouts every toolchain has.
			expect(
				await toolchainBin(handle, { ...cache, subDir: "bin", exe: "demo" }),
			).toBe(`/cache/${DEMO_CACHE}/2.0/linux-x86_64/bin/demo`);
			expect(await toolchainBin(handle, { ...cache, exe: "demo.exe" })).toBe(
				`/cache/${DEMO_CACHE}/2.0/linux-x86_64/demo.exe`,
			);
		});
	});

	test("toolchainToolSpec returns a run({ tools }) entry for the install", async () => {
		await withFakeToolchainHost(async () => {
			const handle = installTask("3.0/linux-x86_64");

			const spec = await toolchainToolSpec(handle, {
				toolName: "demo",
				name: DEMO_CACHE,
				key: "3.0/linux-x86_64",
				binDirs: ["bin"],
			});

			expect(spec).toEqual({
				kind: "tool",
				name: "demo",
				cache: DEMO_CACHE,
				key: "3.0/linux-x86_64",
				binDirs: ["bin"],
			});
		});
	});

	// The likely mistake when adding a toolchain: the install task extracts
	// the archive but never publishes it, so nothing outside the sandbox can
	// reach the result. Say so, rather than returning a broken path.
	test("an install that publishes no named cache fails by name", async () => {
		await withFakeToolchainHost(async () => {
			const handle = installTask("4.0/linux-x86_64", { publish: false });
			let message = "";
			try {
				await toolchainDir(handle, {
					name: DEMO_CACHE,
					key: "4.0/linux-x86_64",
				});
			} catch (error) {
				message = String(error.message || error);
			}
			expect(message).toContain(`'${DEMO_CACHE}/4.0/linux-x86_64' is empty`);
			expect(message).toContain("namedCache");
		});
	});

	// The full chain `imp @tool` walks: productFor(handle, TOOLCHAIN) ->
	// bin() -> the graph install -> an absolute path.
	test("a Toolchain whose bin() resolves the graph answers the toolchain product", async () => {
		await withFakeToolchainHost(async () => {
			const handle = installTask("5.0/linux-x86_64");

			class GraphToolchain extends Toolchain {
				static kind = "toolchain-test-graph";
				static tool = toolName("toolchain-test-graph");
				constructor({ version }, opts) {
					super({ kind: GraphToolchain.kind, attrs: { version } }, opts);
				}

				bin() {
					return toolchainBin(handle, {
						name: DEMO_CACHE,
						key: "5.0/linux-x86_64",
						subDir: "bin",
						exe: "demo",
					});
				}
			}

			const toolchain = new GraphToolchain({ version: "5.0" });
			expect(await productFor(toolchain, TOOLCHAIN)).toBe(
				`/cache/${DEMO_CACHE}/5.0/linux-x86_64/bin/demo`,
			);
		});
	});
});
