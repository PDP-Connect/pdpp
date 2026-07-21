// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared helper for connector `schemas.ts` files. Wraps a stream→zod
 * registry into a `ValidateRecord` closure with consistent diagnostics.
 *
 * Before this helper, every connector's `schemas.ts` ended with a
 * verbatim 17-line copy of the same validator function — same try /
 * unwrap / map-issues logic, just keyed off a different `SCHEMAS`
 * object. Centralizing it removes the boilerplate and gives one place
 * to evolve diagnostic shape (adding stream-tag, hint text, etc.).
 *
 * This module imports zod, which is why it's separate from
 * connector-runtime.ts (the runtime stays zod-free so the framework
 * can run a connector that doesn't validate). Connectors import
 * `makeValidateRecord` here; the runtime itself never does.
 */

import type { z } from "zod";
import type { RecordData, ValidateRecord } from "./connector-runtime.ts";

export type SchemaRegistry = Readonly<Record<string, z.ZodTypeAny>>;

/**
 * Build a `ValidateRecord` from a stream-keyed zod registry.
 *
 * Behavior matches the per-connector implementations it replaces:
 *   - Unknown stream → pass-through (`{ ok: true, data }`). This keeps
 *     newly-added streams from blocking emit before their schema lands.
 *   - Known stream + parse success → `{ ok: true, data: parsed }`.
 *   - Known stream + parse failure → `{ ok: false, issues }` where each
 *     issue has `{ path, message }` (path joined with dots).
 */
export function makeValidateRecord(schemas: SchemaRegistry): ValidateRecord {
  return (stream, data) => {
    const schema = schemas[stream];
    if (!schema) {
      return { ok: true, data };
    }
    const result = schema.safeParse(data);
    if (result.success) {
      return { ok: true, data: result.data as RecordData };
    }
    const issues = result.error.issues.map((i) => ({
      path: i.path.join("."),
      message: i.message,
    }));
    return { ok: false, issues };
  };
}
