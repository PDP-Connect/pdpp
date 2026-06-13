"use client";

import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { LongviewWordmark } from "@/components/longview-wordmark.tsx";
import type { ConnectorCardProps } from "@/components/pdpp/connector-card.tsx";
import { ConnectorCard } from "@/components/pdpp/connector-card.tsx";
import { ConsentCard } from "@/components/pdpp/consent-card.tsx";
import type { GrantInspectorProps } from "@/components/pdpp/grant-inspector.tsx";
import { GrantInspector } from "@/components/pdpp/grant-inspector.tsx";
import { StreamInventory } from "@/components/pdpp/stream-inventory.tsx";
import { ReferenceHeroProof } from "@/components/reference-hero-proof.tsx";
import { SiteHeader } from "@/components/site-header.tsx";
import {
  LONGVIEW_CLIENT_ID,
  LONGVIEW_CLIENT_NAME,
  LONGVIEW_CLIENT_URI,
  LONGVIEW_CONNECTOR_SPECIMEN,
  LONGVIEW_CONSENT_SPECIMEN,
  LONGVIEW_GRANT_SPECIMEN,
  LONGVIEW_INVENTORY_SPECIMEN,
  LONGVIEW_PAY_STATEMENT_ALL_FIELDS,
  LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS,
  LONGVIEW_POLICY_URI,
  LONGVIEW_PURPOSE_CODE,
  LONGVIEW_PURPOSE_DESCRIPTION,
  LONGVIEW_TOS_URI,
} from "@/lib/longview-world.ts";
import { type ClientIntrospection, type ProtocolPhase, useProtocol } from "@/lib/use-protocol.ts";

// ─── Config ─────────────────────────────────────────────────────────────────

const SPEC_BASE_URL = "https://pdpp-smoky.vercel.app";

// Stable synthetic keys for the decorative payroll-bar illustrations.
// These lists never reorder; the keys are purely to satisfy noArrayIndexKey.
const INGEST_BAR_IDS = Array.from({ length: 22 }, (_, i) => `ingest-bar-${i}`);
const DELTA_EXISTING_BAR_IDS = Array.from({ length: 24 }, (_, i) => `delta-existing-${i}`);
const DELTA_NEW_BAR_IDS = Array.from({ length: 1 }, (_, i) => `delta-new-${i}`);

// ─── Section definitions ────────────────────────────────────────────────────

const SECTIONS = [
  { id: "enforce", label: "Enforce", num: 1 },
  { id: "request", label: "Request", num: 2 },
  { id: "consent", label: "Consent", num: 3 },
  { id: "grant", label: "Grant", num: 4 },
  { id: "sync", label: "Sync", num: 5 },
  { id: "revoke", label: "Revoke", num: 6 },
  { id: "export", label: "Export", num: 7 },
  { id: "inventory", label: "Inventory", num: 8 },
  { id: "ingest", label: "Ingest", num: 9 },
  { id: "multi", label: "Multi", num: 10 },
  { id: "spec", label: "Spec", num: 11 },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const SECTION_DISPLAY_ORDER = Object.fromEntries(
  SECTIONS.map((section, index) => [section.id, (index + 1) * 10])
) as Record<SectionId, number>;

const FEATURED_SECTION_WASH = {
  human:
    "linear-gradient(to bottom, color-mix(in oklab, var(--human) 14%, transparent), color-mix(in oklab, var(--human) 5%, transparent) 32%, transparent 68%)",
  protocol:
    "linear-gradient(to bottom, color-mix(in oklab, var(--primary) 12%, transparent), color-mix(in oklab, var(--primary) 4%, transparent) 32%, transparent 68%)",
} as const;

const HERO_WASH =
  "radial-gradient(circle at 16% 18%, color-mix(in oklab, var(--human) 14%, transparent) 0, transparent 26rem), radial-gradient(circle at 86% 4%, color-mix(in oklab, var(--primary) 16%, transparent) 0, transparent 30rem), linear-gradient(to bottom, color-mix(in oklab, var(--card) 42%, transparent), transparent 74%)";

// ─── Specimen data ──────────────────────────────────────────────────────────

const CONNECTOR_SPECIMEN = LONGVIEW_CONNECTOR_SPECIMEN;
const INVENTORY_SPECIMEN = LONGVIEW_INVENTORY_SPECIMEN;
const CONSENT_SPECIMEN = LONGVIEW_CONSENT_SPECIMEN;
const GRANT_SPECIMEN = LONGVIEW_GRANT_SPECIMEN;

const MULTI_CONNECTORS: ConnectorCardProps[] = [
  CONNECTOR_SPECIMEN,
  {
    connectorId: "https://registry.pdpp.org/connectors/spotify",
    displayName: "Spotify",
    version: "2.0.0",
    streams: [
      {
        name: "top_artists",
        label: "Top artists",
        semantics: "mutable_state",
        supportsFields: true,
        supportsResources: false,
        supportsTimeRange: true,
        viewCount: 2,
      },
      {
        name: "play_events",
        label: "Play history",
        semantics: "append_only",
        supportsFields: true,
        supportsResources: false,
        supportsTimeRange: true,
        viewCount: 0,
      },
    ],
  },
  {
    connectorId: "https://registry.pdpp.org/connectors/oura",
    displayName: "Oura Ring",
    version: "1.0.0",
    streams: [
      {
        name: "sleep_sessions",
        label: "Sleep sessions",
        semantics: "append_only",
        supportsFields: true,
        supportsResources: false,
        supportsTimeRange: true,
        viewCount: 0,
      },
    ],
  },
];

// ─── Section content ────────────────────────────────────────────────────────

interface SectionConfig {
  headline: string;
  id: SectionId;
  narrative: string;
  surface: "human" | "protocol" | "neutral";
}

// Using a tuple-literal (`satisfies [...]`) rather than `SectionConfig[]`
// so positional reads like `SECTION_CONTENT[0]` keep a non-optional type
// under `noUncheckedIndexedAccess`.
const SECTION_CONTENT = [
  {
    id: "ingest",
    headline: "Native where possible, connector-backed where needed",
    narrative:
      "Platforms can implement PDPP directly. Native endpoints, browser automation, and imports can all feed the same compensation records into one grant and enforcement model.",
    surface: "protocol",
  },
  {
    id: "inventory",
    headline: "Records make access exact",
    narrative:
      "Pay statements, equity grants, and benefits enrollments become records the server can match, project, and revoke. Once the data has shape, access can become exact.",
    surface: "protocol",
  },
  {
    id: "request",
    headline: "A client app requests access",
    narrative: `${LONGVIEW_CLIENT_NAME} is the client app. It requests pay statements and equity grants for career-move compensation planning. The request names the client, the purpose, and the exact streams.`,
    surface: "protocol",
  },
  {
    id: "consent",
    headline: "Consent fixes the boundary",
    narrative: "The consent surface shows the client, streams, and enforced boundary before approval.",
    surface: "human",
  },
  {
    id: "grant",
    headline: "The grant makes it durable",
    narrative: "Approval becomes a grant with exact streams, fields, access mode, and time window.",
    surface: "protocol",
  },
  {
    id: "enforce",
    headline: "Only the granted fields come back",
    narrative: `${LONGVIEW_CLIENT_NAME} queries pay statements. The server returns the four granted comparison fields and leaves the identity-heavy payroll fields behind.`,
    surface: "protocol",
  },
  {
    id: "sync",
    headline: "Only what changed",
    narrative:
      "On the next payroll cycle, one new pay statement lands. Longview syncs again and gets only the new record.",
    surface: "protocol",
  },
  {
    id: "revoke",
    headline: "Access is revocable",
    narrative: `One click revokes the grant. The next query from ${LONGVIEW_CLIENT_NAME} receives a refusal within 60 seconds.`,
    surface: "human",
  },
  {
    id: "export",
    headline: "Self-export remains full-fidelity",
    narrative:
      "Owner access can retrieve full records at any time. Every field, every stream, no third-party grant required.",
    surface: "human",
  },
  {
    id: "multi",
    headline: "One protocol across platforms",
    narrative:
      "Compensation planning is one reference world. Subscription review, travel reimbursement, and benefits disputes can use the same grant-and-enforcement model across different platforms and deployment paths.",
    surface: "neutral",
  },
  {
    id: "spec",
    headline: "Built on an open specification",
    narrative:
      "Every component on this page implements a section of the PDPP specification. Published, versioned, and open for review.",
    surface: "neutral",
  },
] as const satisfies readonly SectionConfig[];

// ─── Stepper navigation ─────────────────────────────────────────────────────

const SECTION_TEMPERATURE: Record<SectionId, "human" | "protocol" | "neutral"> = {
  ingest: "protocol",
  inventory: "protocol",
  request: "protocol",
  consent: "human",
  grant: "protocol",
  enforce: "protocol",
  sync: "protocol",
  revoke: "human",
  export: "human",
  multi: "neutral",
  spec: "neutral",
};

function Stepper({
  activeId,
  onNavigate,
  phase,
}: {
  activeId: SectionId;
  onNavigate: (id: SectionId) => void;
  phase: ProtocolPhase;
}) {
  return (
    <nav
      aria-label="Protocol sections"
      className="fixed top-1/2 right-6 z-30 hidden -translate-y-1/2 flex-col items-end gap-0.5 lg:flex"
    >
      {SECTIONS.map(({ id, label }) => {
        const isActive = id === activeId;
        const temp = SECTION_TEMPERATURE[id];
        let inactiveColor = "var(--authorship-client-fg)";
        if (temp === "human") {
          inactiveColor = "color-mix(in oklab, var(--authorship-manifest-accent) 70%, transparent)";
        } else if (temp === "protocol") {
          inactiveColor = "color-mix(in oklab, var(--authorship-protocol-accent) 55%, transparent)";
        }
        return (
          <button
            className="flex items-center gap-2 rounded-md px-2 py-1 text-right transition-colors"
            key={id}
            onClick={() => onNavigate(id)}
            style={{
              backgroundColor: isActive ? "var(--foreground)" : "transparent",
              color: isActive ? "var(--background)" : inactiveColor,
            }}
            type="button"
          >
            <span className="font-medium text-xs">{label}</span>
          </button>
        );
      })}
      {/* Grant state machine — anchored as the rail's terminal status row so it
          reads as a protocol indicator with spatial context, never a floating
          toast that collides with the consent CTA. Surfaces only on the
          lifecycle sections where grant state is meaningful. */}
      {PROTOCOL_INDICATOR_SECTIONS.includes(activeId) && <GrantStatusRow phase={phase} />}
    </nav>
  );
}

// Shared grant-status atom used by both the desktop rail (Stepper) and the
// mobile/tablet sticky header, so the "Grant: <state>" indicator is anchored
// to a stable slot at every viewport and never floats over interactive content.
function GrantStatusRow({ phase }: { phase: ProtocolPhase }) {
  const { dotColor, grantLabel } = resolveGrantIndicator(phase);
  return (
    <div
      aria-live="polite"
      className="mt-1 flex items-center gap-2 rounded-md border px-2 py-1 text-right"
      style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}
    >
      <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
      <span className="font-medium text-muted-foreground text-xs">Grant: {grantLabel}</span>
    </div>
  );
}

// ─── Detail panel (Level 2 depth) ───────────────────────────────────────────

function DetailPanel({ spec, label, children }: { spec: string; label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6 w-full" style={{ maxWidth: "52ch" }}>
      <button
        className="mb-2 flex items-center gap-1 text-muted-foreground text-xs"
        onClick={() => setOpen((v) => !v)}
        type="button"
      >
        <span
          className="inline-block text-xs"
          style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)", transition: "transform 150ms" }}
        >
          &#x203A;
        </span>
        {label || "Protocol details"}
        <span className="ml-1 font-mono text-edu-fg">{spec}</span>
      </button>
      {open && (
        <div
          className="flex flex-col gap-2 border-l-2 pl-3 text-xs leading-relaxed"
          style={{ borderColor: "var(--authorship-protocol-wash)", color: "var(--muted-foreground)" }}
        >
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Field projection animation ─────────────────────────────────────────────

// The one expressive set-piece (design-direction decision 5): the grant
// visibly filters data fields — allowed fields flow through, others fade and
// redact. Restrained ease-out vocabulary (150–250ms, no spring/bounce).
// prefers-reduced-motion users get the static final state: the projected
// result, no motion. The animation only enters on scroll-into-view, once.
const PROJECTION_EASE = "var(--ease-enter)";
const PROJECTION_DURATION_MS = 200;
// Per-chip stagger stays inside the set-piece's restraint budget.
const PROJECTION_STAGGER_MS = 24;

function FieldProjection({ grantedFields, allFields }: { grantedFields: string[]; allFields: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const prefersReduced = useRef(false);
  const [phase, setPhase] = useState<"hidden" | "show" | "filter" | "result">("hidden");

  useEffect(() => {
    prefersReduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          if (prefersReduced.current) {
            // Static final state: skip the show→filter→result choreography and
            // render the projected outcome directly, with no transitions.
            setPhase("result");
          } else {
            setPhase("show");
            setTimeout(() => setPhase("filter"), 320);
            setTimeout(() => setPhase("result"), 620);
          }
          obs.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const reduced = prefersReduced.current;
  const easeOut = PROJECTION_EASE;
  // Reduced-motion: zero-duration so any property change is an instant cut.
  const dur = reduced ? 0 : PROJECTION_DURATION_MS;
  const stagger = reduced ? 0 : PROJECTION_STAGGER_MS;

  return (
    <div className="w-full py-4" ref={ref} style={{ maxWidth: "580px" }}>
      <div
        className="mb-8 font-mono text-xs"
        style={{
          color: "var(--muted-foreground)",
          opacity: phase === "hidden" ? 0 : 0.5,
          transition: `opacity ${dur}ms ${easeOut}`,
        }}
      >
        GET /v1/streams/pay_statements/records
      </div>

      <div className="flex flex-col gap-6">
        {/* Record on server — all fields */}
        <div>
          <div
            className="mb-3 font-medium text-xs"
            style={{
              color: "var(--muted-foreground)",
              opacity: phase === "hidden" ? 0 : 1,
              transition: `opacity ${dur}ms ${easeOut}`,
            }}
          >
            Record on server ({allFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allFields.map((f, i) => {
              const granted = grantedFields.includes(f);
              const isFiltered = phase === "filter" || phase === "result";
              const dimmedByFilter = isFiltered && !granted;
              let opacity = 1;
              if (phase === "hidden") {
                opacity = 0;
              } else if (dimmedByFilter) {
                opacity = 0.15;
              }
              let transform = "translateY(0)";
              if (phase === "hidden") {
                transform = "translateY(12px)";
              } else if (dimmedByFilter) {
                transform = "translateX(8px) scale(0.95)";
              }
              return (
                <span
                  className="rounded-md px-2 py-1 font-mono text-xs"
                  key={f}
                  style={{
                    backgroundColor: granted ? "var(--success-wash)" : "var(--muted)",
                    color: granted ? "var(--success)" : "var(--muted-foreground)",
                    opacity,
                    transform,
                    transition: `opacity ${dur}ms ${easeOut} ${phase === "hidden" ? i * stagger : stagger * 4}ms, transform ${dur}ms ${easeOut} ${phase === "hidden" ? i * stagger : stagger * 4}ms`,
                    textDecoration: dimmedByFilter ? "line-through" : "none",
                  }}
                >
                  {f}
                </span>
              );
            })}
          </div>
        </div>

        {/* Grant filter line — the central metaphor */}
        <div className="flex items-center gap-3 py-2">
          <div
            className="h-0.5 flex-1"
            style={{
              backgroundColor:
                phase === "filter" || phase === "result" ? "var(--authorship-protocol-accent)" : "var(--border)",
              opacity: phase === "hidden" ? 0 : 1,
              boxShadow:
                phase === "filter" || phase === "result"
                  ? "0 0 8px color-mix(in oklab, var(--authorship-protocol-accent) 55%, transparent)"
                  : "none",
              transition: `opacity ${dur}ms ${easeOut} ${stagger * 9}ms, background-color ${dur}ms ${easeOut}, box-shadow ${dur}ms ${easeOut}`,
            }}
          />
          <span
            className="shrink-0 font-medium font-mono text-xs"
            style={{
              color:
                phase === "filter" || phase === "result"
                  ? "var(--authorship-protocol-accent)"
                  : "var(--muted-foreground)",
              opacity: phase === "hidden" ? 0 : 1,
              transition: `opacity ${dur}ms ${easeOut} ${stagger * 9}ms, color ${dur}ms ${easeOut}`,
            }}
          >
            grant filter
          </span>
          <div
            className="h-0.5 flex-1"
            style={{
              backgroundColor:
                phase === "filter" || phase === "result" ? "var(--authorship-protocol-accent)" : "var(--border)",
              opacity: phase === "hidden" ? 0 : 1,
              boxShadow:
                phase === "filter" || phase === "result"
                  ? "0 0 8px color-mix(in oklab, var(--authorship-protocol-accent) 55%, transparent)"
                  : "none",
              transition: `opacity ${dur}ms ${easeOut} ${stagger * 9}ms, background-color ${dur}ms ${easeOut}, box-shadow ${dur}ms ${easeOut}`,
            }}
          />
        </div>

        {/* Response to client — only granted fields */}
        <div>
          <div
            className="mb-3 font-medium text-xs"
            style={{
              color: "var(--success)",
              opacity: phase === "result" ? 1 : 0,
              transition: `opacity ${dur}ms ${easeOut}`,
            }}
          >
            Response to client ({grantedFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {grantedFields.map((f, i) => (
              <span
                className="rounded-md px-2 py-1 font-mono text-xs"
                key={f}
                style={{
                  backgroundColor: "var(--success-wash-strong)",
                  color: "var(--success)",
                  fontWeight: 500,
                  opacity: phase === "result" ? 1 : 0,
                  transform: phase === "result" ? "translateY(0)" : "translateY(12px)",
                  transition: `opacity ${dur}ms ${easeOut} ${i * stagger}ms, transform ${dur}ms ${easeOut} ${i * stagger}ms`,
                }}
              >
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Incremental sync animation ─────────────────────────────────────────────

function IncrementalSync() {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<"hidden" | "first" | "delta">("hidden");

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setPhase("first");
          setTimeout(() => setPhase("delta"), 650);
          obs.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div className="w-full py-4" ref={ref} style={{ maxWidth: "520px" }}>
      <div className="flex flex-col gap-6">
        {/* First query */}
        <div>
          <div
            className="mb-2 font-medium text-xs"
            style={{
              color: "var(--muted-foreground)",
              opacity: phase === "hidden" ? 0 : 1,
              transition: "opacity 300ms",
            }}
          >
            First query: 24 pay statements
          </div>
          <div className="flex flex-wrap items-center gap-0.5">
            {INGEST_BAR_IDS.map((id, i) => (
              <div
                className="h-3 w-1.5 rounded-sm"
                key={id}
                style={{
                  backgroundColor: "var(--primary)",
                  opacity: phase === "hidden" ? 0 : 0.6,
                  transform: phase === "hidden" ? "scaleY(0)" : "scaleY(1)",
                  transition: `opacity 200ms ${i * 30}ms, transform 200ms ${i * 30}ms`,
                  transformOrigin: "bottom",
                }}
              />
            ))}
          </div>
          <div
            className="mt-1.5 font-mono text-xs"
            style={{
              color: "var(--muted-foreground)",
              opacity: phase === "hidden" ? 0 : 0.6,
              transition: `opacity 220ms ${24 * 18 + 120}ms`,
            }}
          >
            next_changes_since: "cursor_a8f2..."
          </div>
        </div>

        {/* Separator */}
        <div
          className="h-px"
          style={{
            backgroundColor: "var(--border)",
            opacity: phase === "delta" ? 1 : 0,
            transition: "opacity 300ms",
          }}
        />

        {/* Delta sync */}
        <div>
          <div
            className="mb-2 font-medium text-xs"
            style={{
              color: "var(--muted-foreground)",
              opacity: phase === "delta" ? 1 : 0,
              transition: "opacity 300ms 100ms",
            }}
          >
            Sync one payroll cycle later: <span className="text-success">1 new pay statement</span>
          </div>
          <div className="flex flex-wrap items-center gap-0.5">
            {/* Existing records (dimmed) */}
            {DELTA_EXISTING_BAR_IDS.map((id, i) => (
              <div
                className="h-3 w-1.5 rounded-sm"
                key={id}
                style={{
                  backgroundColor: "var(--border)",
                  opacity: phase === "delta" ? 1 : 0,
                  transition: `opacity 160ms ${120 + i * 10}ms`,
                }}
              />
            ))}
            {/* New records (green, staggered) */}
            {DELTA_NEW_BAR_IDS.map((id, i) => (
              <div
                className="h-3 w-1.5 rounded-sm"
                key={id}
                style={{
                  backgroundColor: "var(--success)",
                  opacity: phase === "delta" ? 1 : 0,
                  transform: phase === "delta" ? "scaleY(1)" : "scaleY(0)",
                  transition: `opacity 220ms ${420 + i * 80}ms, transform 220ms ${420 + i * 80}ms`,
                  transformOrigin: "bottom",
                }}
              />
            ))}
          </div>
          <div
            className="mt-1.5 font-mono text-xs"
            style={{
              color: "var(--muted-foreground)",
              opacity: phase === "delta" ? 0.6 : 0,
              transition: "opacity 300ms 1000ms",
            }}
          >
            changes_since: "cursor_a8f2..." → 1 record returned
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Token introspection ────────────────────────────────────────────────────

// The protocol moment that gates EVERY query and was previously invisible
// (only described in prose in the Enforce/Export detail panels): before the RS
// projects a single field, it introspects the bearer token to learn its kind
// (owner vs client), the bound subject, and the live grant status. This is what
// makes revocation and single-use enforceable — a revoked grant flips
// `active` to false here, one step before projection, so the next line of the
// exchange is a 403 instead of data. Rendered as a protocol fact: real
// request/response shape from the mock server's introspection endpoint, not a
// diagram. The verdict pill recolors live as the grant moves active → revoked.

function IntrospectionField({ label, value, accent }: { label: string; value: string; accent?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.65 }}>
        {label}
      </span>
      <span
        className="truncate font-mono text-xs"
        style={{ color: accent ? "var(--authorship-protocol-fg)" : "var(--foreground)" }}
      >
        {value}
      </span>
    </div>
  );
}

function TokenIntrospection({ introspection }: { introspection: ClientIntrospection }) {
  const active = introspection.active;
  const verdictColor = active ? "var(--success)" : "var(--destructive)";
  const verdictWash = active ? "var(--success-wash)" : "var(--status-danger-bg)";
  return (
    <div className="w-full overflow-hidden rounded-xl" data-surface="protocol" style={{ maxWidth: "440px" }}>
      <div className="px-5 pt-4 pb-3" style={{ borderBottom: "1px solid var(--border)" }}>
        <div className="mb-2 flex items-center justify-between gap-2">
          <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
            POST /introspect
          </span>
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
            style={{ backgroundColor: "var(--authorship-protocol-wash)", color: "var(--authorship-protocol-fg)" }}
          >
            RS reads first
          </span>
        </div>
        <pre className="overflow-x-auto font-mono text-xs" style={{ margin: 0, color: "var(--muted-foreground)" }}>
          {"token=<client_token>"}
        </pre>
      </div>
      <div className="flex flex-col px-5 py-3">
        <div className="mb-1.5 flex items-center gap-2">
          <span
            className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
            style={{ backgroundColor: verdictWash, color: verdictColor }}
          >
            active: {String(active)}
          </span>
          <span className="font-mono text-muted-foreground text-xs">
            {active ? "query proceeds to projection" : "query refused — 403"}
          </span>
        </div>
        <IntrospectionField accent label="pdpp_token_kind" value={introspection.pdpp_token_kind} />
        <IntrospectionField label="grant_status" value={introspection.grant_status} />
        <IntrospectionField label="subject_id" value={introspection.subject_id} />
        <IntrospectionField label="grant_id" value={introspection.grant_id} />
        <IntrospectionField label="scope_streams" value={`[${introspection.scope_streams.join(", ") || "—"}]`} />
      </div>
      <div className="px-5 pb-3 text-xs italic" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
        The RS decides token kind and grant status from introspection, never from the token's syntax.
      </div>
    </div>
  );
}

// ─── Outcome card (shared by consent and revoke sections) ───────────────────

function OutcomeCard({
  variant,
  message,
  onReset,
}: {
  variant: "granted" | "revoked";
  message: string;
  onReset: () => void;
}) {
  return (
    <div className="flex w-full flex-col items-center gap-3">
      <div
        className="flex w-full flex-col items-center gap-3 rounded-xl px-6 py-8 text-center"
        style={{ border: "1px solid var(--border)", backgroundColor: "var(--card)" }}
      >
        <div
          className="flex h-8 w-8 items-center justify-center rounded-full text-sm"
          style={{
            backgroundColor: variant === "granted" ? "var(--success)" : "var(--destructive)",
            color: variant === "granted" ? "var(--background)" : "var(--destructive-foreground)",
          }}
        >
          {variant === "granted" ? "\u2713" : "\u00d7"}
        </div>
        <div className="font-medium text-sm">{variant === "granted" ? "Access granted" : "Grant revoked"}</div>
        <div className="text-muted-foreground text-xs">{message}</div>
      </div>
      <button className="px-0.5 font-mono text-muted-foreground text-xs" onClick={onReset} type="button">
        {"\u21ba"} reset flow
      </button>
    </div>
  );
}

// ─── Scroll reveal ──────────────────────────────────────────────────────────

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const prefersReduced = useRef(false);

  useEffect(() => {
    prefersReduced.current = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const reduced = prefersReduced.current;

  return (
    <div
      ref={ref}
      style={{
        opacity: visible ? 1 : 0,
        transform: visible || reduced ? "translateY(0)" : "translateY(12px)",
        transition: reduced
          ? `opacity 200ms ${delay}ms`
          : `opacity 420ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 420ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
      }}
    >
      {children}
    </div>
  );
}

// ─── Collection convergence visual ──────────────────────────────────────────

const COLLECTION_PATHS = [{ label: "Native API" }, { label: "Browser" }, { label: "Import" }] as const;

function CollectionConvergence() {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) {
          setVisible(true);
          obs.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const ease = "cubic-bezier(0.16, 1, 0.3, 1)";

  return (
    <div className="w-full" ref={ref} style={{ padding: "1.5rem 0" }}>
      {/* Different realization paths converging to one record model */}
      <div className="flex items-center">
        {/* Input paths column */}
        <div className="flex shrink-0 flex-col gap-2.5">
          {COLLECTION_PATHS.map((path, i) => (
            <div
              className="flex items-center"
              key={path.label}
              style={{
                opacity: visible ? 1 : 0,
                transform: visible ? "none" : "translateX(-8px)",
                transition: `opacity var(--duration-slow) ${ease} ${i * 80}ms, transform var(--duration-slow) ${ease} ${i * 80}ms`,
              }}
            >
              <span
                className="pdpp-label shrink-0"
                style={{
                  fontFamily: "var(--font-mono)",
                  color: visible ? "var(--primary)" : "var(--muted-foreground)",
                  transition: `color var(--duration-moderate) ${ease} ${240 + i * 60}ms`,
                  padding: "0.375rem 0.75rem",
                  border: "1px solid",
                  borderColor: visible ? "var(--primary)" : "var(--border)",
                  borderRadius: "var(--radius)",
                  whiteSpace: "nowrap",
                }}
              >
                {path.label}
              </span>
              {/* Connecting line */}
              <div
                style={{
                  height: "1px",
                  flex: "1 1 0",
                  minWidth: "1.5rem",
                  backgroundColor: visible ? "var(--primary)" : "var(--border)",
                  opacity: visible ? 0.35 : 0,
                  transition: `opacity var(--duration-moderate) ${ease} ${200 + i * 60}ms, background-color var(--duration-moderate) ${ease} ${200 + i * 60}ms`,
                }}
              />
            </div>
          ))}
        </div>

        {/* Convergence node */}
        <div
          className="shrink-0"
          style={{
            width: "6px",
            height: "6px",
            borderRadius: "50%",
            backgroundColor: visible ? "var(--primary)" : "var(--border)",
            opacity: visible ? 1 : 0,
            transition: `opacity var(--duration-moderate) ${ease} 350ms, background-color var(--duration-moderate) ${ease} 350ms`,
          }}
        />

        {/* Output line + destination */}
        <div
          className="flex min-w-0 flex-1 items-center"
          style={{
            opacity: visible ? 1 : 0,
            transition: `opacity var(--duration-slow) ${ease} 420ms`,
          }}
        >
          <div
            style={{
              height: "1px",
              flex: "1 1 0",
              minWidth: "1.5rem",
              backgroundColor: "var(--primary)",
              opacity: 0.35,
            }}
          />
          <span
            className="pdpp-label shrink-0"
            style={{
              color: "var(--foreground)",
              fontWeight: 600,
              whiteSpace: "nowrap",
              paddingLeft: "0.75rem",
            }}
          >
            Structured records
          </span>
        </div>
      </div>

      {/* Annotation — the key sentence */}
      <p
        className="pdpp-caption"
        style={{
          marginTop: "1rem",
          color: "var(--muted-foreground)",
          opacity: visible ? 1 : 0,
          transition: `opacity var(--duration-slow) ${ease} 550ms`,
        }}
      >
        Different realization paths. Same grant and enforcement model.
      </p>
    </div>
  );
}

// ─── Section shells ─────────────────────────────────────────────────────────

// Standard section: text left, component right on large screens
function Section({
  config,
  children,
  detail,
  wide,
}: {
  config: SectionConfig;
  children: React.ReactNode;
  detail?: React.ReactNode;
  wide?: boolean;
}) {
  let borderColor = "var(--border)";
  if (config.surface === "human") {
    borderColor = "var(--human)";
  } else if (config.surface === "protocol") {
    borderColor = "var(--primary)";
  }

  return (
    <section
      className="py-20 md:py-28"
      id={config.id}
      style={{ borderLeft: `2px solid ${borderColor}`, order: SECTION_DISPLAY_ORDER[config.id] }}
    >
      <div className={`${wide ? "max-w-5xl" : "max-w-3xl"} mx-auto w-full px-6 md:px-12`}>
        <div className={wide ? "grid grid-cols-1 items-start gap-12 lg:grid-cols-2" : ""}>
          <Reveal>
            <div
              className="mb-3 font-mono text-xs uppercase tracking-widest"
              style={{ color: borderColor, opacity: 0.7 }}
            >
              {config.id}
            </div>
            <h2
              className="mb-4 font-semibold text-2xl tracking-tight md:text-3xl"
              style={{ color: "var(--foreground)", lineHeight: 1.15 }}
            >
              {config.headline}
            </h2>
            <p
              className="text-sm leading-relaxed md:text-base"
              style={{ color: "var(--muted-foreground)", maxWidth: "48ch" }}
            >
              {config.narrative}
            </p>
            {detail && <div className="mt-4">{detail}</div>}
          </Reveal>
          <Reveal delay={150}>
            <div className={wide ? "" : "mt-8"}>{children}</div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}

// Featured section: full-width component, centered, with extra presence
function FeaturedSection({
  config,
  children,
  detail,
}: {
  config: SectionConfig;
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  const borderColor = config.surface === "human" ? "var(--human)" : "var(--primary)";

  return (
    <section
      className="py-28 md:py-40"
      id={config.id}
      style={{
        borderLeft: `2px solid ${borderColor}`,
        order: SECTION_DISPLAY_ORDER[config.id],
        background: config.surface === "human" ? FEATURED_SECTION_WASH.human : FEATURED_SECTION_WASH.protocol,
      }}
    >
      <div className="mx-auto w-full max-w-3xl px-6 md:px-12">
        <Reveal>
          <div
            className="mb-3 font-mono text-xs uppercase tracking-widest"
            style={{ color: borderColor, opacity: 0.7 }}
          >
            {config.id}
          </div>
          <h2
            className="mb-4 font-semibold text-3xl tracking-tight md:text-4xl"
            style={{ color: "var(--foreground)", lineHeight: 1.1 }}
          >
            {config.headline}
          </h2>
          <p
            className="mb-12 text-sm leading-relaxed md:text-base"
            style={{ color: "var(--muted-foreground)", maxWidth: "48ch" }}
          >
            {config.narrative}
          </p>
        </Reveal>
        <Reveal delay={200}>
          <div className="flex justify-center">{children}</div>
        </Reveal>
        {detail && (
          <Reveal delay={300}>
            <div className="mt-8 max-w-xl">{detail}</div>
          </Reveal>
        )}
      </div>
    </section>
  );
}

// ─── Protocol state (driven by mock server) ─────────────────────────────────

const ALL_PAY_STATEMENT_FIELDS = [...LONGVIEW_PAY_STATEMENT_ALL_FIELDS];
const GRANTED_PAY_STATEMENT_FIELDS = [...LONGVIEW_PAY_STATEMENT_GRANTED_FIELDS];

// ─── Default hero ───────────────────────────────────────────────────────────

function DefaultReferenceHero() {
  return (
    <section className="px-6 pt-20 pb-16 md:px-12 md:pt-28 md:pb-24" style={{ background: HERO_WASH }}>
      <div className="mx-auto max-w-3xl">
        <Reveal>
          <div className="mb-8 flex items-center gap-2">
            <span
              className="rounded px-2 py-0.5 font-mono text-xs"
              style={{
                backgroundColor: "var(--primary-wash)",
                color: "var(--primary)",
                border: "1px solid color-mix(in oklab, var(--primary) 34%, var(--border))",
              }}
            >
              PDPP
            </span>
            <span className="font-mono text-muted-foreground text-xs">v0.1.0 · Open reference</span>
          </div>
        </Reveal>
        <Reveal delay={50}>
          <h1
            className="mb-6 font-semibold text-4xl md:text-5xl lg:text-6xl"
            style={{ color: "var(--foreground)", lineHeight: 1.05, letterSpacing: "-0.03em" }}
          >
            Granular access
            <br />
            to personal data
          </h1>
        </Reveal>
        <Reveal delay={150}>
          <p
            className="mb-3 text-base leading-relaxed md:text-lg"
            style={{ color: "var(--muted-foreground)", maxWidth: "48ch" }}
          >
            Clients request named records and fields. Every response stays inside the grant.
          </p>
        </Reveal>
        <Reveal delay={250}>
          <p
            className="mb-10 text-sm leading-relaxed"
            style={{ color: "var(--muted-foreground)", maxWidth: "48ch", opacity: 0.7 }}
          >
            Open specification. Live reference. Real grant enforcement across platforms.
          </p>
        </Reveal>
        <Reveal delay={400}>
          <ReferenceHeroProof />
        </Reveal>
      </div>
    </section>
  );
}

// ─── Page ───────────────────────────────────────────────────────────────────

interface ReferenceAppProps {
  /** Label shown in the SiteHeader breadcrumb. Defaults to "Reference". */
  currentLabel?: string;
  /** Rendered above the first protocol section. If omitted, the default
      hero (v0.1.0 badge + title + flow stepper) is used. */
  hero?: React.ReactNode;
}

const INPUT_LIKE_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT", "BUTTON"]);
const NAV_FORWARD_KEYS = new Set(["ArrowDown", "ArrowRight", " "]);
const NAV_BACKWARD_KEYS = new Set(["ArrowUp", "ArrowLeft"]);

function neighborSection(activeSection: SectionId, direction: 1 | -1): SectionId | null {
  const idx = SECTIONS.findIndex((s) => s.id === activeSection);
  if (idx < 0) {
    return null;
  }
  const target = SECTIONS[idx + direction];
  return target ? target.id : null;
}

function buildKeyNavHandler(activeSection: SectionId, navigateTo: (id: SectionId) => void) {
  return (e: KeyboardEvent) => {
    const tag = (e.target as HTMLElement)?.tagName;
    if (tag && INPUT_LIKE_TAGS.has(tag)) {
      return;
    }
    let direction: 1 | -1 | 0 = 0;
    if (NAV_FORWARD_KEYS.has(e.key)) {
      direction = 1;
    } else if (NAV_BACKWARD_KEYS.has(e.key)) {
      direction = -1;
    }
    if (direction === 0) {
      return;
    }
    e.preventDefault();
    const next = neighborSection(activeSection, direction);
    if (next) {
      navigateTo(next);
    }
  };
}

function resolveGrantIndicator(phase: ProtocolPhase): { dotColor: string; grantLabel: string } {
  if (phase === "granted") {
    return { dotColor: "var(--success)", grantLabel: "active" };
  }
  if (phase === "revoked") {
    return { dotColor: "var(--destructive)", grantLabel: "revoked" };
  }
  return { dotColor: "var(--border)", grantLabel: "idle" };
}

const PROTOCOL_INDICATOR_SECTIONS: SectionId[] = ["consent", "grant", "enforce", "sync", "revoke"];

function buildSectionIntersectionObserver(onActive: (id: SectionId) => void): IntersectionObserver {
  return new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
          onActive(entry.target.id as SectionId);
        }
      }
    },
    { threshold: 0.3 }
  );
}

function observeSectionsWith(observer: IntersectionObserver): void {
  for (const { id } of SECTIONS) {
    const el = document.getElementById(id);
    if (el) {
      observer.observe(el);
    }
  }
}

function deriveGrantInspectorProps(
  protocolGrant: NonNullable<ReturnType<typeof useProtocol>["grant"]>
): GrantInspectorProps {
  return {
    grantId: protocolGrant.grant_id,
    issuedAt: protocolGrant.issued_at,
    status: protocolGrant.status,
    client: { clientId: protocolGrant.client_id, name: LONGVIEW_CLIENT_NAME },
    purposeCode: protocolGrant.purpose_code,
    purposeDescription: protocolGrant.purpose_description,
    accessMode: protocolGrant.access_mode,
    expiresAt: protocolGrant.expires_at ?? null,
    retention: protocolGrant.retention
      ? { duration: "90 days", onExpiry: protocolGrant.retention.on_expiry }
      : undefined,
    streams: protocolGrant.streams.map((s) => ({
      name: s.name,
      label: INVENTORY_SPECIMEN.streams.find((stream) => stream.name === s.name)?.label || s.name,
      detail: INVENTORY_SPECIMEN.streams.find((stream) => stream.name === s.name)?.detail,
      fields: s.fields || undefined,
      view: s.view || undefined,
      timeRange: s.time_range || undefined,
    })),
  };
}

function StickyHeader({
  activeSection,
  currentLabel,
  navigateTo,
  phase,
}: {
  activeSection: SectionId;
  currentLabel: string;
  navigateTo: (id: SectionId) => void;
  phase: ProtocolPhase;
}) {
  const showGrant = PROTOCOL_INDICATOR_SECTIONS.includes(activeSection);
  const { dotColor, grantLabel } = resolveGrantIndicator(phase);
  return (
    <header
      className="sticky top-0 z-40 flex h-12 items-center gap-2 px-4 md:gap-3 md:px-6"
      style={{
        backgroundColor: "var(--background)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid var(--border)",
      }}
    >
      <SiteHeader currentLabel={currentLabel} />
      <span className="font-mono text-muted-foreground text-xs uppercase tracking-wide md:hidden">
        {SECTIONS.find((s) => s.id === activeSection)?.label}
      </span>
      <div className="flex-1" />
      <nav aria-label="Protocol sections" className="hidden items-center gap-0.5 overflow-x-auto md:flex lg:hidden">
        {SECTIONS.map(({ id, label }) => (
          <button
            className="shrink-0 rounded px-2 py-1.5 text-xs transition-colors"
            key={id}
            onClick={() => navigateTo(id)}
            style={{
              backgroundColor: activeSection === id ? "var(--foreground)" : "transparent",
              color: activeSection === id ? "var(--background)" : "var(--muted-foreground)",
            }}
            type="button"
          >
            {label}
          </button>
        ))}
      </nav>
      {/* Grant state — anchored in the sticky header below lg, where the
          right-rail Stepper (which hosts the same indicator at lg+) is hidden.
          Stable slot, never overlaps the consent CTA. */}
      {showGrant && (
        <div
          aria-live="polite"
          className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1 lg:hidden"
          style={{ borderColor: "var(--border)", backgroundColor: "var(--card)" }}
        >
          <div className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: dotColor }} />
          <span className="font-medium text-muted-foreground text-xs">Grant: {grantLabel}</span>
        </div>
      )}
      <span className="hidden font-mono text-xs md:inline" style={{ color: "var(--muted-foreground)", opacity: 0.65 }}>
        v0.1.0
      </span>
    </header>
  );
}

type AccessMode = "continuous" | "single_use";
const ACCESS_MODES: readonly AccessMode[] = ["continuous", "single_use"] as const;

function AccessModeSelector({
  accessMode,
  setAccessMode,
}: {
  accessMode: AccessMode;
  setAccessMode: (mode: AccessMode) => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="text-muted-foreground text-xs">Access mode:</span>
      {ACCESS_MODES.map((mode) => (
        <button
          className="rounded px-2 py-1 font-mono text-xs transition-colors"
          key={mode}
          onClick={() => setAccessMode(mode)}
          style={{
            backgroundColor: accessMode === mode ? "var(--foreground)" : "var(--muted)",
            color: accessMode === mode ? "var(--background)" : "var(--muted-foreground)",
          }}
          type="button"
        >
          {mode}
        </button>
      ))}
    </div>
  );
}

function ConsentOutcomeCard({ onReset, phase }: { onReset: () => void; phase: ProtocolPhase }) {
  const granted = phase === "granted";
  return (
    <OutcomeCard
      message={
        granted
          ? `${LONGVIEW_CLIENT_NAME} may now query the resource server. Scroll down to see enforcement in action.`
          : `The grant has been revoked. ${LONGVIEW_CLIENT_NAME} can no longer query under it.`
      }
      onReset={onReset}
      variant={granted ? "granted" : "revoked"}
    />
  );
}

function ConsentStageBody({
  accessMode,
  handleAllow,
  handleDeny,
  handleReset,
  phase,
  setAccessMode,
}: {
  accessMode: AccessMode;
  handleAllow: () => void;
  handleDeny: () => void;
  handleReset: () => void;
  phase: ProtocolPhase;
  setAccessMode: (mode: AccessMode) => void;
}) {
  if (phase === "idle") {
    return (
      <div className="flex w-full flex-col items-center gap-4">
        <AccessModeSelector accessMode={accessMode} setAccessMode={setAccessMode} />
        <ConsentCard {...CONSENT_SPECIMEN} accessMode={accessMode} onAllow={handleAllow} onDeny={handleDeny} />
      </div>
    );
  }
  return <ConsentOutcomeCard onReset={handleReset} phase={phase} />;
}

export function ReferenceApp({ hero, currentLabel = "Reference" }: ReferenceAppProps = {}) {
  const [activeSection, setActiveSection] = useState<SectionId>(SECTIONS[0].id);
  const observerRef = useRef<IntersectionObserver | null>(null);
  const [multiIdx, setMultiIdx] = useState(0);
  const [accessMode, setAccessMode] = useState<AccessMode>("continuous");

  // Protocol state from mock server
  const protocol = useProtocol();

  // Map protocol phase to the old interface for sections that still use it
  const handleAllow = useCallback(() => protocol.approve(accessMode), [protocol, accessMode]);
  const handleDeny = protocol.deny;
  const handleRevoke = protocol.revoke;
  const handleReset = protocol.reset;

  // Track active section via IntersectionObserver
  useEffect(() => {
    observerRef.current = buildSectionIntersectionObserver(setActiveSection);
    observeSectionsWith(observerRef.current);
    return () => observerRef.current?.disconnect();
  }, []);

  const navigateTo = useCallback((id: SectionId) => {
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  // Keyboard navigation — only when no interactive element is focused
  useEffect(() => {
    const handleKey = buildKeyNavHandler(activeSection, navigateTo);
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [activeSection, navigateTo]);

  // Derive grant inspector props from protocol state
  const grantProps: GrantInspectorProps = protocol.grant ? deriveGrantInspectorProps(protocol.grant) : GRANT_SPECIMEN;

  const grantedPayStatementFields =
    protocol.grant?.streams.find((stream) => stream.name === "pay_statements")?.fields || GRANTED_PAY_STATEMENT_FIELDS;

  return (
    <div className="min-h-screen" style={{ backgroundColor: "var(--background)", color: "var(--foreground)" }}>
      <StickyHeader
        activeSection={activeSection}
        currentLabel={currentLabel}
        navigateTo={navigateTo}
        phase={protocol.phase}
      />

      {/* Right-side stepper (large screens). The grant state indicator is
          anchored as the rail's terminal row — no floating toast. */}
      <Stepper activeId={activeSection} onNavigate={navigateTo} phase={protocol.phase} />

      {hero ?? <DefaultReferenceHero />}

      {/* ── Sections ── */}
      {/* Visual order comes from SECTION_DISPLAY_ORDER so the narrative can be iterated
          without rewriting each section block every pass. */}
      <div className="flex flex-col">
        {/* Ingest — wide layout: text left, card right */}
        <Section
          config={SECTION_CONTENT[0]}
          detail={
            <DetailPanel label="See one realization path" spec="§7 Manifest, Collection Profile">
              <p className="pdpp-caption mb-3 text-muted-foreground">
                The reference uses a user-side connector runtime. It is one realization path for PDPP; the protocol
                itself is defined by consent, grants, and enforcement.
              </p>
              <p className="font-medium text-foreground">Connector manifest</p>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`{
  "connector_id": "https://registry.pdpp.org/profiles/compensation-v1",
  "version": "1.0.0",
  "display_name": "Compensation profile",
  "streams": [{
    "name": "pay_statements",
    "display": { "label": "Pay statements", "detail": "..." },
    "semantics": "append_only",
    "selection": { "fields": true, "resources": false },
    "consent_time_field": "pay_period"
  }]
}`}
              </pre>

              <p className="mt-4 font-medium text-foreground">Collection runtime message flow</p>
              <p>
                The runtime spawns the connector as a child process. Communication is stdin/stdout JSONL. The connector
                never sees the raw grant or token.
              </p>

              {/* Message sequence visualization */}
              <div className="mt-2 flex flex-col gap-0">
                {[
                  {
                    dir: "→",
                    from: "Runtime",
                    to: "Connector",
                    msg: "START",
                    detail: "{ collection_mode, state, bindings }",
                    color: "var(--primary)",
                  },
                  {
                    dir: "←",
                    from: "Connector",
                    to: "Runtime",
                    msg: "RECORD",
                    detail: '{ stream: "pay_statements", key: "pay_0", data: {...} }',
                    color: "var(--success)",
                  },
                  {
                    dir: "←",
                    from: "Connector",
                    to: "Runtime",
                    msg: "RECORD",
                    detail: '{ stream: "pay_statements", key: "pay_1", data: {...} }',
                    color: "var(--success)",
                  },
                  {
                    dir: "←",
                    from: "Connector",
                    to: "Runtime",
                    msg: "STATE",
                    detail: '{ cursor: "..." }',
                    color: "var(--warning)",
                  },
                  {
                    dir: "←",
                    from: "Connector",
                    to: "Runtime",
                    msg: "RECORD",
                    detail: "...24 records total",
                    color: "var(--success)",
                  },
                  {
                    dir: "←",
                    from: "Connector",
                    to: "Runtime",
                    msg: "DONE",
                    detail: '{ status: "succeeded", records_emitted: 24 }',
                    color: "var(--primary)",
                  },
                ].map((m, i, arr) => (
                  <div
                    className="flex items-start gap-2 py-1.5 font-mono text-xs"
                    key={m.detail}
                    style={{ borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}
                  >
                    <span className="w-4 shrink-0 text-center text-muted-foreground">{m.dir}</span>
                    <span className="shrink-0 font-medium" style={{ color: m.color }}>
                      {m.msg}
                    </span>
                    <span style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>{m.detail}</span>
                  </div>
                ))}
              </div>

              <div className="mt-3 flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>INTERACTION</span> — connector requests user input (OTP, captcha).
                  Runtime presents to user, returns response.
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>SKIP_RESULT</span> — connector signals intentional stream skip (rate
                  limit, unavailable).
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>Binding matching</span> — runtime checks manifest bindings before
                  spawn. Fails fast if payroll, equity, or benefits bindings are unmet.
                </span>
              </div>

              <p className="mt-3 font-medium text-foreground">Platform access methods</p>
              <p>
                The <code className="font-mono">bindings</code> field in the manifest declares what the connector needs
                from the runtime. Some compensation sources can expose native exports. Others still need browser
                automation or import flows. When a source adds native support, only the collection path changes. The
                consent surface, grants, and enforcement stay the same.
              </p>
            </DetailPanel>
          }
        >
          <div className="flex w-full flex-col gap-6">
            <CollectionConvergence />
            <ConnectorCard {...CONNECTOR_SPECIMEN} />
          </div>
        </Section>

        {/* Inventory — wide layout */}
        <Section
          config={SECTION_CONTENT[1]}
          detail={
            <DetailPanel label="See a record" spec="§4 Record Model">
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`// A PDPP record
{
  "stream": "pay_statements",
  "key": "pay_0",
  "data": {
    "employer": "Northstar Labs",
    "pay_period": "2025-01-15",
    "gross_pay": 6150,
    "net_pay": 4605,
    "employee_id": "emp_4100",
    "home_address": "1207 W Maple Ave, Chicago, IL",
    "bank_account_last4": "4821",
    "tax_id_fragment": "2487"
  },
  "emitted_at": "2025-01-15T00:00:00.000Z"
}`}
              </pre>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>append_only</span> — immutable events (~95% of data). No version
                  history needed.
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>mutable_state</span> — evolving entities. RS maintains version history
                  for incremental sync.
                </span>
              </div>
              <p>
                Every stream has a primary key, a JSON Schema, and an optional consent_time_field for temporal
                filtering.
              </p>
            </DetailPanel>
          }
          wide
        >
          <StreamInventory
            connectorName={INVENTORY_SPECIMEN.connectorName}
            connectorVersion={INVENTORY_SPECIMEN.connectorVersion}
            streams={protocol.serverStats.map((s) => ({
              name: s.name,
              label: INVENTORY_SPECIMEN.streams.find((stream) => stream.name === s.name)?.label || s.name,
              detail: INVENTORY_SPECIMEN.streams.find((is) => is.name === s.name)?.detail || "",
              semantics:
                INVENTORY_SPECIMEN.streams.find((stream) => stream.name === s.name)?.semantics || "append_only",
              recordCount: s.recordCount,
              lastSynced: "Apr 15, 2026",
            }))}
          />
        </Section>

        {/* Request — wide layout */}
        <Section
          config={SECTION_CONTENT[2]}
          detail={
            <DetailPanel label="See the HTTP request" spec="§5 Selection Request">
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`POST /authorize HTTP/1.1
Content-Type: application/json

{
  "response_type": "code",
  "client_id": "${LONGVIEW_CLIENT_ID}",
  "client_display": { "name": "${LONGVIEW_CLIENT_NAME}", ... },
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "source": {
      "kind": "connector",
      "id": "https://registry.pdpp.org/profiles/compensation-v1"
    },
    "purpose_code": "${LONGVIEW_PURPOSE_CODE}",
    "streams": [
      { "name": "pay_statements", "necessity": "required" },
      { "name": "equity_grants", "necessity": "required" },
      { "name": "benefits_enrollments", "necessity": "optional" }
    ]
  }]
}`}
              </pre>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>client_display</span> — entity-scoped display metadata (RFC 7591
                  vocabulary, inline transport)
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>resolution</span> — AS may prefer registered or trust-registry
                  metadata over inline values
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>client_claims</span> — request-scoped, rendered with "[name] says:"
                  attribution
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>necessity</span> — required (included in grant) or optional (user
                  choice)
                </span>
              </div>
              <p>
                The AS must accept any syntactically valid purpose code URI. It must not reject solely because a code is
                unrecognized.
              </p>
            </DetailPanel>
          }
          wide
        >
          <div className="w-full overflow-hidden rounded-xl" data-surface="protocol">
            <div className="px-5 pt-5 pb-4">
              <div className="mb-4 flex items-center justify-between">
                <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                  POST /authorize
                </div>
                <span
                  className="rounded px-1.5 py-0.5 font-mono text-xs"
                  style={{ backgroundColor: "var(--warning-wash)", color: "var(--warning)" }}
                >
                  client request
                </span>
              </div>

              {/* Identity block */}
              <div className="mb-3 flex items-start justify-between gap-3">
                <LongviewWordmark compact />
                <div className="flex flex-wrap items-center justify-end gap-1.5">
                  <span
                    className="rounded px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wide"
                    style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
                  >
                    client app
                  </span>
                  <span className="font-mono text-success text-xs">verified</span>
                </div>
              </div>

              <div className="mb-3 text-foreground text-xs">{LONGVIEW_PURPOSE_DESCRIPTION}</div>
            </div>

            {/* Requested streams */}
            <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
              {[
                { name: "pay_statements", necessity: "required" },
                { name: "equity_grants", necessity: "required" },
                { name: "benefits_enrollments", necessity: "optional" },
              ].map((s) => (
                <div
                  className="flex items-center justify-between py-2"
                  key={s.name}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <span className="font-mono text-foreground text-xs">{s.name}</span>
                  <span
                    className="text-xs"
                    style={{
                      color: s.necessity === "optional" ? "var(--muted-foreground)" : "var(--foreground)",
                      opacity: s.necessity === "optional" ? 0.6 : 1,
                    }}
                  >
                    {s.necessity}
                  </span>
                </div>
              ))}
            </div>

            {/* Commitments */}
            <div className="px-5 py-3">
              <div className="text-xs italic" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                Client claim: planning workspace only.
              </div>
            </div>
          </div>
        </Section>

        {/* Consent — THE featured moment */}
        <FeaturedSection
          config={SECTION_CONTENT[3]}
          detail={
            <DetailPanel label="See the trust model" spec="§5 Semantic classes">
              <p className="font-medium text-foreground">
                Every cell in the consent card maps to exactly one semantic class. The spec defines three classes plus{" "}
                <span className="font-mono">client_display</span> as a separate identity category, and a conformant AS
                MUST NOT flatten them into one undifferentiated surface:
              </p>

              {/* Trust model mapping — what in the UI comes from where, tagged by
                  the spec's refined semantic class (spec-core.md §5). */}
              <div className="mt-1 flex flex-col gap-0">
                {[
                  {
                    element: '"Pay statements", "Equity grants"',
                    source: "Manifest display.label (manifest-authored)",
                    trust: "Data description",
                    color: "var(--primary)",
                  },
                  {
                    element: '"Employer, pay period, gross pay..."',
                    source: "Manifest display.detail (manifest-authored, never client)",
                    trust: "Data description",
                    color: "var(--primary)",
                  },
                  {
                    element: "Streams · fields · access_mode",
                    source: "grant constraints (AS/RS enforce)",
                    trust: "Protocol-enforced",
                    color: "var(--success)",
                  },
                  {
                    element: '"Ongoing access until revocation" / "One-time"',
                    source: "grant.access_mode (server-derived)",
                    trust: "Protocol-enforced",
                    color: "var(--success)",
                  },
                  {
                    element: "Purpose · retention",
                    source: "purpose_code, purpose_description, retention",
                    trust: "Policy declaration",
                    color: "var(--warning)",
                  },
                  {
                    element: `"${LONGVIEW_CLIENT_NAME} says: Workspace only..."`,
                    source: "client_claims.commitments (request-scoped)",
                    trust: "Attributed client claim",
                    color: "var(--human)",
                  },
                  {
                    element: `"${LONGVIEW_CLIENT_NAME}" + CLIENT APP + VERIFIED badge`,
                    source: "client_display (entity-scoped) resolved under AS policy",
                    trust: "Identity metadata",
                    color: "var(--primary)",
                  },
                ].map((row, i, arr) => (
                  <div
                    className="flex items-start gap-2 py-1.5 text-xs"
                    key={row.element}
                    style={{ borderBottom: i < arr.length - 1 ? "1px solid var(--border)" : "none" }}
                  >
                    <div className="mt-1.5 h-1 w-1 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                    <div className="min-w-0 flex-1">
                      <span className="text-foreground">{row.element}</span>
                      <br />
                      <span className="font-mono" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                        {row.source}
                      </span>
                      <span className="ml-2" style={{ color: row.color }}>
                        {row.trust}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`// Selection request (RFC 9396 authorization_details
// + RFC 7591-style client metadata carried inline)
{
  "client_display": {
    "name": "${LONGVIEW_CLIENT_NAME}",
    "uri": "${LONGVIEW_CLIENT_URI}",
    "policy_uri": "${LONGVIEW_POLICY_URI}",
    "tos_uri": "${LONGVIEW_TOS_URI}"
  },
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "purpose_code": "${LONGVIEW_PURPOSE_CODE}",
    "purpose_description": "${LONGVIEW_PURPOSE_DESCRIPTION}",
    "access_mode": "continuous",
    "streams": [
      { "name": "pay_statements", "necessity": "required" },
      { "name": "equity_grants", "necessity": "required" },
      { "name": "benefits_enrollments", "necessity": "optional" }
    ],
    "client_claims": {
      "commitments": ["Analysis stays inside this planning workspace"]
    }
  }]
}`}
              </pre>
              <p className="italic" style={{ opacity: 0.7 }}>
                The AS resolves client identity metadata under local policy. For unverified clients, it falls back to a
                monogram instead of fetching arbitrary remote logos.
              </p>
              <p>
                ai_training purpose code requires explicit affirmative consent — the sole protocol-level requirement.
              </p>
            </DetailPanel>
          }
        >
          <ConsentStageBody
            accessMode={accessMode}
            handleAllow={handleAllow}
            handleDeny={handleDeny}
            handleReset={handleReset}
            phase={protocol.phase}
            setAccessMode={setAccessMode}
          />
        </FeaturedSection>

        {/* Grant — wide layout */}
        <Section
          config={SECTION_CONTENT[4]}
          detail={
            <DetailPanel label="See the grant JSON" spec="§6 Grant">
              <p>
                The grant is an immutable consent artifact. Once issued, it cannot be modified. Changes require
                revoke-and-reissue.
              </p>
              {protocol.grant && (
                <pre
                  className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                  style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
                >
                  {JSON.stringify(
                    {
                      grant_id: protocol.grant.grant_id,
                      issued_at: protocol.grant.issued_at,
                      status: protocol.grant.status,
                      client: { client_id: protocol.grant.client_id },
                      purpose_code: protocol.grant.purpose_code,
                      access_mode: protocol.grant.access_mode,
                      streams: protocol.grant.streams.map((s) => ({
                        name: s.name,
                        fields: s.fields,
                        view: s.view,
                      })),
                      retention: protocol.grant.retention,
                      expires_at: protocol.grant.expires_at,
                    },
                    null,
                    2
                  )}
                </pre>
              )}
              <p>Three orthogonal time concepts that must not be conflated:</p>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>grant validity:</span> issued_at / expires_at
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>data scope:</span> streams[].time_range
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>access pattern:</span> access_mode (single_use | continuous)
                </span>
              </div>
              <p>
                A <strong>single_use</strong> grant is consumed on the first token issuance: the issued token keeps
                working until expiry, but no second token is ever minted (a second attempt is rejected{" "}
                <span className="font-mono">grant_consumed</span> → 403). The runtime enforces this and persists no
                STATE from single_use runs. See{" "}
                <a
                  className="underline"
                  href="/docs/reference-implementation-examples#example-6-single-use-grant-consumption"
                >
                  Example 6
                </a>{" "}
                for the real HTTP/JSON exchange (conformance-tested).
              </p>
              <p className="italic" style={{ opacity: 0.7 }}>
                retention is a policy commitment by the client, not server-enforced. Enforcement is through legal
                agreements, consistent with how OAuth 2.0 treats scope compliance.
              </p>
            </DetailPanel>
          }
        >
          <GrantInspector {...grantProps} onRevoke={protocol.phase === "granted" ? handleRevoke : undefined} />
        </Section>

        {/* Enforce — featured: the "one screenshot" moment */}
        <FeaturedSection
          config={SECTION_CONTENT[5]}
          detail={
            <DetailPanel label="See the HTTP exchange" spec="§8 Resource Server">
              <p>
                The RS computes effective_filter = grant_filter AND request_filter. Request-time filters can only
                narrow, never widen.
              </p>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`GET /v1/streams/pay_statements/records HTTP/1.1
Authorization: Bearer <client_token>
PDPP-Version: 0.1.0

→ RS introspects token
→ Resolves grant: ${protocol.grant?.grant_id || "grt_longview01"}
→ Grant authorizes fields: [${grantedPayStatementFields.join(", ")}]
→ Record has fields: [${ALL_PAY_STATEMENT_FIELDS.join(", ")}]
→ Response contains only: [${grantedPayStatementFields.join(", ")}]
→ Stripped: [${ALL_PAY_STATEMENT_FIELDS.filter((f) => !grantedPayStatementFields.includes(f)).join(", ")}]`}
              </pre>
              <p>Edge cases:</p>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span className="text-destructive">403 grant_revoked</span> — grant has been revoked
                </span>
                <span>
                  <span className="text-destructive">403 field_not_granted</span> — filter targets unauthorized field
                </span>
                <span>
                  <span className="text-destructive">403 insufficient_scope</span> — stream not in grant
                </span>
                <span>
                  <span className="text-warning">410 Gone</span> — changes_since cursor has expired
                </span>
              </div>
              <p className="italic" style={{ opacity: 0.7 }}>
                The introspection panel below <em>illustrates</em> the{" "}
                <span className="font-mono">POST /introspect</span> step with a simplified envelope (this demo mock uses
                an illustrative <span className="font-mono">grant_status</span> field; the real server returns{" "}
                <span className="font-mono">active</span>, <span className="font-mono">grant</span>,{" "}
                <span className="font-mono">exp</span>, and related fields instead). For the exact, conformance-tested
                request/response a reviewer can run against a live node — active, revoked, and grant-package shapes —
                see{" "}
                <a
                  className="underline"
                  href="/docs/reference-implementation-examples#example-4-token-introspection-verify-an-issued-token-and-read-its-grant"
                >
                  Example 4
                </a>{" "}
                (conformance-tested by the B3 suite).
              </p>
            </DetailPanel>
          }
        >
          {protocol.phase === "revoked" ? (
            <div className="flex w-full flex-col items-center gap-6">
              <TokenIntrospection introspection={protocol.introspection} />
              <div className="w-full overflow-hidden rounded-xl px-5 py-8 text-center" data-surface="protocol">
                <div className="mb-2 font-mono text-destructive text-xs">403 grant_revoked</div>
                <div className="text-muted-foreground text-xs">
                  Introspection returned active:false, so no further queries are served.
                </div>
              </div>
            </div>
          ) : (
            <div className="flex w-full flex-col items-center gap-6">
              <TokenIntrospection introspection={protocol.introspection} />
              <FieldProjection allFields={ALL_PAY_STATEMENT_FIELDS} grantedFields={grantedPayStatementFields} />
              {protocol.queryResult?.records?.[0] && (
                <div
                  className="w-full overflow-hidden rounded-xl px-5 py-4"
                  data-surface="protocol"
                  style={{ maxWidth: "440px" }}
                >
                  <div className="mb-2 font-medium text-success text-xs">Actual response (first record)</div>
                  <pre className="overflow-x-auto font-mono text-muted-foreground text-xs">
                    {JSON.stringify(protocol.queryResult.records[0].data, null, 2)}
                  </pre>
                  <div className="mt-2 text-xs italic" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                    {Object.keys(protocol.queryResult.records[0].data).length} of {ALL_PAY_STATEMENT_FIELDS.length}{" "}
                    fields returned.{" "}
                    {ALL_PAY_STATEMENT_FIELDS.length - Object.keys(protocol.queryResult.records[0].data).length}{" "}
                    stripped by the grant filter.
                  </div>
                </div>
              )}
            </div>
          )}
        </FeaturedSection>

        {/* Sync — wide */}
        <Section
          config={SECTION_CONTENT[6]}
          detail={
            <DetailPanel label="See the sync protocol" spec="§4.1 Incremental Sync">
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`GET /v1/streams/pay_statements/records?changes_since=${protocol.syncCursor || '"cursor_a8f2..."'}
Authorization: Bearer <client_token>

→ RS finds records added/changed since cursor
→ Applies field projection to EACH record in the delta
→ Returns only records whose AUTHORIZED projection changed
→ Includes next_changes_since for subsequent sync`}
              </pre>
              <p>
                <strong>Projection-aware deltas</strong> (the novel property): if unauthorized field{" "}
                <code className="font-mono">home_address</code> changes but the client is only authorized for{" "}
                <code className="font-mono">[employer, pay_period, gross_pay, net_pay]</code>, the record does not
                appear in the delta. The client cannot infer that home_address changed.
              </p>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>cursor</span> — pagination within a single query (distinct token
                  space)
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>changes_since</span> — sync state across sessions (distinct token
                  space)
                </span>
                <span>A client MUST NOT use a next_cursor value as a changes_since parameter.</span>
              </div>
              <p className="mt-3 font-medium text-foreground">Tombstones</p>
              <p>
                When a record is deleted from a mutable_state stream, the RS includes a tombstone in incremental sync
                responses:
              </p>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`{ "stream": "benefits_enrollments",
  "key": "benefits_0",
  "deleted": true,
  "deleted_at": "2026-04-08T10:00:00Z",
  "emitted_at": "2026-04-08T10:00:01Z" }`}
              </pre>

              <p className="mt-3 font-medium text-foreground">Cursor expiry</p>
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`GET /v1/streams/pay_statements/records?changes_since=expired_cursor
→ 410 Gone
→ Client MUST perform full re-sync`}
              </pre>

              <p>
                <strong>single_use grants</strong> do not support incremental sync. The runtime does not persist STATE
                from single_use collection runs.
              </p>
            </DetailPanel>
          }
        >
          {protocol.phase === "granted" ? (
            <div className="flex w-full flex-col gap-6">
              {/* Live sync state from mock server */}
              <div className="w-full" style={{ maxWidth: "520px" }}>
                <div className="mb-2 font-medium text-muted-foreground text-xs">
                  Initial sync: {protocol.syncResult?.records?.length || 24} records
                </div>
                <div className="mb-1 flex flex-wrap items-center gap-0.5">
                  {Array.from({ length: protocol.syncResult?.records?.length || 24 }, (_, i) => `sync-bar-${i}`).map(
                    (id) => (
                      <div
                        className="h-3 w-1.5 rounded-sm"
                        key={id}
                        style={{ backgroundColor: "var(--primary)", opacity: 0.5 }}
                      />
                    )
                  )}
                </div>
                {protocol.syncCursor && (
                  <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.65 }}>
                    next_changes_since: &quot;{protocol.syncCursor}&quot;
                  </div>
                )}
              </div>

              {/* Add pay statement button */}
              <button
                className="self-start rounded-md px-3 py-1.5 text-xs transition-colors"
                onClick={() => protocol.addNewPayStatements(1)}
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
                type="button"
              >
                + Simulate 1 new pay statement arriving
              </button>

              {/* Live delta result */}
              {protocol.syncResult?.records && protocol.syncResult.records.length > 24 && (
                <div className="w-full" style={{ maxWidth: "520px" }}>
                  <div className="mb-2 font-medium text-success text-xs">
                    Delta: {protocol.syncResult.records.length - 24} new record
                    {protocol.syncResult.records.length - 24 === 1 ? "" : "s"}
                  </div>
                  <pre
                    className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                    style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
                  >
                    {JSON.stringify(
                      protocol.syncResult.records.slice(-1).map((r) => r.data),
                      null,
                      2
                    )}
                  </pre>
                  <div className="mt-2 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                    {grantedPayStatementFields.length} of {ALL_PAY_STATEMENT_FIELDS.length} fields per record.
                    Projection applied to the delta.
                  </div>
                </div>
              )}
            </div>
          ) : (
            <IncrementalSync />
          )}
        </Section>

        {/* Revoke — wide */}
        <Section
          config={SECTION_CONTENT[7]}
          detail={
            <DetailPanel label="See the revocation flow" spec="§6.5 Revocation">
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`// After revocation:
POST /revoke  →  AS marks grant.status = "revoked"

// Next client query:
GET /v1/streams/pay_statements/records
Authorization: Bearer <client_token>
→ RS introspects token  →  active: false
→ 403 grant_revoked

// Propagation window:
Introspection cache TTL ≤ 60 seconds
RS sees revocation within max(token_exp, 60s)`}
              </pre>
              <p>
                Revocation stops <em>future</em> access only. Records already delivered are governed by the grant's
                retention policy and legal obligations. PDPP does not retroactively reach into client-side data stores.
              </p>
              <p>
                Grant narrowing is not supported in v0.1. Scope reduction: revoke the existing grant, issue a new
                narrower one.
              </p>
            </DetailPanel>
          }
          wide
        >
          {protocol.phase === "revoked" ? (
            <OutcomeCard
              message="Access has been revoked. The enforcement section above now shows a 403 response."
              onReset={handleReset}
              variant="revoked"
            />
          ) : (
            <GrantInspector {...grantProps} onRevoke={protocol.phase === "granted" ? handleRevoke : undefined} />
          )}
        </Section>

        {/* Export — wide */}
        <Section
          config={SECTION_CONTENT[8]}
          detail={
            <DetailPanel label="See the token exchange" spec="§8.3 Owner Tokens">
              <pre
                className="overflow-x-auto rounded-md p-3 font-mono text-xs"
                style={{ backgroundColor: "var(--muted)", color: "var(--muted-foreground)" }}
              >
                {`// Self-export: owner token, no grant required
GET /v1/streams/pay_statements/records
Authorization: Bearer <owner_token>

→ RS introspects token
→ pdpp_token_kind: "owner"
→ subject_id: "user_abc123"
→ No grant needed — full access to own data
→ All ${ALL_PAY_STATEMENT_FIELDS.length} fields returned (no projection)`}
              </pre>
              <div className="flex flex-col gap-1 font-mono text-xs">
                <span>
                  <span style={{ opacity: 0.65 }}>owner token</span> — ingest, state management, self-export
                </span>
                <span>
                  <span style={{ opacity: 0.65 }}>client token</span> — querying under a grant (field projection
                  enforced)
                </span>
                <span>RS determines token kind from introspection, never from syntax.</span>
              </div>
            </DetailPanel>
          }
          wide
        >
          <div className="flex w-full flex-col gap-4">
            <div className="w-full overflow-hidden rounded-xl px-5 py-6" data-surface="human">
              <div className="mb-4 flex items-center gap-2">
                <div className="h-2 w-2 rounded-full" style={{ backgroundColor: "var(--success)" }} />
                <span className="font-medium text-success text-xs">Owner access</span>
                <span className="font-mono text-muted-foreground text-xs">No grant required</span>
              </div>
              <div className="flex flex-col">
                {protocol.serverStats.map((s) => (
                  <button
                    className="flex items-center justify-between py-2 text-left"
                    key={s.name}
                    onClick={() => protocol.selfExport(s.name)}
                    style={{ borderBottom: "1px solid var(--border)" }}
                    type="button"
                  >
                    <span className="font-medium text-foreground text-xs">{s.name}</span>
                    <span className="font-mono text-muted-foreground text-xs">
                      {s.fields.length} fields, {s.recordCount} records
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-3 text-muted-foreground text-xs">
                Click a stream to export. All fields returned, no projection.
              </div>
            </div>

            {/* Show export result */}
            {(() => {
              const firstExportRecord = protocol.exportResult?.records?.[0];
              if (!(firstExportRecord && protocol.exportResult?.records?.length)) {
                return null;
              }
              return (
                <div className="w-full overflow-hidden rounded-xl px-5 py-4" data-surface="protocol">
                  <div className="mb-2 font-medium text-success text-xs">
                    Exported {protocol.exportResult.records.length} records (all fields)
                  </div>
                  <div
                    className="overflow-x-auto font-mono text-xs"
                    style={{ color: "var(--muted-foreground)", maxHeight: "120px", overflowY: "auto" }}
                  >
                    {JSON.stringify(firstExportRecord.data, null, 2)}
                  </div>
                  <div className="mt-2 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.7 }}>
                    Showing first record. Compare to the grant-projected response in the Enforce section.
                  </div>
                </div>
              );
            })()}
          </div>
        </Section>

        {/* ── Separator ── */}
        <div className="mx-auto max-w-2xl px-6 md:px-12" style={{ order: 75 }}>
          <div className="h-px" style={{ backgroundColor: "var(--border)" }} />
        </div>

        {/* Multi-connector */}
        <Section config={SECTION_CONTENT[9]}>
          <div className="flex w-full flex-col gap-4">
            <div className="mb-2 flex gap-1.5">
              {MULTI_CONNECTORS.map((c, i) => (
                <button
                  className="rounded px-2 py-1 text-xs transition-colors"
                  key={c.connectorId}
                  onClick={() => setMultiIdx(i)}
                  style={{
                    backgroundColor: i === multiIdx ? "var(--foreground)" : "var(--muted)",
                    color: i === multiIdx ? "var(--background)" : "var(--muted-foreground)",
                  }}
                  type="button"
                >
                  {c.displayName}
                </button>
              ))}
            </div>
            <ConnectorCard {...(MULTI_CONNECTORS[multiIdx] ?? CONNECTOR_SPECIMEN)} />
          </div>
        </Section>

        {/* Spec — mapping of reference sections to spec sections */}
        <Section config={SECTION_CONTENT[10]}>
          <div className="flex w-full flex-col gap-6">
            <div className="flex flex-col gap-2">
              {[
                {
                  ref: "Enforce",
                  spec: "§8 Resource Server",
                  desc: "Token introspection, field projection, effective filter composition",
                },
                { ref: "Request", spec: "§5 Selection Request", desc: "RFC 9396 authorization_details envelope" },
                { ref: "Consent", spec: "§5.1, §5.2", desc: "Client display, client claims, attribution" },
                { ref: "Grant", spec: "§6 Grant", desc: "Immutable consent artifact with three time axes" },
                { ref: "Sync", spec: "§4.1 Incremental", desc: "Projection-aware deltas via changes_since" },
                { ref: "Revoke", spec: "§6.5 Revocation", desc: "60s propagation window, retention governs past data" },
                { ref: "Export", spec: "§8.3 Owner Tokens", desc: "Self-export via owner token, no grant required" },
                { ref: "Inventory", spec: "§4 Record Model", desc: "Flat relational streams with primary keys" },
                { ref: "Ingest", spec: "§7 Manifest", desc: "Connector manifest declares the consent surface" },
              ].map(({ ref, spec, desc }) => (
                <div
                  className="flex items-baseline gap-3 py-1.5"
                  key={ref}
                  style={{ borderBottom: "1px solid var(--border)" }}
                >
                  <span className="w-16 shrink-0 font-medium text-foreground text-xs">{ref}</span>
                  <span className="shrink-0 font-mono text-edu-fg text-xs">{spec}</span>
                  <span className="text-muted-foreground text-xs">{desc}</span>
                </div>
              ))}
            </div>
            <a
              className="font-medium text-primary text-sm transition-opacity hover:opacity-70"
              href={`${SPEC_BASE_URL}/spec-core`}
              rel="noopener noreferrer"
              target="_blank"
            >
              Read the full specification →
            </a>
          </div>
        </Section>
      </div>

      {/* Footer */}
      <footer className="py-8 text-center">
        <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.4 }}>
          PDPP v0.1.0 — Personal Data Portability Protocol
        </span>
      </footer>
    </div>
  );
}
