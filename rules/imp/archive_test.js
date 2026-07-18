import {
	describe,
	expect,
	test,
	withFakeToolchainHost,
} from "//rules/imp/test";
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

	test("extractArchive uses unzip for a Unix zip archive", async () => {
		await withFakeToolchainHost(async (host) => {
			await extractArchive({
				archive: "a.zip",
				dest: "out",
				format: "zip-unix",
				tools: [],
				display: "unzip",
			});

			expect(host.runs[0].argv[2]).toContain("unzip -q");
		});
	});

	test("extractArchive runs tar with format flags into a named-cache output", async () => {
		await withFakeToolchainHost(async (host) => {
			const dest = await extractArchive({
				archive: ".imp/downloads/tool.tar.gz",
				dest: ".imp/toolchains/1.0.0",
				format: "tar.gz",
				stripComponents: 1,
				tools: [],
				namedCache: { name: "tool-toolchains", key: "1.0.0/linux-x86_64" },
				display: "install tool",
			});

			expect(dest).toBe(".imp/toolchains/1.0.0");
			expect(host.runs.length).toBe(1);
			const [extract] = host.runs;
			expect(extract.argv[0]).toBe("sh");
			expect(extract.argv[2]).toContain("tar -xzf");
			expect(extract.argv[2]).toContain("--strip-components=1");
			expect(extract.argv).toContain(".imp/downloads/tool.tar.gz");
			expect(extract.inputs[0].path).toBe(".imp/downloads/tool.tar.gz");
			expect(extract.outputs[0].namedCache.name).toBe("tool-toolchains");
		});
	});

	test("extractArchive omits strip-components and named cache when not asked", async () => {
		await withFakeToolchainHost(async (host) => {
			await extractArchive({
				archive: "a.zip",
				dest: "out",
				format: "zip",
				tools: [],
				display: "unzip",
			});

			const [extract] = host.runs;
			expect(extract.argv[2]).toContain("tar -xf");
			expect(extract.argv[2].includes("--strip-components")).toBe(false);
			expect(extract.outputs[0].namedCache === undefined).toBe(true);
		});
	});

	test("extractArchive rejects unknown formats", async () => {
		let message = null;
		try {
			await extractArchive({
				archive: "a",
				dest: "b",
				format: "7z",
				tools: [],
				display: "x",
			});
		} catch (e) {
			message = e.message;
		}
		expect(message).toContain("unsupported archive format");
	});
});
