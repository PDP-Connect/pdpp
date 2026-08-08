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
import type { RecordData, ShapeAnomaly, ValidateRecord } from "./connector-runtime.ts";

export type SchemaRegistry = Readonly<Record<string, z.ZodTypeAny>>;

/**
 * A zod issue for a value outside a declared set. Zod 4 reports these as
 * `code: "invalid_value"` with the modeled options on `values`; the same code
 * covers `z.literal`, which `isOpenVocabularyIssue` filters out below.
 */
interface InvalidValueIssue {
  code: string;
  path: readonly PropertyKey[];
  values?: readonly unknown[];
}

/**
 * True when an issue is a value outside a declared *vocabulary* (`z.enum`)
 * rather than a violated *discriminator* (`z.literal`).
 *
 * The distinction is load-bearing. An enum over a third-party API's type
 * vocabulary is an open set in practice: the vendor ships a feature, a new
 * member appears, and a schema written from docs goes stale without anything
 * being wrong with the record. A literal is the opposite — it is how a schema
 * says "this is the variant I claim to be", so a wrong literal means the record
 * is not the thing it purports to be, and tolerating it would let a genuinely
 * mis-shaped record through. Zod gives both the same code, so we separate them
 * by arity: two-or-more options is a vocabulary, exactly one is a discriminator.
 */
function isOpenVocabularyIssue(issue: InvalidValueIssue): boolean {
  return issue.code === "invalid_value" && Array.isArray(issue.values) && issue.values.length >= 2;
}

/** Read the value actually present at `path` in the source record, for verbatim reporting. */
function valueAtPath(data: unknown, path: readonly PropertyKey[]): unknown {
  let cursor: unknown = data;
  for (const segment of path) {
    if (cursor === null || typeof cursor !== "object") {
      return;
    }
    cursor = (cursor as Record<PropertyKey, unknown>)[segment];
  }
  return cursor;
}

/**
 * Build a `ValidateRecord` from a stream-keyed zod registry.
 *
 * Behavior:
 *   - Unknown stream → pass-through (`{ ok: true, data }`). This keeps
 *     newly-added streams from blocking emit before their schema lands.
 *   - Known stream + parse success → `{ ok: true, data: parsed }`.
 *   - Known stream + parse failure where EVERY issue is an unmodeled enum
 *     value → `{ ok: true, data, anomalies }`: the record is retained with
 *     its original value intact and the drift reported. See below.
 *   - Known stream + any other parse failure → `{ ok: false, issues }` where
 *     each issue has `{ path, message }` (path joined with dots).
 *
 * ## Why an unmodeled enum value must not discard the record
 *
 * A closed enum checked against a third-party API is a standing bet that the
 * vendor will never add a member, and that bet always loses eventually. When it
 * does, the failure is silent and total: every record carrying the new value is
 * dropped, however sound the rest of it is. For a personal-data tool that is the
 * worst available outcome — the owner loses their own history because someone
 * else shipped a feature. Retaining the record costs a schema that is
 * momentarily less precise; discarding it costs data that cannot be recovered
 * once the source ages it out.
 *
 * So an enum-only failure degrades instead of dropping. Three properties hold:
 *
 *   1. **Retained.** The record emits.
 *   2. **Verbatim.** It emits as `data` — the caller's ORIGINAL input, not
 *      `result.data`, which does not exist for a failed parse. Nothing is
 *      coerced to a fallback member, defaulted, or stripped. A consumer that
 *      understands the new value gets it; the runtime never pretends to know
 *      what the value means.
 *   3. **Visible.** Each unmodeled value is reported as a `ShapeAnomaly`, so
 *      the drift surfaces as a diagnostic instead of becoming a silent
 *      pass-through. Tolerating drift and hiding it are different things; only
 *      the first is intended here.
 *
 * This deliberately does NOT weaken validation elsewhere. A missing required
 * `id`, a field of the wrong type, a violated literal — each is still a hard
 * skip, and a record that mixes an enum drift with any such fault is skipped on
 * the fault. Only a record whose *sole* defect is vocabulary drift is retained.
 *
 * The policy lives here, not in a connector, because it is a property of
 * validating against third-party vocabularies in general rather than of any one
 * provider. Every connector routes its schemas through this helper, so the
 * tolerance applies uniformly and no connector re-decides it.
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

    const issues = result.error.issues as readonly (InvalidValueIssue & { message: string })[];
    // Retain only when EVERY issue is vocabulary drift; one real fault alongside
    // the drift still skips, so this cannot mask a malformed record.
    if (issues.length > 0 && issues.every(isOpenVocabularyIssue)) {
      const anomalies: ShapeAnomaly[] = issues.map((issue) => ({
        path: issue.path.join("."),
        value: valueAtPath(data, issue.path),
        expected: issue.values ?? [],
      }));
      // `data`, not `result.data`: a failed parse produces no output object, and
      // the unrecognized value must survive exactly as the source sent it.
      return { ok: true, data, anomalies };
    }

    return {
      ok: false,
      issues: issues.map((i) => ({
        path: i.path.join("."),
        message: i.message,
      })),
    };
  };
}
