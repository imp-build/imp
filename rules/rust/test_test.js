import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { targetOutputSlug } from "imp:core";
import { cargoPackage } from "//rules/rust";
import { cargoPackageTests, parseTestBinaries } from "//rules/rust/test";
import {
	__resetRustToolchainStateForTest,
	rustToolchain,
} from "//rules/rust/toolchain";
import { gccToolchain, __resetGccToolchainStateForTest } from "//rules/c/gcc";
import { nativeTool } from "//rules/imp/native-tool";

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

describe("rust package tests", () => {
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

	function fakeCompilerArtifactStdout(buildDir, name, kind, executable) {
		return JSON.stringify({
			reason: "compiler-artifact",
			target: { name, kind: [kind] },
			profile: { test: true },
			executable: `/sandbox/xyz/${buildDir}/${executable}`,
		});
	}

	function setFakeMetadata(host) {
		host.setRunStdout(
			"cargo metadata rules/rust/example",
			JSON.stringify({
				workspace_root: "rules/rust/example",
				packages: [
					{
						manifest_path: "rules/rust/example/Cargo.toml",
						targets: [{ name: "hello", kind: ["bin"], test: true }],
					},
				],
			}),
		);
	}

	test("package tests compile with --no-run and execute the discovered binary", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const packageLabel = cargoPackage({
				path: "rules/rust/example",
				testArgs: ["--nocapture"],
			});
			setFakeMetadata(host);
			host.setRunStdout(
				"cargo test --no-run rules/rust/example",
				[
					fakeCompilerArtifactStdout(
						`build/rust/${targetOutputSlug(packageLabel)}`,
						"hello",
						"bin",
						"debug/deps/hello-abc123",
					),
					fakeCompilerArtifactStdout(
						`build/rust/${targetOutputSlug(packageLabel)}`,
						"integration",
						"test",
						"debug/deps/integration-def456",
					),
				].join("\n"),
			);

			await cargoPackageTests(packageLabel);

			const buildRun = host.runs.find(
				(run) => run.argv[2] && run.argv[2].includes("--no-run"),
			);
			expect(buildRun.argv[0]).toBe("sh");
			expect(buildRun.argv[2]).toContain("--no-run");
			expect(buildRun.argv[2]).toContain("--message-format=json");
			expect(buildRun.argv).toContain("rules/rust/example/Cargo.toml");
			const testRun = host.runs.find(
				(run) =>
					run.argv[0] ===
					`build/rust/${targetOutputSlug(packageLabel)}/debug/deps/hello-abc123`,
			);
			expect(testRun.argv[0]).toBe(
				`build/rust/${targetOutputSlug(packageLabel)}/debug/deps/hello-abc123`,
			);
			expect(testRun.argv).toContain("--test-threads=1");
			expect(testRun.argv).toContain("--nocapture");
			expect(testRun.impure).toBeFalsy();
		});
	});

	test("package tests expose declared native test tools", async () => {
		await withRustHost(async (host) => {
			gccToolchain("2025.08-1", { default: true, unverified: true });
			rustToolchain("1.93.0", { default: true, unverified: true });
			const packageLabel = cargoPackage({
				path: "rules/rust/example",
				testTools: [nativeTool("tar")],
			});
			setFakeMetadata(host);
			host.setRunStdout(
				"cargo test --no-run rules/rust/example",
				[
					fakeCompilerArtifactStdout(
						`build/rust/${targetOutputSlug(packageLabel)}`,
						"hello",
						"bin",
						"debug/deps/hello-abc123",
					),
					fakeCompilerArtifactStdout(
						`build/rust/${targetOutputSlug(packageLabel)}`,
						"integration",
						"test",
						"debug/deps/integration-def456",
					),
				].join("\n"),
			);

			await cargoPackageTests(packageLabel);

			const testRun = host.runs[host.runs.length - 1];
			expect(testRun.tools.some((tool) => tool.name === "tar")).toBe(true);
		});
	});

	test("cargoPackage preserves workspace-member source scope", () => {
		const packageLabel = cargoPackage({
			path: "crates/imp-store",
			workspaceMember: true,
		});

		expect(packageLabel.data.workspaceMember).toBe(true);
	});
});
