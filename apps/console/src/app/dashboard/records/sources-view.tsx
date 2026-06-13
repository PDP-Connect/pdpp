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
 *   - Status dot/flag comes from `connection_health.state` via the shared
 *     `deriveSourceStatus` mapping (see sources-view-model.ts).
 *   - Sync now calls the real `runConnectorNowAction` (the client variant that
 *     returns a discriminated `RunNowResult`) so a failed start surfaces as an
 *     in-place toast, never the route error boundary.
 *   - Revoke is the real server action `revokeConnectionAction`, behind a
 *     Keep|Confirm ceremony with a server-enforced `confirm_revoke=yes` field.
 *     The destructive variant is reserved for it; the warm copper `human`
 *     variant is reserved for owner-consent acts (none here are consent, so the
 *     foot uses default/ghost/destructive only — copper would mis-signal).
 *   - Reauthorize has no dedicated server action at the index level; it links
 *     to the connection detail page (the always-safe target where reauth lives)
 *     and is labeled as a navigation, not a stubbed mutation.
 *   - The next_action CTA renders the formatted, non-secret label and links to
 *     the in-app detail page, never the raw `action_target`.
 */
"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useState, useTransition } from "react";
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
} from "@/components/ink-carbon";
import { type RunNowResult, runConnectorNowAction } from "./actions.ts";
import type { SourceInstanceView } from "./sources-view-model.ts";
import "./sources-view.css";

interface SourcesViewProps {
  instances: SourceInstanceView[];
  /** Whether the real Sync/Revoke mutations are wired (live) or read-only. */
  interactive: boolean;
  /** The real server action behind the Revoke ceremony (live binding only). */
  revokeAction?: (formData: FormData) => void | Promise<void>;
}

type ToastState = { kind: "none" } | { kind: "ok"; message: string } | { kind: "error"; message: string };

const ADD_SOURCE_HREF = "/dashboard/records/add";

export function SourcesView({ instances, interactive, revokeAction }: SourcesViewProps) {
  const [selectedId, setSelectedId] = useState<string | null>(instances[0]?.id ?? null);
  const selected = instances.find((i) => i.id === selectedId) ?? instances[0] ?? null;

  if (instances.length === 0) {
    return (
      <div className="rr-s-empty" data-testid="sources-empty">
        No sources yet. <Link href={ADD_SOURCE_HREF}>Add a source →</Link>
      </div>
    );
  }

  return (
    <div className="rr-s">
      <aside aria-label="Sources" className="rr-s-list">
        {instances.map((instance) => (
          <InstanceListItem
            instance={instance}
            key={instance.id}
            onSelect={() => setSelectedId(instance.id)}
            selected={selected?.id === instance.id}
          />
        ))}
        <div className="rr-s-end">
          <Link className="rr-s-link" href={ADD_SOURCE_HREF}>
            add a source →
          </Link>
          <span className="rr-s-end__note">a source pushes into your streams · nothing leaves</span>
        </div>
      </aside>

      {selected ? (
        <div className="rr-s-detail">
          <InstancePassport instance={selected} interactive={interactive} revokeAction={revokeAction} />
          <StreamManifest instance={selected} />
        </div>
      ) : null}
    </div>
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
  return (
    <button aria-pressed={selected} className={cls} onClick={onSelect} type="button">
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
    </button>
  );
}

function InstancePassport({
  instance,
  interactive,
  revokeAction,
}: {
  instance: SourceInstanceView;
  interactive: boolean;
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
        <PassportActions instance={instance} interactive={interactive} revokeAction={revokeAction} />
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
  revokeAction,
}: {
  instance: SourceInstanceView;
  interactive: boolean;
  revokeAction?: (formData: FormData) => void | Promise<void>;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [toast, setToast] = useState<ToastState>({ kind: "none" });
  const [confirmingRevoke, setConfirmingRevoke] = useState(false);

  const handleSync = useCallback(() => {
    setToast({ kind: "none" });
    startTransition(async () => {
      const res: RunNowResult = await runConnectorNowAction(
        instance.connectorId,
        instance.connectionId ?? instance.connectorInstanceId ?? null
      );
      if (res.ok) {
        setToast({ kind: "ok", message: res.run_id ? `Sync started (${res.run_id}).` : "Sync started." });
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
  }, [instance.connectorId, instance.connectionId, instance.connectorInstanceId, router]);

  // Push-mode connections can't be remotely pulled — Sync is inert for them.
  const syncDisabled = !interactive || instance.isLocalDevicePush || instance.revoked || isPending;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12, width: "100%" }}>
      <div className="rr-s-actions">
        {instance.isLocalDevicePush ? (
          <span className="rr-s-cta__hint" data-testid="sources-sync-device-wait">
            Data arrives when your paired device pushes it.
          </span>
        ) : (
          <IcButton
            aria-label={`Sync ${instance.displayName} now`}
            disabled={syncDisabled}
            onClick={handleSync}
            size="sm"
            type="button"
          >
            {isPending ? "Syncing…" : "Sync now"}
          </IcButton>
        )}

        <Link
          className="pdpp-btn pdpp-btn--ghost pdpp-btn--sm"
          href={instance.detailHref}
          title="Reauthorize and credential controls live on the connection detail page."
        >
          Reauthorize →
        </Link>

        {interactive && revokeAction && instance.connectionId && !instance.revoked ? (
          <IcButton onClick={() => setConfirmingRevoke((v) => !v)} size="sm" type="button" variant="destructive">
            Revoke
          </IcButton>
        ) : null}
      </div>

      {confirmingRevoke && revokeAction && instance.connectionId ? (
        <form action={revokeAction} className="rr-s-revoke" data-testid="sources-revoke-ceremony">
          <input name="connection_id" type="hidden" value={instance.connectionId} />
          <p className="rr-s-revoke__copy">
            Revoke stops future collection for this connection. Already-collected records, grants, and audit history are
            retained — revoke does not erase anything.
          </p>
          <label className="rr-s-revoke__check">
            <input name="confirm_revoke" type="checkbox" value="yes" />
            <span>
              Stop future collection for <code style={{ fontFamily: "var(--font-mono)" }}>{instance.connectionId}</code>
              ; keep its records.
            </span>
          </label>
          <div className="rr-s-revoke__row">
            <IcButton onClick={() => setConfirmingRevoke(false)} size="sm" type="button" variant="ghost">
              Keep
            </IcButton>
            <IcButton size="sm" type="submit" variant="destructive">
              Confirm revoke
            </IcButton>
          </div>
        </form>
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
        <Table className="rr-s-cols" cols="minmax(0, 1.1fr) 76px 110px 64px minmax(0, 1fr)">
          <TableHeaderRow>
            <TableHeader>stream</TableHeader>
            <TableHeader numeric>records</TableHeader>
            <TableHeader>cursor</TableHeader>
            <TableHeader>search</TableHeader>
            <TableHeader>read in</TableHeader>
          </TableHeaderRow>
          {instance.streams.map((stream) => (
            <StreamManifestRow key={stream.name} stream={stream} />
          ))}
        </Table>
      )}
      <p className="rr-s-note">
        Records are never read here. Click any stream to open it in Explore — the one reader. A stream's search and
        cursor state are shown on the source detail page.
      </p>
    </div>
  );
}

function StreamManifestRow({ stream }: { stream: SourceInstanceView["streams"][number] }) {
  return (
    <Link className="pdpp-table__row" href={stream.exploreHref} style={{ display: "grid" }}>
      <TableCell>
        <span className="rr-s-stream">{stream.name}</span>
      </TableCell>
      <TableCell numeric>{stream.recordCount === null ? "—" : stream.recordCount.toLocaleString()}</TableCell>
      <TableCell>
        <span className="rr-s-cursor">{stream.cursor ?? "—"}</span>
      </TableCell>
      <TableCell>
        <span className="rr-s-cursor">{searchLabel(stream.searchable)}</span>
      </TableCell>
      <TableCell>
        <span className="rr-s-readby">Explore →</span>
      </TableCell>
    </Link>
  );
}

/** Honest search label: only claim "text"/"sealed" when the manifest declared it. */
function searchLabel(searchable: boolean | null): string {
  if (searchable === null) {
    return "—";
  }
  return searchable ? "text" : "sealed";
}
