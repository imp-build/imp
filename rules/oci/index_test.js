import { BUILD, PACKAGE, PUBLISH } from "imp:core";
import { describe, expect, test } from "//rules/imp/test";
import { ociBuild, ociMirror, ociPull, ociPush } from "//rules/oci";

const DIGEST_A = "sha256:" + "a".repeat(64);

describe("OCI graph rules", () => {
	test("ociPull returns build and package graph roots", () => {
		const image = ociPull({
			repo: "docker.io/library/alpine",
			digest: DIGEST_A,
		});
		expect(image.image.layout.__imp_graph_handle).toBe(true);
		expect(image[BUILD].__imp_graph_handle).toBe(true);
		expect(image[PACKAGE].__imp_graph_handle).toBe(true);
	});

	test("ociPull validates its immutable or mutable reference", () => {
		expect(() => ociPull({ tag: "latest" })).toThrow("requires 'repo'");
		expect(() => ociPull({ repo: "alpine" })).toThrow(
			"exactly one of 'tag' or 'digest'",
		);
	});

	test("ociBuild composes image objects and source layers without executing", () => {
		const base = ociPull({
			repo: "docker.io/library/alpine",
			digest: DIGEST_A,
		});
		const image = ociBuild({
			base,
			sourceBase: ".",
			layers: [{ srcs: ["rules/oci/index.js"], path: "/app" }],
		});
		expect(image.image.layout.__imp_graph_handle).toBe(true);
		expect(image[PACKAGE].__imp_graph_handle).toBe(true);
	});

	test("registry mutation is publish-only", () => {
		const image = ociPull({
			repo: "docker.io/library/alpine",
			digest: DIGEST_A,
		});
		const push = ociPush({ image, repo: "ghcr.io/example/app", tag: "v1" });
		const mirror = ociMirror({
			from: { repo: "docker.io/library/alpine", tag: "3.20" },
			to: { repo: "ghcr.io/example/alpine", tag: "3.20" },
		});
		expect(push[PUBLISH].__imp_graph_handle).toBe(true);
		expect(push[BUILD]).toBe(undefined);
		expect(mirror[PUBLISH].__imp_graph_handle).toBe(true);
	});
});
