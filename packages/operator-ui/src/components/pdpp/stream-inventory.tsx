"use client";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import React from "react";

// ─── Stream Inventory ────────────────────────────────────────────────────────

// Props contract — all fields are server-authoritative:
//
// FROM connector manifest (server-trusted):
//   connectorName, streams[].name, streams[].label, streams[].detail,
//   streams[].semantics
//
// FROM resource server (runtime state):
//   streams[].recordCount, streams[].lastSynced

export interface InventoryStream {
  detail?: string; // manifest display.detail
  label: string; // manifest display.label
  lastSynced?: string; // human-readable date, absent if never synced
  name: string;
  recordCount: number;
  semantics: "append_only" | "mutable_state";
}

export interface StreamInventoryProps {
  connectorName: string;
  connectorVersion: string;
  streams: InventoryStream[];
}

export function StreamInventory({ connectorName, connectorVersion, streams }: StreamInventoryProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded((v) => ({ ...v, [key]: !v[key] }));

  const totalRecords = streams.reduce((sum, s) => sum + s.recordCount, 0);

  return (
    <div style={{ maxWidth: "440px" }}>
      <div className="overflow-hidden rounded-xl" data-surface="protocol">
        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="mb-1 flex items-center justify-between gap-3">
            <span className="font-medium text-sm" style={{ color: "var(--foreground)" }}>
              {connectorName}
            </span>
            <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
              v{connectorVersion}
            </span>
          </div>
          <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
            {streams.length} stream{streams.length === 1 ? "" : "s"}, {totalRecords.toLocaleString()} record
            {totalRecords === 1 ? "" : "s"}
          </div>
        </div>

        {/* ── Stream rows ── */}
        <div className="px-5 pb-2" style={{ borderTop: "1px solid var(--border)" }}>
          {streams.map(({ name, label, detail, semantics, recordCount, lastSynced }) => (
            <div key={name} style={{ borderBottom: "1px solid var(--border)" }}>
              <button
                aria-expanded={!!expanded[name]}
                className="flex w-full items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(name)}
                type="button"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="font-medium text-xs" style={{ color: "var(--foreground)" }}>
                    {label}
                  </span>
                  <span className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                    {recordCount.toLocaleString()}
                  </span>
                </div>
                <span
                  className="shrink-0 text-xs"
                  style={{
                    color: "var(--muted-foreground)",
                    display: "inline-block",
                    transform: expanded[name] ? "rotate(90deg)" : "rotate(0deg)",
                    transition: "transform 150ms",
                  }}
                >
                  &#x203A;
                </span>
              </button>
              {expanded[name] && (
                <div
                  className="flex flex-col gap-1 border-l-2 pb-2.5 pl-3"
                  style={{ borderColor: "oklch(0.580 0.172 253.7 / 0.25)" }}
                >
                  {detail && (
                    <div className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                      {detail}
                    </div>
                  )}
                  <div
                    className="flex items-center gap-3 font-mono text-xs"
                    style={{ color: "var(--muted-foreground)" }}
                  >
                    <span>
                      <span style={{ opacity: 0.6 }}>stream: </span>
                      {name}
                    </span>
                    <span className="rounded px-1 py-px" style={{ backgroundColor: "var(--muted)" }}>
                      {semantics === "append_only" ? "append only" : "mutable state"}
                    </span>
                  </div>
                  {lastSynced && (
                    <div className="font-mono text-xs" style={{ color: "var(--muted-foreground)" }}>
                      <span style={{ opacity: 0.6 }}>last synced: </span>
                      {lastSynced}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
