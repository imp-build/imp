// CI-only overlay, loaded after imp.workspace.js when running on GitHub
// Actions (see CI_WORKSPACE_FILE in src/spike.rs). Runners are ephemeral, so
// there's no benefit to the 30-day default retention window; a short one
// just keeps the restored cache small without hurting hit rate within a run.
export const cache = { gcMaxAgeDays: 3 };
