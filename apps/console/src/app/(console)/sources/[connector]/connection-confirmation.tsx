// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import React from "react";
import {
  type boundaryClaimGaps,
  COVERAGE_HORIZON_BASES,
  COVERAGE_HORIZON_REASONS,
  coverageHorizonCandidateDisclosure,
  LOSS_CAUSES,
  LOSS_SCOPES,
  lossAcknowledgementCandidateDisclosure,
  pendingHorizonConfirmations,
  pendingLossAcknowledgements,
} from "../../lib/generic-confirmation-evidence.ts";
import type { RefAcknowledgedLossRecord, RefCoverageHorizon } from "../../lib/ref-client.ts";

type ConfirmationAction = (formData: FormData) => void | Promise<void>;

interface Props {
  acknowledgeConnectionLossAction: ConfirmationAction;
  acknowledgedLoss: RefAcknowledgedLossRecord | null | undefined;
  confirmCoverageHorizonAction: ConfirmationAction;
  connectionId: string | null;
  error?: string;
  latestKnownGaps: readonly unknown[] | null | undefined;
  message?: string;
  pendingHorizons: readonly RefCoverageHorizon[] | null | undefined;
}

function formatValue(value: string | null | undefined): string {
  return value?.trim() ? value : "Not supplied";
}

function EvidenceField({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="pdpp-caption text-muted-foreground">{label}</dt>
      <dd className="pdpp-body break-words text-foreground">{formatValue(value)}</dd>
    </div>
  );
}

function HorizonEvidence({ horizons }: { horizons: readonly RefCoverageHorizon[] }) {
  if (horizons.length === 0) {
    return null;
  }

  return (
    <div className="flex flex-col gap-3">
      <h3 className="pdpp-body font-medium text-foreground">Recorded coverage boundaries</h3>
      {horizons.map((horizon) => (
        <div className="rounded-md border border-border p-3" key={horizon.horizonId}>
          <dl className="grid gap-3 sm:grid-cols-2">
            <EvidenceField label="Stream" value={horizon.stream} />
            <EvidenceField label="Earliest available" value={horizon.earliestAvailable} />
            <EvidenceField label="Basis" value={horizon.basis} />
            <EvidenceField label="Reason" value={horizon.reason} />
            <EvidenceField label="Confirmed by" value={horizon.confirmedBy} />
            <EvidenceField label="Confirmed at" value={horizon.confirmedAt} />
            <EvidenceField label="Superseded at" value={horizon.supersededAt} />
            <EvidenceField label="Superseded by" value={horizon.supersededByHorizonId} />
            <EvidenceField label="Status" value={horizon.supersededAt === null ? "Current" : "Superseded"} />
            <EvidenceField label="Note" value={horizon.note} />
          </dl>
        </div>
      ))}
    </div>
  );
}

function HorizonForm({
  action,
  connectionId,
  stream,
  candidate,
}: {
  action: ConfirmationAction;
  connectionId: string;
  stream: string;
  candidate: ReturnType<typeof boundaryClaimGaps>[number];
}) {
  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <input name="connection_id" type="hidden" value={connectionId} />
      <input name="stream" type="hidden" value={stream} />
      <div>
        <h3 className="pdpp-body font-medium text-foreground">Confirm {stream} history boundary</h3>
        <p className="pdpp-caption mt-1 text-muted-foreground">{coverageHorizonCandidateDisclosure(candidate)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
          Basis
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
            defaultValue={candidate.basis ?? ""}
            name="basis"
            required
          >
            <option disabled value="">
              Select a basis
            </option>
            {COVERAGE_HORIZON_BASES.map((basis) => (
              <option key={basis} value={basis}>
                {basis}
              </option>
            ))}
          </select>
        </label>
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
          Reason
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
            defaultValue={candidate.reason ?? ""}
            name="reason"
            required
          >
            <option disabled value="">
              Select a reason
            </option>
            {COVERAGE_HORIZON_REASONS.map((reason) => (
              <option key={reason} value={reason}>
                {reason}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
        Earliest available (optional)
        <input
          className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          defaultValue={candidate.earliestAvailable ?? ""}
          name="earliest_available"
          type="text"
        />
      </label>
      <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
        Note (optional)
        <textarea
          className="min-h-16 rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          defaultValue={candidate.note ?? ""}
          name="note"
        />
      </label>
      <div>
        <button className="rounded-md border border-border px-3 py-2 font-medium text-foreground text-sm" type="submit">
          Record coverage boundary
        </button>
      </div>
    </form>
  );
}

function LossEvidence({ record }: { record: RefAcknowledgedLossRecord }) {
  return (
    <div className="rounded-md border border-border p-3">
      <h3 className="pdpp-body font-medium text-foreground">Recorded loss acknowledgement</h3>
      <dl className="mt-3 grid gap-3 sm:grid-cols-2">
        <EvidenceField label="Cause" value={record.cause} />
        <EvidenceField label="Scope" value={record.scope} />
        <EvidenceField label="Acknowledged by" value={record.acknowledgedBy} />
        <EvidenceField label="Acknowledged at" value={record.acknowledgedAt} />
        <EvidenceField label="Streams" value={record.streams?.join(", ") || "All streams"} />
        <EvidenceField label="Note" value={record.note} />
      </dl>
    </div>
  );
}

function LossForm({
  action,
  connectionId,
  stream,
  candidate,
}: {
  action: ConfirmationAction;
  connectionId: string;
  stream: string;
  candidate: ReturnType<typeof pendingLossAcknowledgements>[number];
}) {
  return (
    <form action={action} className="flex flex-col gap-3 rounded-md border border-border p-4">
      <input name="connection_id" type="hidden" value={connectionId} />
      <input name="stream" type="hidden" value={stream} />
      <div>
        <h3 className="pdpp-body font-medium text-foreground">Acknowledge missing {stream} data</h3>
        <p className="pdpp-caption mt-1 text-muted-foreground">{lossAcknowledgementCandidateDisclosure(candidate)}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
          Cause
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
            defaultValue={candidate.cause ?? ""}
            name="cause"
            required
          >
            <option disabled value="">
              Select a cause
            </option>
            {LOSS_CAUSES.map((cause) => (
              <option key={cause} value={cause}>
                {cause}
              </option>
            ))}
          </select>
        </label>
        <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
          Scope
          <select
            className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
            defaultValue={candidate.scope ?? ""}
            name="scope"
            required
          >
            <option disabled value="">
              Select a scope
            </option>
            {LOSS_SCOPES.map((scope) => (
              <option key={scope} value={scope}>
                {scope}
              </option>
            ))}
          </select>
        </label>
      </div>
      <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
        Your name
        <input
          className="rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          name="acknowledged_by"
          required
          type="text"
        />
      </label>
      <label className="pdpp-caption flex flex-col gap-1 text-muted-foreground">
        Note (optional)
        <textarea
          className="min-h-16 rounded-md border border-border bg-background px-2 py-1.5 text-foreground"
          defaultValue={candidate.note ?? ""}
          name="note"
        />
      </label>
      <div>
        <button className="rounded-md border border-border px-3 py-2 font-medium text-foreground text-sm" type="submit">
          Record loss acknowledgement
        </button>
      </div>
    </form>
  );
}

export function ConnectionConfirmation({
  acknowledgedLoss,
  acknowledgeConnectionLossAction,
  connectionId,
  confirmCoverageHorizonAction,
  error,
  latestKnownGaps,
  message,
  pendingHorizons,
}: Props) {
  if (!connectionId) {
    return null;
  }
  const pendingBoundaryGaps = pendingHorizonConfirmations(latestKnownGaps, pendingHorizons);
  const pendingLossGaps = pendingLossAcknowledgements(latestKnownGaps, acknowledgedLoss);
  const hasCurrentHorizon = (pendingHorizons ?? []).some((horizon) => horizon.supersededAt === null);
  if (
    !hasCurrentHorizon &&
    pendingBoundaryGaps.length === 0 &&
    pendingLossGaps.length === 0 &&
    !acknowledgedLoss &&
    !error &&
    !message
  ) {
    return null;
  }

  return React.createElement(
    "section",
    { className: "flex flex-col gap-4", id: "coverage-confirmation" },
    <div>
      <h2 className="pdpp-heading text-foreground">Coverage and loss confirmation</h2>
      <p className="pdpp-caption mt-1 text-muted-foreground">
        Review durable backend evidence and record your acknowledgement. These records do not change retained data or
        connection health.
      </p>
    </div>,
    error ? (
      <div className="pdpp-caption mb-4 rounded-md border border-destructive/30 border-l-4 border-l-destructive/60 bg-destructive/5 px-4 py-2.5 text-destructive">
        {error}
      </div>
    ) : null,
    message ? (
      <div className="pdpp-caption mb-4 rounded-md border border-border px-4 py-2.5 text-foreground">{message}</div>
    ) : null,
    pendingBoundaryGaps.map((candidate) => (
      <HorizonForm
        action={confirmCoverageHorizonAction}
        candidate={candidate}
        connectionId={connectionId}
        key={candidate.stream}
        stream={candidate.stream}
      />
    )),
    pendingLossGaps.map((candidate) => (
      <LossForm
        action={acknowledgeConnectionLossAction}
        candidate={candidate}
        connectionId={connectionId}
        key={`loss-${candidate.stream}`}
        stream={candidate.stream}
      />
    )),
    <HorizonEvidence horizons={pendingHorizons ?? []} />,
    acknowledgedLoss ? <LossEvidence record={acknowledgedLoss} /> : null
  );
}
