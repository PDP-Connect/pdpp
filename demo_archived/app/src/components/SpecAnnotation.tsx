'use client';

import { type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
  className?: string;
}

/**
 * SpecAnnotation wraps UI elements in the education layer — things a real
 * PDPP app wouldn't show but that we overlay to explain the protocol.
 * Visual cues: muted violet tint + ⬡ label in corner.
 */
export function SpecAnnotation({ children, label = 'Spec annotation', className }: Props) {
  return (
    <div
      className={`relative rounded-md pt-5 px-3 pb-3 ${className ?? ''}`}
      style={{
        background: 'var(--edu-bg)',
        border: '1px solid var(--edu-border)',
      }}
    >
      <div
        className="absolute top-1 right-2 flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide select-none"
        style={{ color: 'var(--edu-fg)' }}
      >
        <span>⬡</span>
        <span>{label}</span>
      </div>
      {children}
    </div>
  );
}
