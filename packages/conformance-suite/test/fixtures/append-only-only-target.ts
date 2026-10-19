// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Append-only streams still owe beginning, terminal tokens and cursor isolation.
// Mutable-write probes remain unsupported, so CLI coverage is still incomplete.

import { DEFAULT_FIXTURES, ReferenceTargetAdapter } from "../../src/targets/reference-adapter.ts";

export const APPEND_ONLY_ONLY = DEFAULT_FIXTURES.filter((f) => f.semantics === "append_only").map((fixture) => ({
  ...fixture,
  records: fixture.records.flatMap((record) => [
    record,
    { ...record, ...Object.fromEntries(fixture.primaryKey.map((key) => [key, `${String(record[key])}-second`])) },
  ]),
}));

export default function target(): ReferenceTargetAdapter {
  return new ReferenceTargetAdapter(APPEND_ONLY_ONLY);
}
