// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Over-time chart pure logic — re-export of the shared, React-free module in
 * @pdpp/operator-ui so the canvas, the presentational component, AND the
 * assembler (which builds the bucket series during data assembly) all use ONE
 * definition of the brush/bucket math. Importing through this local path keeps
 * the explore canvas's sibling-module convention; the single source of truth is
 * `packages/operator-ui/src/explore/over-time-chart.ts`.
 *
 * DESIGN: docs/research/explore-design-cells/over-time-chart/design.md
 */
// biome-ignore lint/performance/noBarrelFile: thin re-export of ONE shared module; preserves the explore canvas's sibling-import convention so the assembler, canvas, and component share a single definition.
export * from "@pdpp/operator-ui/explore/over-time-chart";
