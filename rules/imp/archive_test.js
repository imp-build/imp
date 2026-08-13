import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
import { cacheGet, output, task } from "imp:core";
import { extractArchive, extractArchiveTools } from "//rules/imp/archive";

describe("archive", () => {
	test("extractArchiveTools lists per-format decompressors", () => {
		expect(extractArchiveTools("tar.gz")).toEqual(["mkdir", "tar", "gzip"]);
		expect(extractArchiveTools("tar.xz")).toEqual(["mkdir", "tar", "xz"]);
		expect(extractArchiveTools("tar")).toEqual(["mkdir", "tar"]);
		expect(extractArchiveTools("zip")).toEqual(["mkdir", "tar"]);
		expect(extractArchiveTools("zip-unix")).toEqual(["mkdir", "unzip"]);
		expect(() => extractArchiveTools("rar")).toThrow(
			"unsupported archive format",
		);
	});

	function fakeDownload(name = "tool.tar.gz") {
		return task({
			display: "download tool",
			outputs: { archive: output.artifact() },
			async run(exec) {
				const result = await exec.action({
					argv: ["true"],
					outputs: { archive: output.file(name) },
				});
				return { archive: result.outputs.archive };
			},
		}).outputs.archive;
	}

	test("extractArchive uses unzip for a Unix zip archive", async () => {
		await withFakeToolchainHost(async (host) => {
			const extracted = extractArchive({
				archive: fakeDownload("a.zip"),
				dest: "out",
				format: "zip-unix",
				display: "unzip",
			});
			await host.resolve(extracted);

			const extract = host.runs.find((run) => run.argv[2]?.includes("unzip"));
			expect(extract.argv[2]).toContain("unzip -q");
		});
	});

	test("extractArchive runs tar with format flags into a named-cache output", async () => {
		await withFakeToolchainHost(async (host) => {
			const extracted = extractArchive({
				archive: fakeDownload(),
				dest: ".imp/toolchains/1.0.0",
				format: "tar.gz",
				stripComponents: 1,
				namedCache: { name: "tool-toolchains", key: "1.0.0/linux-x86_64" },
				display: "install tool",
			});
			await host.resolve(extracted);

			const extract = host.runs.find((run) => run.argv[2]?.includes("tar -xzf"));
			expect(extract.argv[0]).toBe("sh");
			expect(extract.argv[2]).toContain("tar -xzf");
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.outputs[0].namedCache.name).toBe("tool-toolchains");
			expect(cacheGet("tool-toolchains", "1.0.0/linux-x86_64")).toBe(
				"/cache/tool-toolchains/1.0.0/linux-x86_64",
			);
		});
	});

	test("extractArchive omits strip-components and named cache when not asked", async () => {
		await withFakeToolchainHost(async (host) => {
			const extracted = extractArchive({
				archive: fakeDownload("a.zip"),
				dest: "out",
				format: "zip",
				display: "unzip",
			});
			await host.resolve(extracted);

			const extract = host.runs.find((run) => run.argv[2]?.includes("tar -xf"));
			expect(extract.argv[2]).toContain("tar -xf");
			expect(extract.argv[2].includes("--strip-components")).toBe(false);
			expect(extract.outputs[0].namedCache === undefined).toBe(true);
		});
	});

	test("extractArchive graph form returns a directory handle without running", async () => {
		await withFakeToolchainHost(async (host) => {
			const source = task({
				outputs: { archive: output.artifact() },
				async run() {
					throw new Error("construction must not execute the producer");
				},
			}).outputs.archive;
			const extracted = extractArchive({
				archive: source,
				dest: "tool",
				format: "tar.gz",
			});
			expect(extracted.__imp_graph_handle).toBe(true);
			expect(host.runs.length).toBe(0);
		});
	});

	test("extractArchive graph form publishes a named cache when asked", async () => {
		await withFakeToolchainHost(async (host) => {
			const source = task({
				display: "download tool",
				outputs: { archive: output.artifact() },
				async run(exec) {
					const result = await exec.action({
						argv: ["true"],
						outputs: { archive: output.file("tool.tar.gz") },
					});
					return { archive: result.outputs.archive };
				},
			}).outputs.archive;
			const extracted = extractArchive({
				archive: source,
				dest: "tool",
				format: "tar.gz",
				stripComponents: 1,
				namedCache: { name: "demo-toolchains", key: "1.0/linux-x86_64" },
			});

			await host.resolve(extracted);

			const extract = host.runs.find((run) =>
				run.argv[2]?.includes("tar -xzf"),
			);
			expect(extract.outputs[0].namedCache).toEqual({
				name: "demo-toolchains",
				key: "1.0/linux-x86_64",
			});
			// The install is now reachable at a real absolute path, which is
			// what Toolchain.bin() reads back for `imp @tool`.
			expect(cacheGet("demo-toolchains", "1.0/linux-x86_64")).toBe(
				"/cache/demo-toolchains/1.0/linux-x86_64",
			);
		});
	});

	test("extractArchive graph form still rejects caller-supplied tools", async () => {
		let message = null;
		try {
			const source = task({
				outputs: { archive: output.artifact() },
				run() {},
			}).outputs.archive;
			extractArchive({
				archive: source,
				dest: "tool",
				format: "tar.gz",
				tools: [],
			});
		} catch (e) {
			message = e.message;
		}
		expect(message).toContain("owns its tools");
	});

	test("extractArchive rejects unknown formats", async () => {
		let message = null;
		try {
			const source = task({
				outputs: { archive: output.artifact() },
				run() {},
			}).outputs.archive;
			extractArchive({
				archive: source,
				dest: "b",
				format: "7z",
				display: "x",
			});
		} catch (e) {
			message = e.message;
		}
		expect(message).toContain("unsupported archive format");
	});
});
