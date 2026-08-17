// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * pdppSafeText — Zod brand for human-readable text fields in connector records.
 *
 * The invariant: every value of type `PdppSafeText` is valid Unicode text
 * excluding U+0000 and non-whitelisted control characters (whitelist:
 * \t, \n, \r). It is safe to store in JSONB, index in FTS5, render in
 * the dashboard, and transport over the wire without further
 * sanitization.
 *
 * Why a brand and not a plain refinement: the `.brand<"PdppSafeText">()`
 * call produces a nominally distinct TypeScript type. Downstream code
 * can declare functions that accept `PdppSafeText` and refuse a raw
 * `string` without an explicit parse — making the validation guarantee
 * tracked by the type system rather than by convention.
 *
 * Pairs with `safeTextPreview` (the parse-time helper). Parsers call
 * `safeTextPreview` to decide whether to assign a value to a text field
 * or route it to the blobs table. `pdppSafeText` is the validation gate
 * that catches mistakes where a parser inlined binary content anyway.
 *
 * Design contract: docs/reference/binary-content-invariant-design-brief.md §4.3.
 */

import { z } from "zod";
import { safeTextPreview } from "./safe-text-preview.ts";

/**
 * A branded Zod schema for human-readable PDPP-safe text. Use this in
 * place of `z.string()` for any field declared by a connector schema as
 * human-readable text (titles, bodies, snippets, previews, message
 * content). Length caps and other refinements compose on top:
 *
 *   const bodySchema = pdppSafeText.max(10_000_000).nullable();
 *
 * Reference-shaped strings (IDs, URLs, regex-validated codes) do NOT
 * need this brand — they're already constrained by their structural
 * shape. Use this only where the field carries free-form human-readable
 * content that could in theory accept arbitrary bytes.
 */
export const pdppSafeText = z
  .string()
  .refine(
    (s) => {
      const result = safeTextPreview(s);
      return result.kind === "text" || result.kind === "empty";
    },
    {
      message:
        "must be PDPP-safe Unicode text (no U+0000, no forbidden control characters, valid UTF-8). " +
        "Binary or control-rich payloads MUST be stored in the blobs table.",
    }
  )
  .brand<"PdppSafeText">();

/**
 * The branded TypeScript type. Functions that accept `PdppSafeText`
 * carry the validation guarantee through the type system.
 */
export type PdppSafeText = z.infer<typeof pdppSafeText>;

/**
 * Shorthand for `pdppSafeText.nullable()`. Provided to make the
 * mechanical rollout less error-prone and to make schema intent
 * visually obvious.
 */
export const nullablePdppSafeText = pdppSafeText.nullable();
