'use client';

import { useState } from 'react';
import { PDPP_PURPOSE_DOCS, type PurposeDoc } from '@/lib/purpose-docs';

interface Props {
  purposeUri: string;
}

const RETENTION_LABELS: Record<string, string> = {
  'P1Y': '1 year', 'P2Y': '2 years', 'P3Y': '3 years',
  'P6M': '6 months', 'P30D': '30 days',
};

function DocExpanded({ doc, onClose }: { doc: PurposeDoc; onClose: () => void }) {
  return (
    <div
      className="mt-2 rounded-md p-3 text-[11px] flex flex-col gap-3"
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--indigo-border)',
        animation: 'fadein 0.15s ease',
      }}
    >
      {/* URI + close */}
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-[9px] break-all" style={{ color: 'var(--text-tertiary)' }}>
          {doc.uri}
        </span>
        <button
          onClick={onClose}
          className="text-[12px] shrink-0 cursor-pointer border-none bg-transparent"
          style={{ color: 'var(--text-tertiary)' }}
        >✕</button>
      </div>

      <p className="leading-relaxed" style={{ color: 'var(--text-secondary)' }}>{doc.description}</p>

      <div className="flex gap-3 flex-wrap">
        <div className="flex-1 min-w-[130px]">
          <div className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--success)' }}>
            Permitted uses
          </div>
          <div className="flex flex-col gap-1">
            {doc.permitted_uses.map(u => (
              <div key={u} className="flex gap-1.5 items-start" style={{ color: 'var(--text-secondary)' }}>
                <span className="shrink-0 mt-px" style={{ color: 'var(--success)' }}>✓</span>
                <span>{u}</span>
              </div>
            ))}
          </div>
        </div>
        <div className="flex-1 min-w-[130px]">
          <div className="text-[9px] font-bold uppercase tracking-wider mb-2" style={{ color: 'var(--danger)' }}>
            Prohibited
          </div>
          <div className="flex flex-col gap-1">
            {doc.prohibited_uses.map(u => (
              <div key={u} className="flex gap-1.5 items-start" style={{ color: 'var(--text-secondary)' }}>
                <span className="shrink-0 mt-px" style={{ color: 'var(--danger)' }}>✗</span>
                <span>{u}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="flex gap-4 flex-wrap text-[10px]">
        <span>
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Max retention </span>
          <span style={{ color: 'var(--text-secondary)' }}>{RETENTION_LABELS[doc.max_retention] ?? doc.max_retention}</span>
        </span>
        <span>
          <span className="text-[9px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-tertiary)' }}>Explicit consent </span>
          <span style={{ color: doc.requires_explicit_consent ? 'var(--warning)' : 'var(--text-secondary)' }}>
            {doc.requires_explicit_consent ? 'required' : 'not required'}
          </span>
        </span>
      </div>
    </div>
  );
}

export function PurposeDocument({ purposeUri }: Props) {
  const [expanded, setExpanded] = useState(false);
  const doc = PDPP_PURPOSE_DOCS[purposeUri];

  if (!doc) {
    return (
      <span
        className="font-mono text-[10px] px-2 py-0.5 rounded"
        style={{
          background: 'var(--surface-raised)',
          color: 'var(--indigo)',
          border: '1px solid var(--border)',
        }}
      >
        {purposeUri}
      </span>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(v => !v)}
        title={expanded ? 'Hide purpose document' : 'Show full purpose document'}
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[10px] font-mono cursor-pointer border transition-all duration-150"
        style={{
          background: expanded ? 'var(--indigo-dim)' : 'var(--surface-raised)',
          border: `1px solid ${expanded ? 'var(--indigo-border)' : 'var(--border)'}`,
          color: 'var(--indigo)',
        }}
      >
        <span>pdpp.org/purpose/{doc.label}</span>
        <span
          className="text-[8px] opacity-70 inline-block transition-transform duration-150"
          style={{ transform: expanded ? 'rotate(180deg)' : 'none' }}
        >▼</span>
      </button>
      {expanded && <DocExpanded doc={doc} onClose={() => setExpanded(false)} />}
    </div>
  );
}
