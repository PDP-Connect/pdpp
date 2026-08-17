// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Syncs view — the Recordroom presentation of the Runs route.
 *
 * Composes the Ink Carbon kit (Band, Table, KV, Endorse, IcButton, Rhythm) over
 * the pure {@link SyncsViewModel}. No state color is spent outside Endorse and
 * Rhythm; the only warm element is the copper (`human`) owner-action button.
 * Self-handled `wait` cards show status copy and NO button, so a throttled
 * connection is never told to "log in again".
 */

import {
  Band,
  BandCell,
  buttonVariants,
  Caption,
  Endorse,
  IcButton,
  IcSelect,
  IcTimestamp,
  KV,
  KVRow,
  Rhythm,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
} from "@pdpp/brand-react";
import { humanizeFieldLabel } from "@pdpp/display";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { formatCoverageAxis } from "../lib/connection-evidence.ts";
import { SOURCE_WORK_GROUP_COPY } from "../lib/source-actionability.ts";
import {
  type DuplicateSyncGroup,
  describeRecentSyncOutcome,
  type FailureCard,
  type PendingSetupCard,
  type RecentSyncEntry,
  type SyncGroup,
  type SyncRhythmTick,
  type SyncRow,
  type SyncsViewModel,
} from "./syncs-model.ts";

/** One filterable/pageable option for a recent-syncs filter control. */
interface RecentSyncsFilterOption {
  label: string;
  value: string;
}

/**
 * Pagination + filter state for the recent-syncs list, computed server-side in
 * `page.tsx` from the real `_ref/runs` response (`has_more`/`next_cursor`) and
 * the current search params. Passed in rather than fetched here so this view
 * stays a pure server component (no client hydration for a GET form).
 */
export interface RecentSyncsPaging {
  /**
   * The connectors this owner actually has, projected from the SAME bounded
   * fleet page the rest of Syncs renders from — never a hardcoded roster and
   * never connector-specific knowledge held in the console. If the fleet page
   * is empty the picker is not rendered at all rather than offering a filter
   * that can only ever return nothing.
   */
  connectorOptions: readonly RecentSyncsFilterOption[];
  hasMore: boolean;
  isPaged: boolean;
  nextCursor: string | undefined;
  params: Readonly<Record<string, string | undefined>>;
  statusOptions: readonly RecentSyncsFilterOption[];
}

const RECENT_SYNCS_PATH = "/syncs";
const RECENT_SYNCS_PAGER_OWNED_KEYS = new Set(["run_cursor"]);

function recentSyncsHref(
  params: Readonly<Record<string, string | undefined>>,
  overrides: Record<string, string | undefined>
): string {
  const merged: Record<string, string | undefined> = { ...params, ...overrides };
  const qs = Object.entries(merged)
    .flatMap(([k, v]) => (v === undefined || v === "" ? [] : [`${encodeURIComponent(k)}=${encodeURIComponent(v)}`]))
    .join("&");
  return qs ? `${RECENT_SYNCS_PATH}?${qs}` : RECENT_SYNCS_PATH;
}

const SYNC_COLS = "minmax(0,1.4fr) minmax(0,1.2fr)";

const RESET_NOTE = "Nothing already saved is ever lost — a held connection only pauses new arrivals.";

const FAILURE_SECTION_ORDER = ["needsOwner", "review", "systemIssue", "working", "notMeasured", "other"] as const;

type FailureSection = (typeof FAILURE_SECTION_ORDER)[number];

// The four source-attention groups draw their label + note from the ONE shared
// map (`SOURCE_WORK_GROUP_COPY`) so Runs and the dashboard render identical
// category copy. Only "other" is local to this surface.
const FAILURE_SECTION_COPY: Record<FailureSection, { label: string; note: string }> = {
  needsOwner: SOURCE_WORK_GROUP_COPY.needsOwner,
  notMeasured: SOURCE_WORK_GROUP_COPY.notMeasured,
  other: {
    label: "Other source work",
    note: "Open when you have a moment.",
  },
  review: SOURCE_WORK_GROUP_COPY.review,
  systemIssue: SOURCE_WORK_GROUP_COPY.systemIssue,
  working: SOURCE_WORK_GROUP_COPY.working,
};

// ─── Health stat band ─────────────────────────────────────────────────────────

function HealthBandStrip({ band }: { band: SyncsViewModel["band"] }) {
  const reviewValue = band.needYourHand > 0 ? band.needYourHand : band.needsReview;
  let reviewLabel = "need attention";
  if (band.needYourHand > 0) {
    reviewLabel = "need your attention";
  } else if (band.needsReview > 0) {
    reviewLabel = "need review";
  }
  return (
    <div className="rr-sync-health">
      <Band>
        <BandCell k="streams on schedule" v={band.onSchedule} />
        <BandCell className={band.needsReview > 0 ? "is-warn" : undefined} k={reviewLabel} v={reviewValue} />
      </Band>
      <p className="rr-sync-health__note">
        {band.allClear
          ? `Nothing needs your attention right now. ${RESET_NOTE}`
          : `Review the cards below. ${RESET_NOTE}`}
      </p>
    </div>
  );
}

// ─── Failure card ─────────────────────────────────────────────────────────────

/**
 * One failure CARD (a panel, not a row). The CTA is bound to the pre-derived
 * `FailureSummary.cta`:
 *   - `connection_detail` / `reconnect` → copper owner-action button to the connection detail page
 *   - `view_runs` → neutral link to this connection's runs
 *   - `wait`      → NO button; the next-attempt time stands in for the action
 *
 * The prose is verbatim from the server-owned rendered verdict when available.
 */
function FailureCardPanel({ card }: { card: FailureCard }) {
  const { summary } = card;
  const ownerActionLabel = summary.actionLabel ?? (summary.cta === "reconnect" ? "Reconnect" : "Open source");
  // biome-ignore lint/suspicious/noUnnecessaryConditions: card.work is SourceWorkItem | null; tsc rejects removing this guard.
  const sourceWorkGroup = card.work?.group ?? "other";
  return (
    <section className="rr-fix" data-cta={summary.cta} data-source-work={sourceWorkGroup}>
      <div className="rr-fix__body">
        <h3 className="rr-fix__title">
          {card.name} — {summary.triggerLabel}
        </h3>
        <p className="rr-fix__expl">{summary.prose}</p>
        {summary.cta === "wait" && summary.nextAttemptAt ? (
          <p className="rr-fix__meta">
            Next automatic attempt <IcTimestamp mode="relative" value={summary.nextAttemptAt} />.
          </p>
        ) : null}
        {summary.lastSuccessAt ? (
          <p className="rr-fix__meta">
            Last successful sync <IcTimestamp mode="relative" value={summary.lastSuccessAt} />.
          </p>
        ) : null}
      </div>
      <div className="rr-fix__act">
        {summary.cta === "connection_detail" || summary.cta === "reconnect" ? (
          <Link href={dashboardRoutes.connector(card.connectionId)} prefetch={false}>
            <IcButton size="sm" variant="human">
              {ownerActionLabel}
            </IcButton>
          </Link>
        ) : null}
        {summary.cta === "view_runs" ? (
          <Link
            className="rr-link"
            href={`${dashboardRoutes.section.runs}?connector_id=${encodeURIComponent(card.connectorId)}`}
            prefetch={false}
          >
            View runs →
          </Link>
        ) : null}
        {summary.cta === "wait" ? (
          <Caption className="rr-fix__waiting">{summary.actionLabel ?? "No action needed"}</Caption>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Card for a draft connection awaiting its first credential capture / ingest.
 * Rendered above the failure-card sections (same "needs you" tier, but a
 * distinct shape — no `FailureSummary`, since the connection has never had a
 * run to derive one from) so a freshly created connection is discoverable on
 * Syncs immediately, not only after it starts failing or succeeding.
 */
function PendingSetupCardPanel({ card }: { card: PendingSetupCard }) {
  return (
    <section className="rr-fix" data-source-work="needsOwner" data-testid="syncs-pending-setup-card">
      <div className="rr-fix__body">
        <h3 className="rr-fix__title">
          {card.name} — {card.statusLabel}
        </h3>
        <p className="rr-fix__expl">{card.what}</p>
      </div>
      <div className="rr-fix__act">
        <Link href={card.continueHref} prefetch={false}>
          <IcButton size="sm" variant="human">
            {card.actionLabel}
          </IcButton>
        </Link>
      </div>
    </section>
  );
}

function failureSectionForCard(card: FailureCard): FailureSection {
  if (card.work?.group && card.work.group !== "unavailable") {
    return card.work.group;
  }
  return card.summary.ownerActionRequired ? "needsOwner" : "other";
}

interface AttentionSectionData {
  cards: FailureCard[];
  pendingSetupCards: PendingSetupCard[];
  section: FailureSection;
}

/**
 * Bucket every attention card into exactly ONE section per group id.
 *
 * Draft connections awaiting setup are a different card SHAPE
 * ({@link PendingSetupCard} — no rendered verdict to derive a
 * {@link FailureSummary} from), but they are the same KIND of work as a
 * verdict-derived needs-you card: the owner has to act before collection
 * continues. They therefore join the `needsOwner` section instead of rendering
 * a second section under an identical heading.
 */
function attentionSections(model: SyncsViewModel): AttentionSectionData[] {
  const bySection = new Map<FailureSection, FailureCard[]>();
  for (const card of model.failureCards) {
    const section = failureSectionForCard(card);
    const bucket = bySection.get(section);
    if (bucket) {
      bucket.push(card);
    } else {
      bySection.set(section, [card]);
    }
  }
  return FAILURE_SECTION_ORDER.flatMap((section) => {
    const sectionCards = bySection.get(section) ?? [];
    const pendingSetupCards = section === "needsOwner" ? [...model.pendingSetupCards] : [];
    if (sectionCards.length === 0 && pendingSetupCards.length === 0) {
      return [];
    }
    return [{ cards: sectionCards, pendingSetupCards, section }];
  });
}

function AttentionSection({ cards, pendingSetupCards, section }: AttentionSectionData) {
  const copy = FAILURE_SECTION_COPY[section];
  const count = cards.length + pendingSetupCards.length;
  return (
    <section className="rr-sync__fix-section" data-source-work={section}>
      <div className="rr-sync__fix-section-head">
        <h2 className="rr-sync__fix-section-title">
          {copy.label} <span className="rr-sync__fix-section-count">{count}</span>
        </h2>
        <Caption>{copy.note}</Caption>
      </div>
      <div className="rr-sync__fix-section-cards">
        {pendingSetupCards.map((card) => (
          <PendingSetupCardPanel card={card} key={`setup:${card.connectionId}`} />
        ))}
        {cards.map((card) => (
          <FailureCardPanel card={card} key={card.connectionId} />
        ))}
      </div>
    </section>
  );
}

function DuplicateSyncGroupPanel({ group }: { group: DuplicateSyncGroup }) {
  return (
    <aside className="rr-sync-duplicates" data-testid="syncs-duplicate-group">
      <span className="rr-sync-duplicates__eyebrow">Several sources need labels</span>
      <p className="rr-sync-duplicates__head">
        {group.total.toLocaleString()} unnamed {group.kind} sources are collapsed in this overview.
      </p>
      <p className="rr-sync-duplicates__note">
        They still represent {group.streamCount.toLocaleString()} stream{group.streamCount === 1 ? "" : "s"}.
        {group.ownerActionCount > 0
          ? ` ${group.ownerActionCount.toLocaleString()} ${group.ownerActionCount === 1 ? "source needs" : "sources need"} your attention.`
          : ""}
        {group.advisoryCount > 0
          ? ` ${group.advisoryCount.toLocaleString()} ${
              group.advisoryCount === 1 ? "source has" : "sources have"
            } the same advisory.`
          : ""}{" "}
        Open Sources to label, retry, or revoke each concrete source.
      </p>
      <Link
        className="rr-link rr-sync-duplicates__link"
        href={dashboardRoutes.connector(group.firstConnectionId)}
        prefetch={false}
      >
        Review duplicate source labels →
      </Link>
    </aside>
  );
}

// ─── Recent syncs (one run per row) ───────────────────────────────────────────

const RECENT_COLS = "minmax(0,1.4fr) minmax(0,1fr) minmax(0,0.9fr) minmax(0,0.8fr)";

/**
 * One recent run. The whole row links to `/syncs/[runId]`, so the primary
 * gesture on this page is "open the sync I am looking at".
 */
function RecentSyncRow({ entry }: { entry: RecentSyncEntry }) {
  return (
    <Link className="pdpp-table__row rr-recent-row" href={entry.href} prefetch={false}>
      <TableCell className="rr-recent-row__name">
        <span className="rr-recent-row__connection">{entry.connectionName}</span>
        <span className="rr-recent-row__run">{entry.runId}</span>
      </TableCell>
      <TableCell className="rr-recent-row__outcome">
        <span className="rr-recent-row__chip" data-outcome={entry.outcome}>
          {describeRecentSyncOutcome(entry.outcome)}
        </span>
        {entry.duration === null ? null : <span className="rr-recent-row__duration">{entry.duration}</span>}
      </TableCell>
      <TableCell className="rr-recent-row__records">
        {entry.eventCount === null ? (
          <span className="rr-recent-row__empty">—</span>
        ) : (
          `${entry.eventCount.toLocaleString()} record${entry.eventCount === 1 ? "" : "s"}`
        )}
      </TableCell>
      <TableCell className="rr-recent-row__when" numeric>
        <IcTimestamp mode="relative" value={entry.at} />
      </TableCell>
    </Link>
  );
}

/**
 * GET-submitted outcome + source filters for recent syncs. A plain server form:
 * no client state on this page, matching the "no useState" invariant — the
 * select's own module owns the minimal client interactivity, same pattern as
 * `/audit`.
 *
 * Both controls are honest about what `_ref/runs` can actually apply. Every
 * status option is a real run status (see `RUN_STATUS_FILTER_OPTIONS` in
 * `page.tsx`), and every source option is a connector the owner really has,
 * projected from the fleet page this route already fetches — so neither offers
 * a filter the server can't honour. The two compose: `_ref/runs` takes
 * `status` and `connector_id` together, so submitting the form carries
 * whichever of the pair are set.
 *
 * `run_cursor` is deliberately NOT carried through this form. A cursor is a
 * position inside ONE filtered feed; re-filtering makes it meaningless, so
 * applying a filter restarts at the newest page. Paging preserves both filters
 * instead — see `RecentSyncsPager`, which merges the current params.
 *
 * There is no sort control, because `_ref/runs` has no sort parameter. Faking
 * one client-side would only reorder the current page and read as a whole-feed
 * sort, so the list stays newest-first — the one order the feed guarantees.
 */
function RecentSyncsFilterForm({ paging }: { paging: RecentSyncsPaging }) {
  const status = paging.params.status ?? "";
  const connectorId = paging.params.connector_id ?? "";
  const hasFilter = status !== "" || connectorId !== "";
  return (
    <form
      action={RECENT_SYNCS_PATH}
      className="rr-sync__recent-filters"
      method="get"
      style={{ alignItems: "center", display: "flex", flexWrap: "wrap", gap: 8 }}
    >
      <IcSelect
        aria-label="Filter recent syncs by outcome"
        defaultValue={status}
        name="status"
        options={paging.statusOptions}
        style={{ minWidth: 160 }}
      />
      {paging.connectorOptions.length > 0 ? (
        <IcSelect
          aria-label="Filter recent syncs by source"
          defaultValue={connectorId}
          name="connector_id"
          options={paging.connectorOptions}
          style={{ minWidth: 160 }}
        />
      ) : null}
      <IcButton size="sm" type="submit" variant="ghost">
        Apply
      </IcButton>
      {hasFilter ? (
        <a
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={recentSyncsHref(paging.params, { connector_id: undefined, run_cursor: undefined, status: undefined })}
        >
          Clear filter
        </a>
      ) : null}
    </form>
  );
}

function RecentSyncsPager({ paging }: { paging: RecentSyncsPaging }) {
  if (!(paging.hasMore || paging.isPaged)) {
    return null;
  }
  const restOfParams = Object.fromEntries(
    Object.entries(paging.params).filter(([key]) => !RECENT_SYNCS_PAGER_OWNED_KEYS.has(key))
  );
  return (
    <nav aria-label="Recent syncs pagination" className="rr-sync__recent-pager" style={{ display: "flex", gap: 12 }}>
      {paging.isPaged ? (
        <a
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={recentSyncsHref(restOfParams, { run_cursor: undefined })}
        >
          Restart from newest
        </a>
      ) : null}
      {paging.hasMore && paging.nextCursor ? (
        <a
          className={buttonVariants({ size: "sm", variant: "ghost" })}
          href={recentSyncsHref(paging.params, { run_cursor: paging.nextCursor })}
        >
          Older syncs →
        </a>
      ) : null}
    </nav>
  );
}

function RecentSyncsSection({ entries, paging }: { entries: readonly RecentSyncEntry[]; paging: RecentSyncsPaging }) {
  const hasFilter = Boolean(paging.params.status) || Boolean(paging.params.connector_id);
  return (
    <section className="rr-sync__recent" data-testid="syncs-recent-list">
      <div className="rr-sync__section-head">
        <h2 className="rr-sync__section-title">Recent syncs</h2>
      </div>
      <RecentSyncsFilterForm paging={paging} />
      {entries.length > 0 ? (
        <>
          <Table cols={RECENT_COLS}>
            <TableHeaderRow>
              <TableHeader>source</TableHeader>
              <TableHeader>outcome</TableHeader>
              <TableHeader>records</TableHeader>
              <TableHeader numeric>when</TableHeader>
            </TableHeaderRow>
            {entries.map((entry) => (
              <RecentSyncRow entry={entry} key={entry.runId} />
            ))}
          </Table>
          <RecentSyncsPager paging={paging} />
        </>
      ) : (
        <div className="rr-sync__empty">
          <Caption>{hasFilter ? "No syncs match this filter." : "Syncs appear here once a source runs."}</Caption>
        </div>
      )}
    </section>
  );
}

/** Seeded-demo rendering: no filter form or pager, since the demo has no live runs feed to page against. */
function RecentSyncsSectionDemo({ entries }: { entries: readonly RecentSyncEntry[] }) {
  return (
    <section className="rr-sync__recent" data-testid="syncs-recent-list">
      <div className="rr-sync__section-head">
        <h2 className="rr-sync__section-title">Recent syncs</h2>
      </div>
      {entries.length > 0 ? (
        <Table cols={RECENT_COLS}>
          <TableHeaderRow>
            <TableHeader>source</TableHeader>
            <TableHeader>outcome</TableHeader>
            <TableHeader>records</TableHeader>
            <TableHeader numeric>when</TableHeader>
          </TableHeaderRow>
          {entries.map((entry) => (
            <RecentSyncRow entry={entry} key={entry.runId} />
          ))}
        </Table>
      ) : (
        <div className="rr-sync__empty">
          <Caption>Syncs appear here once a source runs.</Caption>
        </div>
      )}
    </section>
  );
}

// ─── Sync row (one stream) ────────────────────────────────────────────────────

/**
 * Format the per-stream collected count for display.
 * Returns null when collection_report is absent (honest empty state).
 */
function formatCollectedThisRun(row: SyncRow): string | null {
  if (row.streamSkipped) {
    return "skipped";
  }
  if (row.collectedThisRun === null) {
    return row.failed ? "sync failed" : null;
  }
  // A real per-stream collected count is per-stream truth and wins over the
  // connection-level failure flag: a stream that collected rows did not fail,
  // even if the run as a whole did.
  if (row.collectedThisRun > 0) {
    return `+${row.collectedThisRun.toLocaleString()} collected`;
  }
  if (row.failed) {
    return "sync failed";
  }
  return "no change";
}

/**
 * The coverage condition is shown only when it adds information: "complete" is
 * the expected baseline and "unknown" is noise, so both are suppressed.
 * Otherwise this renders the SAME owner-facing wording as the source detail
 * page and connection diagnostics (`formatCoverageAxis`'s humanized `value`,
 * e.g. "won't backfill" / "retryable gap") — never the raw internal axis key
 * (e.g. "terminal_gap"), and never a second, competing translation of it.
 */
function coverageSuffix(condition: string | null): string {
  if (!condition || condition === "complete" || condition === "unknown") {
    return "";
  }
  return ` · ${formatCoverageAxis(condition).value}`;
}

function SyncTableRow({ row }: { row: SyncRow }) {
  const collectedText = formatCollectedThisRun(row);
  const isQuiet = !row.failed && row.collectedThisRun !== null && row.collectedThisRun <= 0 && !row.streamSkipped;
  const deltaClass = ["rr-sync-row__delta", isQuiet ? "is-quiet" : undefined, row.failed ? "is-failed" : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <details className="rr-sync-row-shell">
      <summary
        className={["pdpp-table__row", "rr-sync-row", row.failed ? "is-failed" : null].filter(Boolean).join(" ")}
      >
        <TableCell className="rr-sync-row__stream">
          <span title={row.stream}>{humanizeFieldLabel(row.stream)}</span>
        </TableCell>
        <TableCell className={deltaClass}>
          {collectedText === null ? <span className="rr-sync-row__empty">—</span> : <span>{collectedText}</span>}
          {coverageSuffix(row.coverageCondition) ? (
            <span className="rr-sync-row__coverage">{coverageSuffix(row.coverageCondition)}</span>
          ) : null}
        </TableCell>
      </summary>
      <div className="rr-sync-detail">
        <KV>
          <KVRow k="collected (last run)">
            {collectedText ?? "—"}
            {coverageSuffix(row.coverageCondition)}
          </KVRow>
        </KV>
        <Link className="rr-link rr-sync-detail__browse" href={row.browseHref} prefetch={false}>
          browse this stream →
        </Link>
      </div>
    </details>
  );
}

// ─── Sync group (one connection) ──────────────────────────────────────────────

function SyncGroupLastRun({
  delta,
  duration,
  lastRunAt,
  rhythm,
}: {
  delta: string | null;
  duration: string | null;
  lastRunAt: string | null;
  rhythm: SyncRhythmTick[];
}) {
  return (
    <div className="rr-sync-group__last-run">
      {rhythm.length > 0 ? <Rhythm ticks={rhythm} /> : null}
      {delta === null ? null : <span className="rr-sync-group__delta">{delta}</span>}
      {duration === null ? null : <span className="rr-sync-group__duration">{duration}</span>}
      {lastRunAt === null ? null : (
        <span className="rr-sync-group__when">
          <IcTimestamp mode="relative" value={lastRunAt} />
        </span>
      )}
    </div>
  );
}

/**
 * The connection's schedule — cadence and next-due. One pair per connection
 * (every stream shares the same schedule), so it renders once here instead of
 * repeating on every stream row below.
 */
function SyncGroupSchedule({ cadence, next, nextAt }: { cadence: string; next: string; nextAt: string | null }) {
  return (
    <div className="rr-sync-group__schedule">
      <span className="rr-sync-group__cadence">{cadence}</span>
      <span className="rr-sync-group__next">next {nextAt ? <IcTimestamp mode="relative" value={nextAt} /> : next}</span>
    </div>
  );
}

function SyncGroupBlock({ group }: { group: SyncGroup }) {
  const healthy = group.health === "ok";
  const activeRunHref = group.activeRunId ? `/syncs/${encodeURIComponent(group.activeRunId)}` : null;
  // Reserve an accurate placeholder height for content-visibility so off-screen
  // groups do not shift the page when scrolled into view. ~52px per stream row
  // plus the group header/last-run block.
  const intrinsicHeight = group.streams.length * 52 + 96;
  return (
    <section
      className="rr-sync-group"
      style={{ "--sync-group-intrinsic": `${intrinsicHeight}px` } as Record<string, string>}
    >
      <div className="rr-sync-group__head">
        <span aria-hidden className={["rr-sync-group__dot", healthy ? "is-ok" : "is-fail"].join(" ")} />
        <span className="rr-sync-group__name">{group.name}</span>
        <span className="rr-sync-group__cin">{group.connectionId}</span>
        <span className="rr-sync-group__count">
          {group.streams.length} {group.streams.length === 1 ? "stream" : "streams"}
        </span>
        <SyncGroupLastRun
          delta={group.lastRunDelta}
          duration={group.lastRunDuration}
          lastRunAt={group.lastRunAt}
          rhythm={group.lastRunRhythm}
        />
        <SyncGroupSchedule cadence={group.cadence} next={group.next} nextAt={group.nextAt} />
        {activeRunHref ? (
          <Link className="rr-link rr-sync-group__active" href={activeRunHref} prefetch={false}>
            Active sync →
          </Link>
        ) : null}
      </div>
      <Table cols={SYNC_COLS}>
        <TableHeaderRow>
          <TableHeader>stream</TableHeader>
          <TableHeader>collected (last run)</TableHeader>
        </TableHeaderRow>
        {group.streams.map((row) => {
          const key = `${group.connectionId}:${row.stream}`;
          return <SyncTableRow key={key} row={row} />;
        })}
      </Table>
    </section>
  );
}

// ─── The view ─────────────────────────────────────────────────────────────────

export function SyncsView({
  model,
  recentSyncsPaging,
  seeded = false,
}: {
  model: SyncsViewModel;
  /** Absent only for the seeded `?demo=` render, which has no live runs feed to page. */
  recentSyncsPaging?: RecentSyncsPaging;
  seeded?: boolean;
}) {
  return (
    <div className="rr-sync">
      <header className="rr-sync__masthead">
        <h1 className="rr-sync__title">Syncs</h1>
        <p className="rr-sync__sub">What ran recently and what needs your attention.</p>
        {seeded ? <Endorse className="rr-sync__seeded" label="seeded demo" status="continuous" /> : null}
      </header>

      <HealthBandStrip band={model.band} />

      {model.pendingSetupCards.length > 0 || model.failureCards.length > 0 ? (
        <div className="rr-sync__fixes">
          {attentionSections(model).map(({ cards, pendingSetupCards, section }) => (
            <AttentionSection cards={cards} key={section} pendingSetupCards={pendingSetupCards} section={section} />
          ))}
        </div>
      ) : null}

      {model.duplicateGroups.length > 0 ? (
        <div className="rr-sync__duplicates">
          {model.duplicateGroups.map((group) => (
            <DuplicateSyncGroupPanel group={group} key={group.connectorId} />
          ))}
        </div>
      ) : null}

      {recentSyncsPaging ? (
        <RecentSyncsSection entries={model.recentSyncs} paging={recentSyncsPaging} />
      ) : (
        <RecentSyncsSectionDemo entries={model.recentSyncs} />
      )}

      <section className="rr-sync__streams">
        <div className="rr-sync__section-head">
          <h2 className="rr-sync__section-title">Streams by source</h2>
          <Caption>Each source's schedule and what every stream collected last time.</Caption>
        </div>
        {model.groups.length > 0 ? (
          <div className="rr-sync__groups">
            {model.groups.map((group) => (
              <SyncGroupBlock group={group} key={group.connectionId} />
            ))}
          </div>
        ) : (
          <div className="rr-sync__empty">
            <Caption>Connect a source and its streams appear here.</Caption>
          </div>
        )}
      </section>
    </div>
  );
}
