import { expect, test } from "//rules/imp/test";
import {
	craneArtifactName,
	craneCacheKey,
	craneDownloadUrl,
	craneSupportedPlatforms,
	craneToolchain,
	defaultCraneToolchain,
} from "//rules/oci/toolchain";

test("Crane release helpers are platform-specific", () => {
	const plat = { os: "linux", arch: "x86_64" };
	expect(craneArtifactName("0.20.6", plat)).toBe(
		"go-containerregistry_Linux_x86_64.tar.gz",
	);
	expect(craneDownloadUrl("0.20.6", plat)).toContain("/v0.20.6/");
	expect(craneCacheKey("0.20.6", plat)).toBe("0.20.6/linux-x86_64");
	expect(craneSupportedPlatforms().length).toBe(5);
});

test("Crane declarations return graph tools", () => {
	const tool = craneToolchain("0.20.6", { default: true });
	expect(tool.__imp_graph_handle).toBe(true);
	expect(defaultCraneToolchain()).toBe(tool);
});
