/**
 * SourcesView — the Recordroom "loading dock" presentation.
 *
 * Master-detail over the owner's configured source instances:
 *   - left: a dense instance list, each row a health-flagged button;
 *   - right: a "passport" Sheet (identity + KV block + foot actions) over a
 *     stream manifest Table that LINKS INTO Explore (records are never rendered
 *     here — Explore is the one reader).
 *
 * Data binding (honest, no fabrication):
 *   - Status dot/flag comes from the server-owned `rendered_verdict` via the
 *     shared projection mapping (see sources-view-model.ts).
 *   - A runtime fault renders once above the list, never as N per-source alarms.
 *   - Sync now calls the real `runConnectorNowAction` (the client variant that
 *     returns a discriminated `RunNowResult`) so a failed start surfaces as an
 *     in-place toast, never the route error boundary.
 *   - Revoke is the real server action `revokeConnectionAction`, behind a
 *     Keep|Confirm ceremony with a server-enforced `confirm_revoke=yes` field.
 *     The destructive variant is reserved for it; the warm copper `human`
 *     variant is reserved for owner-consent acts (none here are consent, so the
 *     foot uses default/ghost/destructive only — copper would mis-signal).
 *   - Reactivate is the real server action `reactivateConnectionAction`. Shown
 *     on REVOKED connections only; it is the clean inverse of revoke (flips
 *     status back to active, clears revoked_at, resumes collection) without
 *     erasing any collected data. Copy is SLVP-honest: shows the retained
 *     record count and notes that credential freshness may need attention on
 *     the next run for OAuth/account connections.
 *   - Reauthorize has no dedicated server action at the index level; it links
 *     to the connection detail page (the always-safe target where reauth lives)
 *     and is labeled as a navigation, not a stubbed mutation.
 *   - The next_action CTA renders the formatted, non-secret label and links to
 *     the in-app detail page, never the raw `action_target`.
 */
"use client";

import {
  CopyMono,
  Endorse,
  IcButton,
  KV,
  KVRow,
  Sheet,
  SheetBody,
  SheetFoot,
  SheetHead,
  SheetSerial,
  SheetTitle,
  Table,
  TableCell,
  TableHeader,
  TableHeaderRow,
} from "@pdpp/brand-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
import { type RunNowResult, runConnectorNowAction } from "./actions.ts";
import {
  buildDuplicateSourceReview,
  collapseDuplicateFallbackSources,
  type DuplicateSourceGroup,
  type DuplicateSourceReview,
  type SourceInstanceView,
  type SourcesChurnAdvisory,
  type SourcesRuntimeAdvisory,
} from "./sources-view-model.ts";
import "./sources-view.css";

interface SourcesViewProps {
  /**
   * Quiet version-churn advisory derived from `/_ref/records/version-stats`
   * (metadata only — never record payloads). Null when no churning stream
   * crosses the risk threshold. Rendered as an informational protocol-toned
   * footer, never an alarm; the per-source detail page carries the drilldown.
   */
  churnAdvisory?: SourcesChurnAdvisory | null;
  instances: SourceInstanceView[];
  /** Whether the real Sync/Revoke/Reactivate mutations are wired (live) or read-only. */
  interactive: boolean;
  /** The real server action behind the Reactivate button (live binding only). */
  reactivateAction?: (formData: FormData) => void | Promise<void>;
  /** The real server action behind the Revoke ceremony (live binding only). */
  revokeAction?: (formData: FormData) => void | Promise<void>;
  /** One global collection-runtime status. Runtime faults must not cascade per source. */
  runtimeAdvisory?: SourcesRuntimeAdvisory | null;
}

type ToastState = { kind: "none" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

const ADD_SOURCE_HREF = "/dashboard/records/add";

export function SourcesView({
  churnAdvisory,
  instances,
  interactive,
  reactivateAction,
  revokeAction,
  runtimeAdvisory,
}: SourcesViewProps) {
  const activeInstances = instances.filter((i) => !i.revoked);
  const revokedInstances = instances.filter((i) => i.revoked);
  const duplicateReviews = buildDuplicateSourceReview(instances);
  const { duplicateGroups, visibleActiveInstances } = collapseDuplicateFallbackSources(instances);

  // Default selection: first active source, or first revoked if all are revoked.
  const defaultId = (visibleActiveInstances[0] ?? duplicateGroups[0]?.items[0] ?? revokedInstances[0])?.id ?? null;
  const [selectedId, setSelectedId] = useState<string | null>(defaultId);
  const selected = instances.find((i) => i.id === selectedId) ?? activeInstances[0] ?? revokedInstances[0] ?? null;

  if (instances.length === 0) {
    return (
      <div className="rr-s-empty" data-testid="sources-empty">
        No sources yet. <Link href={ADD_SOURCE_HREF}>Add a source →</Link>
      </div>
    );
  }

  return (
    <>
      {/* Advisories lead — before the list so they're not orphaned at the bottom on mobile. */}
      {runtimeAdvisory ? <RuntimeAdvisory advisory={runtimeAdvisory} /> : null}
      {churnAdvisory ? <ChurnAdvisory advisory={churnAdvisory} /> : null}
      {duplicateReviews.length > 0 ? <DuplicateSourcesAdvisory reviews={duplicateReviews} /> : null}
      <div className="rr-s">
        <aside aria-label="Sources" className="rr-s-list">
          {visibleActiveInstances.map((instance) => (
            <InstanceListItem
              instance={instance}
              key={instance.id}
              onSelect={() => setSelectedId(instance.id)}
              selected={selected?.id === instance.id}
            />
          ))}

          {duplicateGroups.map((group) => (
            <DuplicateSourceGroupList
              group={group}
              key={group.connectorId}
              onSelect={setSelectedId}
              selectedId={selected?.id ?? null}
            />
          ))}

          {/* Revoked sources: accessible but not noise. Collapsed by default so
              they don't clutter the active list; the owner can always expand to
              inspect, navigate to detail, or delete. Full row behavior is intact. */}
          {revokedInstances.length > 0 ? (
            <details className="rr-s-revoked-group" data-testid="sources-revoked-group">
              <summary className="rr-s-revoked-group__summary">Revoked ({revokedInstances.length})</summary>
              {revokedInstances.map((instance) => (
                <InstanceListItem
                  instance={instance}
                  key={instance.id}
                  onSelect={() => setSelectedId(instance.id)}
                  selected={selected?.id === instance.id}
                />
              ))}
            </details>
          ) : null}

          <div className="rr-s-end">
            <Link className="rr-s-link" href={ADD_SOURCE_HREF}>
              add a source →
            </Link>
            <span className="rr-s-end__note">a source pushes into your streams · nothing leaves</span>
          </div>
        </aside>

        {selected ? (
          <div className="rr-s-detail">
            <InstancePassport
              instance={selected}
              interactive={interactive}
              reactivateAction={reactivateAction}
              revokeAction={revokeAction}
            />
            <StreamManifest instance={selected} />
          </div>
        ) : null}
      </div>
    </>
  );
}

function DuplicateSourceGroupList({
  group,
  onSelect,
  selectedId,
}: {
  group: DuplicateSourceGroup;
  onSelect: (id: string) => void;
  selectedId: string | null;
}) {
  const selectedInGroup = group.items.some((instance) => instance.id === selectedId);
  return (
    <details className="rr-s-duplicate-group" data-testid="sources-duplicate-group" open={selectedInGroup}>
      <summary className="rr-s-duplicate-group__summary">
        {group.total.toLocaleString()} unnamed {group.kind} sources
      </summary>
      <p className="rr-s-duplicate-group__note">
        Open a row to label it on the detail page or revoke a setup attempt. Nothing is merged or removed automatically.
      </p>
      {group.items.map((instance) => (
        <InstanceListItem
          instance={instance}
          key={instance.id}
          onSelect={() => onSelect(instance.id)}
          selected={selectedId === instance.id}
        />
      ))}
    </details>
  );
}

function DuplicateSourcesAdvisory({ reviews }: { reviews: readonly DuplicateSourceReview[] }) {
  const primary = reviews[0];
  if (!primary) {
    return null;
  }
  const more = reviews.length > 1 ? ` ${reviews.length - 1} other source type needs the same review.` : "";
  return (
    <aside className="rr-s-duplicates" data-testid="sources-duplicate-review" role="note">
      <span className="rr-s-churn__eyebrow">same source type · review labels</span>
      <p className="rr-s-churn__head">
        {primary.total.toLocaleString()} {primary.kind} sources are configured; {primary.unnamed.toLocaleString()}{" "}
        {primary.unnamed === 1 ? "is" : "are"} unnamed.
      </p>
      <p className="rr-s-churn__note">
        Keep multiple accounts or devices when they are intentional. Rename the ones you want to keep, or open a source
        and revoke it if it was only a setup attempt.{more}
      </p>
      <Link className="rr-s-duplicates__link" href={primary.firstUnnamedHref}>
        Review first unnamed source →
      </Link>
    </aside>
  );
}

function RuntimeAdvisory({ advisory }: { advisory: SourcesRuntimeAdvisory }) {
  return (
    <aside className="rr-s-runtime" data-testid="sources-runtime-advisory" role="status">
      <span className="rr-s-churn__eyebrow">collection runtime</span>
      <p className="rr-s-churn__head">{advisory.headline}</p>
      <p className="rr-s-churn__note">{advisory.note}</p>
    </aside>
  );
}

/**
 * Quiet, protocol-toned version-churn advisory.
 *
 * This is the Recordroom home of the signal the old records page surfaced via
 * `VersionChurnNotice`. It is deliberately informational, NOT an alarm: version
 * churn is *retained change history*, not current-data loss, so the surface
 * stays on the muted/border palette (no warning amber, no copper consent tone)
 * regardless of `needsReview` — `needsReview` only refines the mono eyebrow
 * copy. The full per-stream drilldown (dispositions, dry-run commands) lives on
 * the source detail page; this footer is a one-line pointer, not a re-render of
 * that table.
 */
function ChurnAdvisory({ advisory }: { advisory: SourcesChurnAdvisory }) {
  return (
    <aside className="rr-s-churn" data-testid="sources-version-churn" role="note">
      <span className="rr-s-churn__eyebrow">
        {advisory.needsReview ? "retained history · review" : "retained history · classified"}
      </span>
      <p className="rr-s-churn__head">{advisory.headline}</p>
      <p className="rr-s-churn__signal">{advisory.highestSignal}</p>
      <p className="rr-s-churn__note">
        This is kept change history, not current-data loss — your latest records are intact. Open a source to see its
        per-stream disposition and any safe compaction.
      </p>
    </aside>
  );
}

function InstanceListItem({
  instance,
  onSelect,
  selected,
}: {
  instance: SourceInstanceView;
  onSelect: () => void;
  selected: boolean;
}) {
  const cls = ["rr-s-item", selected ? "is-on" : null, instance.revoked ? "is-revoked" : null]
    .filter(Boolean)
    .join(" ");
  // Inner content shared by both the mobile <Link> and the desktop <button>.
  const inner = (
    <>
      <span className="rr-s-item__name">{instance.displayName}</span>
      {/* The connector kind is quiet secondary metadata folded into the account
          line (row 2) so it never competes with the bold name on row 1 nor
          crowds / clips against the health dot at the card's right edge. */}
      <span className="rr-s-item__line">
        {instance.accountLine}
        <span className="rr-s-item__kind">{instance.kind}</span>
      </span>
      <span className="rr-s-item__flag">
        {/* The dot is a decorative reinforcement of the status; the textual
            label is announced via the sr-only span so color is never the sole
            signal and the glyph itself carries no a11y burden. */}
        <span aria-hidden="true" className="rr-s-dot" data-tone={instance.status.tone} title={instance.status.label}>
          {instance.status.dot}
        </span>
        <span className="sr-only">{instance.status.label}</span>
      </span>
    </>
  );
  return (
    <>
      {/*
       * Mobile (≤800px): a full-page push to the connection detail page.
       * The detail column is hidden on mobile via CSS so tapping here is the
       * only path to the detail — no stacked-below dead content.
       */}
      <Link
        aria-current={selected ? "page" : undefined}
        className={`${cls} rr-s-item--mobile`}
        href={instance.detailHref}
      >
        {inner}
      </Link>
      {/*
       * Desktop (>800px): in-place selection drives the right-column passport.
       * Hidden on mobile via CSS so only one affordance is interactive at
       * any given viewport width.
       */}
      <button aria-pressed={selected} className={`${cls} rr-s-item--desktop`} onClick={onSelect} type="button">
        {inner}
      </button>
    </>
  );
}

function InstancePassport({
  instance,
  interactive,
  reactivateAction,
  revokeAction,
}: {
  instance: SourceInstanceView;
  interactive: boolean;
  reactivateAction?: (formData: FormData) => void | Promise<void>;
  revokeAction?: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <Sheet>
      <SheetHead>
        <SheetTitle>{instance.revoked ? <s>{instance.displayName}</s> : instance.displayName}</SheetTitle>
        {instance.connectionId ? (
          <SheetSerial>
            <CopyMono text={instance.connectionId} />
          </SheetSerial>
        ) : (
          <SheetSerial>no connection id</SheetSerial>
        )}
      </SheetHead>

      <SheetBody>
        <PassportStatusLine instance={instance} />
        <KV>
          {instance.passportFields.map((field) => (
            <KVRow className={field.mono ? "rr-s-mono-row" : undefined} k={field.k} key={field.k}>
              <PassportValue mono={field.mono} value={field.value} />
            </KVRow>
          ))}
        </KV>
        {instance.nextAction ? (
          <NextActionCta detailHref={instance.detailHref} formatted={instance.nextAction} />
        ) : null}
        {instance.revoked ? (
          <p className="rr-s-revoked-note">
            Future collection is stopped. Already-collected records stay visible and searchable; revoke does not erase
            anything.
          </p>
        ) : null}
      </SheetBody>

      <SheetFoot>
        <PassportActions
          instance={instance}
          interactive={interactive}
          reactivateAction={reactivateAction}
          revokeAction={revokeAction}
        />
      </SheetFoot>
    </Sheet>
  );
}

function PassportStatusLine({ instance }: { instance: SourceInstanceView }) {
  const endorseStatus = endorseFor(instance.status.kind);
  return (
    <div style={{ marginBottom: 12 }}>
      <Endorse label={instance.status.label} status={endorseStatus} />
    </div>
  );
}

/** Map a status kind to the closest Endorse variant (the kit's color home). */
function endorseFor(
  kind: SourceInstanceView["status"]["kind"]
): "active" | "continuous" | "denied" | "expiring" | "revoked" {
  switch (kind) {
    case "healthy":
      return "active";
    case "degraded":
      return "expiring";
    case "blocked":
      return "denied";
    case "revoked":
      return "revoked";
    default:
      // unknown → muted outline, same chrome as revoked but a distinct label.
      return "revoked";
  }
}

function PassportValue({ value, mono }: { value: string | null; mono?: boolean }) {
  if (value === null) {
    return <span style={{ color: "var(--muted-foreground)", fontStyle: "italic" }}>—</span>;
  }
  if (mono) {
    return <span>{value}</span>;
  }
  return <span style={{ fontFamily: "var(--font-sans)" }}>{value}</span>;
}

function NextActionCta({
  detailHref,
  formatted,
}: {
  detailHref: string;
  formatted: NonNullable<SourceInstanceView["nextAction"]>;
}) {
  // We never link to the spine's raw `action_target`; the always-safe target is
  // the connection detail page. Schedule-fallback CTAs are imprecise by
  // definition → render the label as plain text, not a link.
  const interactive = formatted.actionTarget !== null && formatted.variant === "structured";
  const label = interactive ? (
    <Link className="rr-s-cta__label" href={detailHref}>
      {formatted.label}
    </Link>
  ) : (
    <span className="rr-s-cta__label">{formatted.label}</span>
  );
  return (
    <div className="rr-s-cta" data-next-action-source={formatted.variant} data-testid="sources-next-action">
      {label}
      {formatted.caveat ? <span className="rr-s-cta__caveat">{formatted.caveat}</span> : null}
      {formatted.notificationHint ? <span className="rr-s-cta__hint">{formatted.notificationHint}</span> : null}
    </div>
  );
}

function PassportActions({
  instance,
  interactive,
  reactivateAction,
  revokeAction,
}: {
  instance: SourceInstanceView;
  interactive: boolean;
  reactivateAction?: (formData: FormData) => void | Promise<void>;
  revokeAction?: (formData: FormData) => void | Promise<void>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState>({ kind: "none" });
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);
  const [confirmingReactivate, setConfirmingReactivate] = useState(false);
  const manualUploadHref = instance.manualUploadHref;

  const handleSync = useCallback(() => {
    setToast({ kind: "none" });
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(
        instance.connectorId,
        instance.connectionId ?? instance.connectorInstanceId ?? null
      );
      if (res.ok) {
        const action = manualUploadHref ? "Reprocessing all uploaded exports" : "Sync";
        setToast({ kind: "ok", message: res.run_id ? `${action} started (${res.run_id}).` : `${action} started.` });
        router.refresh();
        return;
      }
      if (res.reason === "already_running") {
        setToast({ kind: "ok", message: res.message });
        router.refresh();
        return;
      }
      setToast({ kind: "error", message: res.message });
    });
  }, [instance.connectorId, instance.connectionId, instance.connectorInstanceId, manualUploadHref, router]);

  // Push-mode connections can't be remotely pulled — Sync is inert for them.
  const syncDisabled =
    !interactive || instance.isLocalDevicePush || instance.revoked || instance.isRunning || isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <div className="rr-s-actions">
        <CollectionRunAction
          instance={instance}
          isPending={isPending}
          manualUploadHref={manualUploadHref}
          onSync={handleSync}
          syncDisabled={syncDisabled}
        />

        <Link
          className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
          href={instance.detailHref}
          title={
            manualUploadHref
              ? "Open runs, receipts, streams, and source settings."
              : "Reauthorize and credential controls live on the connection detail page."
          }
        >
          {manualUploadHref ? "Source details →" : "Reauthorize →"}
        </Link>

        {interactive && revokeAction && instance.connectionId && !instance.revoked ? (
          <IcButton onClick={() => setConfirmingRevoke((v) => !v)} size="sm" type="button" variant="destructive">
            Revoke
          </IcButton>
        ) : null}

        {interactive && reactivateAction && instance.connectionId && instance.revoked ? (
          <IcButton
            data-testid="sources-reactivate-btn"
            onClick={() => setConfirmingReactivate((v) => !v)}
            size="sm"
            type="button"
            variant="default"
          >
            Reactivate
          </IcButton>
        ) : null}
      </div>

      {confirmingRevoke && revokeAction && instance.connectionId ? (
        <RevokeCeremony
          connectionId={instance.connectionId}
          onCancel={() => setConfirmingRevoke(false)}
          revokeAction={revokeAction}
        />
      ) : null}

      {confirmingReactivate && reactivateAction && instance.connectionId ? (
        <ReactivateCeremony
          connectionId={instance.connectionId}
          instance={instance}
          onCancel={() => setConfirmingReactivate(false)}
          reactivateAction={reactivateAction}
        />
      ) : null}

      {toast.kind === "none" ? null : (
        <div
          aria-live="polite"
          className="rr-s-toast"
          data-testid="sources-action-toast"
          data-tone={toast.kind}
          role="status"
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}

function manualImportButtonLabel(instance: SourceInstanceView, isPending: boolean): string {
  if (instance.isRunning) {
    return "Import running";
  }
  if (isPending) {
    return "Starting…";
  }
  return "Reprocess all exports";
}

function CollectionRunAction({
  instance,
  isPending,
  manualUploadHref,
  onSync,
  syncDisabled,
}: {
  instance: SourceInstanceView;
  isPending: boolean;
  manualUploadHref: string | null;
  onSync: () => void;
  syncDisabled: boolean;
}) {
  if (manualUploadHref) {
    return (
      <>
        <Link
          className="pdpp-btn pdpp-btn--default pdpp-btn--sm"
          href={manualUploadHref}
          title="Upload another exported file into this same source. Use Add source only for a different account or identity."
        >
          Add another export
        </Link>
        <IcButton
          aria-label={`Reprocess the uploaded export for ${instance.displayName}`}
          disabled={syncDisabled}
          onClick={onSync}
          size="sm"
          title="Reprocesses files already uploaded for this source. It does not add a new export."
          type="button"
          variant="ghost"
        >
          {manualImportButtonLabel(instance, isPending)}
        </IcButton>
      </>
    );
  }
  if (instance.isLocalDevicePush) {
    return (
      <span className="rr-s-cta__hint" data-testid="sources-sync-device-wait">
        Data arrives when your paired device pushes it.
      </span>
    );
  }
  return (
    <IcButton
      aria-label={`Sync ${instance.displayName} now`}
      disabled={syncDisabled}
      onClick={onSync}
      size="sm"
      type="button"
    >
      {isPending ? "Syncing…" : "Sync now"}
    </IcButton>
  );
}

function RevokeCeremony({
  connectionId,
  onCancel,
  revokeAction,
}: {
  connectionId: string;
  onCancel: () => void;
  revokeAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={revokeAction} className="rr-s-revoke" data-testid="sources-revoke-ceremony">
      <input name="connection_id" type="hidden" value={connectionId} />
      <p className="rr-s-revoke__copy">
        Revoke stops future collection for this connection. Already-collected records, grants, and audit history are
        retained — revoke does not erase anything.
      </p>
      <label className="rr-s-revoke__check">
        <input name="confirm_revoke" type="checkbox" value="yes" />
        <span>
          Stop future collection for <code style={{ fontFamily: "var(--font-mono)" }}>{connectionId}</code>; keep its
          records.
        </span>
      </label>
      <div className="rr-s-revoke__row">
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">
          Keep
        </IcButton>
        <IcButton size="sm" type="submit" variant="destructive">
          Confirm revoke
        </IcButton>
      </div>
    </form>
  );
}

function reactivateCopy(instance: SourceInstanceView): string {
  const recordCopy =
    instance.totalRecords > 0
      ? `${instance.totalRecords.toLocaleString()} collected record${instance.totalRecords === 1 ? "" : "s"} are`
      : "collected records are";
  const authCopy =
    instance.status.kind === "revoked" && instance.revoked
      ? " If your session or credential has expired, the first run may surface an auth error — use the connection detail to update it."
      : "";
  return `Reactivate resumes collection for this connection. Your ${recordCopy} preserved — nothing is erased. Collection will resume on the next scheduled run.${authCopy}`;
}

function ReactivateCeremony({
  connectionId,
  instance,
  onCancel,
  reactivateAction,
}: {
  connectionId: string;
  instance: SourceInstanceView;
  onCancel: () => void;
  reactivateAction: (formData: FormData) => void | Promise<void>;
}) {
  return (
    <form action={reactivateAction} className="rr-s-revoke" data-testid="sources-reactivate-ceremony">
      <input name="connection_id" type="hidden" value={connectionId} />
      <p className="rr-s-revoke__copy">{reactivateCopy(instance)}</p>
      <div className="rr-s-revoke__row">
        <IcButton onClick={onCancel} size="sm" type="button" variant="ghost">
          Cancel
        </IcButton>
        <IcButton data-testid="sources-reactivate-confirm" size="sm" type="submit" variant="default">
          Reactivate
        </IcButton>
      </div>
    </form>
  );
}

function StreamManifest({ instance }: { instance: SourceInstanceView }) {
  return (
    <div className="rr-s-manifest">
      <div className="rr-s-mini-head">
        <h3 className="rr-s-mini-head__t">Streams on this source</h3>
        <span className="rr-s-mini-head__n">{instance.streams.length}</span>
      </div>
      {instance.streams.length === 0 ? (
        <p className="rr-s-note">No streams declared on this source yet.</p>
      ) : (
        <Table className="rr-s-cols" cols="minmax(0, 1fr) minmax(13rem, 1.4fr) minmax(10rem, 1fr) 6.5rem">
          <TableHeaderRow>
            <TableHeader>stream</TableHeader>
            <TableHeader>records</TableHeader>
            <TableHeader>coverage</TableHeader>
            <TableHeader>read in</TableHeader>
          </TableHeaderRow>
          {instance.streams.map((stream) => (
            <StreamManifestRow key={stream.name} stream={stream} />
          ))}
        </Table>
      )}
      <p className="rr-s-note">
        Records are never read here. Counts come from the retained-size projection; coverage comes from the latest
        collection report when the reference has one. Click any stream to open it in Explore — the one reader.
      </p>
    </div>
  );
}

function StreamManifestRow({ stream }: { stream: SourceInstanceView["streams"][number] }) {
  const collection = stream.collection;
  return (
    <Link className="pdpp-table__row rr-s-stream-row" href={stream.exploreHref} style={{ display: "grid" }}>
      <TableCell>
        <span className="rr-s-stream">{stream.name}</span>
      </TableCell>
      <TableCell>
        <StreamRecordCount stream={stream} />
      </TableCell>
      <TableCell>
        {collection ? (
          <span className="rr-s-stream-chip" data-tone={collection.tone} title={collection.coverageTitle}>
            {collection.coverageLabel}
          </span>
        ) : (
          <span
            className="rr-s-stream-chip"
            data-tone="neutral"
            title="The reference has not produced a per-stream collection report for this stream yet."
          >
            Unknown
          </span>
        )}
        {collection?.dispositionLabel ? (
          <span className="rr-s-stream-subfact" title={collection.dispositionTitle ?? undefined}>
            {collection.dispositionLabel}
          </span>
        ) : null}
        {collection && collection.pendingDetailGaps > 0 ? (
          <span className="rr-s-stream-subfact is-warning">
            {collection.pendingDetailGaps.toLocaleString()} pending gap{collection.pendingDetailGaps === 1 ? "" : "s"}
          </span>
        ) : null}
        {collection?.skipLabel ? <span className="rr-s-stream-subfact">{collection.skipLabel}</span> : null}
      </TableCell>
      <TableCell>
        <span className="rr-s-readby">Explore →</span>
      </TableCell>
    </Link>
  );
}

function StreamRecordCount({ stream }: { stream: SourceInstanceView["streams"][number] }) {
  const collection = stream.collection;
  if (stream.recordCount !== null) {
    return (
      <>
        <span className="rr-s-stream-fact" title="Current retained records stored for this stream.">
          {stream.recordCount.toLocaleString()} records
        </span>
        {collection?.countsLabel ? (
          <span className="rr-s-stream-subfact" title={collection.countsTitle}>
            last run: {collection.countsLabel}
          </span>
        ) : null}
      </>
    );
  }
  if (collection?.countsLabel) {
    return (
      <span className="rr-s-stream-fact" title={collection.countsTitle}>
        {collection.countsLabel}
      </span>
    );
  }
  if (collection) {
    return (
      <span className="rr-s-stream-fact is-muted" title={collection.countsTitle}>
        Collection count unavailable
      </span>
    );
  }
  return <span className="rr-s-stream-fact is-muted">Collection facts not available yet</span>;
}
