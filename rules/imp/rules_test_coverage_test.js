import { describe, expect, test } from "//rules/imp/test";
import { glob, paths, read_file } from "imp:core";

// `rulesTest({ root })` collects its cases with a single-level `*_test.js`
// glob, so a `*_test.js` file runs only when its own directory has a
// `BUILD.js` that declares a `rulesTest` rooted at that exact directory.
// Nothing else reports a test file that no target claims, so this check
// fails the suite when one is added without the matching stanza.
describe("rules test coverage", () => {
	test("every rules/**/*_test.js sits under a matching rulesTest root", () => {
		const testDirs = new Set(
			paths(glob({ root: "rules", include: ["**/*_test.js"] })).map((p) =>
				p.slice(0, p.lastIndexOf("/")),
			),
		);
		const builds = new Map(
			paths(glob({ root: "rules", include: ["**/BUILD.js"] })).map((p) => [
				p.slice(0, p.lastIndexOf("/")),
				read_file(p),
			]),
		);
		const uncovered = [...testDirs].sort().filter((dir) => {
			const src = builds.get(dir);
			if (src === undefined) return true;
			const rooted = new RegExp(
				`rulesTest\\(\\{[\\s\\S]*?root:\\s*["']//${dir}["']`,
			);
			return !rooted.test(src);
		});
		expect(uncovered).toEqual([]);
	});
});
