import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import {
	parseTestBinaries,
	rustTestBuild,
	rustTestRun,
	RustTest,
} from "//rules/rust/test";
import { CargoPackage } from "//rules/rust/cargo_package";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";
import {
	gccToolchain,
	__resetGccToolchainStateForTest,
} from "//rules/c/gcc/toolchain";
import { nativeTool } from "//rules/imp/native_tool";

function withRustHost(fn) {
	const run = async (host) => {
		__resetRustToolchainStateForTest();
		__resetGccToolchainStateForTest();
		try {
			return await fn(host);
		} finally {
			__resetRustToolchainStateForTest();
			__resetGccToolchainStateForTest();
		}
	};
	return withFakeToolchainHost(run);
}

describe("rust test fan-out", () => {
	test("parseTestBinaries keeps only compiled test-profile artifacts and rebases their path onto buildDir", () => {
		const buildDir = "build/rust/root";
		const stdout = [
			JSON.stringify({
				reason: "compiler-artifact",
				target: { name: "hello", kind: ["bin"] },
				profile: { test: true },
				executable: `/sandbox/xyz/${buildDir}/debug/deps/hello-abc123`,
			}),
			// A non-test build artifact (e.g. the plain `cargo build` of the bin
			// itself) must be ignored even though it also has an `executable`.
			JSON.stringify({
				reason: "compiler-artifact",
				target: { name: "hello", kind: ["bin"] },
				profile: { test: false },
				executable: `/sandbox/xyz/${buildDir}/debug/hello`,
			}),
			// Non-artifact messages (build scripts, warnings) must be ignored.
			JSON.stringify({ reason: "compiler-message" }),
			"",
			JSON.stringify({
				reason: "compiler-artifact",
				target: { name: "integration", kind: ["test"] },
				profile: { test: true },
				executable: `/sandbox/xyz/${buildDir}/debug/deps/integration-def456`,
			}),
		].join("\n");

		const binaries = parseTestBinaries(stdout, buildDir);

		expect(binaries.length).toBe(2);
		expect(binaries[0].name).toBe("hello");
		expect(binaries[0].kind).toBe("bin");
		expect(binaries[0].executable).toBe(`${buildDir}/debug/deps/hello-abc123`);
		expect(binaries[1].name).toBe("integration");
		expect(binaries[1].kind).toBe("test");
		expect(binaries[1].executable).toBe(
			`${buildDir}/debug/deps/integration-def456`,
		);
	});

	test("parseTestBinaries tolerates malformed JSON lines", () => {
		const buildDir = "build/rust/root";
		const stdout =
			"not json\n" +
			JSON.stringify({
				reason: "compiler-artifact",
				target: { name: "hello", kind: ["bin"] },
				profile: { test: true },
				executable: `${buildDir}/debug/deps/hello-abc123`,
			});

		const binaries = parseTestBinaries(stdout, buildDir);
		expect(binaries.length).toBe(1);
	});

	// The fake host's run() always returns empty stdout unless a test
	// registers one via host.setRunStdout(display, stdout) — rustTestBuild
	// now parses buildTestBinaries' stdout to find its own binary (see
	// //rules/rust/test), so every test below has to supply a plausible
	// compiler-artifact line for the name/kind it constructs RustTest with.
	function fakeCompilerArtifactStdout(buildDir, name, kind, executable) {
		return JSON.stringify({
			reason: "compiler-artifact",
			target: { name, kind: [kind] },
			profile: { test: true },
			executable: `/sandbox/xyz/${buildDir}/${executable}`,
		});
	}

	test("rustTestBuild builds via `cargo test --no-run --message-format=json`", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const cargoPackage = new CargoPackage({ path: "rules/rust/example" });
			host.setRunStdout(
				"cargo test --no-run rules/rust/example",
				fakeCompilerArtifactStdout(
					"build/rust/rules/rust/example",
					"hello",
					"bin",
					"debug/deps/hello-abc123",
				),
			);
			const rustTest = new RustTest({
				cargoPackage,
				path: "rules/rust/example",
				testName: "hello",
				testKind: "bin",
			});

			await rustTestBuild(rustTest);

			const buildRun = host.runs[host.runs.length - 1];
			expect(buildRun.argv[0]).toBe("sh");
			expect(buildRun.argv[2]).toContain("--no-run");
			expect(buildRun.argv[2]).toContain("--message-format=json");
			expect(buildRun.argv).toContain("rules/rust/example/Cargo.toml");
		});
	});

	test("rustTestRun executes only the target's own binary, single-threaded", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const cargoPackage = new CargoPackage({ path: "rules/rust/example" });
			host.setRunStdout(
				"cargo test --no-run rules/rust/example",
				fakeCompilerArtifactStdout(
					"build/rust/rules/rust/example",
					"hello",
					"bin",
					"debug/deps/hello-abc123",
				),
			);
			const rustTest = new RustTest({
				cargoPackage,
				path: "rules/rust/example",
				testName: "hello",
				testKind: "bin",
				testArgs: ["--nocapture"],
			});

			await rustTestRun(rustTest);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.argv[0]).toBe(
				"build/rust/rules/rust/example/debug/deps/hello-abc123",
			);
			expect(testRun.argv).toContain("--test-threads=1");
			expect(testRun.argv).toContain("--nocapture");
			expect(testRun.impure).toBeFalsy();
		});
	});

	test("rustTestRun exposes the parent package's native test tools", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const cargoPackage = new CargoPackage({ path: "rules/rust/example" });
			host.setRunStdout(
				"cargo test --no-run rules/rust/example",
				fakeCompilerArtifactStdout(
					"build/rust/rules/rust/example",
					"hello",
					"bin",
					"debug/deps/hello-abc123",
				),
			);
			const rustTest = new RustTest({
				cargoPackage,
				path: "rules/rust/example",
				testName: "hello",
				testKind: "bin",
				testTools: [nativeTool("tar")],
			});

			await rustTestRun(rustTest);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.tools.some((tool) => tool.name === "tar")).toBe(true);
		});
	});

	test("RustTest preserves workspace-member source scope", () => {
		const cargoPackage = new CargoPackage({
			path: "crates/imp-store",
			workspaceMember: true,
		});
		const rustTest = new RustTest({
			cargoPackage,
			path: "crates/imp-store",
			testName: "imp_store",
			testKind: "lib",
			workspaceMember: true,
		});

		expect(rustTest.attrs.workspaceMember).toBe(true);
	});
});
