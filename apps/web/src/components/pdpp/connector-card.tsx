"use client";

import React from "react";

// ─── Connector Card ──────────────────────────────────────────────────────────

// Props contract — all fields from connector manifest (§7):
//
// FROM manifest (server-trusted):
//   connectorId, displayName, version, streams[], profiles[]

export interface ConnectorStream {
  name: string;
  label?: string; // display.label, may be absent
  semantics: "append_only" | "mutable_state";
  supportsFields: boolean; // selection.fields
  supportsResources: boolean; // selection.resources
  supportsTimeRange: boolean; // consent_time_field present
  viewCount: number; // number of views defined
}

export interface ConnectorProfile {
  id: string;
  label: string;
  streamCount: number;
}

export interface ConnectorCardProps {
  connectorId: string;
  displayName: string;
  version: string;
  streams: ConnectorStream[];
  profiles?: ConnectorProfile[];
}

export function ConnectorCard({ connectorId, displayName, version, streams, profiles }: ConnectorCardProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));

  const appendOnly = streams.filter((s) => s.semantics === "append_only").length;
  const mutableState = streams.filter((s) => s.semantics === "mutable_state").length;

  return (
    <div style={{ maxWidth: "440px" }}>
      <div data-surface="protocol" className="overflow-hidden rounded-xl">
        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="font-medium text-sm" style={{ color: "var(--foreground)" }}>
              {displayName}
            </span>
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              v{version}
            </span>
          </div>
          <div className="mb-3 truncate font-mono text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.6 }}>
            {connectorId}
          </div>
          <div className="flex items-center gap-3 text-xs" style={{ color: "var(--muted-foreground)" }}>
            <span>
              {streams.length} stream{streams.length === 1 ? "" : "s"}
            </span>
            {appendOnly > 0 && (
              <span className="rounded px-1 py-px font-mono" style={{ backgroundColor: "var(--muted)" }}>
                {appendOnly} append only
              </span>
            )}
            {mutableState > 0 && (
              <span className="rounded px-1 py-px font-mono" style={{ backgroundColor: "var(--muted)" }}>
                {mutableState} mutable state
              </span>
            )}
          </div>
        </div>

        {/* ── Streams ── */}
        <div className="px-5 pb-1" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map((s) => (
            <div key={s.name} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(s.name)}
                aria-expanded={!!expanded[s.name]}
              >
                <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                  {s.label || s.name}
                </span>
                <span
                  className="shrink-0 text-xs"
                  style={{
                    color: "var(--muted-foreground)",
                    display: "inline-block",
                    transform: expanded[s.name] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 150ms",
                  }}
                >
                  &#x203A;
                </span>
              </button>
              {expanded[s.name] && (
                <div
                  className="flex flex-col gap-1 border-l-2 pb-2.5 pl-3"
                  style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
                >
                  <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                    <span style={{ opacity: 0.6 }}>stream: </span>
                    {s.name}
                  </div>
                  <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                    <span style={{ opacity: 0.6 }}>semantics: </span>
                    <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                      {s.semantics === "append_only" ? "append only" : "mutable state"}
                    </span>
                  </div>
                  <div
                    className="flex flex-wrap items-center gap-2 font-mono text-xs"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    <span style={{ opacity: 0.6 }}>supports:</span>
                    {s.supportsFields && (
                      <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                        fields
                      </span>
                    )}
                    {s.supportsResources && (
                      <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                        resources
                      </span>
                    )}
                    {s.supportsTimeRange && (
                      <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                        time_range
                      </span>
                    )}
                    {!(s.supportsFields || s.supportsResources || s.supportsTimeRange) && (
                      <span style={{ opacity: 0.6 }}>none</span>
                    )}
                  </div>
                  {s.viewCount > 0 && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.6 }}>views: </span>
                      {s.viewCount} defined
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Profiles ── */}
        {profiles && profiles.length > 0 && (
          <div className="px-5 py-3" style={{ borderTop: "1px solid var(--border)" }}>
            <div className="mb-2 text-xs" style={{ color: "var(--muted-foreground)", opacity: 0.6 }}>
              Profiles
            </div>
            <div className="flex flex-col gap-1">
              {profiles.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center justify-between font-mono text-xs"
                  style={{ color: "var(--muted-foreground)" }}
                >
                  <span>{p.label}</span>
                  <span style={{ opacity: 0.6 }}>
                    {p.streamCount} stream{p.streamCount === 1 ? "" : "s"}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
