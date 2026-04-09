'use client';

import React from 'react';

// ─── Stream Inventory ────────────────────────────────────────────────────────

// Props contract — all fields are server-authoritative:
//
// FROM connector manifest (server-trusted):
//   connectorName, streams[].name, streams[].label, streams[].detail,
//   streams[].semantics
//
// FROM resource server (runtime state):
//   streams[].recordCount, streams[].lastSynced

export type InventoryStream = {
  name: string;
  label: string;              // manifest display.label
  detail?: string;            // manifest display.detail
  semantics: 'append_only' | 'mutable_state';
  recordCount: number;
  lastSynced?: string;        // human-readable date, absent if never synced
};

export type StreamInventoryProps = {
  connectorName: string;
  connectorVersion: string;
  streams: InventoryStream[];
};

export function StreamInventory({ connectorName, connectorVersion, streams }: StreamInventoryProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded(v => ({ ...v, [key]: !v[key] }));

  const totalRecords = streams.reduce((sum, s) => sum + s.recordCount, 0);

  return (
    <div style={{ maxWidth: '440px' }}>
      <div data-surface="protocol" className="rounded-xl overflow-hidden">

        {/* ── Header ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center justify-between gap-3 mb-1">
            <span className="text-sm font-medium" style={{ color: 'var(--foreground)' }}>{connectorName}</span>
            <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>v{connectorVersion}</span>
          </div>
          <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {streams.length} stream{streams.length !== 1 ? 's' : ''}, {totalRecords.toLocaleString()} record{totalRecords !== 1 ? 's' : ''}
          </div>
        </div>

        {/* ── Stream rows ── */}
        <div className="px-5 pb-2" style={{ borderTop: '1px solid var(--border)' }}>
          {streams.map(({ name, label, detail, semantics, recordCount, lastSynced }) => (
            <div key={name} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="w-full flex items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(name)}
                aria-expanded={!!expanded[name]}
              >
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{label}</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {recordCount.toLocaleString()}
                  </span>
                </div>
                <span
                  className="text-xs shrink-0"
                  style={{
                    color: 'var(--muted-foreground)',
                    display: 'inline-block',
                    transform: expanded[name] ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 150ms',
                  }}
                >&#x203A;</span>
              </button>
              {expanded[name] && (
                <div className="pb-2.5 pl-3 border-l-2 flex flex-col gap-1" style={{ borderColor: 'oklch(0.580 0.172 253.7 / 0.25)' }}>
                  {detail && (
                    <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{detail}</div>
                  )}
                  <div className="flex items-center gap-3 font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    <span>
                      <span style={{ opacity: 0.6 }}>stream: </span>{name}
                    </span>
                    <span className="px-1 py-px rounded" style={{ backgroundColor: 'var(--muted)' }}>
                      {semantics === 'append_only' ? 'append only' : 'mutable state'}
                    </span>
                  </div>
                  {lastSynced && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.6 }}>last synced: </span>{lastSynced}
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
