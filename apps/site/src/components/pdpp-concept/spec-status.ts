// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// SOURCE OF TRUTH: /spec-core.md header ("# ... (PDPP) v0.1.0", "Status: Normative
// draft", "Date: 2026-04-06"). Hand-synced like the concept site — if spec-core.md's
// header changes, update this one constant (every ported page reads from here).
export const SPEC_STATUS = {
  date: "2026-04-06",
  label: "Normative draft",
  version: "v0.1.0",
} as const;

export const SPEC_STATUS_STAMP = `${SPEC_STATUS.label} · ${SPEC_STATUS.version} · ${SPEC_STATUS.date}`;

export const SPEC_EDITORS = ["Art Abal", "Anna Kaz", "Tim Nunamaker"] as const;
