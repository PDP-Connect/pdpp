'use client';

import React from 'react';
import { Button } from '@/components/ui/button';

// ─── Grant Inspector ─────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §6 Grant):
//
// ALL fields are protocol facts — the grant is an immutable consent artifact.
// No client-claimed content appears here; that was resolved at consent time.
//
// FROM grant object (server-authoritative):
//   grantId, issuedAt, status, client.clientId, client.name,
//   purposeCode, purposeDescription, accessMode, expiresAt,
//   retention, streams[]
//
// FROM manifest display metadata (server-trusted):
//   streams[].label, streams[].detail
//
// FROM server policy:
//   status (active/expired/revoked) — tracked by AS, not in grant

export type GrantStream = {
  name: string;
  label: string;              // manifest display.label
  detail?: string;            // manifest display.detail
  fields?: string[];          // granted field allowlist, absent = all
  view?: string;              // informational — which view was selected
  timeRange?: { since?: string; until?: string };
};

export type GrantInspectorProps = {
  grantId: string;
  issuedAt: string;           // human-readable date
  status: 'active' | 'expired' | 'revoked';
  client: {
    clientId: string;
    name: string;             // from client_display at consent time, or client_id
  };
  purposeCode: string;
  purposeDescription?: string;
  accessMode: 'continuous' | 'single_use';
  expiresAt?: string | null;  // human-readable date, null = no expiry
  retention?: {
    duration: string;         // human-readable, e.g. "90 days"
    onExpiry: 'delete' | 'anonymize';
  };
  streams: GrantStream[];
  onRevoke?: () => void;
};

export function GrantInspector({
  grantId,
  issuedAt,
  status,
  client,
  purposeCode,
  purposeDescription,
  accessMode,
  expiresAt,
  retention,
  streams,
  onRevoke,
}: GrantInspectorProps) {
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const toggleExpand = (key: string) => setExpanded(v => ({ ...v, [key]: !v[key] }));
  const [revoked, setRevoked] = React.useState(status === 'revoked');
  const currentStatus = revoked ? 'revoked' : status;

  const statusColor = {
    active: 'var(--success)',
    expired: 'var(--muted-foreground)',
    revoked: 'var(--destructive)',
  }[currentStatus];

  const statusLabel = {
    active: accessMode === 'continuous' ? 'Active, ongoing' : 'Active, single use',
    expired: 'Expired',
    revoked: 'Revoked',
  }[currentStatus];

  const accessModeLabel = accessMode === 'continuous'
    ? 'Continuous access until revoked'
    : 'Single use, consumed after first query';

  return (
    <div style={{ maxWidth: '440px' }}>
      <div data-surface="protocol" className="rounded-xl overflow-hidden">

        {/* ── Header: grant identity + status ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-center justify-between gap-3 mb-3">
            <div className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: statusColor }} />
              <span className="text-xs font-medium" style={{ color: statusColor }}>{statusLabel}</span>
            </div>
            <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{grantId}</span>
          </div>

          {/* Client + purpose */}
          <div className="text-sm font-medium mb-1" style={{ color: 'var(--foreground)' }}>
            {client.name}
          </div>
          {purposeDescription && (
            <div className="text-xs mb-3" style={{ color: 'var(--muted-foreground)' }}>
              {purposeDescription}
            </div>
          )}

          {/* Key terms grid */}
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 mt-3">
            <div>
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>Issued</div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{issuedAt}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>Expires</div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{expiresAt ?? 'Never'}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>Access</div>
              <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{accessModeLabel}</div>
            </div>
            {retention && (
              <div>
                <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>Retention</div>
                <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {retention.onExpiry === 'delete' ? 'Deleted' : 'Anonymized'} after {retention.duration}
                </div>
              </div>
            )}
          </div>

          {/* Purpose code — technical */}
          <div className="font-mono text-xs mt-3" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>
            purpose: <span style={{ color: 'var(--edu-fg)', opacity: 1 }}>{purposeCode}</span>
          </div>
        </div>

        {/* ── Granted streams ── */}
        <div className="px-5 pb-1" style={{ borderTop: '1px solid var(--border)' }}>
          {streams.map(({ name, label, detail, fields, view, timeRange }) => (
            <div key={name} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="w-full flex items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(name)}
                aria-expanded={!!expanded[name]}
              >
                <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{label}</span>
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
                  {view && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.7 }}>View: </span>
                      <span className="px-1 py-px rounded" style={{ backgroundColor: 'var(--muted)' }}>{view}</span>
                    </div>
                  )}
                  {fields && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.7 }}>Fields: </span>{fields.join(', ')}
                    </div>
                  )}
                  {timeRange?.since && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.7 }}>Since: </span>{timeRange.since}
                    </div>
                  )}
                  {!fields && !view && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>
                      All fields authorized
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>

        {/* ── Revoke action ── */}
        {currentStatus === 'active' && onRevoke && (
          <div className="px-5 py-4">
            <Button
              variant="outline"
              className="w-full"
              style={{ borderColor: 'var(--destructive)', color: 'var(--destructive)' }}
              onClick={() => { setRevoked(true); onRevoke(); }}
            >
              Revoke access
            </Button>
          </div>
        )}

        {currentStatus !== 'active' && (
          <div className="px-5 py-3 text-xs text-center" style={{ color: 'var(--muted-foreground)' }}>
            {currentStatus === 'revoked'
              ? 'Access has been revoked. No further queries will be served.'
              : 'This grant has expired. No further queries will be served.'}
          </div>
        )}

      </div>
      {revoked && status !== 'revoked' && (
        <button
          className="font-mono text-xs mt-2 px-0.5"
          style={{ color: 'var(--muted-foreground)' }}
          onClick={() => setRevoked(false)}
        >
          ↺ reset
        </button>
      )}
    </div>
  );
}
