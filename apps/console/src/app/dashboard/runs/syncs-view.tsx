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
  Caption,
  Endorse,
  IcButton,
  IcTimestamp,
  KV,
  KVRow,
  Rhythm,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
} from "@pdpp/brand-react";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import type {
  DuplicateSyncGroup,
  FailureCard,
  SyncGroup,
  SyncRhythmTick,
  SyncRow,
  SyncsViewModel,
} from "./syncs-model.ts";

const SYNC_COLS = "minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,1.2fr) minmax(0,0.9fr)";

const RESET_NOTE = "Nothing already saved is ever lost — a held connection only pauses new arrivals.";

// ─── Health stat band ─────────────────────────────────────────────────────────

function HealthBandStrip({ band }: { band: SyncsViewModel["band"] }) {
  const reviewValue = band.needYourHand > 0 ? band.needYourHand : band.needsReview;
  const reviewLabel =
    band.needYourHand > 0 ? "need your hand" : band.needsReview > 0 ? "need review" : "need attention";
  return (
    <div className="rr-sync-health">
      <Band>
        <BandCell k="streams on schedule" v={band.onSchedule} />
        <BandCell className={band.needsReview > 0 ? "is-warn" : undefined} k={reviewLabel} v={reviewValue} />
      </Band>
      <p className="rr-sync-health__note">
        {band.allClear ? `Nothing needs you right now. ${RESET_NOTE}` : `Review the cards below. ${RESET_NOTE}`}
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
  return (
    <section className="rr-fix" data-cta={summary.cta}>
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

function DuplicateSyncGroupPanel({ group }: { group: DuplicateSyncGroup }) {
  return (
    <aside className="rr-sync-duplicates" data-testid="syncs-duplicate-group">
      <span className="rr-sync-duplicates__eyebrow">same source type · review labels</span>
      <p className="rr-sync-duplicates__head">
        {group.total.toLocaleString()} unnamed {group.kind} sources are collapsed in this overview.
      </p>
      <p className="rr-sync-duplicates__note">
        They still represent {group.streamCount.toLocaleString()} stream{group.streamCount === 1 ? "" : "s"}.
        {group.ownerActionCount > 0
          ? ` ${group.ownerActionCount.toLocaleString()} ${group.ownerActionCount === 1 ? "source needs" : "sources need"} your hand.`
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
        Review first unnamed source →
      </Link>
    </aside>
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

// The coverage condition is shown only when it adds information: "complete" is
// the expected baseline and "unknown" is noise, so both are suppressed. Single
// source of truth shared by the collapsed cell and the expanded KV detail.
function coverageSuffix(condition: string | null): string {
  if (!condition || condition === "complete" || condition === "unknown") {
    return "";
  }
  return ` · ${condition}`;
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
        <TableCell className="rr-sync-row__stream">{row.stream}</TableCell>
        <TableCell className="rr-sync-row__cadence">{row.cadence}</TableCell>
        <TableCell className={deltaClass}>
          {collectedText === null ? <span className="rr-sync-row__empty">—</span> : <span>{collectedText}</span>}
          {coverageSuffix(row.coverageCondition) ? (
            <span className="rr-sync-row__coverage">{coverageSuffix(row.coverageCondition)}</span>
          ) : null}
        </TableCell>
        <TableCell className="rr-sync-row__next" numeric>
          {row.nextAt ? <IcTimestamp mode="relative" value={row.nextAt} /> : row.next}
        </TableCell>
      </summary>
      <div className="rr-sync-detail">
        <KV>
          <KVRow k="collected (last run)">
            {collectedText ?? "—"}
            {coverageSuffix(row.coverageCondition)}
          </KVRow>
          <KVRow k="cadence">{row.cadence}</KVRow>
          <KVRow k="next">{row.nextAt ? <IcTimestamp mode="relative" value={row.nextAt} /> : row.next}</KVRow>
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

function SyncGroupBlock({ group }: { group: SyncGroup }) {
  const healthy = group.health === "ok";
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
      </div>
      <Table cols={SYNC_COLS}>
        <TableHeaderRow>
          <TableHeader>stream</TableHeader>
          <TableHeader>cadence</TableHeader>
          <TableHeader>collected (last run)</TableHeader>
          <TableHeader numeric>next</TableHeader>
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

export function SyncsView({ model, seeded = false }: { model: SyncsViewModel; seeded?: boolean }) {
  return (
    <div className="rr-sync">
      <header className="rr-sync__masthead">
        <h1 className="rr-sync__title">Syncs</h1>
        <p className="rr-sync__sub">What was recently collected, and what — in plain English — needs your hand.</p>
        {seeded ? <Endorse className="rr-sync__seeded" label="seeded demo" status="continuous" /> : null}
      </header>

      <HealthBandStrip band={model.band} />

      {model.failureCards.length > 0 ? (
        <div className="rr-sync__fixes">
          {model.failureCards.map((card) => (
            <FailureCardPanel card={card} key={card.connectionId} />
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

      {model.groups.length > 0 ? (
        <div className="rr-sync__groups">
          {model.groups.map((group) => (
            <SyncGroupBlock group={group} key={group.connectionId} />
          ))}
        </div>
      ) : (
        <div className="rr-sync__empty">
          <Caption>No connections sync here yet. Connect a source and its streams appear as sync rows.</Caption>
        </div>
      )}
    </div>
  );
}
