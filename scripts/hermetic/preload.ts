// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// The only intended `--import` entry point for the hermetic network guard.
// Two wiring paths use it, both gated on PDPP_HERMETIC_GUARD:
//
//  1. The RI test runner (reference-implementation/scripts/run-tests.ts) sets
//     PDPP_HERMETIC_GUARD=1 and prepends `--import <this file>` to every test
//     child, so every test process runs fail-closed and each test-owned
//     server auto-grants its own bound origin (see guard.ts).
//
//  2. The lane/maker/gate process boundary. A direct Node CLI smoke -- the
//     exact shape that caused the incident (a migrated CLI whose default
//     AS_URL fell back to http://localhost:7662 and reached the live server)
//     -- is guarded by exporting, in the orchestrator's environment:
//
//       export PDPP_HERMETIC_GUARD=1
//       export NODE_OPTIONS="--import <repo>/scripts/hermetic/preload.ts ${NODE_OPTIONS:-}"
//
//     Every `node ...` the lane then spawns inherits the guard. A CLI that
//     starts its own server still works (bind-derived authority); a CLI that
//     dials an origin it did not start (7662, or any ambient service) fails
//     LOUD instead of silently succeeding.
//
// This file is inert unless PDPP_HERMETIC_GUARD === "1". Merely having it on
// disk, or an accidental --import of it, can never activate network denial
// for a real operator/product run -- activation is opt-in and explicit, not
// "on by default because loaded". It is never imported by any product/runtime
// startup path.
import { installHermeticNetworkGuard } from "./guard.ts";

if (process.env.PDPP_HERMETIC_GUARD === "1") {
  await installHermeticNetworkGuard();
}
