"use client";

/**
 * Syncs view — the Recordroom presentation of the Runs route.
 *
 * Composes the Ink Carbon kit (Band, Table, KV, Endorse, IcButton, Rhythm) over
 * the pure {@link SyncsViewModel}. No state color is spent outside Endorse and
 * Rhythm; the only warm element is the copper (`human`) reconnect button — and
 * that button appears ONLY when the bound `FailureSummary.cta` is `reconnect`.
 * A source-pressure cooldown's `wait` card shows the next-attempt time and NO
 * button, so a throttled connection is never told to "log in again".
 */

import {
  Band,
  BandCell,
  Caption,
  Endorse,
  IcButton,
  KV,
  KVRow,
  Rhythm,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
  TableRow,
} from "@pdpp/brand-react";
import { dashboardRoutes } from "@pdpp/operator-ui/components/views/routes";
import Link from "next/link";
import { useState } from "react";
import { Timestamp } from "@pdpp/operator-ui/ui/timestamp";
import type { FailureCard, SyncGroup, SyncRow, SyncsViewModel } from "./syncs-model.ts";

const SYNC_COLS = "minmax(0,1.4fr) minmax(0,0.9fr) auto minmax(0,1.2fr) minmax(0,0.9fr)";

const RESET_NOTE = "Nothing already saved is ever lost — a held connection only pauses new arrivals.";

// ─── Health stat band ─────────────────────────────────────────────────────────

function HealthBandStrip({ band }: { band: SyncsViewModel["band"] }) {
  return (
    <div className="rr-sync-health">
      <Band>
        <BandCell k="streams on schedule" v={band.onSchedule} />
        <BandCell
          className={band.needYourHand > 0 ? "is-warn" : undefined}
          k={band.needYourHand > 0 ? "need your hand" : "need attention"}
          v={band.needYourHand}
        />
      </Band>
      <p className="rr-sync-health__note">
        {band.allClear ? `Nothing needs you right now. ${RESET_NOTE}` : RESET_NOTE}
      </p>
    </div>
  );
}

// ─── Failure card ─────────────────────────────────────────────────────────────

/**
 * One failure CARD (a panel, not a row). The CTA is bound to the pre-derived
 * `FailureSummary.cta`:
 *   - `reconnect` → copper owner-action button to the connection's setup page
 *   - `view_runs` → neutral link to this connection's runs
 *   - `wait`      → NO button; the next-attempt time stands in for the action
 *
 * The prose is verbatim from `deriveFailureSummary` — the source-pressure guard
 * lives there, so a cooling/throttled connection reads "the source is throttling
 * … resumes on the next scheduled attempt" and gets the `wait` branch below.
 */
function FailureCardPanel({ card }: { card: FailureCard }) {
  const { summary } = card;
  return (
    <section className="rr-fix" data-cta={summary.cta}>
      <div className="rr-fix__body">
        <h3 className="rr-fix__title">
          {card.name} — {summary.triggerLabel}
        </h3>
        <p className="rr-fix__expl">{summary.prose}</p>
        {summary.cta === "wait" && summary.nextAttemptAt ? (
          <p className="rr-fix__meta">
            Next automatic attempt <Timestamp mode="relative" value={summary.nextAttemptAt} />.
          </p>
        ) : null}
        {summary.lastSuccessAt ? (
          <p className="rr-fix__meta">
            Last successful sync <Timestamp mode="relative" value={summary.lastSuccessAt} />.
          </p>
        ) : null}
      </div>
      <div className="rr-fix__act">
        {summary.cta === "reconnect" ? (
          <Link href={dashboardRoutes.connector(card.connectorId)}>
            <IcButton size="sm" variant="human">
              Reconnect
            </IcButton>
          </Link>
        ) : null}
        {summary.cta === "view_runs" ? (
          <Link
            className="rr-link"
            href={`${dashboardRoutes.section.runs}?connector_id=${encodeURIComponent(card.connectorId)}`}
          >
            View runs →
          </Link>
        ) : null}
        {summary.cta === "wait" ? <Caption className="rr-fix__waiting">No action needed</Caption> : null}
      </div>
    </section>
  );
}

// ─── Sync row (one stream) ────────────────────────────────────────────────────

function SyncTableRow({ row, isOpen, onToggle }: { row: SyncRow; isOpen: boolean; onToggle: () => void }) {
  const deltaClass = ["rr-sync-row__delta", row.quiet ? "is-quiet" : undefined, row.failed ? "is-failed" : undefined]
    .filter(Boolean)
    .join(" ");
  return (
    <>
      <TableRow
        className={["rr-sync-row", row.failed ? "is-failed" : null].filter(Boolean).join(" ")}
        onClick={onToggle}
      >
        <TableCell className="rr-sync-row__stream">{row.stream}</TableCell>
        <TableCell className="rr-sync-row__cadence">{row.cadence}</TableCell>
        <TableCell>
          <Rhythm ticks={row.rhythm} />
        </TableCell>
        <TableCell className={deltaClass}>
          <span>{row.delta}</span>
          {row.lastAt ? (
            <span className="rr-sync-row__when">
              <Timestamp mode="relative" value={row.lastAt} />
            </span>
          ) : null}
        </TableCell>
        <TableCell className="rr-sync-row__next" numeric>
          {row.nextAt ? <Timestamp mode="relative" value={row.nextAt} /> : row.next}
        </TableCell>
      </TableRow>
      {isOpen ? (
        <div className="rr-sync-detail">
          <KV>
            <KVRow k="last run">
              {row.lastAt ? <Timestamp mode="relative" value={row.lastAt} /> : "—"}
              {row.duration ? ` · ${row.duration}` : ""}
            </KVRow>
            <KVRow k="delta">{row.failed ? "0 records — cursor held" : row.delta}</KVRow>
            <KVRow k="cadence">{row.cadence}</KVRow>
            <KVRow k="next">{row.nextAt ? <Timestamp mode="relative" value={row.nextAt} /> : row.next}</KVRow>
          </KV>
          <Link className="rr-link rr-sync-detail__browse" href={row.browseHref}>
            browse this stream →
          </Link>
        </div>
      ) : null}
    </>
  );
}

// ─── Sync group (one connection) ──────────────────────────────────────────────

function SyncGroupBlock({
  group,
  openKey,
  onToggle,
}: {
  group: SyncGroup;
  openKey: string | null;
  onToggle: (key: string) => void;
}) {
  const healthy = group.health === "ok";
  return (
    <section className="rr-sync-group">
      <div className="rr-sync-group__head">
        <span aria-hidden className={["rr-sync-group__dot", healthy ? "is-ok" : "is-fail"].join(" ")} />
        <span className="rr-sync-group__name">{group.name}</span>
        <span className="rr-sync-group__cin">{group.connectionId}</span>
        <span className="rr-sync-group__count">
          {group.streams.length} {group.streams.length === 1 ? "stream" : "streams"}
        </span>
      </div>
      <Table cols={SYNC_COLS}>
        <TableHeaderRow>
          <TableHeader>stream</TableHeader>
          <TableHeader>cadence</TableHeader>
          <TableHeader>recent</TableHeader>
          <TableHeader>last result</TableHeader>
          <TableHeader numeric>next</TableHeader>
        </TableHeaderRow>
        {group.streams.map((row) => {
          const key = `${group.connectionId}:${row.stream}`;
          return <SyncTableRow isOpen={openKey === key} key={key} onToggle={() => onToggle(key)} row={row} />;
        })}
      </Table>
    </section>
  );
}

// ─── The view ─────────────────────────────────────────────────────────────────

export function SyncsView({ model, seeded = false }: { model: SyncsViewModel; seeded?: boolean }) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const toggle = (key: string) => setOpenKey((cur) => (cur === key ? null : key));

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

      {model.groups.length > 0 ? (
        <div className="rr-sync__groups">
          {model.groups.map((group) => (
            <SyncGroupBlock group={group} key={group.connectionId} onToggle={toggle} openKey={openKey} />
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
