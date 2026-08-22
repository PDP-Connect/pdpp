// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

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
 *   - Reauthorization has no dedicated server action at the index level, and no
 *     affordance here claims otherwise. "Source details →" links to the
 *     connection detail page (the always-safe target where reauth and
 *     credential controls actually live) and is named for that destination —
 *     it is a navigation, not a stubbed mutation. The label is CONSTANT: it
 *     used to flip to "Reauthorize →" on a manual-upload / non-owner-verdict
 *     condition unrelated to reauthorization, while pointing at the same href.
 *   - The next_action CTA renders the formatted, non-secret label and links to
 *     the in-app detail page, never the raw `action_target`.
 *
 * ── NAV-vs-ACTION RULE (applies to every affordance in this file) ──
 *
 * A <Link> NAVIGATES and never changes state. An <IcButton> CHANGES STATE and
 * never navigates. The rendered chrome must say which is which BEFORE the user
 * reads the label:
 *
 *   1. Navigation carries a trailing "→" and never a filled or destructive
 *      variant. In `pdpp-btn` terms that means `pdpp-btn--ghost`, never
 *      `pdpp-btn--default` / `--destructive` / `--human`.
 *   2. Mutation carries NO arrow and keeps the filled `default` /
 *      `destructive` / `human` variant semantics.
 *
 * Why: these sit side by side in one `rr-s-actions` flex row. Before this rule,
 * "Add another export" (a <Link>) and "Reactivate" (a real server action) both
 * rendered as filled `default` `sm` controls, and "Reprocess all exports" (a
 * mutation) was styled identically to "Source details →" (navigation). Nothing
 * in the output distinguished a route change from a state change. The trailing
 * arrow already existed as a habit here — this promotes it to the rule.
 */
"use client";

import {
  ConnectorIcon,
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
import { SOURCE_ACCESS_NOTE } from "./sources-copy.ts";
import {
  buildDuplicateSourceReview,
  collapseDuplicateFallbackSources,
  type DuplicateSourceGroup,
  type DuplicateSourceReview,
  reactivateRecordCopy,
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

type ToastState =
  | { kind: "none" }
  | { kind: "ok"; message: string; runHref?: string; runId?: string }
  | { kind: "error"; message: string };

const ADD_SOURCE_HREF = "/sources/add";

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
            <span className="rr-s-end__note">{SOURCE_ACCESS_NOTE}</span>
          </div>
        </aside>

        {selected ? (
          <div className="rr-s-detail" data-pdpp-selected-source={selected.connectionId ?? selected.id}>
            <InstancePassport
              instance={selected}
              interactive={interactive}
              key={selected.id}
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
  const [primary] = reviews;
  if (!primary) {
    return null;
  }
  const more = reviews.length > 1 ? ` ${reviews.length - 1} other source type needs the same review.` : "";
  return (
    <aside className="rr-s-duplicates" data-testid="sources-duplicate-review" role="note">
      <span className="rr-s-churn__eyebrow">Several sources need labels</span>
      <p className="rr-s-churn__head">
        {primary.total.toLocaleString()} {primary.kind} sources are configured; {primary.unnamed.toLocaleString()}{" "}
        {primary.unnamed === 1 ? "is" : "are"} unnamed.
      </p>
      <p className="rr-s-churn__note">
        Keep multiple accounts or devices when they are intentional. Rename the ones you want to keep, or open a source
        and revoke it if it was only a setup attempt.{more}
      </p>
      <Link className="rr-s-duplicates__link" href={primary.firstUnnamedHref}>
        Review duplicate source labels →
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
      <span className="rr-s-item__identity">
        <ConnectorIcon className="rr-s-item__icon" icon={instance.icon} name={instance.displayName} />
        <span className="rr-s-item__name">{instance.displayName}</span>
      </span>
      {/* Keep list rows comparable: connector kind lives in the selected detail
          panel, while the list shows only the owner label, retained facts, and
          health. */}
      <span className="rr-s-item__line">{instance.accountLine}</span>
      {instance.ownerActionCue ? (
        <span
          className="rr-s-item__cue"
          data-testid="sources-owner-action-cue"
          title="Open the source detail to review this suggested action."
        >
          Review: {instance.ownerActionCue.label}
        </span>
      ) : null}
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
        data-pdpp-source-row={instance.connectionId ?? instance.id}
        data-source-id={instance.id}
        data-source-label={instance.displayName}
        href={instance.detailHref}
      >
        {inner}
      </Link>
      {/*
       * Desktop (>800px): the row body SELECTS, driving the right-column
       * passport in place. The link to the full detail page lives IN that
       * passport, next to the identity it belongs to — a second "Open" column
       * beside every row repeated the same destination once per row and read
       * as a stray column. Hidden on mobile via CSS, where the row Link above
       * is the single affordance.
       */}
      <div className="rr-s-item-wrap rr-s-item-wrap--desktop">
        <button
          aria-pressed={selected}
          className={`${cls} rr-s-item--desktop`}
          data-pdpp-source-row={instance.connectionId ?? instance.id}
          data-source-id={instance.id}
          data-source-label={instance.displayName}
          onClick={onSelect}
          type="button"
        >
          {inner}
        </button>
      </div>
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
            {/* The connection id is the thing owners recognize a source BY, so it
                is both a jump-off and a copy target — not either/or. CopyMono keeps
                the copy affordance (its button is a real control, so it must stay a
                SIBLING of the link, never nested inside one); the adjacent arrow
                link navigates to the same detail page the foot CTA targets. */}
            <CopyMono text={instance.connectionId} />
            <Link
              aria-label={`Open source details for connection ${instance.connectionId}`}
              className="rr-s-serial-open"
              href={instance.detailHref}
              title="Open this connection's detail page."
            >
              →
            </Link>
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
  const { manualUploadHref } = instance;
  const detailsTitle = sourceDetailsTitle();

  const handleSync = useCallback(() => {
    setToast({ kind: "none" });
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(
        instance.connectorId,
        instance.connectionId ?? instance.connectorInstanceId ?? null
      );
      if (res.ok) {
        const action = manualUploadHref ? "Reprocessing all uploaded exports" : "Sync";
        setToast({
          kind: "ok",
          message: `${action} started.`,
          runHref: res.run_id ? `/syncs/${encodeURIComponent(res.run_id)}` : undefined,
          runId: res.run_id || undefined,
        });
        router.refresh();
        return;
      }
      if (res.reason === "already_running") {
        setToast({
          kind: "ok",
          message: res.message,
          runHref: res.run_id ? `/syncs/${encodeURIComponent(res.run_id)}` : undefined,
          runId: res.run_id,
        });
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
          primaryVerdictAction={instance.primaryVerdictAction}
          syncDisabled={syncDisabled}
        />

        {/* NAV (see the nav-vs-action rule above): one destination, one name.
            The label used to flip to "Reauthorize →" on a condition — manual-upload
            support / a non-owner-runnable verdict — that has nothing to do with
            reauthorization, so a healthy OAuth source with no pending reauth still
            read "Reauthorize →". The href never changed; only the word did. */}
        <Link className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm" href={instance.detailHref} title={detailsTitle}>
          Source details →
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
          {toast.kind === "ok" && toast.runHref && toast.runId ? (
            <>
              {" "}
              <Link href={toast.runHref}>Open run {toast.runId} →</Link>
            </>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * Tooltip for the "Source details →" link.
 *
 * One destination gets one description. The old fallback branch read
 * "Reauthorize and credential controls live on the connection detail page." —
 * an accurate description of a PAGE attached to a control that read like a
 * CREDENTIAL OPERATION, which is what made the affordance misleading. The
 * detail page is where reauth/credential controls live either way, so naming
 * the page honestly covers every branch.
 */
function sourceDetailsTitle(): string {
  return "Open runs, receipts, streams, credential controls, and settings for this source.";
}

/**
 * Enforce the nav-vs-action rule's trailing arrow on a SERVER-SUPPLIED label.
 *
 * Verdict CTAs come from the reference's rendered verdict, so their wording is
 * not ours to choose — but the arrow is chrome, not copy, and every navigation
 * in this file must carry one. Idempotent: a `cta` that already ends in an
 * arrow is returned untouched, so this never yields "Open →  →".
 */
function withNavArrow(label: string): string {
  return label.trimEnd().endsWith("→") ? label : `${label} →`;
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
  primaryVerdictAction,
  syncDisabled,
}: {
  instance: SourceInstanceView;
  isPending: boolean;
  manualUploadHref: string | null;
  onSync: () => void;
  primaryVerdictAction: SourceInstanceView["primaryVerdictAction"];
  syncDisabled: boolean;
}) {
  if (primaryVerdictAction !== null && !primaryVerdictAction.ownerRunnable) {
    return (
      <span
        className="rr-s-cta__hint"
        data-action-audience={primaryVerdictAction.audience}
        data-action-kind={primaryVerdictAction.kind}
        data-testid="sources-verdict-status-action"
        title={
          primaryVerdictAction.terminal
            ? "This source is not owner-repairable from the dashboard."
            : "This source is waiting on reference-side work."
        }
      >
        {primaryVerdictAction.cta}
      </span>
    );
  }
  if (
    primaryVerdictAction?.ownerRunnable &&
    (primaryVerdictAction.kind === "refresh_now" || primaryVerdictAction.kind === "retry_gap")
  ) {
    return (
      <IcButton
        aria-label={`${primaryVerdictAction.cta} for ${instance.displayName}`}
        disabled={syncDisabled}
        onClick={onSync}
        size="sm"
        type="button"
      >
        {isPending ? "Starting…" : primaryVerdictAction.cta}
      </IcButton>
    );
  }
  if (primaryVerdictAction?.ownerRunnable) {
    // NAV: this owner action is COMPLETED on the detail page, not started here,
    // so it takes the ghost+arrow navigation chrome. It previously rendered
    // filled `default` — visually identical to the adjacent Reactivate/Sync
    // mutations. The server-supplied `cta` may or may not already end in an
    // arrow, so append one only when it does not.
    return (
      <Link
        className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
        data-action-audience={primaryVerdictAction.audience}
        data-action-kind={primaryVerdictAction.kind}
        data-testid="sources-owner-verdict-action"
        href={instance.detailHref}
        title="Open source details to complete this owner action."
      >
        {withNavArrow(primaryVerdictAction.cta)}
      </Link>
    );
  }
  if (manualUploadHref) {
    return (
      <>
        {/* NAV: this routes to the manual-upload flow; it does not itself upload
            anything. It used to render filled `default` — the same chrome as the
            Reactivate mutation beside it. Ghost + arrow per the rule above. */}
        <Link
          className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
          href={manualUploadHref}
          title="Upload another exported file into this same source. Use Add source only for a different account or identity."
        >
          Add another export →
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
  const recordCopy = reactivateRecordCopy(instance.totalRecords, instance.totalRecordsState);
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
            <StreamManifestRow connectionId={instance.connectionId ?? instance.id} key={stream.name} stream={stream} />
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

function StreamManifestRow({
  connectionId,
  stream,
}: {
  connectionId: string;
  stream: SourceInstanceView["streams"][number];
}) {
  const { collection } = stream;
  const isDisplayLabelDifferent = stream.displayLabel !== stream.name;
  return (
    <Link
      className="pdpp-table__row rr-s-stream-row"
      data-connection-id={connectionId}
      data-pdpp-stream-row="true"
      data-stream-name={stream.name}
      href={stream.exploreHref}
      style={{ display: "grid" }}
    >
      <TableCell>
        <span className="rr-s-stream" title={isDisplayLabelDifferent ? stream.name : undefined}>
          {stream.displayLabel}
        </span>
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
            title="Nothing has measured this stream yet — the reference has not produced a collection report for it, so we can't say whether it is complete."
          >
            Not measured
          </span>
        )}
        {collection?.dispositionLabel ? (
          <span className="rr-s-stream-subfact" title={collection.dispositionTitle ?? undefined}>
            {collection.dispositionLabel}
          </span>
        ) : null}
        {collection && collection.pendingDetailGaps > 0 ? (
          <span className="rr-s-stream-subfact is-warning">{collection.pendingDetailGapsLabel ?? "pending gaps"}</span>
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
  const { collection } = stream;
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
        Record count not available yet
      </span>
    );
  }
  return <span className="rr-s-stream-fact is-muted">Collection facts not available yet</span>;
}
