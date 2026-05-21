"use client";

import Image from "next/image";
import React from "react";
import { Button } from "@/components/ui/button.tsx";

// ─── Consent Card ─────────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §5 Client Display, Client Claims, §7 Stream Display):
//
// FROM resolved client display metadata (entity-scoped):
//   requester.name, requester.monogram, requester.uri, requester.policyUri,
//   requester.tosUri, requester.logoSrc
//   Source may be local registration, trust registry, validated software
//   statement metadata, or inline client_display.
//
// FROM client_claims (request-scoped, attributed with disclaimer):
//   commitments[]
//
// FROM purpose_description (request-scoped, first-class field):
//   purpose
//
// FROM manifest display metadata (server-trusted):
//   streams[].label, streams[].detail
//
// FROM server policy / trust registry:
//   requester.verified
//
// Server-derived from grant fields (protocol facts):
//   accessMode, technical.*, retention display text, access mode display text
//
// Server-generated generic copy (v0.1):
//   optional.consequenceOn/Off

export interface ConsentCardStream {
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
    <div style={{ maxWidth: "440px" }}>
      <div
        className="flex flex-col items-center gap-3 rounded-xl px-6 py-8 text-center"
        style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-sm"
          style={{
            backgroundColor: approved ? "var(--success)" : "var(--muted)",
            color: approved ? "var(--background)" : "var(--muted-foreground)",
          }}
        >
          {approved ? "✓" : "×"}
        </div>
        <div className="font-medium text-sm">{approved ? "Access granted" : "Access denied"}</div>
        <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          {approved
            ? `${requesterName} may now query your personal server. You can revoke this any time from your server dashboard.`
            : `No grant was issued. ${requesterName} cannot access your data.`}
        </div>
      </div>
      <button
        className="mt-2 px-0.5 font-mono text-xs"
        onClick={onReset}
        style={{ color: "var(--muted-foreground)" }}
        type="button"
      >
        ↺ reset
      </button>
    </div>
  );
}

function RequesterAvatar({ logoSrc, monogram }: { logoSrc?: string; monogram: string }) {
  return (
    <div
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg"
      style={
        logoSrc
          ? { backgroundColor: "var(--background)", border: "1px solid var(--border)" }
          : { backgroundColor: "var(--human)", color: "var(--background)" }
      }
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
  if (verified) {
    return (
      <span
        className="rounded px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide"
        style={{ backgroundColor: "oklch(0.52 0.15 150 / 0.1)", color: "var(--success)" }}
      >
        verified
      </span>
    );
  }
  return (
    <span
      className="rounded px-1.5 py-0.5 font-mono text-xs uppercase tracking-wide"
      style={{ backgroundColor: "oklch(0.62 0.15 70 / 0.1)", color: "var(--warning)" }}
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
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-semibold text-sm" style={{ color: "var(--foreground)" }}>
            {requester.name}
          </span>
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
            style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
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
  return (
    <div
      className="mt-3 rounded-lg px-3 py-2.5 text-xs"
      style={{
        backgroundColor: "oklch(0.55 0.20 27 / 0.08)",
        border: "1px solid oklch(0.55 0.20 27 / 0.2)",
        color: "var(--destructive)",
      }}
    >
      This app wants to use your data for AI model training. This requires your explicit consent.
    </div>
  );
}

function Commitments({ commitments, requesterName }: { commitments: string[]; requesterName: string }) {
  return (
    <div className="mt-3 text-xs leading-relaxed" style={{ color: "var(--muted-foreground)" }}>
      <div className="mb-1" style={{ color: "var(--foreground)" }}>
        {requesterName} says:
      </div>
      <div className="flex flex-col gap-0.5 pl-3" style={{ borderLeft: "2px solid oklch(0.52 0.09 45 / 0.35)" }}>
        {commitments.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div className="mt-1.5 italic" style={{ opacity: 0.7 }}>
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
  return (
    <>
      <button
        className="mt-3 flex items-center gap-1 text-xs"
        onClick={onToggle}
        style={{ color: "var(--muted-foreground)" }}
        type="button"
      >
        <span
          className="inline-block text-xs"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}
        >
          &#x203A;
        </span>
        Technical details
      </button>
      {open && (
        <div
          className="mt-1.5 flex flex-col gap-0.5 border-l-2 pl-3"
          style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
        >
          <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
            <span style={{ opacity: 0.6 }}>Client ID: </span>
            {technical.clientId}
          </div>
          <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
            <span style={{ opacity: 0.6 }}>Purpose: </span>
            <span style={{ color: "var(--edu-fg)" }}>{technical.purposeCode}</span>
          </div>
          <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
            <span style={{ opacity: 0.6 }}>Grant expires: </span>
            {technical.grantExpires}
          </div>
        </div>
      )}
    </>
  );
}

function Chevron({ opacity, open }: { opacity?: number; open: boolean }) {
  return (
    <span
      className="shrink-0 text-xs"
      style={{
        color: "var(--muted-foreground)",
        display: "inline-block",
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 150ms",
        ...(opacity === undefined ? {} : { opacity }),
      }}
    >
      &#x203A;
    </span>
  );
}

function RequiredStreamRow({
  detail,
  expanded,
  label,
  onToggle,
}: {
  detail: string;
  expanded: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <button
        aria-expanded={expanded}
        className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
        onClick={onToggle}
        type="button"
      >
        <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
          {label}
        </span>
        <Chevron open={expanded} />
      </button>
      {expanded && (
        <div className="pb-2.5 pl-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
          {detail}
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
      className="relative h-4 w-7 shrink-0 rounded-full"
      onClick={onToggle}
      role="switch"
      style={{
        backgroundColor: enabled ? "var(--primary)" : "var(--border)",
        transition: "background-color var(--motion-state)",
      }}
      type="button"
    >
      <span
        className="absolute top-0.5 h-3 w-3 rounded-full"
        style={{
          backgroundColor: "white",
          left: "2px",
          transform: enabled ? "translateX(12px)" : "translateX(0)",
          transition: "transform var(--motion-state)",
        }}
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
  const inactiveOpacity = enabled ? 1 : 0.5;
  return (
    <div style={{ borderBottom: "1px solid var(--border)" }}>
      <div className="flex items-center gap-3 py-2.5">
        <OptionalToggle enabled={enabled} label={optional.label} onToggle={onToggleEnabled} />
        <button
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center justify-between gap-2 text-left"
          onClick={onToggleExpand}
          type="button"
        >
          <span className="font-medium text-xs" style={{ color: "var(--foreground)", opacity: inactiveOpacity }}>
            {optional.label}
            <span className="ml-1.5 font-normal" style={{ color: "var(--muted-foreground)" }}>
              optional
            </span>
          </span>
          <Chevron opacity={inactiveOpacity} open={expanded} />
        </button>
      </div>
      {expanded && (
        <div className="mb-2 pl-10 text-xs" style={{ color: "var(--muted-foreground)", opacity: enabled ? 1 : 0.4 }}>
          {optional.detail}
        </div>
      )}
      <div className="pb-2.5 pl-10 text-xs" style={{ color: "var(--muted-foreground)" }}>
        {enabled ? optional.consequenceOn : optional.consequenceOff}
      </div>
    </div>
  );
}

function AccessDuration({ accessMode }: { accessMode: ConsentCardProps["accessMode"] }) {
  const label =
    accessMode === "continuous"
      ? "Ongoing access, active until you revoke it. Your server enforces this."
      : "One-time access. Your server will not allow further queries.";
  return (
    <div className="flex items-start gap-2 px-5 py-3">
      <div
        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
        style={{ backgroundColor: accessMode === "continuous" ? "var(--warning)" : "var(--success)" }}
      />
      <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
        {label}
      </div>
    </div>
  );
}

function DecisionButtons({ onAllow, onDeny }: { onAllow: () => void; onDeny: () => void }) {
  return (
    <div className="px-5 pt-1 pb-5">
      <div className="flex items-center gap-3">
        <Button
          className="flex-1"
          onClick={onAllow}
          style={{ borderColor: "var(--primary)", color: "var(--primary)" }}
          variant="outline"
        >
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
    <div style={{ maxWidth: "440px" }}>
      <div className="overflow-hidden rounded-xl" data-surface="human">
        <div className="px-5 pt-5 pb-4">
          <RequesterHeader requester={requester} />
          <p className="mt-4 text-sm leading-relaxed" style={{ color: "var(--foreground)" }}>
            {purpose}
          </p>
          {technical.purposeCode === "ai_training" && <AITrainingWarning />}
          {commitments.length > 0 && <Commitments commitments={commitments} requesterName={requester.name} />}
          <TechnicalDetails onToggle={() => setTechExpanded((v) => !v)} open={techExpanded} technical={technical} />
        </div>

        <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map(({ key, label, detail }) => (
            <RequiredStreamRow
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
      </div>
    </div>
  );
}
