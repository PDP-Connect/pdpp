// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// A reference-target module with no `mutable_state` stream, for the CLI exit
// code test: exercising "zero failures, incomplete coverage" needs a target
// where the incremental-sync requirements are genuinely `unsupported` rather
// than a real, honestly-reported failure. `--target reference` no longer
// serves that scenario after RS-7/RS-8 applicability started tracking seeded
// stream semantics, because the in-repo reference target does seed a
// `mutable_state` stream and does not implement `changes_since`.

import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../../src/targets/reference-adapter.ts";

const APPEND_ONLY_ONLY = DEFAULT_FIXTURES.filter((f) => f.semantics === "append_only");

export default function target(): ReferenceTargetAdapter {
  return new ReferenceTargetAdapter(APPEND_ONLY_ONLY);
}
