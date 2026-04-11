'use client';

import { ReferenceApp } from '@/components/ReferenceApp';
import { Hero } from '@/components/Hero';

export default function Home() {
  return (
    <ReferenceApp
      currentLabel="Overview"
      hero={
        <Hero
          layout="cross"
          gradient="dual"
          size="splash"
          eyebrow={
            <span className="flex items-center gap-2">
              <span
                className="font-mono text-xs px-2 py-0.5 rounded"
                style={{
                  backgroundColor: 'var(--primary-wash)',
                  color: 'var(--primary)',
                  border: '1px solid oklch(0.580 0.172 253.7 / 0.15)',
                }}
              >
                v0.1.0
              </span>
              <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Draft specification
              </span>
            </span>
          }
          title={
            <>
              Personal Data
              <br />
              Portability Protocol
            </>
          }
          description={
            <>
              An authorization and disclosure protocol for personal data. You decide what to share,
              with whom, for how long, for what purpose.
              <br />
              <span className="pdpp-caption" style={{ display: 'block', marginTop: '0.5rem', opacity: 0.7 }}>
                This is the protocol, running. Every component below implements a section of the spec.
              </span>
            </>
          }
          actions={
            <div className="hidden md:flex items-center gap-0 pb-2">
              {[
                { label: 'Platform', color: 'var(--muted-foreground)', bg: 'var(--muted)' },
                { label: 'Connector', color: 'var(--primary)', bg: 'var(--primary-wash)' },
                { label: 'Your Server', color: 'var(--primary)', bg: 'var(--primary-wash)' },
                { label: 'Consent', color: 'var(--human)', bg: 'var(--human-wash)' },
                { label: 'Grant', color: 'var(--primary)', bg: 'var(--primary-wash)' },
                { label: 'Enforce', color: 'var(--primary)', bg: 'var(--primary-wash)' },
                { label: 'Client', color: 'var(--muted-foreground)', bg: 'var(--muted)' },
              ].map((step, i, arr) => (
                <span key={step.label} className="flex items-center">
                  <span
                    className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium"
                    style={{
                      backgroundColor: step.bg,
                      color: step.color,
                      border: `1px solid ${step.color}20`,
                    }}
                  >
                    {step.label}
                  </span>
                  {i < arr.length - 1 && (
                    <span className="shrink-0 w-6 h-px" style={{ backgroundColor: 'var(--border)' }} />
                  )}
                </span>
              ))}
            </div>
          }
        />
      }
    />
  );
}
