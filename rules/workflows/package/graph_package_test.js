import { graphPackageGoal } from "//rules/workflows/package";
import { binaryProduct } from "//rules/workflows/package";
import { output, task } from "imp:core";
import {
	expect,
	test,
	withFakeToolchainHost,
	withFakeWriteWorkspace,
} from "//rules/imp/test";

test("binary products keep a single artifact without shared libraries", () => {
	const built = task({
		outputs: { artifact: output.artifact() },
		async run() {
			return { artifact: null };
		},
	});
	const plan = binaryProduct({
		namespace: "c",
		targetSlug: "app",
		executableName: "app",
	});
	const product = plan.finish(built.outputs.artifact);

	expect(plan.bundled).toBe(false);
	expect(product.artifact).toBe(built.outputs.artifact);
	expect(product.run).toBe(built.outputs.artifact);
	expect(product.executablePath).toBe(null);
});

test("binary products bundle the executable and describe its path", () => {
	return withFakeToolchainHost(async () => {
		const built = task({
			outputs: { artifact: output.artifact() },
			async run() {
				return { artifact: null };
			},
		});
		const library = task({
			outputs: { artifact: output.artifact() },
			async run() {
				return { artifact: null };
			},
		});
		const plan = binaryProduct({
			namespace: "odin",
			targetSlug: "app",
			executableName: "output",
			sharedLibraries: [library.outputs.artifact],
			bundleDisplay: "odin bundle app",
			runDisplay: "odin run app",
		});
		const product = plan.finish(built.outputs.artifact);

		expect(plan.bundled).toBe(true);
		expect(plan.bundleDir).toBe("build/odin/app.d");
		expect(plan.executablePath).toBe("build/odin/app.d/output");
		expect(product.artifact.__imp_graph_handle).toBe(true);
		expect(product.run.__imp_graph_handle).toBe(true);
	});
});

test("graph package roots are materialized at the workflow boundary", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphPackageGoal([
			{
				address: "//images:app",
				result: { type: "artifact", digest: "digest", path: "package" },
			},
		]);
		expect(calls).toEqual([
			{ path: "dist/images/app", digest: "digest", from: "package" },
		]);
	});
});

// A shared library is the one product whose filename a consumer resolves by
// name at run time: the consumer's own DT_NEEDED entry holds it, and the
// loader looks for exactly that. Publishing it under the target name gave
// dist/rules/c/cmake/example/hello_cmake for a file every consumer knows as
// libhello_cmake.so.
test("a shared library is published under its own filename, not the target name", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphPackageGoal([
			{
				address: "//native/hello:hello",
				result: {
					type: "artifact",
					digest: "digest",
					path: "build/c/libhello.so",
				},
			},
		]);
		expect(calls).toEqual([
			{
				path: "dist/native/hello/libhello.so",
				digest: "digest",
				from: "build/c/libhello.so",
			},
		]);
	});
});

test("a versioned soname and the other platforms' extensions are recognized", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphPackageGoal([
			{
				address: "//a:x",
				result: { type: "artifact", digest: "d", path: "build/libfoo.so.1" },
			},
			{
				address: "//b:y",
				result: { type: "artifact", digest: "d", path: "build/libfoo.so.1.2.3" },
			},
			{
				address: "//c:z",
				result: { type: "artifact", digest: "d", path: "build/libfoo.dylib" },
			},
			{
				address: "//d:w",
				result: { type: "artifact", digest: "d", path: "build/foo.dll" },
			},
		]);
		expect(calls.map((call) => call.path)).toEqual([
			"dist/a/libfoo.so.1",
			"dist/b/libfoo.so.1.2.3",
			"dist/c/libfoo.dylib",
			"dist/d/foo.dll",
		]);
	});
});

// Nothing resolves an executable by name, so it keeps the target-shaped name
// that makes dist/ readable. This is the case the rule above must not catch.
test("an executable and a subtree keep the target name", async () => {
	await withFakeWriteWorkspace(async (calls) => {
		graphPackageGoal([
			{
				address: "//native/hello:hello",
				result: { type: "artifact", digest: "d", path: "build/c/hello" },
			},
			{
				address: "//images:app",
				result: { type: "artifact", digest: "d", path: null },
			},
			// A ".sofa" suffix ends in the same three letters a shared library
			// does without being one.
			{
				address: "//data:couch",
				result: { type: "artifact", digest: "d", path: "build/couch.sofa" },
			},
		]);
		expect(calls.map((call) => call.path)).toEqual([
			"dist/native/hello/hello",
			"dist/images/app",
			"dist/data/couch",
		]);
	});
});
