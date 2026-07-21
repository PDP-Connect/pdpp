// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Record renderer — the ONE record body for the whole console.
 *
 * Ported from the Recordroom design (`rr-record.jsx`) and rebound to the REAL
 * record shape. `RecordBody` is the single record renderer — Explore's
 * inspector, Sources' previews, and everywhere a record is shown compose this.
 *
 * The kind dispatch (see `kindOf` in record-fields.ts) chooses the body:
 *   money     → a hero amount (the amount IS the record) + dual-key rows
 *   attachment→ an inline image (server-declared blob, or last-resort heuristic) + rows
 *   body      → a reading region for the long text + rows
 *   generic   → the dual-key field list
 *
 * Images:
 *   The PRIMARY image signal is the server-declared `blobAffordance` a caller
 *   passes in (built by operator-ui `buildBlobAffordance` from
 *   `field_capabilities.type === "blob"` + the RS `fetch_url`). When present and
 *   available it drives the inline image. Only when NO declared blob is supplied
 *   does the body fall back to the heuristic `findImageField` (first field whose
 *   value looks like an image URL/data-URI) — a LAST-RESORT path for callers
 *   that have no declared capability, never the primary one. We never fabricate
 *   an image; relationship rails are composed by callers that hold declared
 *   `expand_capabilities` (the records page and the Explore inspector).
 */
import "./components.css";
import {
  type DeclaredFieldTypes,
  findImageField,
  isLongVal,
  kindOf,
  labelFor,
  nounFor,
  resolveFieldValue,
} from "./record-fields.ts";

// ─── RecordField — the dual-key row ───────────────────────────────

interface RecordFieldProps {
  /** The declared presentation type for this field (drives money formatting). */
  declaredType?: string;
  /** The wire key — what a client literally receives. Mono voice. */
  fieldKey: string;
  /** The raw value from `data`. */
  value: unknown;
}

/**
 * One field row: human label + wire key on the left, value on the right.
 * Money values are tabular and bold; empty values render an italic token.
 */
export function RecordField({ fieldKey, value, declaredType }: RecordFieldProps) {
  const resolved = resolveFieldValue(value, declaredType);
  const valClass = ["rr-fld__val", resolved.money ? "is-num" : undefined, resolved.empty ? "is-empty" : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <div className="rr-fld">
      <span className="rr-fld__id">
        <span className="rr-fld__label">{labelFor(fieldKey)}</span>
        <span className="rr-fld__wire">{fieldKey}</span>
      </span>
      <span className={valClass}>{resolved.text}</span>
    </div>
  );
}

// ─── RecordBody — kind-aware record renderer ──────────────────────

/**
 * Server-declared blob affordance for a record — the SAME shape operator-ui's
 * `buildBlobAffordance` produces (`ExplorerBlobAffordance`). Declared here as a
 * structural type so the framework-light ink-carbon kit does not depend on
 * operator-ui; callers pass the already-computed affordance straight through.
 */
export interface RecordBlobAffordance {
  fieldName: string;
  href?: string;
  reason?: string;
  state: "available" | "unavailable";
}

interface RecordBodyProps {
  /**
   * Server-declared blob/image for this record (from `field_capabilities` via
   * `buildBlobAffordance`). When supplied and available it is the PRIMARY image
   * source; the heuristic `findImageField` is only used when this is absent.
   */
  blobAffordance?: RecordBlobAffordance;
  className?: string;
  /** The record's `data` payload — where ALL real fields live. */
  data: Record<string, unknown>;
  /** Declared field types from `field_capabilities` (money detection). */
  declaredTypes?: DeclaredFieldTypes;
  /** The stream this record belongs to (drives the derived-title noun). */
  stream: string;
}

const MONEY_HERO_KEYS = ["net_pay", "amount", "gross_pay"] as const;
const MONEY_CAPTION_KEYS = ["merchant", "employer", "category", "period_end", "date"] as const;

export function RecordBody({ data, stream, declaredTypes = {}, className, blobAffordance }: RecordBodyProps) {
  const entries = Object.entries(data);
  // Graceful degradation: a record with no payload fields states its kind in
  // the system's voice rather than rendering an empty surface.
  if (entries.length === 0) {
    return (
      <div className={["rr-recbody", className].filter(Boolean).join(" ")}>
        <p className="rr-recbody__empty">No fields on this {nounFor(stream)}.</p>
      </div>
    );
  }

  const kind = kindOf(data, declaredTypes);
  const has = (key: string) => Object.hasOwn(data, key);

  // Money hero: the first present money key becomes the headline amount.
  const heroKey = kind === "money" ? MONEY_HERO_KEYS.find((k) => has(k)) : undefined;
  const heroResolved = heroKey ? resolveFieldValue(data[heroKey], declaredTypes[heroKey]) : null;

  // Image slot. PRIMARY path: a server-declared blob — the caller renders the
  // blob/image itself (it has the grant-scoped `fetch_url` + mime), so here we
  // only keep its field out of the inline-heuristic image and let the caller
  // own the visual. LAST-RESORT fallback (only when NO declared blob is passed):
  // the heuristic `findImageField` for a field with no declared capability.
  const heuristicImageField = kind === "attachment" ? findImageField(data) : null;
  const imageField = blobAffordance ? null : heuristicImageField;
  // A declared blob field is rendered by the caller (e.g. the Explore inspector
  // BlobAffordanceView), so drop it from the dual-key rows to avoid showing the
  // raw blob_ref object twice.
  const declaredBlobField = blobAffordance?.fieldName;

  // Long-text reading region: the first long string field.
  const longEntry = entries.find(([k, v]) => isLongVal(k, v));

  // Caption parts for the money hero (merchant/employer/etc.).
  const captionParts: string[] =
    kind === "money"
      ? MONEY_CAPTION_KEYS.map((k) => {
          if (!has(k)) {
            return null;
          }
          const r = resolveFieldValue(data[k], declaredTypes[k]);
          return r.empty ? null : r.text;
        }).filter((x): x is string => x !== null)
      : [];

  // Remaining rows: everything not promoted to hero / image / reading region,
  // and not the declared blob field (the caller renders that affordance).
  const skip = new Set<string>();
  if (heroKey) {
    skip.add(heroKey);
  }
  if (imageField) {
    skip.add(imageField[0]);
  }
  if (declaredBlobField) {
    skip.add(declaredBlobField);
  }
  if (longEntry) {
    skip.add(longEntry[0]);
  }
  const rows = entries.filter(([k]) => !skip.has(k));

  return (
    <div className={["rr-recbody", className].filter(Boolean).join(" ")}>
      {heroKey && heroResolved ? (
        <div className="rr-hero rr-hero--money">
          <span className={["rr-hero__amount", heroResolved.negative ? "is-neg" : undefined].filter(Boolean).join(" ")}>
            {heroResolved.text}
          </span>
          {captionParts.length > 0 && <span className="rr-hero__cap">{captionParts.slice(0, 2).join(" · ")}</span>}
          <span className="rr-hero__wire">
            {labelFor(heroKey)} · <span className="rr-fld__wire">{heroKey}</span>
          </span>
        </div>
      ) : null}

      {imageField ? (
        // Derived image — the heuristic URL is rendered as a CSS background so
        // an arbitrary (un-sized, un-optimizable) remote record field can paint
        // inline without an <img> element. The caption names the source field.
        <figure className="rr-rec-image">
          <span aria-hidden="true" className="rr-rec-image__img" style={{ backgroundImage: `url(${imageField[1]})` }} />
          <figcaption className="rr-rec-image__cap">
            {labelFor(imageField[0])} · <span className="rr-fld__wire">{imageField[0]}</span>
          </figcaption>
        </figure>
      ) : null}

      {longEntry ? (
        <div className="rr-bodytext">
          <span className="rr-bodytext__label">
            {labelFor(longEntry[0])} <span className="rr-fld__wire">{longEntry[0]}</span>
          </span>
          <p className="rr-bodytext__text">{String(longEntry[1])}</p>
        </div>
      ) : null}

      {rows.length > 0 && (
        <div className="rr-flds">
          {rows.map(([k, v]) => (
            <RecordField declaredType={declaredTypes[k]} fieldKey={k} key={k} value={v} />
          ))}
        </div>
      )}
    </div>
  );
}

// The pure record helpers (labelFor, kindOf, displayTitle, resolveFieldValue,
// etc.) are NOT re-exported here — import them from "./record-fields.ts" or the
// kit barrel `index.ts`, which surfaces them directly. This file exports only
// the React renderers, keeping the module graph flat.
