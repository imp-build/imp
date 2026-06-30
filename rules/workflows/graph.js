// Migration target for src/commands/graph.rs
//
// The legacy Rust command scanned Odin import statements, built a package
// dependency graph, rendered it as Mermaid markdown, and piped it through
// mmdc to produce a dependencies.svg file. Two modes: package-level and file-level.
//
// Intended shape:
//
//   import { goal } from "imp:core";
//
//   export default async function () {
//     // TODO: define a graph goal that produces a Mermaid/dot graph from
//     //       odin-package dependency edges already tracked by the workspace
//     // goal("graph", { ... });
//     // goal("graph:files", { ... });
//   }

// TODO: implement
