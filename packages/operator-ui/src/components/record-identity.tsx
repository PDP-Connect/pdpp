// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * RecordIdentity — the ONE shared, markup-neutral record-identity cell.
 *
 * THE PROBLEM IT KILLS (THE-LENS Gate 3 "ONE unified record presentation
 * everywhere"; Part-0 "the same record looking different in two places"): before
 * this cell, a record's identity line rendered FOUR ways — the feed inlined its
 * own `<span>` identity, the per-stream table led every row with the raw `id` in
 * mono, the mobile RecordCard re-implemented a field-name `<dl>`, and the detail
 * H1 inlined its own `rowPrimary` call. Four copies = four drift paths.
 *
 * THE FIX: every surface (feed row, table leading cell, mobile card header,
 * detail H1) renders identity through THIS cell, over the SAME canonical
 * `RecordPreview` (`record-preview.ts`) the honesty engine already produces. A
 * record CANNOT render two ways because all four read one model through one
 * projection (`rowPrimary`/`rowSecondary`) through one view-adapter
 * (`recordIdentityView`) through this one cell.
 *
 * IT IS NOT A SECOND MODEL. `RecordPreview` stays the sole canonical object; this
 * file adds only a stateless view-adapter (reads slots the engine already
 * computed — no selection rules, no title guessing, no new heuristic) and the
 * presentational cell.
 *
 * RSC-PURITY CONSTRAINT (callable in the client feed AND the server table/detail):
 * NO `"use client"`, NO React hooks, NO browser/server side-effects, NO
 * server-only imports — a pure formatter of `RecordPreview` → JSX. Its only
 * imports are the engine projections (`rowPrimary`/`rowSecondary`) and the
 * `RecordKind`/`RecordPreview` types. It does NOT import `entryHasImage` (a
 * feed-entry helper): the image signal arrives ONLY as the surface-supplied
 * `hasImage` boolean prop, kept reliable/server-declared at each call site.
 *
 * MARKUP-NEUTRALITY (prior-art anti-pattern #5: a `<tr>`-coupled row can't live
 * in a feed): renders ONLY `<span>`s. The table wraps it in a `<td>`, the feed in
 * its `<li>`/`<button>`, the detail/peek header uses it inline.
 *
 * THE HONESTY INVARIANTS ARE CENTRALIZED HERE (THE-LENS Gate 1, enforced ONCE):
 *   - declared-or-honest-generic title (no field-name guessing — inherited from
 *     `buildRecordPreview`; the cell never adds a guess);
 *   - identity keys (id/uuid/`*_id`) are NEVER the visual title lead — they render
 *     ONLY as the quiet mono `data-rr-x="key"` token;
 *   - the primary content line is NEVER mono; mono only for the key + timestamp;
 *   - amounts are declared-only (delegated to the engine's `formatDeclaredAmount`
 *     path — the cell never re-formats money);
 *   - the image mark comes from the reliable surface-supplied `hasImage` prop —
 *     the cell never sniffs the preview for an image.
 */

import type { ReactElement } from "react";
import type { RecordKind } from "../lib/record-kind.ts";
import { type RecordPreview, rowPrimary, rowSecondary } from "../lib/record-preview.ts";

/**
 * The leading kind-glyph map (W1 row anatomy; prior art: Primer ActionList
 * `leadingVisual`, Sentry, Stripe). A CATEGORY marker derived from the record's
 * already-honest presentation `kind` — NOT content and NOT a content inference:
 * it lets the eye triage rows by category before reading. A short glyph keeps the
 * fixed slot narrow so every row's content left-aligns to one x.
 *
 * PROMOTED HERE from `explore-canvas.tsx` so the feed AND the table share ONE
 * glyph map, not two (the design's §5 consolidation: "one glyph source").
 */
export const KIND_GLYPHS: Record<RecordKind, string> = {
  message: "✉",
  money: "$",
  event: "◷",
  activity: "▣",
  reader: "¶",
  location: "⌖",
  titled: "▤",
  generic: "•",
};

/** The leading glyph for a record kind. Unknown/absent kind → a neutral dot. */
export function kindGlyph(kind: RecordKind | null | undefined): string {
  return (kind && KIND_GLYPHS[kind]) || "•";
}

/**
 * The stateless view-adapter (design §3): reads slots the engine already
 * computed. NO new model, NO fetch, NO selection rules. `preview` is the caller's
 * `buildRecordPreview` output (the ONE canonical model). Every value is read
 * straight off `RecordPreview` / its projection — never re-derived.
 */
export interface RecordIdentityView {
  /**
   * True when the primary did NOT come from a manifest-declared display role
   * (title / body / amount / actor) → quiet/generic treatment, NEVER a bold,
   * confident "authored title" weight. Mirrors `explore-canvas.tsx`'s `derived`.
   */
  isDerived: boolean;
  /** = preview?.kind ?? "generic" — leading glyph + a11y. */
  kind: RecordKind;
  /** = rowPrimary(preview, recordKey) — declared title → honest generic field → neutral fallback. */
  primary: string;
  /** = rowSecondary(preview) — the next distinct honest slot, or undefined. */
  secondary?: string;
}

/**
 * Project a `RecordPreview` into the identity view every surface renders. The
 * `isDerived` flag is the SAME `!declaredTitle` test the feed inlined — kept here
 * so it is computed once, not per surface.
 */
export function recordIdentityView(preview: RecordPreview | null, recordKey: string): RecordIdentityView {
  const declaredTitle = preview?.title ?? preview?.body ?? preview?.amount ?? preview?.author;
  return {
    isDerived: !declaredTitle,
    kind: preview?.kind ?? "generic",
    primary: rowPrimary(preview, recordKey),
    secondary: rowSecondary(preview),
  };
}

/** Host-surface layout role. Controls spacing + whether the secondary/key show. NOT a behavior switch. */
export type RecordIdentityVariant = "feed" | "table-cell" | "card" | "header";

export interface RecordIdentityProps {
  className?: string;
  /**
   * SURFACE-SUPPLIED reliable image signal (NOT preview-derived). The feed passes
   * `entryHasImage(entry)`; the table/detail pass their resolved
   * `blobAffordance?.state === "available"`. The cell renders the image mark iff
   * this is true and NEVER sniffs the preview for an image.
   */
  hasImage?: boolean;
  /** The canonical model the surface already built via `buildRecordPreview`. */
  preview: RecordPreview | null;
  /** Raw record key → quiet mono token (when shown); NEVER the visual title lead. */
  recordKey: string;
  /** Show the leading kind glyph. Default true. */
  showGlyph?: boolean;
  /** Show the quiet mono record-key token. Default: feed/card show it; table/header omit it. */
  showKey?: boolean;
  /** Host-surface layout role. Controls spacing + whether secondary/key show. */
  variant: RecordIdentityVariant;
}

function defaultShowKey(variant: RecordIdentityVariant): boolean {
  return variant === "feed" || variant === "card";
}

/**
 * The markup-NEUTRAL presentational cell. Renders ONLY `<span>`s:
 *   [glyph?] [image mark? — from the hasImage PROP] [primary (sans; weight-500 when
 *   !isDerived, generic weight when isDerived)] [secondary (muted sans)]
 *   [recordKey (mono, muted, when showKey)].
 *
 * Stable `data-rr-x` selectors (glyph/primary/secondary/key) make the anti-drift
 * assertions DOM-level, not snapshot-fragile.
 */
export function RecordIdentity({
  preview,
  recordKey,
  hasImage = false,
  variant,
  showGlyph = true,
  showKey,
  className,
}: RecordIdentityProps): ReactElement {
  const view = recordIdentityView(preview, recordKey);
  const showKeyResolved = showKey ?? defaultShowKey(variant);
  // The secondary rides alongside the primary on the feed/card; the table cell
  // and the detail H1 are dense single-line identity leads, so they suppress it
  // (their host already shows the supporting columns / the description row).
  const showSecondary = (variant === "feed" || variant === "card") && Boolean(view.secondary);
  const rootCls = ["rr-x-identity", `rr-x-identity--${variant}`, className].filter(Boolean).join(" ");
  // The primary content line: SANS always (mono ONLY on key/timestamp), weight by
  // declaration — a declared title earns weight-500; a derived/generic primary
  // (first honest field or the neutral key fallback) stays generic weight so an
  // id/uuid or an arbitrary key:value is never styled like an authored title.
  const primaryCls = ["rr-x-identity__primary", view.isDerived ? "is-derived" : ""].filter(Boolean).join(" ");
  return (
    <span className={rootCls} data-kind={view.kind}>
      {showGlyph ? (
        <span aria-hidden="true" className="rr-x-identity__glyph" data-kind={view.kind} data-rr-x="glyph">
          {kindGlyph(view.kind)}
        </span>
      ) : null}
      <span className="rr-x-identity__body">
        <span className={primaryCls} data-derived={String(view.isDerived)} data-rr-x="primary">
          {/* The image mark is gated ONLY by the surface-supplied hasImage prop —
              the reliable server-declared blob signal — never a preview sniff. */}
          {hasImage ? <span className="rr-x-mark">image</span> : null}
          {view.primary}
        </span>
        {showSecondary ? (
          <span className="rr-x-identity__secondary" data-rr-x="secondary">
            {view.secondary}
          </span>
        ) : null}
      </span>
      {/* The record key stays fully reachable but NEVER the visual lead: a quiet
          MONO token (mono is correct here — it is a machine value), muted. */}
      {showKeyResolved ? (
        <span className="rr-x-identity__key" data-rr-x="key">
          {recordKey}
        </span>
      ) : null}
    </span>
  );
}
