// The "build" goal is seeded by default in HostState::default() (src/spike.rs),
// but its real products live elsewhere: odin-package (rules/odin/index.js),
// cmake-lib/cmake-toolchain (rules/c/cmake/index.js), asset (rules/asset.js),
// stamp-file (rules/gen.js), odin-gen (rules/odin/index.js). This file just
// declares the goal explicitly so it's documented here rather than relying
// solely on the Rust default; goal registration is first-registration-wins,
// so this is a no-op today and stays correct if that default is ever dropped.
//
// The callback resolves each selected target's product itself via
// resolveProduct rather than delegating to dispatchSelection, so it drives
// its own fan-out/await loop directly.

import { goal, logInfo, resolveProduct } from "imp:core";

function resultOutputs(result) {
    return result && Array.isArray(result.outputs) ? result.outputs : [];
}

function outputPath(output) {
    if (typeof output === "string") return output;
    return output && typeof output.path === "string" ? output.path : null;
}

export function formatBuildArtifactSummary(artifacts) {
    const lines = ["Build artifacts:"];
    for (const artifact of artifacts) {
        lines.push(`- ${artifact.label}`);
        for (const path of artifact.paths) {
            lines.push(`  -> ${path}`);
        }
    }
    return lines.join("\n");
}

export async function buildGoal(selection) {
    const resolved = selection.map(resolveProduct);
    const calls = resolved.map(({ label, fn, handle }) => ({ label, promise: fn(handle) }));
    const artifacts = [];
    for (const { label, promise } of calls) {
        let result;
        try {
            result = await promise;
        } catch (e) {
            throw new Error(`${label}: ${e && e.message ? e.message : e}`);
        }
        const paths = resultOutputs(result)
            .map(outputPath)
            .filter((path) => path !== null);
        if (paths.length === 0) {
            throw new Error(`${label}: build product did not declare any output artifacts`);
        }
        artifacts.push({
            label,
            paths,
        });
    }
    if (artifacts.length > 0) {
        logInfo(formatBuildArtifactSummary(artifacts));
    }
}

goal("build", buildGoal);
