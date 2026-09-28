// Export selected graph codegen roots below dist/codegen while preserving each
// output's declared workspace-relative path.
import { goal, goalError, logInfo, writeWorkspace } from "imp:core";

function isWorkspaceRelativeFile(path) {
	return (
		typeof path === "string" &&
		path.length > 0 &&
		!path.startsWith("/") &&
		!path.includes("\\") &&
		!/^[A-Za-z]:/.test(path) &&
		path.split("/").every((part) => part !== "" && part !== "." && part !== "..")
	);
}

function collisionKey(path) {
	// Reject case-only aliases on every host so one selection behaves the same
	// on case-sensitive and case-insensitive filesystems.
	return path.toLowerCase();
}

function findPathConflict(owners, key) {
	const parts = key.split("/");
	for (let end = 1; end < parts.length; end += 1) {
		const ancestor = parts.slice(0, end).join("/");
		const owner = owners.get(ancestor);
		if (owner !== undefined) return owner;
	}
	for (const [existing, owner] of owners) {
		if (existing.startsWith(`${key}/`)) return owner;
	}
	return owners.get(key);
}

/** Publish selected codegen roots under dist/codegen. */
export function graphCodegenGoal(roots) {
	const outputs = [];
	const owners = new Map();

	for (const { address, result } of roots) {
		if (!result || !Array.isArray(result.paths) || !result.files) {
			throw goalError(
				`${address}: codegen root must resolve to a codegen() result`,
			);
		}
		for (const path of result.paths) {
			if (!isWorkspaceRelativeFile(path)) {
				throw goalError(
					`${address}: codegen output path '${path}' must be a normalized workspace-relative path`,
				);
			}
			const artifact = result.files[path];
			if (!artifact || typeof artifact.digest !== "string" || !artifact.digest) {
				throw goalError(
					`${address}: codegen root has no artifact for '${path}'`,
				);
			}
			const destination = `dist/codegen/${path}`;
			const key = collisionKey(destination);
			const owner = findPathConflict(owners, key);
			if (owner !== undefined) {
				throw goalError(
					`codegen output path conflict at '${destination}': ${owner.address} ` +
						`(${owner.path}) and ${address} (${path})`,
				);
			}
			owners.set(key, { address, path });
			outputs.push({ address, path, destination, digest: artifact.digest });
		}
	}

	for (const { path, destination, digest } of outputs) {
		writeWorkspace(destination, digest, { from: path });
	}
	if (outputs.length > 0) {
		logInfo(
			`Exported ${outputs.length} codegen file${outputs.length === 1 ? "" : "s"}:` +
				outputs
					.map(({ address, path, destination }) => `\n  ${address}: ${path} -> ${destination}`)
					.join(""),
		);
	}
}

export const CODEGEN = goal("codegen", undefined, { graph: graphCodegenGoal });
