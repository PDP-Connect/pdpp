// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { IcButton, IcTimestamp } from "@pdpp/brand-react";
import type {
  ApprovalReview as ApprovalReviewData,
  ApprovalReviewJson,
  BatchConsentApprovalArtifact,
  ConsentApprovalArtifact,
  ReviewedStreamArtifact,
  SingleConsentApprovalArtifact,
  SourceDeclarationArtifact,
} from "../../../lib/ref-client.ts";

function jsonLabel(value: ApprovalReviewJson | null | undefined): string {
  if (value === null || value === undefined) {
    return "Not provided";
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function listLabel(values: readonly string[] | null | undefined, empty: string): string {
  return values?.length ? values.join(", ") : empty;
}

function claimsLabel(claims: { commitments: string[] } | null): string {
  return claims ? claims.commitments.join("; ") : "None";
}

function safeHref(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function sourceDeclarationEvidenceLabel(sourceDeclaration: SourceDeclarationArtifact): string {
  const evidence = [`${sourceDeclaration.version} / ${sourceDeclaration.digest}`];
  if (sourceDeclaration.accepted_revision_reference) {
    evidence.push(`accepted revision ${sourceDeclaration.accepted_revision_reference}`);
  }
  if (sourceDeclaration.publisher_attribution) {
    evidence.push(
      `publisher ${sourceDeclaration.publisher_attribution.id} (${sourceDeclaration.publisher_attribution.status})`
    );
  }
  if (sourceDeclaration.resource_authority) {
    const authority =
      sourceDeclaration.resource_authority.status === "verified"
        ? `${sourceDeclaration.resource_authority.status}: ${sourceDeclaration.resource_authority.authority_binding}`
        : sourceDeclaration.resource_authority.status;
    evidence.push(`resource authority ${authority}`);
  }
  return evidence.join("; ");
}

function DisplayLink({ label, value }: { label: string; value: string | null | undefined }) {
  if (!value) {
    return null;
  }
  const href = safeHref(value);
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd>
        {href ? (
          <a className="underline-offset-2 hover:underline" href={href}>
            {value}
          </a>
        ) : (
          <span>{value}</span>
        )}
      </dd>
    </>
  );
}

function StreamFacts({ streams }: { streams: readonly ReviewedStreamArtifact[] }) {
  return (
    <ul className="mt-3 list-disc space-y-3 pl-5">
      {streams.map((stream) => (
        <li key={`${stream.name}:${stream.instance_ids.join(",")}`}>
          <span className="font-medium">{stream.name}</span>
          <dl className="pdpp-caption mt-1 grid gap-x-4 gap-y-1 text-muted-foreground sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt>Instance IDs</dt>
            <dd>{listLabel(stream.instance_ids, "No closed instance ids")}</dd>
            <dt>Fields</dt>
            <dd>{listLabel(stream.fields, "All fields")}</dd>
            <dt>Resources</dt>
            <dd>{listLabel(stream.resources, "All records")}</dd>
            <dt>Time</dt>
            <dd>
              {stream.time_constraint
                ? `${stream.time_constraint.field}: ${stream.time_constraint.since ?? "beginning"} to ${
                    stream.time_constraint.until ?? "open-ended"
                  }`
                : "No time limit"}
            </dd>
          </dl>
        </li>
      ))}
    </ul>
  );
}

function SingleArtifactFacts({ artifact }: { artifact: SingleConsentApprovalArtifact }) {
  const display = artifact.client.client_display ?? {};
  return (
    <>
      <section aria-labelledby="artifact-authority" className="mb-8">
        <h2 className="pdpp-title" id="artifact-authority">
          Reviewed authority
        </h2>
        <dl className="pdpp-body mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Artifact version</dt>
          <dd>{artifact.version}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd>{artifact.subject.id}</dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>
            {display.name ?? artifact.client.client_id} ({artifact.client.client_id},{" "}
            {artifact.client.registration_mode})
          </dd>
          <DisplayLink label="Registered site" value={display.uri} />
          <DisplayLink label="App policy" value={display.policy_uri} />
          <DisplayLink label="Terms" value={display.tos_uri} />
          <dt className="text-muted-foreground">Source</dt>
          <dd>
            {artifact.source.kind}: {artifact.source.id}
          </dd>
          <dt className="text-muted-foreground">Source declaration</dt>
          <dd>{sourceDeclarationEvidenceLabel(artifact.source_declaration)}</dd>
          <dt className="text-muted-foreground">Client claims</dt>
          <dd>{claimsLabel(artifact.client_claims)}</dd>
          <dt className="text-muted-foreground">Selection preset</dt>
          <dd>{artifact.selection_preset ?? "None"}</dd>
          <dt className="text-muted-foreground">Purpose</dt>
          <dd>{artifact.purpose_description ?? artifact.purpose_code}</dd>
          <dt className="text-muted-foreground">Access mode</dt>
          <dd>{artifact.access_mode}</dd>
          <dt className="text-muted-foreground">AI training decision</dt>
          <dd>{artifact.ai_training_consented === null ? "Not applicable" : String(artifact.ai_training_consented)}</dd>
          <dt className="text-muted-foreground">Retention</dt>
          <dd>{jsonLabel(artifact.retention as ApprovalReviewJson | null)}</dd>
          <dt className="text-muted-foreground">Request expiry</dt>
          <dd>{artifact.expires_at ? <IcTimestamp value={artifact.expires_at} /> : "No expiry in artifact"}</dd>
        </dl>
      </section>
      <section aria-labelledby="resolved-streams" className="mb-8">
        <h2 className="pdpp-title" id="resolved-streams">
          Resolved streams
        </h2>
        <StreamFacts streams={artifact.resolved_streams} />
      </section>
    </>
  );
}

function BatchArtifactFacts({ artifact }: { artifact: BatchConsentApprovalArtifact }) {
  return (
    <>
      <section aria-labelledby="batch-authority" className="mb-8">
        <h2 className="pdpp-title" id="batch-authority">
          Reviewed batch authority
        </h2>
        <dl className="pdpp-body mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
          <dt className="text-muted-foreground">Artifact version</dt>
          <dd>{artifact.version}</dd>
          <dt className="text-muted-foreground">Subject</dt>
          <dd>{artifact.subject.id}</dd>
          <dt className="text-muted-foreground">Client</dt>
          <dd>{artifact.client.client_display?.name ?? artifact.client.client_id}</dd>
          <dt className="text-muted-foreground">Approved source indexes</dt>
          <dd>{artifact.approved_source_indexes.join(", ") || "None"}</dd>
          <dt className="text-muted-foreground">Source narrowing</dt>
          <dd>{jsonLabel(artifact.source_narrowing as ApprovalReviewJson)}</dd>
          <dt className="text-muted-foreground">Request expiry</dt>
          <dd>{artifact.expires_at ? <IcTimestamp value={artifact.expires_at} /> : "No expiry in artifact"}</dd>
        </dl>
      </section>
      {artifact.sources.map((source) => (
        <section aria-labelledby={`source-${source.index}`} className="mb-8" key={source.index}>
          <h2 className="pdpp-title" id={`source-${source.index}`}>
            Source {source.index}
          </h2>
          <dl className="pdpp-body mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-[auto_minmax(0,1fr)]">
            <dt className="text-muted-foreground">Source</dt>
            <dd>
              {source.source.kind}: {source.source.id}
            </dd>
            <dt className="text-muted-foreground">Source declaration</dt>
            <dd>{sourceDeclarationEvidenceLabel(source.source_declaration)}</dd>
            <dt className="text-muted-foreground">Client claims</dt>
            <dd>{claimsLabel(source.client_claims)}</dd>
            <dt className="text-muted-foreground">Selection preset</dt>
            <dd>{source.selection_preset ?? "None"}</dd>
            <dt className="text-muted-foreground">Purpose</dt>
            <dd>{source.purpose_description ?? source.purpose_code}</dd>
            <dt className="text-muted-foreground">Access mode</dt>
            <dd>{source.access_mode}</dd>
            <dt className="text-muted-foreground">Retention</dt>
            <dd>{jsonLabel(source.retention as ApprovalReviewJson | null)}</dd>
          </dl>
          <StreamFacts streams={source.resolved_streams} />
        </section>
      ))}
    </>
  );
}

function ConsentFacts({ artifact }: { artifact: ConsentApprovalArtifact }) {
  if (artifact.version === "reference.batch-approval-review.v1") {
    return <BatchArtifactFacts artifact={artifact} />;
  }
  return <SingleArtifactFacts artifact={artifact} />;
}

function ExactArtifactJson({ artifact }: { artifact: ConsentApprovalArtifact }) {
  return (
    <section aria-labelledby="exact-artifact" className="mb-8">
      <h2 className="pdpp-title" id="exact-artifact">
        Exact reviewed artifact
      </h2>
      <pre className="mt-3 overflow-auto rounded-md border border-border bg-muted/40 p-3 text-xs">
        {JSON.stringify(artifact, null, 2)}
      </pre>
    </section>
  );
}

export function ApprovalReview({
  approveAction,
  confirm,
  denyAction,
  detail,
  error,
}: {
  approveAction: (formData: FormData) => void | Promise<void>;
  confirm: boolean;
  denyAction: (formData: FormData) => void | Promise<void>;
  detail: ApprovalReviewData;
  error?: string;
}) {
  const reviewHref = `/grants/approvals/${encodeURIComponent(detail.approval_id)}`;
  const artifact = detail.kind === "consent" ? detail.approval_review : undefined;
  const isBatch = artifact?.version === "reference.batch-approval-review.v1";
  const appName =
    detail.kind === "consent"
      ? (detail.approval_review.client.client_display?.name ?? detail.approval_review.client.client_id)
      : detail.client_id;
  let decisionControl = (
    <div className="mt-3 flex flex-wrap gap-2">
      <a
        className="inline-flex h-9 items-center rounded-md bg-primary px-3 font-medium text-primary-foreground text-sm"
        href={`${reviewHref}?confirm=1`}
      >
        Continue to approval
      </a>
      <form action={denyAction}>
        <input name="approval_id" type="hidden" value={detail.approval_id} />
        <input name="kind" type="hidden" value={detail.kind} />
        <IcButton aria-label={`Deny request from ${appName}`} size="sm" type="submit" variant="destructive">
          Deny request
        </IcButton>
      </form>
    </div>
  );
  if (confirm) {
    decisionControl = (
      <form action={approveAction} className="mt-3 grid gap-3 rounded-md border border-border p-4">
        <p className="pdpp-body">
          Approve {appName} for the exact request shown above. This action issues the grant only if the reviewed
          revision is still current.
        </p>
        <input name="approval_confirmation" type="hidden" value="approve" />
        <input name="approval_id" type="hidden" value={detail.approval_id} />
        <input name="kind" type="hidden" value={detail.kind} />
        {detail.kind === "consent" ? (
          <>
            <input name="request_uri" type="hidden" value={detail.request_uri} />
            <input name="approval_review_revision" type="hidden" value={detail.approval_review_revision} />
          </>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <IcButton aria-label={`Approve and issue grant to ${appName}`} size="sm" type="submit">
            Approve and issue grant
          </IcButton>
          <a className="pdpp-caption self-center underline-offset-2 hover:underline" href={reviewHref}>
            Return to review
          </a>
        </div>
      </form>
    );
  }
  if (detail.kind === "consent" && isBatch) {
    decisionControl = (
      <p className="pdpp-body mt-3 rounded-md border border-border p-4">
        Batch approval is not available from this console review. Use the hosted source-review ceremony for this
        request.
      </p>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6 border-border/80 border-b pb-5">
        <p className="pdpp-eyebrow">Pending approval</p>
        <h1 className="pdpp-heading mt-1">{confirm ? "Confirm approval" : "Review request"}</h1>
        <p className="pdpp-body mt-2 text-muted-foreground">
          {detail.kind === "consent"
            ? `${appName} requests access to your data.`
            : `${appName} requests owner-device authorization.`}
        </p>
      </header>
      {error ? (
        <p
          className="mb-5 rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3 text-destructive"
          role="alert"
        >
          Approval was not issued. Review the newly materialized request before trying again: {error}
        </p>
      ) : null}
      {artifact ? (
        <>
          <ConsentFacts artifact={artifact} />
          <ExactArtifactJson artifact={artifact} />
        </>
      ) : (
        <section aria-labelledby="owner-device-warning" className="mb-8">
          <h2 className="pdpp-title" id="owner-device-warning">
            Owner device control
          </h2>
          <p className="pdpp-body mt-3">
            This authorizes owner-level control for this device flow. It is not a scoped third-party data grant, so
            there is no data scope or purpose to review.
          </p>
          <p className="pdpp-body mt-2">
            Request expires at {detail.kind === "owner_device" ? <IcTimestamp value={detail.expires_at} /> : null}.
          </p>
        </section>
      )}
      <section aria-labelledby="decision">
        <h2 className="pdpp-title" id="decision">
          Decision
        </h2>
        {decisionControl}
      </section>
    </div>
  );
}
