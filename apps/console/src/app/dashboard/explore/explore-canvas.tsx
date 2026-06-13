/**
 * ExploreCanvas — the Ink Carbon "Recordroom · Explore" reading room.
 *
 * The deepest console view: one record viewer for the whole product, with
 * owner-grade query power (typed operators + a machine-parity query line),
 * instance-true facets, day-grouped feed, and a record inspector that always
 * shows the full owner view plus what stays withheld and what's connected.
 *
 * ── DATA SEAM (real, not mocked) ──────────────────────────────────
 * This component consumes the SAME `RecordsExplorerData` the live page already
 * assembles via `assembleExplorerData(...)` (see page.tsx). It renders that
 * shape; it never calls a data source itself. URL state (`q`, `connection`,
 * `stream`, `since`, `until`, `peek`, `order`) is the source of truth — every
 * server-backed interaction navigates with a local `buildHref`, so the SSR
 * re-fetch stays authoritative. Client-only operators filter the already-loaded
 * feed in the browser (see explore-grammar.ts for the honest API mapping).
 *
 * ── SERVER-DECLARED SIGNALS (no client-side reinvention) ──────────
 *   - Blobs / images: every feed entry and peek field carries a server-declared
 *     `blobAffordance` (built by operator-ui `buildBlobAffordance` from
 *     `field_capabilities.type === "blob"` + the RS-decorated `fetch_url`). The
 *     feed badge and the inspector blob render from THAT signal only — never a
 *     URL regex.
 *   - Relationships: resolved server-side from declared `expand_capabilities`
 *     and connector manifests via the proven `records/lib/relationships.ts`
 *     helpers (the same the records detail page uses), and passed in as plain
 *     `peekRelationships` props. The rail is omitted when no declared edge
 *     exists; it never inspects payload fields to guess at links.
 *   - Grant lens: the live data carries no per-watcher projection. The peek
 *     fields' `state: "withheld"` IS the only real projection-enforcement
 *     signal, so we render the owner full view and surface withheld fields as
 *     "Stays with you" wherever the read contract reports them. When no
 *     projection is active there is nothing withheld and we say so.
 *   - field:value etc.: a `field:value` over a declared exact-filterable field
 *     is a real server `filter[]` param; only genuinely server-inexpressible
 *     operators stay client-side, and the compiled line marks those honestly.
 */
"use client";

import { feedDescription, feedSectionTitle } from "@pdpp/operator-ui/components/views/explorer-utils";
import {
  type ExplorerBlobAffordance,
  type ExplorerConnectionFacet,
  type ExplorerFeedEntry,
  type ExplorerPeekData,
  type ExplorerWarning,
  explorerPeekParam,
  type RecordsExplorerData,
} from "@pdpp/operator-ui/components/views/records-explorer-view";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CopyMono,
  displayTitle,
  IcInput,
  RecordBody,
  Sheet,
  SheetBody,
  SheetFoot,
  SheetHead,
  SheetSerial,
  SheetTitle,
} from "@/components/ink-carbon/index.ts";
import {
  buildCompiledQuery,
  hasClientSideTokens,
  type ParsedQuery,
  parseQuery,
  removeToken,
} from "./explore-grammar.ts";
import type { PeekRelationships } from "./explore-peek-relationships.ts";

const FEED_LIMIT = 50;
const IMAGE_MIME_RE = /^image\//i;
const UNDERSCORE_RE = /_/g;

/**
 * De-duplicate warnings by (code, message) so the warning list never renders
 * two elements with the same React key. The assembler already merges fan-in
 * failures into a single `partial_fan_in` summary; this is the last-line guard
 * for any per-stream warning (e.g. `search_meta_warning`) that could repeat.
 */
function dedupeWarnings(warnings: readonly ExplorerWarning[]): ExplorerWarning[] {
  const seen = new Set<string>();
  const out: ExplorerWarning[] = [];
  for (const w of warnings) {
    const sig = `${w.code}:${w.message}`;
    if (!seen.has(sig)) {
      seen.add(sig);
      out.push(w);
    }
  }
  return out;
}

type SortOrder = "newest" | "oldest";

interface ExploreCanvasProps {
  data: RecordsExplorerData;
  /**
   * The Explore route base path (e.g. "/dashboard/explore"). A plain string —
   * NOT the function-bearing `Routes` object — because this is a Client
   * Component and RSC cannot serialize the route helper methods across the
   * server→client boundary. The page passes `dashboardRoutes.section.explore`.
   */
  explorePath: string;
  /** Display sort order (newest|oldest) read from the URL by the page. */
  order?: SortOrder;
  /**
   * Relationship links for the inspected record, resolved server-side from
   * declared `expand_capabilities` + connector manifests via the proven
   * `records/lib/relationships.ts` helpers. Plain serializable data; `null` when
   * no record is open or no readable metadata was available.
   */
  peekRelationships?: PeekRelationships | null;
}

interface HrefOpts {
  connectionIds?: readonly string[];
  peek?: string;
  query?: string;
  since?: string;
  streams?: readonly string[];
  until?: string;
}

/**
 * Local href builder over the explore base path. Mirrors operator-ui's
 * `buildExplorerHref` param contract (q / connection* / stream* / since / until
 * / peek) but takes a plain base-path string so no function-bearing object
 * crosses the RSC boundary.
 */
function buildHref(base: string, opts: HrefOpts): string {
  const params = new URLSearchParams();
  if (opts.query) {
    params.set("q", opts.query);
  }
  for (const id of opts.connectionIds ?? []) {
    params.append("connection", id);
  }
  for (const s of opts.streams ?? []) {
    params.append("stream", s);
  }
  if (opts.since) {
    params.set("since", opts.since);
  }
  if (opts.until) {
    params.set("until", opts.until);
  }
  if (opts.peek) {
    params.set("peek", opts.peek);
  }
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

// ─── Client-side feed predicate ───────────────────────────────────
//
// Applies ONLY the operators the server cannot express. A `field:value` over a
// declared exact-filterable field is a server `filter[]` param (the server
// already narrowed the feed), so it is NOT re-applied here; only undeclared
// fields fall back to this honest in-window text match.

// `has:link` is genuinely server-inexpressible (no declared "link" capability),
// so it remains an honest client-side text match over the preview — clearly a
// last-resort fallback, never used for image/blob detection.
const URL_LINK_RE = /^https?:\/\//i;

function entryHaystack(entry: ExplorerFeedEntry): string {
  const p = entry.preview;
  const parts = [entry.stream, entry.summary, p?.title, p?.body, p?.author, p?.amount];
  return parts
    .filter((x): x is string => typeof x === "string")
    .join(" ")
    .toLowerCase();
}

function entryHasImage(entry: ExplorerFeedEntry): boolean {
  // Declared signal ONLY: the stream declared a `blob`-typed field and the RS
  // decorated it with a usable `fetch_url`. No URL regex, no payload guessing.
  return entry.blobAffordance?.state === "available";
}

function entryHasLink(entry: ExplorerFeedEntry): boolean {
  const candidates = [entry.preview?.body, entry.preview?.title, entry.summary];
  return candidates.some((c) => typeof c === "string" && URL_LINK_RE.test(c));
}

function passesClientFilter(
  entry: ExplorerFeedEntry,
  parsed: ParsedQuery,
  serverFilterableFields: ReadonlySet<string>
): boolean {
  if (parsed.role) {
    const author = entry.preview?.author?.toLowerCase() ?? "";
    if (!author.includes(parsed.role)) {
      return false;
    }
  }
  if (parsed.hasImage && !entryHasImage(entry)) {
    return false;
  }
  if (parsed.hasLink && !entryHasLink(entry)) {
    return false;
  }
  // `is:folded` has no real analog (the feed is never folded), so it matches
  // nothing rather than pretending — an honest empty result for an honest token.
  if (parsed.folded) {
    return false;
  }
  // Only undeclared fields are post-filtered here. Declared exact-filterable
  // fields were applied by the server, so re-filtering them client-side would
  // be redundant (and could wrongly drop rows on a fuzzy text mismatch).
  const clientFields = parsed.fields.filter((f) => !serverFilterableFields.has(f.key.toLowerCase()));
  if (clientFields.length > 0) {
    const hay = entryHaystack(entry);
    if (!clientFields.every((f) => hay.includes(f.key.toLowerCase()) || hay.includes(f.value))) {
      return false;
    }
  }
  return true;
}

// ─── Pure derivations (kept out of the component to bound complexity) ──

const DAY_FMT = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
const RANGE_DAYS: Record<"today" | "7d" | "30d", number> = { today: 0, "7d": 6, "30d": 29 };

/** ISO `since` for a relative range, or "" for "all". */
function sinceForRange(range: "today" | "7d" | "30d" | "all"): string {
  if (range === "all") {
    return "";
  }
  const since = Date.now() - RANGE_DAYS[range] * 86_400_000;
  return new Date(since).toISOString().slice(0, 10);
}

function dayLabel(day: string): string {
  if (!day) {
    return "Undated";
  }
  const ms = Date.parse(`${day}T00:00:00Z`);
  return Number.isNaN(ms) ? "Undated" : DAY_FMT.format(new Date(ms));
}

interface DayGroup {
  day: string;
  entries: ExplorerFeedEntry[];
  label: string;
}

/** Group an already-sorted feed into contiguous day buckets. */
function groupVisibleFeedByDay(feed: readonly ExplorerFeedEntry[]): DayGroup[] {
  const groups: DayGroup[] = [];
  let current: DayGroup | null = null;
  for (const entry of feed) {
    const day = typeof entry.displayAt === "string" ? entry.displayAt.slice(0, 10) : "";
    if (!current || current.day !== day) {
      current = { day, label: dayLabel(day), entries: [] };
      groups.push(current);
    }
    current.entries.push(entry);
  }
  return groups;
}

/**
 * Stream facet rows: instance-true when exactly one connection is selected
 * (counts that connection's streams in the visible window); otherwise a
 * NAME-match across all connections (overlap is incidental, count = #connections).
 */
function computeStreamFacets(
  data: RecordsExplorerData,
  parsed: ParsedQuery,
  scoped: ExplorerConnectionFacet | null,
  serverFilterableFields: ReadonlySet<string>
): Array<readonly [string, number]> {
  if (scoped) {
    const counts = new Map<string, number>(scoped.streams.map((s) => [s, 0]));
    for (const e of data.feed) {
      if (passesClientFilter(e, parsed, serverFilterableFields) && e.connectionId === scoped.connectionId) {
        counts.set(e.stream, (counts.get(e.stream) ?? 0) + 1);
      }
    }
    return [...counts.entries()];
  }
  const conSel = new Set(data.selectedConnectionIds);
  const byName = new Map<string, Set<string>>();
  for (const c of data.connections) {
    if (conSel.size > 0 && !conSel.has(c.connectionId)) {
      continue;
    }
    for (const s of c.streams) {
      const set = byName.get(s) ?? new Set<string>();
      set.add(c.connectionId);
      byName.set(s, set);
    }
  }
  return [...byName.entries()].map(([name, set]) => [name, set.size] as const).sort((a, b) => b[1] - a[1]);
}

// ─── Inspector body parsing ───────────────────────────────────────
//
// The peek carries the record body as pretty JSON + a field-by-field model
// (with `withheld` markers). RecordBody renders the OWNER full view from the
// parsed body; the withheld set comes from the field model.

function parsePeekBody(peek: ExplorerPeekData): Record<string, unknown> {
  if (!peek.bodyJson) {
    return {};
  }
  try {
    const parsed = JSON.parse(peek.bodyJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// ─── Blob affordance (server-declared) ────────────────────────────
//
// Driven ONLY by the server-declared `blobAffordance` on a peek field — built by
// operator-ui `buildBlobAffordance` from `field_capabilities.type === "blob"`
// plus the RS-decorated `fetch_url`. We never sniff a URL to decide a field is a
// blob; the declaration is authoritative.

/** The single blob affordance for the peeked record, if any field declares one. */
function peekBlobAffordance(peek: ExplorerPeekData): ExplorerBlobAffordance | null {
  for (const field of peek.fields) {
    if (field.blobAffordance) {
      return field.blobAffordance;
    }
  }
  return null;
}

/**
 * The DECLARED mime type for a blob field, read from the record body's
 * `blob_ref` shape (`{ blob_id, mime_type, fetch_url }`) at `fieldName`. This is
 * the declared mime the connector emits — NOT a guess from the URL — so the
 * inline-image decision is driven by the declaration.
 */
function declaredBlobMime(body: Record<string, unknown>, fieldName: string): string | undefined {
  const ref = body[fieldName];
  if (!(ref && typeof ref === "object") || Array.isArray(ref)) {
    return;
  }
  const mime = (ref as { mime_type?: unknown }).mime_type;
  return typeof mime === "string" && mime.length > 0 ? mime : undefined;
}

/**
 * Render the declared blob, Ink Carbon styled. An available image mime paints
 * inline (grant-scoped, same-origin `fetch_url`); any other available blob is an
 * "Open blob →" link; an unavailable blob is a muted chip carrying the reason.
 * The mime is the connector's DECLARED `blob_ref.mime_type`, never inferred from
 * a URL.
 */
function BlobAffordanceView({
  affordance,
  mimeType,
}: {
  affordance: ExplorerBlobAffordance;
  mimeType: string | undefined;
}) {
  if (affordance.state === "unavailable") {
    return (
      <span className="rr-x-blob rr-x-blob--off">{affordance.reason ?? "Blob unavailable under projection."}</span>
    );
  }
  if (!affordance.href) {
    return null;
  }
  // Inline only when the connector's DECLARED mime is an image. No URL sniffing.
  const isImage = mimeType ? IMAGE_MIME_RE.test(mimeType) : false;
  return (
    <div className="rr-x-blob">
      {isImage ? (
        // Declared image blob — same-origin, grant-scoped fetch_url.
        // biome-ignore lint/performance/noImgElement: blob fetch_url is a grant-scoped RS URL, not a static asset Next can optimize.
        // biome-ignore lint/correctness/useImageSize: a remote record blob has no known intrinsic dimensions; the CSS box constrains it.
        <img alt={affordance.fieldName} className="rr-x-blob__img" src={affordance.href} />
      ) : null}
      <a className="rr-x-blob__open" href={affordance.href}>
        Open blob →
      </a>
    </div>
  );
}

// ─── Facet rail ───────────────────────────────────────────────────

function ConnectionFacets({
  connections,
  selected,
  countFor,
  onToggle,
}: {
  connections: readonly ExplorerConnectionFacet[];
  selected: readonly string[];
  countFor: (connectionId: string) => number;
  onToggle: (connectionId: string) => void;
}) {
  return (
    <div className="rr-x-facets">
      <span className="rr-x-facets__label">Connections</span>
      {connections.map((c) => {
        const on = selected.includes(c.connectionId);
        const n = countFor(c.connectionId);
        return (
          <button
            className={["rr-x-facet", on ? "is-on" : ""].filter(Boolean).join(" ")}
            key={c.connectionId}
            onClick={() => onToggle(c.connectionId)}
            type="button"
          >
            <span className="rr-x-facet__name">{c.displayName}</span>
            <span className="rr-x-facet__flag" />
            <span className="rr-x-facet__n">{n || "—"}</span>
          </button>
        );
      })}
      {connections.length === 0 && <span className="rr-x-facets__note">No connections configured yet.</span>}
    </div>
  );
}

function StreamFacets({
  streamFacets,
  scopedToConnection,
  selected,
  onToggle,
}: {
  streamFacets: ReadonlyArray<readonly [string, number]>;
  scopedToConnection: ExplorerConnectionFacet | null;
  selected: readonly string[];
  onToggle: (stream: string) => void;
}) {
  return (
    <div className="rr-x-facets">
      <span className="rr-x-facets__label">
        {scopedToConnection ? `Streams — ${scopedToConnection.displayName}` : "Stream names"}
      </span>
      {!scopedToConnection && (
        <span className="rr-x-facets__note">names overlap across connections — this filters by name</span>
      )}
      {streamFacets.map(([s, n]) => {
        const on = selected.includes(s);
        return (
          <button
            className={["rr-x-facet", on ? "is-on" : ""].filter(Boolean).join(" ")}
            key={s}
            onClick={() => onToggle(s)}
            type="button"
          >
            <span className="rr-x-facet__name rr-x-facet__name--mono">{s}</span>
            <span className="rr-x-facet__flag" />
            <span className="rr-x-facet__n">{n}</span>
          </button>
        );
      })}
      {streamFacets.length === 0 && <span className="rr-x-facets__note">No streams in view.</span>}
    </div>
  );
}

// ─── Feed row ─────────────────────────────────────────────────────

function FeedRow({
  entry,
  selected,
  onSelect,
  onArrow,
}: {
  entry: ExplorerFeedEntry;
  selected: boolean;
  onSelect: () => void;
  /** Arrow-key feed nav handled on the interactive row button. */
  onArrow: (direction: -1 | 1) => void;
}) {
  const title = displayTitle({
    data: entry.preview?.title ? { name: entry.preview.title } : {},
    display_name: entry.preview?.title,
    stream: entry.stream,
  });
  const derived = title.kicker !== null;
  const role = entry.preview?.author ?? (entry.kind === "message" ? "message" : undefined);
  const snippet = entry.preview?.body ?? entry.preview?.amount ?? entry.summary;
  return (
    <button
      className={["rr-x-row", selected ? "is-selected" : ""].filter(Boolean).join(" ")}
      data-feed-row
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          onArrow(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          onArrow(-1);
        }
      }}
      type="button"
    >
      <span className="rr-x-row__attr">
        <span className="rr-x-row__stream">{entry.stream}</span>
        <span className="rr-x-row__con">{entry.connectionDisplayName ?? entry.connectorId}</span>
        {entry.retrievalMode && <span className="rr-x-row__rel">{entry.retrievalMode}</span>}
      </span>
      <span className={["rr-x-row__title", derived ? "is-derived" : ""].filter(Boolean).join(" ")}>
        {entryHasImage(entry) ? <span className="rr-x-mark">image</span> : null}
        {derived ? title.primary : (entry.preview?.title ?? entry.summary)}
      </span>
      {snippet && snippet !== entry.preview?.title && (
        <span className="rr-x-row__snippet">
          {role && <span className="rr-x-role">{role}</span>}
          {snippet}
        </span>
      )}
    </button>
  );
}

// ─── Inspector ────────────────────────────────────────────────────

function Inspector({
  peek,
  relationships,
}: {
  peek: ExplorerPeekData | null;
  relationships: PeekRelationships | null;
}) {
  if (!peek) {
    return (
      <Sheet className="rr-inspector rr-inspector--empty">
        <SheetBody className="rr-x-empty">
          <span className="rr-x-empty__eyebrow">The reading room</span>
          <p className="rr-x-empty__line">
            Pick a record to read it in full — every field, the call that reads it, and what stays withheld.
          </p>
          <dl className="rr-x-empty__preview">
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">Fields</dt>
              <dd className="rr-x-empty__preview-v">label + the wire key a client receives</dd>
            </div>
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">The call</dt>
              <dd className="rr-x-empty__preview-v">the exact request that reads this record</dd>
            </div>
            <div className="rr-x-empty__preview-row">
              <dt className="rr-x-empty__preview-k">Withheld</dt>
              <dd className="rr-x-empty__preview-v">what stays with you, never shared</dd>
            </div>
          </dl>
        </SheetBody>
      </Sheet>
    );
  }

  const body = parsePeekBody(peek);
  // Declared field types from the read contract (`field_capabilities[].type`)
  // drive money formatting in RecordBody — e.g. a `currency` amount of -640
  // renders as -$6.40, not -640. Mirrors the assembler's peek-field model.
  const declaredTypes: Record<string, string> = {};
  for (const f of peek.fields) {
    if (f.type) {
      declaredTypes[f.name] = f.type;
    }
  }
  const withheld = peek.fields.filter((f) => f.state === "withheld");
  const visibleCount = peek.fields.filter((f) => f.state === "visible").length;
  const totalDeclared = peek.fields.length;
  // Server-declared blob (if any field declares one) + its declared mime — read
  // from the connector's `blob_ref.mime_type`, never inferred from the URL.
  const blob = peekBlobAffordance(peek);
  const blobMime = blob ? declaredBlobMime(body, blob.fieldName) : undefined;
  const relatedLinks = relationships?.relatedLinks ?? [];
  const parentBackLinks = relationships?.parentBackLinks ?? [];
  const reverseChildListLinks = relationships?.reverseChildListLinks ?? [];
  const hasRelationships = relatedLinks.length > 0 || parentBackLinks.length > 0 || reverseChildListLinks.length > 0;

  return (
    <Sheet className="rr-inspector">
      <SheetHead>
        <SheetTitle>{peek.stream}</SheetTitle>
        <SheetSerial>
          <CopyMono text={peek.recordId} />
        </SheetSerial>
      </SheetHead>
      <SheetBody>
        {/* Grant lens. Live data has no per-watcher projection, so the active
            view is the owner's. When a projection withholds fields, the read
            contract reports them below — that is the only honest lens signal. */}
        <div className="rr-ex-lens">
          <span className="rr-ex-lens__label">read it as</span>
          <span className="rr-x-facets__note">
            You — the owner full view. Watchers read a projection enforced on every read; withheld fields are listed
            below when a projection is active.
          </span>
        </div>

        {peek.error ? (
          <p className="rr-x-warn__msg">{peek.error}</p>
        ) : (
          <RecordBody
            blobAffordance={blob ?? undefined}
            data={body}
            declaredTypes={declaredTypes}
            stream={peek.stream}
          />
        )}

        {/* Server-declared blob/image. Driven by the field's `blobAffordance`,
            never a URL regex. Available image mimes paint inline. */}
        {blob && <BlobAffordanceView affordance={blob} mimeType={blobMime} />}

        {withheld.length > 0 && (
          <div className="rr-ex-keep">
            <span className="rr-ex-keep__label">Stays with you</span>
            <span className="rr-ex-keep__fields">{withheld.map((f) => f.name).join(" · ")}</span>
            <span className="rr-ex-keep__note">
              {withheld.length} {withheld.length === 1 ? "field" : "fields"} never leave your server under the active
              projection — never sent, not blacked out.
            </span>
          </div>
        )}

        {/* Connected records. Links are resolved server-side from declared
            `expand_capabilities` + manifests (one source of truth:
            records/lib/relationships.ts) — navigable edges are protocol links,
            advisory (ungranted/underspecified) relations are muted text. */}
        {hasRelationships && (
          <div className="rr-x-rel">
            <span className="rr-ex-keep__label">Connected</span>
            {parentBackLinks.map((link) => (
              <a
                className="rr-x-rel__row rr-x-rel__row--link"
                href={link.href}
                key={`parent:${link.parentStream}:${link.childParentKeyField}`}
              >
                <span className="rr-x-rel__k">{link.parentStream}</span>
                <span className="rr-x-rel__v">{link.childParentKeyField} → parent</span>
              </a>
            ))}
            {relatedLinks.map((link) =>
              link.navigable && link.href ? (
                <a className="rr-x-rel__row rr-x-rel__row--link" href={link.href} key={`rel:${link.relation}`}>
                  <span className="rr-x-rel__k">{link.relation}</span>
                  <span className="rr-x-rel__v">{link.cardinality} →</span>
                </a>
              ) : (
                <div className="rr-x-rel__row rr-x-rel__row--inert" key={`rel:${link.relation}`} title={link.advisory}>
                  <span className="rr-x-rel__k">{link.relation}</span>
                  <span className="rr-x-rel__v">{link.advisory ?? `no related ${link.relation}`}</span>
                </div>
              )
            )}
            {reverseChildListLinks.map((link) => (
              <a
                className="rr-x-rel__row rr-x-rel__row--link"
                href={link.href}
                key={`reverse:${link.childStream}:${link.foreignKey}`}
              >
                <span className="rr-x-rel__k">{link.childStream}</span>
                <span className="rr-x-rel__v">has_many →</span>
              </a>
            ))}
          </div>
        )}
      </SheetBody>
      <SheetFoot>
        <div className="rr-x-compiled">
          <span className="rr-x-compiled__label">the read this record came from:</span>
          <CopyMono text={`GET ${peek.readUrl}`} />
        </div>
        <span className="rr-x-facets__note">
          {withheld.length > 0
            ? `${visibleCount} of ${totalDeclared} fields cross under the active projection · enforced on every read`
            : `${totalDeclared} fields · readable by you`}
        </span>
      </SheetFoot>
    </Sheet>
  );
}

// ─── ExploreCanvas ────────────────────────────────────────────────

export function ExploreCanvas({ data, explorePath, order = "newest", peekRelationships = null }: ExploreCanvasProps) {
  const router = useRouter();

  // The facet rail is a <details> that renders CLOSED (feed-first on phones).
  // On wide viewports we open it so the disclosure state matches the always-
  // shown desktop rail, and we keep it in sync across resizes. Desktop CSS
  // force-shows the body regardless, so first paint never hides desktop facets.
  const railRef = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const rail = railRef.current;
    if (!rail) {
      return;
    }
    const mql = window.matchMedia("(min-width: 861px)");
    const sync = () => {
      rail.open = mql.matches;
    };
    sync();
    mql.addEventListener("change", sync);
    return () => mql.removeEventListener("change", sync);
  }, []);

  // The search input holds local text; server tokens commit on Enter, while
  // client-only operators filter live as you type.
  const [draft, setDraft] = useState(data.query);
  useEffect(() => setDraft(data.query), [data.query]);

  const parsed = useMemo(() => parseQuery(draft), [draft]);
  const committedParsed = useMemo(() => parseQuery(data.query), [data.query]);

  // Server exact-filterable field names (declared `field_capabilities`). A
  // `field:value` over one of these was applied by the server, so it is excluded
  // from the client-side post-filter and rendered as a real param in the
  // compiled line.
  const serverFilterableFields = useMemo(
    () => new Set(data.serverFilterableFields.map((f) => f.toLowerCase())),
    [data.serverFilterableFields]
  );

  // Server-backed slice of the feed is already scoped by the SSR fetch
  // (selected connections, streams, since/until, free-text q, and declared
  // exact-match filters). Only server-inexpressible operators narrow further.
  const visibleFeed = useMemo(() => {
    let list = data.feed.filter((e) => passesClientFilter(e, parsed, serverFilterableFields));
    if (order === "oldest") {
      list = [...list].reverse();
    }
    return list;
  }, [data.feed, parsed, order, serverFilterableFields]);

  // Facet counts: reactive over the CURRENTLY VISIBLE feed, ignoring the
  // facet's own axis (a connection facet counts rows regardless of connection
  // selection; a stream facet ignores stream selection). Honest within the
  // loaded window — labeled "in view" by the count line.
  const countForConnection = useCallback(
    (connectionId: string) => {
      const streamSel = new Set(data.selectedStreams);
      return data.feed.filter((e) => {
        if (!passesClientFilter(e, parsed, serverFilterableFields)) {
          return false;
        }
        if (streamSel.size > 0 && !streamSel.has(e.stream)) {
          return false;
        }
        return e.connectionId === connectionId;
      }).length;
    },
    [data.feed, data.selectedStreams, parsed, serverFilterableFields]
  );

  // Stream facet: instance-true when exactly one connection is selected
  // (counts that connection's streams); otherwise a NAME-match across all
  // connections (overlap is incidental, surfaced as "<n> conn").
  const scopedConnection = useMemo(() => {
    if (data.selectedConnectionIds.length !== 1) {
      return null;
    }
    return data.connections.find((c) => c.connectionId === data.selectedConnectionIds[0]) ?? null;
  }, [data.connections, data.selectedConnectionIds]);

  const streamFacets = useMemo(
    () => computeStreamFacets(data, parsed, scopedConnection, serverFilterableFields),
    [data, parsed, scopedConnection, serverFilterableFields]
  );

  // ── Navigation (server-backed state lives in the URL) ──
  const navigate = useCallback(
    (opts: {
      query?: string;
      connectionIds?: string[];
      streams?: string[];
      since?: string;
      until?: string;
      peek?: string;
      order?: SortOrder;
    }) => {
      const href = buildHref(explorePath, {
        query: opts.query ?? data.query,
        connectionIds: opts.connectionIds ?? data.selectedConnectionIds,
        streams: opts.streams ?? data.selectedStreams,
        since: opts.since ?? data.since,
        until: opts.until ?? data.until,
        peek: opts.peek,
      });
      const nextOrder = opts.order ?? order;
      const withOrder = nextOrder === "oldest" ? `${href}${href.includes("?") ? "&" : "?"}order=oldest` : href;
      router.push(withOrder);
    },
    [router, explorePath, data.query, data.selectedConnectionIds, data.selectedStreams, data.since, data.until, order]
  );

  const toggleConnection = useCallback(
    (connectionId: string) => {
      const next = data.selectedConnectionIds.includes(connectionId)
        ? data.selectedConnectionIds.filter((id) => id !== connectionId)
        : [...data.selectedConnectionIds, connectionId];
      navigate({ connectionIds: next, streams: [] });
    },
    [data.selectedConnectionIds, navigate]
  );

  const toggleStream = useCallback(
    (stream: string) => {
      const next = data.selectedStreams.includes(stream)
        ? data.selectedStreams.filter((s) => s !== stream)
        : [...data.selectedStreams, stream];
      navigate({ streams: next });
    },
    [data.selectedStreams, navigate]
  );

  const commitQuery = useCallback(() => navigate({ query: draft }), [draft, navigate]);

  const setRange = useCallback(
    (range: "today" | "7d" | "30d" | "all") => navigate({ since: sinceForRange(range), until: "" }),
    [navigate]
  );

  const setOrder = useCallback((next: SortOrder) => navigate({ order: next }), [navigate]);

  const selectRecord = useCallback(
    (entry: ExplorerFeedEntry) => navigate({ peek: explorerPeekParam(entry) }),
    [navigate]
  );

  const clearAll = useCallback(() => {
    setDraft("");
    router.push(explorePath);
  }, [router, explorePath]);

  // ── Keyboard row navigation (↑/↓ from a focused row move the selection) ──
  const moveSelection = useCallback(
    (fromParam: string, direction: -1 | 1) => {
      const fromIndex = visibleFeed.findIndex((entry) => explorerPeekParam(entry) === fromParam);
      const nextIndex = Math.max(0, Math.min(visibleFeed.length - 1, fromIndex + direction));
      const next = visibleFeed[nextIndex];
      if (next) {
        selectRecord(next);
      }
    },
    [visibleFeed, selectRecord]
  );

  // ── Active filter chips ──
  const rangeLabel = useMemo(() => {
    if (!(data.since || data.until)) {
      return null;
    }
    return data.until ? `${data.since || "…"} → ${data.until}` : `since ${data.since}`;
  }, [data.since, data.until]);

  const chips = useMemo(() => {
    const out: Array<{ id: string; label: string; clear: () => void }> = [];
    for (const id of data.selectedConnectionIds) {
      const name = data.connections.find((c) => c.connectionId === id)?.displayName ?? id;
      out.push({ id: `con:${id}`, label: name, clear: () => toggleConnection(id) });
    }
    for (const s of data.selectedStreams) {
      out.push({ id: `stream:${s}`, label: `stream: ${s}`, clear: () => toggleStream(s) });
    }
    if (rangeLabel) {
      out.push({ id: "range", label: rangeLabel, clear: () => setRange("all") });
    }
    committedParsed.tokens.forEach((tk, i) => {
      out.push({
        id: `tok:${i}`,
        label: tk.label,
        clear: () => navigate({ query: removeToken(data.query, tk.raw) }),
      });
    });
    return out;
  }, [
    data.selectedConnectionIds,
    data.selectedStreams,
    data.connections,
    data.query,
    rangeLabel,
    committedParsed.tokens,
    toggleConnection,
    toggleStream,
    setRange,
    navigate,
  ]);

  // ── Compiled machine-parity line ──
  const compiled = useMemo(
    () =>
      buildCompiledQuery({
        parsed: committedParsed,
        selectedConnectionIds: data.selectedConnectionIds,
        selectedStreams: data.selectedStreams,
        serverFilterableFields,
        since: data.since,
        until: data.until,
        order,
        limit: FEED_LIMIT,
      }),
    [
      committedParsed,
      data.selectedConnectionIds,
      data.selectedStreams,
      serverFilterableFields,
      data.since,
      data.until,
      order,
    ]
  );

  // ── Day grouping over the visible feed ──
  const dayGroups = useMemo(() => groupVisibleFeedByDay(visibleFeed), [visibleFeed]);

  const selectedPeekParam = data.peek ? explorerPeekParam(data.peek) : null;
  const clientSide =
    hasClientSideTokens(committedParsed, serverFilterableFields) || hasClientSideTokens(parsed, serverFilterableFields);

  // Active facet-filter count powers the collapsed mobile "Filters (N)" label.
  // Desktop forces the disclosure open (CSS), so this is a no-op there.
  const activeFacetCount = data.selectedConnectionIds.length + data.selectedStreams.length;

  return (
    <div className="rr-x">
      {/* ── Facet rail ──
          A <details> disclosure so the rail can FOLD on phones (≤860px): the
          feed is the primary reading surface there, and the connection/stream
          facets live behind a "Filters" toggle instead of burying the feed
          under a tall rail. On desktop the disclosure is forced open and its
          summary chrome is hidden (see components.css), so the rail renders
          exactly as the static 3-column rail it replaced. It renders CLOSED so
          phones lead with the feed; desktop CSS force-shows the body regardless
          of the `open` state, and a small client effect opens it on wide
          viewports so the disclosure animates correctly if the window narrows. */}
      <details className="rr-x-rail" ref={railRef}>
        <summary className="rr-x-rail__toggle">
          <span className="rr-x-rail__toggle-label">Filters</span>
          {activeFacetCount > 0 && <span className="rr-x-rail__toggle-n">{activeFacetCount}</span>}
        </summary>
        <div className="rr-x-rail__body">
          <ConnectionFacets
            connections={data.connections}
            countFor={countForConnection}
            onToggle={toggleConnection}
            selected={data.selectedConnectionIds}
          />
          <StreamFacets
            onToggle={toggleStream}
            scopedToConnection={scopedConnection}
            selected={data.selectedStreams}
            streamFacets={streamFacets}
          />
        </div>
      </details>

      {/* ── Feed ── */}
      <div className="rr-x-main">
        <div className="rr-x-controls">
          <div className="rr-x-searchrow">
            <IcInput
              className="rr-x-search"
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  commitQuery();
                }
              }}
              placeholder="Search names, fields, and values — or type an operator"
              type="text"
              value={draft}
            />
            <div className="rr-x-sort">
              <span className="rr-x-sort__label">sort</span>
              <button
                className={["rr-lens", order === "newest" ? "is-on" : ""].filter(Boolean).join(" ")}
                onClick={() => setOrder("newest")}
                type="button"
              >
                newest
              </button>
              <button
                className={["rr-lens", order === "oldest" ? "is-on" : ""].filter(Boolean).join(" ")}
                onClick={() => setOrder("oldest")}
                type="button"
              >
                oldest
              </button>
            </div>
          </div>

          <div className="rr-x-ranges">
            {(["today", "7d", "30d", "all"] as const).map((v) => {
              const active = v === "all" ? !(data.since || data.until) : Boolean(data.since);
              return (
                <button
                  className={["rr-lens", active && (v === "all" || data.since) ? "is-on" : ""]
                    .filter(Boolean)
                    .join(" ")}
                  key={v}
                  onClick={() => setRange(v)}
                  type="button"
                >
                  {v}
                </button>
              );
            })}
            <details className="rr-x-help">
              <summary>operators</summary>
              <div className="rr-x-help__body">
                <code>con:</code> <code>stream:</code> <code>role:</code> <code>has:image</code> <code>has:link</code>{" "}
                <code>is:folded</code> <code>before:2026-06-11</code> <code>after:2026-06-10</code>{" "}
                <code>merchant:coffee</code> — combine freely; everything composes.
              </div>
            </details>
            <button className="rr-link rr-x-jump" onClick={commitQuery} type="button">
              jump to an id →
            </button>
          </div>

          {chips.length > 0 && (
            <div className="rr-x-active">
              {chips.map((c) => (
                <button className="rr-x-chip" key={c.id} onClick={c.clear} type="button">
                  {c.label}
                  <span className="rr-x-chip__x">×</span>
                </button>
              ))}
              <button className="rr-x-clearall" onClick={clearAll} type="button">
                clear all
              </button>
            </div>
          )}

          <div className="rr-x-compiled">
            <span className="rr-x-compiled__label">
              {clientSide
                ? "the same call any client makes (+ client-side filters):"
                : "the same call any client makes:"}
            </span>
            <CopyMono text={compiled} />
          </div>
        </div>

        <p className="rr-x-pulse__note">
          {visibleFeed.length.toLocaleString()} in view{data.truncated ? " (window capped)" : ""}
          {data.activitySummary ? ` · ${data.activitySummary.text}` : ""}
        </p>
        <p className="rr-x-feeddesc">{feedDescription(data.lens, data.hybridUsed)}</p>

        {dedupeWarnings(data.warnings).map((w) => (
          <div className="rr-x-warn" key={`${w.code}:${w.message}`}>
            <span className="rr-x-warn__line">{w.code.replace(UNDERSCORE_RE, " ")}</span>
            <span className="rr-x-warn__msg">{w.message}</span>
          </div>
        ))}

        <div className="rr-x-days">
          {dayGroups.length === 0 ? (
            <div className="rr-x-empty">
              <p className="rr-x-empty__line">
                {feedSectionTitle(data.lens)} — nothing in view. Try different terms or a wider window.
              </p>
              {chips.length > 0 && (
                <button className="rr-link" onClick={clearAll} type="button">
                  clear filters →
                </button>
              )}
            </div>
          ) : (
            dayGroups.map((g) => (
              <div className="rr-x-day" key={g.day || "undated"}>
                <div className="rr-x-day__head">
                  <span className="rr-x-day__label">{g.label}</span>
                  <span className="rr-x-day__n">{g.entries.length}</span>
                </div>
                {g.entries.map((entry) => {
                  const param = explorerPeekParam(entry);
                  return (
                    <FeedRow
                      entry={entry}
                      key={param}
                      onArrow={(direction) => moveSelection(param, direction)}
                      onSelect={() => selectRecord(entry)}
                      selected={param === selectedPeekParam}
                    />
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>

      {/* ── Record inspector ── */}
      <Inspector peek={data.peek} relationships={peekRelationships} />
    </div>
  );
}
