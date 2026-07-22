1. Ask, don't assume. If something is unclear, ask before writing a single line. Never make silent assumptions about intent, architecture, or requirements. When running unattended, pick the most reasonable interpretation, proceed, and record the assumption rather than blocking.

2. Implement the simplest solution for simple problems, better solutions for harder problems. Do not over-engineer or add flexibility that isn't needed yet.

3. Don't touch unrelated code but please do surface bad code or design smells you discover with me so we can address them as a separate issue.

4. Flag uncertainty explicitly. If you're unsure about something, see point 1 above. If it makes sense to do so, conduct a small, localised and low-risk experiment and bring the hypothesis and results to me to discuss. Confidence without certainty causes more damage than admitting a gap.

5. I'm always open to ideas on better ways to do things. Please don't hesitate to suggest a better way, or one that has long lasting impact over a tactical change. (as a few examples)

### Helpful notes:

- Planned builds write task/CAS cache data under `XDG_CACHE_HOME/imp`, falling back to `$HOME/.cache/imp` and then `/tmp/imp/cache`. In sandboxed runs where `$HOME` is read-only, set `XDG_CACHE_HOME` to a writable location such as `/tmp/imp-cache`.
- The repo is a cargo workspace: the `imp` bin crate lives at the root (frontend: CLI, JS engine, graph), with `crates/imp-store` (CAS/digests/caches), `crates/imp-exec-api` (the REv2-shaped execution API boundary), and `crates/imp-execution` (sandboxed runs, workers, toolchain fetch). Run Rust tests with `cargo test --workspace` — a bare `cargo test` only covers the root crate.
- If formatting changes unrelated files; do not go around trying to undo - just liberally format to avoid that happening in the first place.
- Always run `imp fmt //...`, `imp lint //...`, and `imp test //...` before committing — `cargo build`/`cargo test` alone don't cover lint or the project's own formatting conventions.
