import { describe, expect, test } from "//rules/imp/test";
import {
	Toolchain,
	TOOLCHAIN,
	productFor,
	toolName,
	__resetToolchainDefaultsForTest,
} from "imp:core";

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
