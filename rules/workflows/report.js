// Shared rendering for goal reports printed as plain output (not logs) once
// the live progress UI has shut down — see execute_goal_live_selection's
// `report` capture and `run()` in crates/imp/src/main.rs. Used by both
// graphTestGoal (//rules/workflows/test) and graphFmtGoal
// (//rules/workflows/fmt): sort by status severity, then by identifier;
// align the identifier into a column; color the status. Unconditional ANSI
// color, no tty detection, mirrors this codebase's own existing precedent
// (rules/python/ruff_graph.js always passes ruff --color=always).
const RESET = "\x1b[0m";
const COLOR = { red: "\x1b[31m", yellow: "\x1b[33m", green: "\x1b[32m" };

/**
 * Render `{ key, status, output? }[]` as a report: one column-aligned,
 * colored line per unit (sorted by status severity per `order`, then by
 * `key`), then each unit's `output` block (if any), then `summary(counts)`'s
 * line.
 *
 * @param {Array<{key: string, status: string, output?: string}>} units
 * @param {object} opts
 * @param {string[]} opts.order Status values, most severe first.
 * @param {Record<string, "red"|"yellow"|"green">} opts.colors
 * @param {(counts: Record<string, number>) => string} opts.summary
 * @returns {string}
 */
export function statusReport(units, { order, colors, summary }) {
	const sorted = [...units].sort((a, b) => {
		const byStatus = order.indexOf(a.status) - order.indexOf(b.status);
		return byStatus !== 0 ? byStatus : a.key.localeCompare(b.key);
	});
	const width = Math.max(0, ...sorted.map((unit) => unit.key.length)) + 2;
	const lines = sorted.map((unit) => {
		const color = COLOR[colors[unit.status]] ?? "";
		return `${unit.key.padEnd(width)}${color}${unit.status.toUpperCase()}${RESET}`;
	});
	for (const unit of sorted) {
		if (unit.output) lines.push(`${unit.key}:\n${unit.output}`);
	}
	const counts = Object.fromEntries(order.map((status) => [status, 0]));
	for (const unit of units) counts[unit.status]++;
	lines.push(summary(counts));
	return lines.join("\n");
}
