"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import Image from "next/image";
import React from "react";
import { Button } from "../../ui/button.tsx";

// ─── Consent Card ─────────────────────────────────────────────────────────────
//
// The consent card is the surface where the three-class TRUST MODEL is made
// visible. Every element on the card carries one of three *authorships*, and
// the card renders that authorship so a standards reviewer can point at any
// element and name its provenance (design-direction decision 1):
//
//   • PROTOCOL  (cool blue, `--authorship-protocol-*`)
//       Protocol FACTS — enforced and verifiable by the owner's server.
//       Grant scope, field projections, enforcement state, access duration,
//       the verification verdict, and the technical grant identifiers.
//
//   • MANIFEST  (warm copper, `--authorship-manifest-*`)
//       Manifest/owner-authored — the human consent surface the owner's server
//       trusts. Stream labels and descriptions (display.label / display.detail).
//
//   • CLIENT    (neutral grey + DASHED affordance, `--authorship-client-*`)
//       Client-authored claims — rendered, never trusted. The client_display
//       name & logo, the purpose_description, and the client_claims commitments.
//       The dashed rule/underline says "they say this; your server does not
//       vouch for it" without relying on color alone.
//
// Execution is restrained: temperature lives in eyebrow micro-labels, accent
// rules, dots, and borders — never in loud background fills. A small legend at
// the foot teaches the coding.
//
// Props contract — provenance of each field (see spec §5 Client Display, Client
// Claims, §7 Stream Display):
//
// FROM resolved client display metadata (entity-scoped) → CLIENT authorship:
//   requester.name, requester.monogram, requester.uri, requester.policyUri,
//   requester.tosUri, requester.logoSrc
//   Source may be local registration, trust registry, validated software
//   statement metadata, or inline client_display.
//
// FROM client_claims (request-scoped, attributed with disclaimer) → CLIENT:
//   commitments[]
//
// FROM purpose_description (request-scoped, first-class field) → CLIENT:
//   purpose
//
// FROM manifest display metadata (server-trusted) → MANIFEST authorship:
//   streams[].label, streams[].detail
//
// FROM server policy / trust registry → PROTOCOL authorship:
//   requester.verified
//
// Server-derived from grant fields (protocol facts) → PROTOCOL authorship:
//   accessMode, technical.*, retention display text, access mode display text,
//   per-connection grant scope (streams[].connections[])
//
// Server-generated generic copy (v0.1):
//   optional.consequenceOn/Off

export interface ConsentCardConnection {
  /**
   * Owner-meaningful label. Never `"legacy"`, `"legacy (pre-header)"`,
   * `"default_account"`, or any raw storage placeholder; callers SHOULD
   * fall back to `<Connector> · account N` when the owner has not
   * renamed the connection. See:
   *   openspec/changes/expose-connection-identity-on-public-read
   */
  displayName: string;
  /** Stable canonical `connection_id` for telemetry / dedupe; not rendered. */
  id: string;
}

export interface ConsentCardStream {
  /**
   * Per-connection sub-rows when a grant covers more than one connection
   * of the same connector type. When omitted or single-entry, the row
   * renders as the existing single-connection shape. When multi-entry,
   * the card renders one sub-row per connection so the owner can see
   * which accounts/devices/profiles the grant will cover.
   */
  connections?: ConsentCardConnection[];
  detail: string; // manifest display.detail — server-trusted
  key: string;
  label: string; // manifest display.label — server-trusted
}

export interface ConsentCardOptional {
  consequenceOff: string; // server-generated generic copy in v0.1
  consequenceOn: string; // server-generated generic copy in v0.1
  detail: string; // manifest display.detail — server-trusted
  key: string;
  label: string; // manifest display.label — server-trusted
}

export interface ConsentCardProps {
  accessMode: "continuous" | "single_use"; // grant.access_mode — protocol fact
  commitments: string[]; // client_claims.commitments — attributed, disclaimed
  onAllow?: () => void;
  onDeny?: () => void;
  optional?: ConsentCardOptional; // at most one optional stream (simplification for now)
  purpose: string; // purpose_description — client-authored, first-class
  requester: {
    name: string; // resolved display name
    monogram: string; // server-derived fallback from resolved name
    uri?: string; // resolved client homepage
    policyUri?: string; // resolved privacy policy URI
    tosUri?: string; // resolved terms-of-service URI
    verified: boolean; // server-determined trust signal, never client-asserted
    logoSrc?: string; // server-selected or approved brand mark, never raw untrusted remote content
  };
  streams: ConsentCardStream[]; // required streams
  technical: {
    clientId: string; // grant.client.client_id
    purposeCode: string; // grant.purpose_code
    grantExpires: string; // grant.expires_at — server-formatted
  };
}

// ─── Authorship eyebrow ───────────────────────────────────────────────────────
// The smallest visible unit of the trust coding: a mono micro-label, tinted to
// its tier, that names whose word an element is. `data-authorship` is the
// machine-readable hook the tests assert against (one per element class).

type Authorship = "protocol" | "manifest" | "client";

const AUTHORSHIP_FG: Record<Authorship, string> = {
  client: "text-authorship-client-fg",
  manifest: "text-authorship-manifest-fg",
  protocol: "text-authorship-protocol-fg",
};

function AuthorshipEyebrow({ authorship, children }: { authorship: Authorship; children: React.ReactNode }) {
  return (
    <span
      className={`pdpp-eyebrow text-[10px] ${AUTHORSHIP_FG[authorship]}`}
      data-authorship={authorship}
      data-slot="authorship-eyebrow"
    >
      {children}
    </span>
  );
}

function DecidedState({
  decided,
  onReset,
  requesterName,
}: {
  decided: "approved" | "denied";
  onReset: () => void;
  requesterName: string;
}) {
  const approved = decided === "approved";
  return (
    <div className="max-w-[440px]">
      <div className="flex flex-col items-center gap-3 rounded-xl border border-border bg-card px-6 py-8 text-center">
        <div
          className={`flex h-8 w-8 items-center justify-center rounded-full text-sm ${
            approved ? "bg-success text-background" : "bg-muted text-muted-foreground"
          }`}
        >
          {approved ? "✓" : "×"}
        </div>
        <div className="font-medium text-sm">{approved ? "Access granted" : "Access denied"}</div>
        <div className="text-muted-foreground text-xs">
          {approved
            ? `${requesterName} may now query your personal server. You can revoke this any time from your server dashboard.`
            : `No grant was issued. ${requesterName} cannot access your data.`}
        </div>
      </div>
      <button className="mt-2 px-0.5 font-mono text-muted-foreground text-xs" onClick={onReset} type="button">
        ↺ reset
      </button>
    </div>
  );
}

function RequesterAvatar({ logoSrc, monogram }: { logoSrc?: string; monogram: string }) {
  // CLIENT authorship — the brand mark the client supplied. When the server has
  // no approved logo we fall back to a neutral monogram tile so the avatar never
  // borrows the trusted "human/manifest" warmth for client-supplied art.
  return (
    <div
      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-authorship-client-border border-dashed ${
        logoSrc ? "bg-background" : "bg-authorship-client-wash text-authorship-client-fg"
      }`}
      data-authorship="client"
    >
      {logoSrc ? (
        <Image
          alt=""
          aria-hidden="true"
          className="h-5 w-5 object-contain"
          height={20}
          src={logoSrc}
          unoptimized
          width={20}
        />
      ) : (
        <span className="font-bold font-mono text-xs">{monogram}</span>
      )}
    </div>
  );
}

function VerificationBadge({ verified }: { verified: boolean }) {
  // PROTOCOL authorship — this is the SERVER's verification verdict, not a
  // client assertion. Solid (never dashed) chip; success/warning semantics.
  if (verified) {
    return (
      <span
        className="rounded bg-success-wash px-1.5 py-0.5 font-mono text-success text-xs uppercase tracking-wide"
        data-authorship="protocol"
      >
        verified
      </span>
    );
  }
  return (
    <span
      className="rounded bg-warning-wash px-1.5 py-0.5 font-mono text-warning text-xs uppercase tracking-wide"
      data-authorship="protocol"
    >
      unverified
    </span>
  );
}

function RequesterHeader({ requester }: { requester: ConsentCardProps["requester"] }) {
  return (
    <div className="flex items-start gap-3">
      <RequesterAvatar logoSrc={requester.logoSrc} monogram={requester.monogram} />
      <div className="min-w-0 flex-1 pt-0.5">
        <AuthorshipEyebrow authorship="client">they say they are</AuthorshipEyebrow>
        <div className="mt-0.5 flex flex-wrap items-center gap-2">
          {/* CLIENT authorship — the client_display name. Dashed underline marks
              it as client-asserted, never server-vouched. */}
          <span
            className="border-authorship-client-border border-b border-dashed pb-px font-semibold text-foreground text-sm"
            data-authorship="client"
          >
            {requester.name}
          </span>
          <span
            className="rounded border border-authorship-client-border border-dashed px-1.5 py-0.5 font-mono text-[10px] text-authorship-client-fg uppercase tracking-wide"
            data-authorship="client"
          >
            client app
          </span>
          <VerificationBadge verified={requester.verified} />
        </div>
      </div>
    </div>
  );
}

function AITrainingWarning() {
  // PROTOCOL authorship — the server's enforcement statement (explicit consent
  // is required before training-purpose grants issue). Destructive tone, drawn
  // from the status-danger surface tier (--status-danger-bg is exactly the old
  // inline destructive-at-8% wash, and brings a real dark-mode re-declaration).
  return (
    <div
      className="mt-3 rounded-lg border border-status-danger-fg/20 bg-status-danger-bg px-3 py-2.5 text-destructive text-xs"
      data-authorship="protocol"
    >
      This app wants to use your data for AI model training. This requires your explicit consent.
    </div>
  );
}

function Commitments({ commitments, requesterName }: { commitments: string[]; requesterName: string }) {
  // CLIENT authorship — client_claims.commitments. Dashed left rule + explicit
  // "not enforced" disclaimer: the card renders the claim but the server does
  // not vouch for it.
  return (
    <div className="mt-3 text-muted-foreground text-xs leading-relaxed" data-authorship="client">
      <AuthorshipEyebrow authorship="client">{requesterName} claims</AuthorshipEyebrow>
      <div className="mt-1 flex flex-col gap-0.5 border-authorship-client-border border-l border-dashed pl-3">
        {commitments.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-1.5 text-authorship-client-fg italic">
        These are their commitments, not enforced by your server.
      </div>
    </div>
  );
}

function TechnicalDetails({
  onToggle,
  open,
  technical,
}: {
  onToggle: () => void;
  open: boolean;
  technical: ConsentCardProps["technical"];
}) {
  // PROTOCOL authorship — grant facts (client_id, purpose_code, expiry). Cool
  // blue left rule when expanded.
  return (
    <>
      <button className="mt-3 flex items-center gap-1 text-muted-foreground text-xs" onClick={onToggle} type="button">
        <Chevron open={open} />
        Technical details
      </button>
      {open && (
        <div
          className="mt-1.5 flex flex-col gap-0.5 border-authorship-protocol-border border-l-2 pl-3"
          data-authorship="protocol"
        >
          <div className="font-mono text-muted-foreground text-xs">
            <span className="opacity-60">Client ID: </span>
            {technical.clientId}
          </div>
          <div className="font-mono text-muted-foreground text-xs">
            <span className="opacity-60">Purpose: </span>
            <span className="text-authorship-protocol-fg">{technical.purposeCode}</span>
          </div>
          <div className="font-mono text-muted-foreground text-xs">
            <span className="opacity-60">Grant expires: </span>
            {technical.grantExpires}
          </div>
        </div>
      )}
    </>
  );
}

function Chevron({ dim, open }: { dim?: boolean; open: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 text-muted-foreground text-xs transition-transform duration-150 ${
        open ? "rotate-90" : "rotate-0"
      } ${dim ? "opacity-50" : ""}`}
    >
      &#x203A;
    </span>
  );
}

function ConnectionScopeList({ connections }: { connections: ConsentCardConnection[] }) {
  // PROTOCOL authorship — the per-connection grant scope. These are the
  // server-resolved connection identities the grant will actually cover; the
  // owner-meaningful displayName is rendered, the opaque connection_id is not.
  return (
    <ul
      aria-label="Connections covered by this stream"
      className="mt-1.5 flex flex-col gap-0.5 border-authorship-protocol-border border-l pl-3 text-muted-foreground text-xs"
      data-authorship="protocol"
    >
      {connections.map((connection) => (
        <li className="flex items-center gap-1.5" key={connection.id}>
          <span aria-hidden="true" className="inline-block h-1 w-1 rounded-full bg-authorship-protocol-accent" />
          <span>{connection.displayName}</span>
        </li>
      ))}
    </ul>
  );
}

function RequiredStreamRow({
  connections,
  detail,
  expanded,
  label,
  onToggle,
}: {
  connections?: ConsentCardConnection[];
  detail: string;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  // MANIFEST authorship — the stream label & detail are manifest display
  // metadata the owner's server trusts. Copper accent dot marks the warmth.
  const hasMultipleConnections = Array.isArray(connections) && connections.length > 1;
  return (
    <div className="border-border border-b" data-authorship="manifest">
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-authorship-manifest-accent" />
          <span className="flex min-w-0 flex-col">
            <span className="font-medium text-foreground text-xs">{label}</span>
            {hasMultipleConnections && (
              <span className="text-[10px] text-muted-foreground">{connections.length} connections</span>
            )}
          </span>
        </span>
        <Chevron open={expanded} />
      </button>
      {expanded && (
        <div className="pb-2.5 pl-3.5 text-muted-foreground text-xs">
          {detail}
          {hasMultipleConnections && <ConnectionScopeList connections={connections} />}
        </div>
      )}
    </div>
  );
}

function OptionalToggle({ enabled, label, onToggle }: { enabled: boolean; label: string; onToggle: () => void }) {
  return (
    <button
      aria-checked={enabled}
      aria-label={label}
      className={`relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200 ${
        enabled ? "bg-primary" : "bg-border"
      }`}
      onClick={onToggle}
      role="switch"
      type="button"
    >
      <span
        className={`absolute top-0.5 left-0.5 h-3 w-3 rounded-full bg-white transition-transform duration-200 ${
          enabled ? "translate-x-3" : "translate-x-0"
        }`}
      />
    </button>
  );
}

function OptionalStreamRow({
  enabled,
  expanded,
  onToggleEnabled,
  onToggleExpand,
  optional,
}: {
  enabled: boolean;
  expanded: boolean;
  onToggleEnabled: () => void;
  onToggleExpand: () => void;
  optional: ConsentCardOptional;
}) {
  // MANIFEST authorship — same as required rows; the optional toggle gates
  // whether this manifest-declared stream is included in the grant.
  return (
    <div className="border-border border-b" data-authorship="manifest">
      <div className="flex items-center gap-3 py-2.5">
        <OptionalToggle enabled={enabled} label={optional.label} onToggle={onToggleEnabled} />
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          onClick={onToggleExpand}
          type="button"
        >
          <span className={`flex min-w-0 items-center gap-2 ${enabled ? "opacity-100" : "opacity-50"}`}>
            <span aria-hidden="true" className="h-1.5 w-1.5 shrink-0 rounded-full bg-authorship-manifest-accent" />
            <span className="font-medium text-foreground text-xs">
              {optional.label}
              <span className="ml-1.5 font-normal text-muted-foreground">optional</span>
            </span>
          </span>
          <Chevron dim={!enabled} open={expanded} />
        </button>
      </div>
      {expanded && (
        <div className={`mb-2 pl-10 text-muted-foreground text-xs ${enabled ? "opacity-100" : "opacity-40"}`}>
          {optional.detail}
        </div>
      )}
      <div className="pb-2.5 pl-10 text-muted-foreground text-xs">
        {enabled ? optional.consequenceOn : optional.consequenceOff}
      </div>
    </div>
  );
}

function AccessDuration({ accessMode }: { accessMode: ConsentCardProps["accessMode"] }) {
  // PROTOCOL authorship — grant.access_mode is enforced by the owner's server.
  const label =
    accessMode === "continuous"
      ? "Ongoing access, active until you revoke it. Your server enforces this."
      : "One-time access. Your server will not allow further queries.";
  return (
    <div className="flex items-start gap-2 px-5 py-3" data-authorship="protocol">
      <span className="mt-0.5 shrink-0">
        <AuthorshipEyebrow authorship="protocol">enforced</AuthorshipEyebrow>
      </span>
      <div className="text-muted-foreground text-xs">{label}</div>
    </div>
  );
}

function AuthorshipLegend() {
  // Teaches the trust coding. Three swatches keyed to the three tiers; kept at
  // the foot, muted, so it informs without competing with the card body.
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-border border-t px-5 py-2.5 text-[10px] text-muted-foreground"
      data-slot="authorship-legend"
    >
      <span className="font-medium">How to read this:</span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-authorship-protocol-accent" />
        <span>your server enforces</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span aria-hidden="true" className="h-2 w-2 rounded-full bg-authorship-manifest-accent" />
        <span>your server describes</span>
      </span>
      <span className="flex items-center gap-1.5">
        <span
          aria-hidden="true"
          className="h-2 w-2 rounded-full border border-authorship-client-border border-dashed"
        />
        <span>they claim</span>
      </span>
    </div>
  );
}

function DecisionButtons({ onAllow, onDeny }: { onAllow: () => void; onDeny: () => void }) {
  return (
    <div className="px-5 pt-1 pb-5">
      <div className="flex items-center gap-3">
        <Button className="flex-1 border-primary text-primary" onClick={onAllow} variant="outline">
          Allow access
        </Button>
        <Button className="flex-1" onClick={onDeny} variant="outline">
          Deny
        </Button>
      </div>
    </div>
  );
}

export function ConsentCard({
  requester,
  purpose,
  commitments,
  streams,
  optional,
  accessMode,
  technical,
  onAllow,
  onDeny,
}: ConsentCardProps) {
  const [optionalEnabled, setOptionalEnabled] = React.useState(false);
  const [decided, setDecided] = React.useState<"approved" | "denied" | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [techExpanded, setTechExpanded] = React.useState(false);
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));

  if (decided) {
    return <DecidedState decided={decided} onReset={() => setDecided(null)} requesterName={requester.name} />;
  }

  return (
    <div className="max-w-[440px]">
      <div className="overflow-hidden rounded-xl" data-surface="human">
        <div className="px-5 pt-5 pb-4">
          <RequesterHeader requester={requester} />
          {/* CLIENT authorship — purpose_description is client-authored. */}
          <div className="mt-4" data-authorship="client">
            <AuthorshipEyebrow authorship="client">they say they want</AuthorshipEyebrow>
            <p className="mt-1 text-foreground text-sm leading-relaxed">{purpose}</p>
          </div>
          {technical.purposeCode === "ai_training" && <AITrainingWarning />}
          {commitments.length > 0 && <Commitments commitments={commitments} requesterName={requester.name} />}
          <TechnicalDetails onToggle={() => setTechExpanded((v) => !v)} open={techExpanded} technical={technical} />
        </div>

        <div className="border-border border-t px-5 pb-1">
          {/* MANIFEST authorship — the streams the owner's server is being asked
              to project, described by the manifest. */}
          <div className="pt-2.5 pb-0.5">
            <AuthorshipEyebrow authorship="manifest">your server will share</AuthorshipEyebrow>
          </div>
          {streams.map(({ connections, key, label, detail }) => (
            <RequiredStreamRow
              connections={connections}
              detail={detail}
              expanded={!!expanded[key]}
              key={key}
              label={label}
              onToggle={() => toggleExpand(key)}
            />
          ))}
          {optional && (
            <OptionalStreamRow
              enabled={optionalEnabled}
              expanded={!!expanded[optional.key]}
              onToggleEnabled={() => setOptionalEnabled((v) => !v)}
              onToggleExpand={() => toggleExpand(optional.key)}
              optional={optional}
            />
          )}
        </div>

        <AccessDuration accessMode={accessMode} />

        <DecisionButtons
          onAllow={() => {
            setDecided("approved");
            onAllow?.();
          }}
          onDeny={() => {
            setDecided("denied");
            onDeny?.();
          }}
        />

        <AuthorshipLegend />
      </div>
    </div>
  );
}
