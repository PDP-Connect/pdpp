'use client';

import React, { useState, useEffect } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardFooter } from '@/components/ui/card';

// ─── Nav ──────────────────────────────────────────────────────────────────────

const NAV_SECTIONS = [
  { id: 'color',      label: 'Color' },
  { id: 'typography', label: 'Typography' },
  { id: 'spacing',    label: 'Spacing' },
  { id: 'elevation',  label: 'Elevation' },
  { id: 'motion',     label: 'Motion' },
  { id: 'surfaces',   label: 'Surfaces' },
  { id: 'components', label: 'Components' },
  { id: 'status',     label: 'Status' },
  { id: 'rules',      label: 'Rules' },
];

// ─── Page ─────────────────────────────────────────────────────────────────────

export default function DesignSystemPage() {
  const [active, setActive] = useState('color');

  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) setActive(e.target.id);
        }
      },
      { rootMargin: '-10% 0px -75% 0px', threshold: 0 }
    );
    NAV_SECTIONS.forEach(({ id }) => {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    });
    return () => observer.disconnect();
  }, []);

  const scrollTo = (id: string) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  return (
    <div className="min-h-screen overflow-x-hidden" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>

      {/* ── Top nav ── */}
      <header
        className="sticky top-0 z-40 flex h-12 md:h-11 items-center px-5 md:px-6 gap-3"
        style={{
          backgroundColor: 'var(--background)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-2.5 shrink-0">
          <div
            className="w-6 h-6 md:w-5 md:h-5 rounded flex items-center justify-center shrink-0"
            style={{ background: 'var(--primary)' }}
          >
            <span className="text-[10px] md:text-[9px] font-bold leading-none" style={{ color: 'var(--primary-foreground)' }}>P</span>
          </div>
          <span className="text-base md:text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>PDPP</span>
          <span style={{ color: 'var(--muted-foreground)', opacity: 0.4, margin: '0 2px' }}>/</span>
          <span className="text-base md:text-sm" style={{ color: 'var(--muted-foreground)' }}>Design System</span>
        </div>
        <div className="flex-1" />
        <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>v0.1.0</span>
      </header>

      {/* ── Mobile nav ── */}
      <MobileNav active={active} scrollTo={scrollTo} />

      {/* ── Top row: fixed integer height so all four borders land on whole pixels ── */}
      <div className="hidden md:flex" style={{ height: '208px' }}>
        {/* Top-left quadrant — blank. No borderRight here; hero's borderLeft is the single vertical line */}
        <div className="w-[200px] shrink-0" style={{ borderBottom: '1px solid var(--border)' }} />
        {/* Top-right quadrant — hero. borderLeft (copper) is the sole vertical line at x=200 for this row */}
        <div className="flex-1" style={{
          borderLeft: '1px solid var(--human)',
          borderBottom: '1px solid var(--border)',
          background: 'linear-gradient(to right, var(--human-wash), transparent 60%)',
        }}>
          <div style={{ height: '100%' }}>
            <div className="px-5 md:px-12 py-10 max-w-3xl">
              <h1 className="font-semibold tracking-tight" style={{ fontSize: '2rem', lineHeight: 1.1, color: 'var(--foreground)', marginBottom: '0.5rem' }}>
                Design System
              </h1>
              <p className="text-sm leading-relaxed" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
                Single source of truth for tokens, typography, motion, and components.
                Nothing gets styled without a token.
              </p>
              <div className="flex flex-wrap gap-1.5 mt-4">
                {['Tailwind v4', 'shadcn base-nova', 'Base UI', 'Geist', 'JetBrains Mono'].map(t => (
                  <span key={t} className="font-mono text-[10px] px-2 py-0.5 rounded" style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>{t}</span>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile hero — shown only on mobile (no cross layout) */}
      <div className="md:hidden" style={{
        borderLeft: '1px solid var(--human)',
        borderBottom: '1px solid var(--border)',
        background: 'linear-gradient(to right, var(--human-wash), transparent 60%)',
      }}>
        <div className="px-5 py-10">
          <h1 className="font-semibold tracking-tight" style={{ fontSize: '2rem', lineHeight: 1.1, color: 'var(--foreground)', marginBottom: '0.5rem' }}>
            Design System
          </h1>
          <p className="text-sm leading-relaxed" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            Single source of truth for tokens, typography, motion, and components.
            Nothing gets styled without a token.
          </p>
          <div className="flex flex-wrap gap-1.5 mt-4">
            {['Tailwind v4', 'shadcn base-nova', 'Base UI', 'Geist', 'JetBrains Mono'].map(t => (
              <span key={t} className="font-mono text-[10px] px-2 py-0.5 rounded" style={{ color: 'var(--muted-foreground)', border: '1px solid var(--border)', backgroundColor: 'var(--muted)' }}>{t}</span>
            ))}
          </div>
        </div>
      </div>

      {/* ── Bottom row: nav bottom-left + content bottom-right ── */}
      <div className="flex min-w-0 w-full">
        {/* Bottom-left quadrant — sticky nav */}
        <aside
          className="hidden md:flex flex-col w-[200px] shrink-0 sticky top-11 h-[calc(100vh-2.75rem)] overflow-y-auto"
          style={{ borderRight: '1px solid var(--border)' }}
        >
          <div className="px-3 py-6">
            <div className="text-xs font-semibold mb-1 px-2" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }}>
              Foundations
            </div>
            <nav className="flex flex-col gap-0.5">
              {NAV_SECTIONS.map(({ id, label }) => (
                <button
                  key={id}
                  onClick={() => scrollTo(id)}
                  className="text-left py-0.5 px-2 cursor-pointer rounded-md transition-colors"
                  style={{
                    fontSize: '0.8125rem',
                    color: active === id ? 'var(--foreground)' : 'var(--muted-foreground)',
                    fontWeight: active === id ? 500 : 400,
                    backgroundColor: active === id ? 'var(--muted)' : 'transparent',
                  }}
                >
                  {label}
                </button>
              ))}
            </nav>
            <div className="mt-6 pt-5" style={{ borderTop: '1px solid var(--border)' }}>
              <div className="text-xs font-semibold mb-1 px-2" style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }}>
                Source
              </div>
              <div className="flex flex-col gap-0.5">
                {['globals.css', 'CONSTITUTION.md', 'button.tsx', 'card.tsx'].map(f => (
                  <div key={f} className="px-2 py-1 font-mono text-[11px] rounded" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>{f}</div>
                ))}
              </div>
            </div>
          </div>
        </aside>

        {/* Content + right TOC */}
        <div className="flex flex-1 min-w-0">
            {/* Main content */}
            <main className="flex-1 min-w-0">
              <div className="flex flex-col">
                <ColorSection />
                <TypographySection />
                <SpacingSection />
                <ElevationSection />
                <MotionSection />
                <SurfacesSection />
                <ComponentsSection />
                <StatusSection />
                <RulesSection />
              </div>

              <div className="px-6 md:px-12 py-8" style={{ borderTop: '1px solid var(--border)' }}>
                <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>
                  PDPP Design System · source of truth: globals.css + CONSTITUTION.md
                </span>
              </div>
            </main>

            {/* Right TOC */}
            <div
              className="hidden xl:flex flex-col w-[180px] shrink-0 sticky top-11 h-[calc(100vh-2.75rem)] overflow-y-auto py-6 px-3"
              style={{ borderLeft: '1px solid var(--border)' }}
            >
          <div
            className="text-xs font-semibold mb-1 px-2"
            style={{ color: 'var(--muted-foreground)', letterSpacing: '0.06em' }}
          >
            On this page
          </div>
          <nav className="flex flex-col gap-0.5">
            {NAV_SECTIONS.map(({ id, label }) => (
              <button
                key={id}
                onClick={() => scrollTo(id)}
                className="text-left px-2 py-1 rounded-md cursor-pointer transition-colors"
                style={{
                  fontSize: '0.8125rem',
                  color: active === id ? 'var(--foreground)' : 'var(--muted-foreground)',
                  fontWeight: active === id ? 500 : 400,
                  backgroundColor: active === id ? 'var(--muted)' : 'transparent',
                }}
              >
                {label}
              </button>
            ))}
          </nav>
            </div>

          </div>

      </div>
    </div>
  );
}

// Mobile nav — shown below md
function MobileNav({ active, scrollTo }: { active: string; scrollTo: (id: string) => void }) {
  return (
    <div
      className="md:hidden sticky top-12 z-30 flex items-center gap-0 overflow-x-auto px-2 w-full"
      style={{
        borderBottom: '1px solid var(--border)',
        backgroundColor: 'var(--background)',
        backdropFilter: 'blur(8px)',
        scrollbarWidth: 'none',
      }}
    >
      {NAV_SECTIONS.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => scrollTo(id)}
          className="shrink-0 px-3.5 py-3 text-sm font-medium transition-colors"
          style={{
            color: active === id ? 'var(--foreground)' : 'var(--muted-foreground)',
            borderBottom: active === id ? '2px solid var(--foreground)' : '2px solid transparent',
            marginBottom: '-1px',
          }}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

// ─── Shared primitives ────────────────────────────────────────────────────────

function SectionWrap({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <section
      id={id}
      className="scroll-mt-[96px] md:scroll-mt-11 px-5 md:px-12 py-10 md:py-14"
      style={{ maxWidth: '860px', borderTop: '1px solid var(--border)' }}
    >
      {children}
    </section>
  );
}

function SectionHeader({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col gap-2 mb-10">
      <h2 className="font-semibold tracking-tight leading-none" style={{ fontSize: '1.5rem' }}>{title}</h2>
      {description && (
        <p className="text-sm md:text-sm leading-relaxed mt-1" style={{ color: 'var(--muted-foreground)', maxWidth: '56ch', fontSize: 'clamp(0.875rem, 2.5vw, 0.9375rem)' }}>{description}</p>
      )}
    </div>
  );
}

function SubLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="font-mono text-[9px] font-semibold uppercase tracking-widest mb-4 overflow-hidden text-ellipsis whitespace-nowrap"
      style={{ color: 'var(--muted-foreground)' }}
    >
      {children}
    </div>
  );
}

function RuleBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-4 pl-4 py-3" style={{ borderLeft: '2px solid var(--border)' }}>
      <span className="text-sm leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>{children}</span>
    </div>
  );
}

// Swatch — flat square with a very subtle border
function SwatchDot({ token }: { token: string }) {
  return (
    <div
      className="w-6 h-6 rounded shrink-0"
      style={{
        background: `var(${token})`,
        boxShadow: 'inset 0 0 0 1px oklch(0 0 0 / 0.10)',
        outline: '1px solid oklch(0.88 0 0)',
        outlineOffset: '1px',
      }}
    />
  );
}

// ─── 01 Color ─────────────────────────────────────────────────────────────────

const COLOR_GROUPS = [
  {
    label: 'Surfaces',
    tokens: [
      { token: '--background',        value: 'oklch(0.99 0.002 95)',     label: 'Page background',         usage: 'Root page, panel backgrounds' },
      { token: '--card',              value: 'oklch(1 0 0)',             label: 'Card surface',             usage: 'Cards, elevated panels' },
      { token: '--muted',             value: 'oklch(0.96 0 0)',          label: 'Muted fill',               usage: 'Input backgrounds, secondary rows' },
      { token: '--popover',           value: 'oklch(1 0 0)',             label: 'Floating surface',         usage: 'Dropdowns, tooltips, popovers' },
    ],
  },
  {
    label: 'Text',
    tokens: [
      { token: '--foreground',        value: 'oklch(0.13 0 0)',          label: 'Primary text',             usage: 'Body copy, headings, labels' },
      { token: '--muted-foreground',  value: 'oklch(0.50 0 0)',          label: 'Secondary text',           usage: 'Captions, helper text, placeholders' },
      { token: '--primary-foreground',value: 'oklch(0.99 0 0)',          label: 'On-primary text',          usage: 'Text on primary-colored backgrounds' },
    ],
  },
  {
    label: 'Interactive',
    tokens: [
      { token: '--primary',           value: 'oklch(0.580 0.172 253.7)', label: 'Signature blue (#187adc)', usage: 'CTAs, links, focus rings, progress' },
      { token: '--secondary',         value: 'oklch(0.96 0 0)',          label: 'Secondary action',         usage: 'Secondary buttons, chips' },
      { token: '--destructive',       value: 'oklch(0.55 0.20 27)',      label: 'Destructive',              usage: 'Delete actions, error states' },
    ],
  },
  {
    label: 'Borders',
    tokens: [
      { token: '--border',            value: 'oklch(0.94 0 0)',          label: 'Default border',           usage: 'Cards, dividers, all structural borders' },
      { token: '--input',             value: 'oklch(0.91 0 0)',          label: 'Input border',             usage: 'Form field borders at rest — higher contrast for accessibility' },
      { token: '--ring',              value: 'oklch(0.580 0.172 253.7)', label: 'Focus ring',               usage: 'Keyboard focus indicator' },
    ],
  },
  {
    label: 'Status',
    tokens: [
      { token: '--success',           value: 'oklch(0.52 0.15 150)',     label: 'Success',                  usage: 'Granted, confirmed, synced' },
      { token: '--warning',           value: 'oklch(0.62 0.15 70)',      label: 'Warning',                  usage: 'Pending, caution states' },
      { token: '--edu-fg',            value: 'oklch(0.55 0.08 270)',     label: 'Spec citation (§)',         usage: 'Protocol spec references only' },
    ],
  },
  {
    label: 'Surface Temperature',
    tokens: [
      { token: '--human',             value: 'oklch(0.52 0.09 45)',      label: 'Human — copper-deep',      usage: 'Identity, ownership, consent surfaces' },
      { token: '--human-wash',        value: 'oklch(0.52 0.09 45 / 0.07)', label: 'Human wash',            usage: 'Warm background tint on human surfaces' },
    ],
  },
];

function ColorSection() {
  return (
    <SectionWrap id="color">
      <SectionHeader
        title="Color"
        description="All color values live in :root as CSS custom properties. Semantic tokens only — never raw Tailwind palette classes."
      />

      {/* Signature color — in-situ specimens */}
      <div className="mb-12">
        <SubLabel>Signature color — --primary · #187adc · oklch(0.580 0.172 253.7)</SubLabel>
        <div
          className="grid grid-cols-2 md:grid-cols-4 rounded-lg overflow-hidden"
          style={{ border: '1px solid var(--border)' }}
        >
          {/* CTA button */}
          <div
            className="flex flex-col gap-8 p-6 items-start justify-between"
            style={{ backgroundColor: 'var(--background)', borderRight: '1px solid var(--border)' }}
          >
            <button className="px-3.5 py-1.5 rounded text-sm font-medium" style={{ backgroundColor: 'var(--primary)', color: 'var(--primary-foreground)' }}>
              Allow access
            </button>
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>CTA button</span>
          </div>
          {/* Link */}
          <div
            className="flex flex-col gap-8 p-6 items-start justify-between"
            style={{ backgroundColor: 'var(--background)', borderRight: '1px solid var(--border)' }}
          >
            <span className="text-sm" style={{ color: 'var(--primary)', textDecoration: 'underline', textUnderlineOffset: '3px' }}>Read the spec →</span>
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Link</span>
          </div>
          {/* Focus ring */}
          <div
            className="flex flex-col gap-8 p-6 items-start justify-between"
            style={{ backgroundColor: 'var(--background)', borderRight: '1px solid var(--border)' }}
          >
            <input
              readOnly
              className="px-3 py-1.5 rounded text-xs"
              style={{ border: '1px solid var(--border)', outline: '2px solid var(--ring)', outlineOffset: '2px', backgroundColor: 'var(--background)', width: '80%' }}
              value="focused input"
            />
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Focus ring</span>
          </div>
          {/* Progress */}
          <div
            className="flex flex-col gap-8 p-6 items-start justify-between"
            style={{ backgroundColor: 'var(--background)' }}
          >
            <div className="w-full h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--muted)' }}>
              <div className="h-full w-3/5 rounded-full" style={{ backgroundColor: 'var(--primary)' }} />
            </div>
            <span className="font-mono text-[9px] uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Progress bar</span>
          </div>
        </div>
      </div>

      {/* Token table */}
      <div className="w-full overflow-x-auto" style={{ borderTop: '1px solid var(--border)' }}>
        <table className="w-full text-sm" style={{ tableLayout: 'fixed', minWidth: '480px' }}>
          <colgroup>
            <col style={{ width: '40px' }} />
            <col style={{ width: '180px' }} />
            <col style={{ width: '150px' }} />
            <col className="hidden md:table-column" style={{ width: '190px' }} />
            <col className="hidden md:table-column" />
          </colgroup>
          <thead>
            <tr style={{ borderBottom: '1px solid var(--border)' }}>
              {['', 'Token', 'Semantic label', 'OKLCH value', 'Usage'].map((h, i) => (
                <th
                  key={h}
                  className={`text-left py-3 pr-6 text-xs font-medium${i >= 3 ? ' hidden md:table-cell' : ''}`}
                  style={{ color: 'var(--muted-foreground)' }}
                >{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {COLOR_GROUPS.map(({ label, tokens }, gi) => (
              <React.Fragment key={label}>
                <tr style={{ borderTop: gi > 0 ? '1px solid var(--border)' : undefined }}>
                  <td colSpan={5} className="pt-6 pb-1.5">
                    <span className="font-mono text-[9px] font-semibold uppercase tracking-widest" style={{ color: 'var(--muted-foreground)', opacity: 0.55 }}>{label}</span>
                  </td>
                </tr>
                {tokens.map(({ token, value, label: l, usage }) => (
                  <tr key={token}>
                    <td className="py-2.5 pr-4 align-middle"><SwatchDot token={token} /></td>
                    <td className="py-2.5 pr-4 align-middle"><code className="font-mono text-xs">{token}</code></td>
                    <td className="py-2.5 pr-4 align-middle"><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{l}</span></td>
                    <td className="py-2.5 pr-4 align-middle hidden md:table-cell"><code className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{value}</code></td>
                    <td className="py-2.5 pr-4 align-middle hidden md:table-cell"><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{usage}</span></td>
                  </tr>
                ))}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-10">
        <RuleBlock>
          Never use raw Tailwind palette colors (<code className="font-mono text-xs">bg-green-500</code>, <code className="font-mono text-xs">text-blue-600</code>). Never hardcode hex values inline. If a semantic token doesn't exist for your use case, add it to :root and this page first.
        </RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 02 Typography ────────────────────────────────────────────────────────────

function TypographySection() {
  return (
    <SectionWrap id="typography">
      <SectionHeader
        title="Typography"
        description="Two typefaces. Geist for human-readable copy. JetBrains Mono for everything the protocol produces."
      />

      <div className="flex flex-col gap-14">
        {/* Geist Sans */}
        <div>
          <SubLabel>Geist Sans — interface copy</SubLabel>
          <div className="overflow-x-auto">
          <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'auto', minWidth: '300px' }}>
            <colgroup>
              <col style={{ width: '64px' }} />
              <col />
              <col style={{ width: '64px' }} />
              <col className="hidden md:table-column" style={{ width: '160px' }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['Role', 'Specimen', 'Spec', 'Usage'].map((h, i) => (
                  <th key={h} className={`text-left pb-2 text-xs font-medium${i === 3 ? ' hidden md:table-cell' : ''}`} style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { size: '2rem',    weight: 600, tracking: '-0.02em', label: 'display',  spec: '32/600',  sample: 'Personal Data',              usage: 'Page titles only' },
                { size: '1.25rem', weight: 600, tracking: '-0.01em', label: 'heading',  spec: '20/600',  sample: 'Grant request',              usage: 'Section headers' },
                { size: '0.875rem',weight: 600, tracking: '0',       label: 'title',    spec: '14/600',  sample: 'Audience Lens',              usage: 'Card titles, entity names' },
                { size: '0.875rem',weight: 400, tracking: '0',       label: 'body',     spec: '14/400',  sample: 'Requesting access to your Instagram social graph.', usage: 'Descriptions, prose' },
                { size: '0.75rem', weight: 500, tracking: '0',       label: 'label',    spec: '12/500',  sample: 'What they can access',       usage: 'Field labels, section labels' },
                { size: '0.75rem', weight: 400, tracking: '0',       label: 'caption',  spec: '12/400',  sample: 'No live scraping required.', usage: 'Helper text, footnotes' },
              ].map(({ size, weight, tracking, label, spec, sample, usage }) => (
                <tr key={label}>
                  <td className="py-3 pr-4" style={{ verticalAlign: 'baseline' }}><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{label}</span></td>
                  <td className="py-3 pr-4" style={{ verticalAlign: 'baseline', overflow: 'hidden', maxWidth: 0 }}><span style={{ fontSize: size, fontWeight: weight, letterSpacing: tracking, lineHeight: 1, display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{sample}</span></td>
                  <td className="py-3 pr-4" style={{ verticalAlign: 'baseline' }}><span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{spec}</span></td>
                  <td className="py-3 hidden md:table-cell" style={{ verticalAlign: 'baseline' }}><span className="text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>{usage}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        {/* JetBrains Mono */}
        <div>
          <SubLabel>JetBrains Mono — protocol data</SubLabel>
          <div
            className="grid gap-0 pb-2"
            style={{
              gridTemplateColumns: '72px 1fr',
              borderBottom: '1px solid var(--border)',
            }}
          >
            {['Role', 'Specimen'].map(h => (
              <span
                key={h}
                className="text-xs font-medium"
                style={{ color: 'var(--muted-foreground)' }}
              >{h}</span>
            ))}
          </div>
          {[
            { label: 'id',       sample: 'grt_8f3a2b1c4d5e6f7a8b9c0d1e2f3a4b5c',         usage: 'Grant IDs, resource identifiers',       color: 'var(--foreground)' },
            { label: 'code',     sample: 'following_accounts · social_graph · single_use', usage: 'Stream names, field names, enum values', color: 'var(--foreground)' },
            { label: 'spec-ref', sample: '§4.2 Selection Request · §6.1 Stream Metadata',  usage: 'Protocol spec citations only',           color: 'var(--edu-fg)' },
          ].map(({ label, sample, color }) => (
            <div
              key={label}
              className="grid gap-0 items-baseline py-3"
              style={{ gridTemplateColumns: '72px 1fr', borderBottom: '1px solid color-mix(in oklch, var(--border) 50%, transparent)' }}
            >
              <span className="text-xs pt-px" style={{ color: 'var(--muted-foreground)' }}>{label}</span>
              <span className="font-mono text-[13px] break-all" style={{ color }}>{sample}</span>
            </div>
          ))}
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>Mono signals "this came from the protocol, not a human." All IDs, stream names, field names, enum values, timestamps, and spec citations are mono. No arbitrary font sizes.</RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 03 Spacing ───────────────────────────────────────────────────────────────

function SpacingSection() {
  const steps = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24];
  return (
    <SectionWrap id="spacing">
      <SectionHeader
        title="Spacing"
        description="Standard Tailwind 4px base grid throughout. No arbitrary values."
      />

      <div className="flex items-end gap-4 flex-wrap mb-10 py-6">
        {steps.map(n => (
          <div key={n} className="flex flex-col items-center gap-2">
            <div
              className="rounded-sm"
              style={{
                width: `${n * 4}px`,
                height: `${n * 4}px`,
                backgroundColor: 'color-mix(in oklch, var(--primary) 18%, transparent)',
                border: '1px solid color-mix(in oklch, var(--primary) 30%, transparent)',
              }}
            />
            <div className="font-mono text-[9px] text-center leading-tight" style={{ color: 'var(--muted-foreground)' }}>
              {n}<br />{n * 4}px
            </div>
          </div>
        ))}
      </div>

      <div className="overflow-x-auto" style={{ borderTop: '1px solid var(--border)' }}>
      <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '360px' }}>
        <colgroup>
          <col style={{ width: '160px' }} />
          <col style={{ width: '110px' }} />
          <col />
        </colgroup>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            {['Pattern', 'Value', 'Usage'].map((h, i) => (
              <th key={h} className={`text-left pb-2 pt-3 pr-6 text-xs font-medium${i === 2 ? ' hidden md:table-cell' : ''}`} style={{ color: 'var(--muted-foreground)' }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {[
            { pattern: 'px-4 py-2',     value: '16px 8px',    usage: 'Panel headers, toolbar rows' },
            { pattern: 'p-4 / p-5',     value: '16px / 20px', usage: 'Card content, form sections' },
            { pattern: 'gap-2 / gap-3', value: '8px / 12px',  usage: 'Tight list items, inline groups' },
            { pattern: 'gap-6 / gap-8', value: '24px / 32px', usage: 'Section-level spacing' },
            { pattern: 'px-6 py-8',     value: '24px 32px',   usage: 'Stage / centered empty states' },
          ].map(({ pattern, value, usage }) => (
            <tr key={pattern}>
              <td className="py-3 pr-6" style={{ verticalAlign: 'baseline' }}><code className="font-mono text-xs">{pattern}</code></td>
              <td className="py-3 pr-6" style={{ verticalAlign: 'baseline' }}><span className="font-mono text-[11px] tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{value}</span></td>
              <td className="py-3 hidden md:table-cell" style={{ verticalAlign: 'baseline' }}><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{usage}</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      </div>

      <div className="mt-10">
        <RuleBlock>No arbitrary spacing values. If the Tailwind scale doesn't have it, question the design decision before introducing a custom value.</RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 04 Elevation ─────────────────────────────────────────────────────────────

const ELEVATION_LEVELS = [
  { level: 0, label: 'Flat',   shadow: 'none',                                                                                                                                desc: 'Page surface, rows, default panels' },
  { level: 1, label: 'Raised', shadow: '0 1px 2px rgba(0,0,0,0.04), 0 1px 3px rgba(0,0,0,0.02)',                                                                             desc: 'Cards, form fields' },
  { level: 2, label: 'Float',  shadow: '0 4px 6px rgba(0,0,0,0.04), 0 10px 15px rgba(0,0,0,0.08)',                                                                           desc: 'Dropdowns, command palette' },
  { level: 3, label: 'Modal',  shadow: '0 10px 15px rgba(0,0,0,0.05), 0 20px 25px rgba(0,0,0,0.10), 0 0 0 1px rgba(0,0,0,0.05)',                                             desc: 'Modals, overlays' },
];

function ElevationSection() {
  return (
    <SectionWrap id="elevation">
      <SectionHeader
        title="Elevation"
        description="Depth hierarchy through shadow and border. Four levels — most UI lives at 0 or 1."
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-12">
        {ELEVATION_LEVELS.map(({ level, label, shadow, desc }) => (
          <div key={level} className="flex flex-col gap-3">
            <div
              className="h-24 rounded-lg flex items-start p-3"
              style={{
                backgroundColor: 'var(--card)',
                border: '1px solid var(--border)',
                boxShadow: shadow,
              }}
            >
              <span className="font-mono text-xs font-medium leading-none" style={{ color: 'var(--muted-foreground)', opacity: 0.4 }}>{level}</span>
            </div>
            <div>
              <div className="text-sm font-medium">{label}</div>
              <div className="text-xs mt-0.5 leading-snug" style={{ color: 'var(--muted-foreground)' }}>{desc}</div>
            </div>
          </div>
        ))}
      </div>

      <RuleBlock>Most UI in this app is flat (level 0) with border differentiation. Reach for shadow only when a surface genuinely floats above its context.</RuleBlock>
    </SectionWrap>
  );
}

// ─── 05 Motion ────────────────────────────────────────────────────────────────

function MotionSection() {
  return (
    <SectionWrap id="motion">
      <SectionHeader
        title="Motion"
        description="Productive by default. Every animation must answer: does this help the user understand what just happened? If not, it doesn't animate."
      />

      <div className="flex flex-col gap-12">
        <div>
          <SubLabel>Duration tiers</SubLabel>
          <DurationDemo />
        </div>

        <div>
          <SubLabel>Easing curves</SubLabel>
          <EasingDemo />
        </div>

        <div>
          <SubLabel>Semantic aliases</SubLabel>
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {[
              { token: '--motion-enter',    composes: '300ms ease-enter',    usage: 'Modals, drawers, toasts arriving' },
              { token: '--motion-exit',     composes: '100ms ease-exit',     usage: 'Any element leaving — exits are faster than enters' },
              { token: '--motion-state',    composes: '200ms ease-standard', usage: 'Button hover, checkbox, toggle, tab switch' },
              { token: '--motion-feedback', composes: '100ms ease-spring',   usage: 'Success flash, error indication, confirm action' },
            ].map(({ token, composes, usage }) => (
              <div key={token} className="flex flex-col md:flex-row md:items-center gap-1 md:gap-6 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <code className="font-mono text-xs md:w-44 md:shrink-0">{token}</code>
                <span className="font-mono text-[11px] tabular-nums md:w-40 md:shrink-0" style={{ color: 'var(--muted-foreground)' }}>{composes}</span>
                <span className="text-xs md:flex-1 hidden md:block" style={{ color: 'var(--muted-foreground)' }}>{usage}</span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SubLabel>Stagger — choreographed list entry</SubLabel>
          <StaggerDemo />
        </div>

        <div>
          <SubLabel>Skeleton shimmer — loading state</SubLabel>
          <SkeletonDemo />
        </div>

        <div>
          <SubLabel>Reduced motion</SubLabel>
          <pre
            className="text-xs font-mono rounded-lg border p-5 leading-relaxed overflow-auto"
            style={{
              borderColor: 'var(--border)',
              backgroundColor: 'var(--muted)',
              color: 'var(--muted-foreground)',
            }}
          >{`@media (prefers-reduced-motion: reduce) {
  :root {
    --duration-fast:     0.01ms;
    --duration-base:     0.01ms;
    --duration-moderate: 0.01ms;
    --duration-slow:     0.01ms;
  }
}`}</pre>
          <p className="text-sm mt-3" style={{ color: 'var(--muted-foreground)' }}>One rule at <code className="font-mono text-xs">:root</code> covers the entire system. No per-component overrides needed.</p>
        </div>
      </div>

      <div className="mt-10">
        <RuleBlock>Only animate <code className="font-mono text-xs">transform</code> and <code className="font-mono text-xs">opacity</code> — GPU-composited properties only. Never animate <code className="font-mono text-xs">width</code>, <code className="font-mono text-xs">height</code>, or layout properties. Productive motion is the default; expressive motion is earned for meaningful moments.</RuleBlock>
      </div>
    </SectionWrap>
  );
}

function DurationDemo() {
  const [playing, setPlaying] = useState<string | null>(null);
  const tiers = [
    { name: 'fast',     ms: 100,  cssVar: '--duration-fast' },
    { name: 'base',     ms: 200,  cssVar: '--duration-base' },
    { name: 'moderate', ms: 300,  cssVar: '--duration-moderate' },
    { name: 'slow',     ms: 500,  cssVar: '--duration-slow' },
  ];

  const play = (name: string, ms: number) => {
    setPlaying(null);
    requestAnimationFrame(() => {
      setPlaying(name);
      setTimeout(() => setPlaying(p => p === name ? null : p), ms + 100);
    });
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {tiers.map(({ name, ms, cssVar }) => (
        <div key={name} className="flex items-center gap-4 md:gap-6 py-3">
          <code className="font-mono text-xs w-36 md:w-44 shrink-0">{cssVar}</code>
          <span className="font-mono text-[11px] w-12 shrink-0 tabular-nums" style={{ color: 'var(--muted-foreground)' }}>{ms}ms</span>
          <div className="flex-1 relative h-1 rounded-full overflow-hidden" style={{ backgroundColor: 'var(--muted)' }}>
            <div
              className="absolute left-0 top-0 h-full rounded-full"
              style={{
                width: playing === name ? '100%' : '0%',
                backgroundColor: 'var(--primary)',
                transitionProperty: playing === name ? 'width' : 'none',
                transitionDuration: playing === name ? `${ms}ms` : '0ms',
                transitionTimingFunction: 'var(--ease-standard)',
              }}
            />
          </div>
          <Button size="xs" variant="outline" onClick={() => play(name, ms)} className="shrink-0 w-14">Play</Button>
        </div>
      ))}
    </div>
  );
}

function EasingDemo() {
  const [active, setActive] = useState<string | null>(null);
  const curves = [
    { name: 'enter',    cssVar: '--ease-enter',    desc: 'Decelerate — arrivals' },
    { name: 'exit',     cssVar: '--ease-exit',     desc: 'Accelerate — departures' },
    { name: 'standard', cssVar: '--ease-standard', desc: 'Full arc — state changes' },
    { name: 'spring',   cssVar: '--ease-spring',   desc: 'Overshoot — feedback' },
  ];

  const play = (name: string) => {
    setActive(null);
    requestAnimationFrame(() => requestAnimationFrame(() => setActive(name)));
  };

  return (
    <div style={{ borderTop: '1px solid var(--border)' }}>
      {curves.map(({ name, cssVar }) => (
        <div key={name} className="flex items-center gap-3 py-3">
          <code className="font-mono text-xs w-36 shrink-0">{cssVar}</code>
          <div className="flex-1 min-w-0 relative h-5 rounded overflow-hidden" style={{ backgroundColor: 'var(--muted)' }}>
            <div
              className="absolute top-0.5 h-4 w-8 rounded-sm"
              style={{
                left: active === name ? 'calc(100% - 2.25rem)' : '4px',
                backgroundColor: 'var(--primary)',
                transitionProperty: active === name ? 'left' : 'none',
                transitionDuration: active === name ? '400ms' : '0ms',
                transitionTimingFunction: active === name ? `var(${cssVar})` : 'linear',
              }}
            />
          </div>
          <Button size="xs" variant="outline" onClick={() => play(name)} className="shrink-0 w-14">Play</Button>
        </div>
      ))}
    </div>
  );
}

function StaggerDemo() {
  const [phase, setPhase] = useState<'resting' | 'reset' | 'playing'>('resting');
  const items = ['purpose_binding', 'field_projection', 'stream_isolation', 'temporal_gating', 'single_use_expiry'];

  const play = () => {
    setPhase('reset');
    requestAnimationFrame(() => requestAnimationFrame(() => setPhase('playing')));
  };

  const visible = phase === 'resting' || phase === 'playing';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 p-5 rounded-lg" style={{ border: '1px solid var(--border)' }}>
        {items.map((item, i) => (
          <div
            key={item}
            className="flex items-center gap-2.5 px-3 py-2 rounded"
            style={{
              backgroundColor: 'var(--card)',
              border: '1px solid var(--border)',
              opacity: visible ? 1 : 0,
              transform: visible ? 'translateY(0)' : 'translateY(6px)',
              transitionProperty: phase === 'playing' ? 'opacity, transform' : 'none',
              transitionDuration: 'var(--duration-moderate)',
              transitionTimingFunction: 'var(--ease-enter)',
              transitionDelay: phase === 'playing' ? `${i * 50}ms` : '0ms',
            }}
          >
            <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>✓</span>
            <span className="font-mono text-xs">{item}</span>
          </div>
        ))}
      </div>
      <div className="flex items-center gap-4">
        <Button size="xs" variant="outline" onClick={play}>Play stagger</Button>
        <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>50ms delay per item · <code className="font-mono">--stagger-base</code></span>
      </div>
    </div>
  );
}

function SkeletonDemo() {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2.5 p-5 rounded-lg border" style={{ borderColor: 'var(--border)', backgroundColor: 'var(--card)' }}>
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded shimmer-bone" />
          <div className="flex flex-col gap-1.5 flex-1">
            <div className="h-3 rounded shimmer-bone" style={{ width: '40%' }} />
            <div className="h-2.5 rounded shimmer-bone" style={{ width: '60%' }} />
          </div>
        </div>
        <div className="h-2.5 rounded shimmer-bone" />
        <div className="h-2.5 rounded shimmer-bone" style={{ width: '75%' }} />
      </div>
      <p className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
        Used for loading states where content shape is known. Shimmer moves left-to-right at <code className="font-mono">1.5s</code>.
      </p>
      <style>{`
        .shimmer-bone {
          position: relative;
          overflow: hidden;
          background-color: var(--muted);
        }
        .shimmer-bone::after {
          content: '';
          position: absolute;
          inset: 0;
          background: linear-gradient(90deg, transparent 0%, oklch(1 0 0 / 0.55) 50%, transparent 100%);
          animation: shimmer-sweep 1.5s ease-in-out infinite;
        }
        @keyframes shimmer-sweep {
          from { transform: translateX(-100%); }
          to   { transform: translateX(200%); }
        }
      `}</style>
    </div>
  );
}

// ─── 06 Surfaces ─────────────────────────────────────────────────────────────

function SurfacesSection() {
  return (
    <SectionWrap id="surfaces">
      <SectionHeader
        title="Surfaces"
        description="Semantic HTML attributes that encode what a surface is. CSS derives the visual from the attribute — never the reverse."
      />

      <div className="flex flex-col gap-14">

        {/* Stage */}
        <div>
          <SubLabel>data-surface="stage" — neutral surround</SubLabel>
          <p className="text-xs leading-relaxed mb-6" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            Frames an independent thing — a browser viewport, phone, or device that operates outside the app's own UI. Muted background + radial dot grid.
          </p>
          <div data-surface="stage" className="rounded-xl p-12 flex items-center justify-center" style={{ border: '1px solid var(--border)' }}>
            <Card className="w-64">
              <CardContent className="p-5 text-center flex flex-col gap-2">
                <div className="text-sm font-medium">Staged content</div>
                <div className="text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>A browser, phone, or device frame that operates independently of the surrounding UI.</div>
              </CardContent>
            </Card>
          </div>
        </div>

        {/* Human / Protocol duality */}
        <div>
          <SubLabel>Surface temperature — human vs protocol</SubLabel>
          <p className="text-xs leading-relaxed mb-6" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            Every surface belongs to a person or to the protocol. The visual language makes this legible at a glance. The consent card is the highest-stakes moment — both signals appear simultaneously.
          </p>

          {/* Side-by-side: human row + protocol row */}
          <div className="flex flex-col gap-2 mb-8" style={{ maxWidth: '480px' }}>
            {/* Human row */}
            <div
              style={{
                borderLeft: '1px solid var(--human)',
                background: 'linear-gradient(to right, var(--human-wash), transparent 70%)',
                paddingLeft: '14px',
                paddingTop: '10px',
                paddingBottom: '10px',
              }}
            >
              <div className="text-sm font-medium">the owner Nunamaker</div>
              <div className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)', marginTop: '2px' }}>instagram.com/the owner · owner</div>
            </div>
            {/* Protocol row */}
            <div
              style={{
                borderLeft: '2px solid var(--primary)',
                background: 'linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 70%)',
                paddingLeft: '14px',
                paddingTop: '10px',
                paddingBottom: '10px',
              }}
            >
              <div className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>grt_8f3a2b1c · single_use · §4.2</div>
              <div className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)', opacity: 0.55, marginTop: '2px' }}>expires 24h · PDPP v0.1.0</div>
            </div>
          </div>

          {/* Token reference */}
          <div style={{ borderTop: '1px solid var(--border)' }}>
            {[
              { attr: '--human',      value: 'oklch(0.52 0.09 45)',         desc: '2px left border on human surfaces (identity, ownership, consent)' },
              { attr: '--human-wash', value: 'oklch(0.52 0.09 45 / 0.07)', desc: 'Gradient wash tint — linear-gradient to right, fades to transparent' },
              { attr: '--primary',    value: 'oklch(0.580 0.172 253.7)',    desc: '2px left border on protocol surfaces (tokens, grants, spec data)' },
            ].map(({ attr, value, desc }) => (
              <div key={attr} className="flex flex-col md:flex-row md:items-baseline gap-0.5 md:gap-6 py-3" style={{ borderBottom: '1px solid var(--border)' }}>
                <code className="font-mono text-xs md:w-36 md:shrink-0">{attr}</code>
                <code className="font-mono text-[11px] tabular-nums md:w-52 md:shrink-0" style={{ color: 'var(--muted-foreground)' }}>{value}</code>
                <span className="text-xs md:flex-1 hidden md:block" style={{ color: 'var(--muted-foreground)' }}>{desc}</span>
              </div>
            ))}
          </div>

          {/* Consent card — duality in its most important context */}
          <div className="mt-8">
            <div className="font-mono text-[9px] uppercase tracking-widest mb-4" style={{ color: 'var(--muted-foreground)', opacity: 0.55 }}>Consent card — both temperatures present</div>
            <div style={{ maxWidth: '320px' }}>
              <Card>
                <CardHeader className="p-4 pb-0">
                  {/* Human row inside the card */}
                  <div
                    style={{
                      borderLeft: '1px solid var(--human)',
                      background: 'linear-gradient(to right, var(--human-wash), transparent 70%)',
                      paddingLeft: '10px',
                      paddingTop: '8px',
                      paddingBottom: '8px',
                      marginBottom: '2px',
                    }}
                  >
                    <div className="text-sm font-medium">the owner Nunamaker</div>
                    <div className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)', marginTop: '1px' }}>instagram.com/the owner · owner</div>
                  </div>
                  {/* Protocol row inside the card */}
                  <div
                    style={{
                      borderLeft: '2px solid var(--primary)',
                      background: 'linear-gradient(to right, oklch(0.580 0.172 253.7 / 0.04), transparent 70%)',
                      paddingLeft: '10px',
                      paddingTop: '8px',
                      paddingBottom: '8px',
                    }}
                  >
                    <div className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)' }}>grt_8f3a2b1c · single_use · §4.2</div>
                    <div className="font-mono text-[10px]" style={{ color: 'var(--muted-foreground)', opacity: 0.55, marginTop: '1px' }}>expires 24h · PDPP v0.1.0</div>
                  </div>
                </CardHeader>
                <CardContent className="px-5 pt-3 pb-5">
                  <div className="text-xs font-medium mb-1">Audience Lens</div>
                  <div className="text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>Access to your Instagram social graph. No live scraping required.</div>
                </CardContent>
                <CardFooter className="px-5 py-4 gap-3" style={{ borderTop: '1px solid var(--border)' }}>
                  <Button size="sm">Allow</Button>
                  <Button size="sm" variant="ghost">Deny</Button>
                </CardFooter>
              </Card>
            </div>
          </div>
        </div>

      </div>

      <div className="mt-10">
        <RuleBlock>Before styling any surface: "whose is this?" Person → <code className="font-mono text-xs">--human</code>. System → <code className="font-mono text-xs">--primary</code>. Neither → neutral (no temperature signal).</RuleBlock>
      </div>
    </SectionWrap>
  );
}

// ─── 07 Components ───────────────────────────────────────────────────────────

function ComponentsSection() {
  return (
    <SectionWrap id="components">
      <SectionHeader
        title="Components"
        description="shadcn base-nova on Base UI primitives. Own the source — extend directly, never wrap."
      />

      <div className="flex flex-col gap-12">
        {/* Buttons */}
        <div>
          <SubLabel>Button — all variants</SubLabel>
          <div
            className="rounded-lg overflow-hidden"
            style={{ border: '1px solid var(--border)' }}
          >
            <div className="flex flex-col gap-0">
              <div className="flex items-center gap-2 px-5 py-4" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="font-mono text-[9px] uppercase tracking-widest w-16 shrink-0" style={{ color: 'var(--muted-foreground)', opacity: 0.55 }}>Variants</span>
                <div className="flex flex-wrap gap-2 items-center">
                  <Button>Default</Button>
                  <Button variant="secondary">Secondary</Button>
                  <Button variant="outline">Outline</Button>
                  <Button variant="ghost">Ghost</Button>
                  <Button variant="destructive">Destructive</Button>
                  <Button disabled>Disabled</Button>
                </div>
              </div>
              <div className="flex items-center gap-2 px-5 py-4">
                <span className="font-mono text-[9px] uppercase tracking-widest w-16 shrink-0" style={{ color: 'var(--muted-foreground)', opacity: 0.55 }}>Sizes</span>
                <div className="flex flex-wrap gap-2 items-center">
                  <Button size="lg">Large</Button>
                  <Button>Default</Button>
                  <Button size="sm">Small</Button>
                  <Button size="xs">XS</Button>
                  <Button size="icon">P</Button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Badges */}
        <div>
          <SubLabel>Badge — all variants</SubLabel>
          <div
            className="flex flex-wrap gap-3 px-5 py-4 rounded-lg"
            style={{ border: '1px solid var(--border)' }}
          >
            <Badge>Default</Badge>
            <Badge variant="secondary">Secondary</Badge>
            <Badge variant="outline">Outline</Badge>
            <Badge variant="destructive">Destructive</Badge>
          </div>
        </div>

        {/* Cards */}
        <div>
          <SubLabel>Card — anatomy and states</SubLabel>
          {/* Full card — anatomy specimen */}
          <div className="mb-4" style={{ maxWidth: '340px' }}>
            <Card>
              <CardHeader className="p-5 pb-3">
                <div className="text-sm font-semibold">Grant request</div>
                <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>Audience Lens · single_use</div>
              </CardHeader>
              <CardContent className="px-5 pb-5 pt-0">
                <div className="text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>Requesting access to your Instagram social graph. No live scraping required.</div>
              </CardContent>
              <CardFooter className="px-5 py-4 gap-3" style={{ borderTop: '1px solid var(--border)' }}>
                <Button size="sm">Allow</Button>
                <Button size="sm" variant="ghost">Deny</Button>
              </CardFooter>
            </Card>
          </div>
          {/* States row */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <Card size="sm">
                <CardContent className="p-3">
                  <div className="text-xs font-medium">Default</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Dense data, inline items.</div>
                </CardContent>
              </Card>
              <div className="font-mono text-[9px] mt-1.5 px-0.5" style={{ color: 'var(--muted-foreground)' }}>size="sm"</div>
            </div>
            <div>
              <Card size="sm" className="border-primary/25">
                <CardContent className="p-3">
                  <div className="text-xs font-medium text-primary">Highlighted</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)' }}>Active selection.</div>
                </CardContent>
              </Card>
              <div className="font-mono text-[9px] mt-1.5 px-0.5" style={{ color: 'var(--muted-foreground)' }}>border-primary/25</div>
            </div>
            <div>
              <Card size="sm" style={{ backgroundColor: 'var(--muted)', borderColor: 'var(--border)' }}>
                <CardContent className="p-3">
                  <div className="text-xs font-medium" style={{ color: 'var(--muted-foreground)' }}>Disabled</div>
                  <div className="text-xs mt-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Not interactive.</div>
                </CardContent>
              </Card>
              <div className="font-mono text-[9px] mt-1.5 px-0.5" style={{ color: 'var(--muted-foreground)' }}>bg-muted + muted-foreground text</div>
            </div>
          </div>
        </div>

        {/* Consent Card */}
        <div>
          <SubLabel>Consent card — anatomy</SubLabel>
          <p className="text-xs mb-6 leading-relaxed" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            The highest-stakes surface in the protocol. A client app is asking the person
            to share specific streams from their personal server. Both human and protocol
            signals must be present and legible simultaneously.
          </p>
          <SpecimenSwitcher
            specimens={CONSENT_SPECIMENS}
            render={(data) => <ConsentCard key={JSON.stringify(data.requester)} {...data} />}
          />
        </div>

        {/* Grant Inspector */}
        <div>
          <SubLabel>Grant inspector — anatomy</SubLabel>
          <p className="text-xs mb-6 leading-relaxed" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            The receipt of a consent decision. Shows what was authorized, by whom,
            and the grant's current lifecycle state. Protocol surface, all content
            is server-authoritative.
          </p>
          <SpecimenSwitcher
            specimens={GRANT_SPECIMENS}
            render={(data) => <GrantInspector key={data.grantId} {...data} onRevoke={() => {}} />}
          />
        </div>

        {/* Stream Inventory */}
        <div>
          <SubLabel>Stream inventory</SubLabel>
          <p className="text-xs mb-6 leading-relaxed" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
            What data your personal server holds. Manifest-derived, showing each
            connector's streams with record counts and sync status. The foundation
            users see before any consent decision.
          </p>
          <SpecimenSwitcher
            specimens={INVENTORY_SPECIMENS}
            render={(data) => <StreamInventory key={data.connectorName} {...data} />}
          />
        </div>
      </div>
    </SectionWrap>
  );
}

// ─── Consent Card ─────────────────────────────────────────────────────────────

// Props contract — provenance of each field (see spec §5 Client Display, Client Claims, §7 Stream Display):
//
// FROM client_display (entity-scoped, self-asserted):
//   requester.name, requester.monogram (server may override)
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

type ConsentCardStream = {
  key: string;
  label: string;            // manifest display.label — server-trusted
  detail: string;           // manifest display.detail — server-trusted
};

type ConsentCardOptional = {
  key: string;
  label: string;            // manifest display.label — server-trusted
  detail: string;           // manifest display.detail — server-trusted
  consequenceOn: string;    // server-generated generic copy in v0.1
  consequenceOff: string;   // server-generated generic copy in v0.1
};

type ConsentCardProps = {
  requester: {
    name: string;           // client_display.name
    monogram: string;       // server-derived from name, or client-suggested
    verified: boolean;      // server-determined, never client-asserted
  };
  purpose: string;                          // purpose_description — client-authored, first-class
  commitments: string[];                    // client_claims.commitments — attributed, disclaimed
  streams: ConsentCardStream[];             // required streams
  optional?: ConsentCardOptional;           // at most one optional stream (simplification for now)
  accessMode: 'continuous' | 'single_use';  // grant.access_mode — protocol fact
  technical: {
    clientId: string;                       // grant.client.client_id
    purposeCode: string;                    // grant.purpose_code
    grantExpires: string;                   // grant.expires_at — server-formatted
  };
  onAllow?: () => void;
  onDeny?: () => void;
};

function ConsentCard({
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
  const [decided, setDecided] = React.useState<'approved' | 'denied' | null>(null);
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});
  const [techExpanded, setTechExpanded] = React.useState(false);
  const toggleExpand = (key: string) => setExpanded(v => ({ ...v, [key]: !v[key] }));

  const accessLabel = accessMode === 'continuous'
    ? 'Ongoing access, active until you revoke it. Your server enforces this.'
    : 'One-time access. Your server will not allow further queries.';

  if (decided) {
    return (
      <div style={{ maxWidth: '440px' }}>
        <div
          className="rounded-xl px-6 py-8 flex flex-col items-center gap-3 text-center"
          style={{ border: '1px solid var(--border)', backgroundColor: 'var(--card)' }}
        >
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
            style={{
              backgroundColor: decided === 'approved' ? 'var(--success)' : 'var(--muted)',
              color: decided === 'approved' ? 'white' : 'var(--muted-foreground)',
            }}
          >
            {decided === 'approved' ? '✓' : '×'}
          </div>
          <div className="text-sm font-medium">{decided === 'approved' ? 'Access granted' : 'Access denied'}</div>
          <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {decided === 'approved'
              ? `${requester.name} may now query your personal server. You can revoke this any time from your server dashboard.`
              : `No grant was issued. ${requester.name} cannot access your data.`}
          </div>
        </div>
        <button
          className="font-mono text-xs mt-2 px-0.5"
          style={{ color: 'var(--muted-foreground)' }}
          onClick={() => setDecided(null)}
        >
          ↺ reset
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '440px' }}>
      <div data-surface="human" className="rounded-xl overflow-hidden">

        {/* ── Identity + purpose ── */}
        <div className="px-5 pt-5 pb-4">
          <div className="flex items-start gap-3">
            <div
              className="w-9 h-9 rounded-lg shrink-0 flex items-center justify-center"
              style={{ backgroundColor: 'var(--human)', color: 'white' }}
            >
              <span className="text-xs font-bold font-mono">{requester.monogram}</span>
            </div>
            <div className="flex-1 min-w-0 pt-0.5">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="text-sm font-semibold" style={{ color: 'var(--foreground)' }}>{requester.name}</span>
                {requester.verified ? (
                  <span
                    className="font-mono text-xs px-1.5 py-0.5 rounded uppercase tracking-wide"
                    style={{ backgroundColor: 'oklch(0.52 0.15 150 / 0.1)', color: 'var(--success)' }}
                  >
                    verified
                  </span>
                ) : (
                  <span
                    className="font-mono text-xs px-1.5 py-0.5 rounded uppercase tracking-wide"
                    style={{ backgroundColor: 'oklch(0.62 0.15 70 / 0.1)', color: 'var(--warning)' }}
                  >
                    unverified
                  </span>
                )}
              </div>
            </div>
          </div>

          <p className="text-sm leading-relaxed mt-4" style={{ color: 'var(--foreground)' }}>
            {purpose}
          </p>

          {/* AI training warning — spec §5 requires explicit affirmative consent */}
          {technical.purposeCode === 'ai_training' && (
            <div
              className="mt-3 rounded-lg px-3 py-2.5 text-xs"
              style={{ backgroundColor: 'oklch(0.55 0.20 27 / 0.08)', border: '1px solid oklch(0.55 0.20 27 / 0.2)', color: 'var(--destructive)' }}
            >
              This app wants to use your data for AI model training. This requires your explicit consent.
            </div>
          )}

          {/* Client commitments — scannable list, visually attributed */}
          {commitments.length > 0 && (
            <div className="mt-3 text-xs leading-relaxed" style={{ color: 'var(--muted-foreground)' }}>
              <div style={{ color: 'var(--foreground)' }} className="mb-1">{requester.name} says:</div>
              <div className="flex flex-col gap-0.5 pl-3" style={{ borderLeft: '2px solid oklch(0.52 0.09 45 / 0.35)' }}>
                {commitments.map(c => <span key={c}>{c}</span>)}
              </div>
              <div className="mt-1.5 italic" style={{ opacity: 0.7 }}>
                These are their commitments, not enforced by your server.
              </div>
            </div>
          )}

          {/* Technical details — pull-to-reveal */}
          <button
            className="text-xs mt-3 flex items-center gap-1"
            style={{ color: 'var(--muted-foreground)' }}
            onClick={() => setTechExpanded(v => !v)}
          >
            <span
              className="text-xs inline-block"
              style={{
                transform: techExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform 150ms',
              }}
            >&#x203A;</span>
            Technical details
          </button>
          {techExpanded && (
            <div className="mt-1.5 border-l-2 pl-3 flex flex-col gap-0.5" style={{ borderColor: 'oklch(0.580 0.172 253.7 / 0.25)' }}>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <span style={{ opacity: 0.6 }}>Client ID: </span>{technical.clientId}
              </div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <span style={{ opacity: 0.6 }}>Purpose: </span>
                <span style={{ color: 'var(--edu-fg)' }}>{technical.purposeCode}</span>
              </div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                <span style={{ opacity: 0.6 }}>Grant expires: </span>{technical.grantExpires}
              </div>
            </div>
          )}
        </div>

        {/* ── Data being shared ── */}
        <div className="px-5 pb-1" style={{ borderTop: '1px solid var(--border)' }}>
          {streams.map(({ key, label, detail }) => (
            <div key={key} style={{ borderBottom: '1px solid var(--border)' }}>
              <button
                className="w-full flex items-center justify-between gap-2 py-2.5 text-left"
                onClick={() => toggleExpand(key)}
                aria-expanded={!!expanded[key]}
              >
                <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{label}</span>
                <span
                  className="text-xs shrink-0"
                  style={{
                    color: 'var(--muted-foreground)',
                    display: 'inline-block',
                    transform: expanded[key] ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 150ms',
                  }}
                >&#x203A;</span>
              </button>
              {expanded[key] && (
                <div className="text-xs pb-2.5 pl-3" style={{ color: 'var(--muted-foreground)' }}>
                  {detail}
                </div>
              )}
            </div>
          ))}

          {/* Optional stream — toggle distinguishes it from required */}
          {optional && (
            <div style={{ borderBottom: '1px solid var(--border)' }}>
              <div className="flex items-center gap-3 py-2.5">
                <button
                  onClick={() => setOptionalEnabled(v => !v)}
                  className="w-7 h-4 rounded-full shrink-0 relative"
                  style={{
                    backgroundColor: optionalEnabled ? 'var(--primary)' : 'var(--border)',
                    transition: 'background-color var(--motion-state)',
                  }}
                  aria-label={optionalEnabled ? `Disable ${optional.label}` : `Enable ${optional.label}`}
                >
                  <span
                    className="absolute top-0.5 w-3 h-3 rounded-full"
                    style={{
                      backgroundColor: 'white',
                      left: '2px',
                      transform: optionalEnabled ? 'translateX(12px)' : 'translateX(0)',
                      transition: 'transform var(--motion-state)',
                    }}
                  />
                </button>
                <button
                  className="flex-1 flex items-center justify-between gap-2 text-left min-w-0"
                  onClick={() => toggleExpand(optional.key)}
                  aria-expanded={!!expanded[optional.key]}
                >
                  <span className="text-xs font-medium" style={{ color: 'var(--foreground)', opacity: optionalEnabled ? 1 : 0.5 }}>
                    {optional.label}
                    <span className="font-normal ml-1.5" style={{ color: 'var(--muted-foreground)' }}>optional</span>
                  </span>
                  <span
                    className="text-xs shrink-0"
                    style={{
                      color: 'var(--muted-foreground)',
                      display: 'inline-block',
                      transform: expanded[optional.key] ? 'rotate(90deg)' : 'rotate(0deg)',
                      transition: 'transform 150ms',
                      opacity: optionalEnabled ? 1 : 0.5,
                    }}
                  >&#x203A;</span>
                </button>
              </div>
              {expanded[optional.key] && (
                <div className="text-xs pl-10 mb-2" style={{ color: 'var(--muted-foreground)', opacity: optionalEnabled ? 1 : 0.4 }}>
                  {optional.detail}
                </div>
              )}
              <div className="text-xs pb-2.5 pl-10" style={{ color: 'var(--muted-foreground)' }}>
                {optionalEnabled ? optional.consequenceOn : optional.consequenceOff}
              </div>
            </div>
          )}
        </div>

        {/* ── Access duration ── */}
        <div className="px-5 py-3 flex items-start gap-2">
          <div className="w-1.5 h-1.5 rounded-full shrink-0 mt-1" style={{ backgroundColor: accessMode === 'continuous' ? 'var(--warning)' : 'var(--success)' }} />
          <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
            {accessLabel}
          </div>
        </div>

        {/* ── Actions ── */}
        <div className="px-5 pt-1 pb-5">
          <div className="flex items-center gap-3">
            <Button
              variant="outline"
              className="flex-1"
              style={{ borderColor: 'var(--primary)', color: 'var(--primary)' }}
              onClick={() => { setDecided('approved'); onAllow?.(); }}
            >
              Allow access
            </Button>
            <Button
              variant="outline"
              className="flex-1"
              onClick={() => { setDecided('denied'); onDeny?.(); }}
            >
              Deny
            </Button>
          </div>
        </div>

      </div>
    </div>
  );
}

// ─── Specimen switcher ───────────────────────────────────────────────────────

function SpecimenSwitcher<T>({
  specimens,
  render,
}: {
  specimens: { label: string; axes: string; data: T }[];
  render: (data: T) => React.ReactNode;
}) {
  const [active, setActive] = React.useState(0);
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-4">
        {specimens.map((s, i) => (
          <button
            key={s.label}
            className="text-xs px-2 py-1 rounded transition-colors"
            style={{
              backgroundColor: i === active ? 'var(--foreground)' : 'var(--muted)',
              color: i === active ? 'var(--background)' : 'var(--muted-foreground)',
            }}
            onClick={() => setActive(i)}
          >
            {s.label}
          </button>
        ))}
      </div>
      <div className="text-xs mb-4 font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
        Axes: {specimens[active].axes}
      </div>
      {render(specimens[active].data)}
    </div>
  );
}

// ─── Consent Card specimens ─────────────────────────────────────────────────
// Coverage: all 18 ConsentCard axes across 6 specimens

const CONSENT_SPECIMENS: { label: string; axes: string; data: ConsentCardProps }[] = [
  {
    // Axes: 1=continuous, 2=research, 4=delete, 5=present, 6=date, 7=mixed, 13=verified, 15=present, 16=present, 17=multiple
    label: 'Research (baseline)',
    axes: 'continuous, research, verified, retention:delete, expiry, optional stream, commitments',
    data: {
      requester: { name: 'Audience Lens', monogram: 'AL', verified: true },
      purpose: 'Audience Lens is requesting access to your Instagram data for an influencer network study.',
      commitments: [
        'Data used only for this study',
        'Not sold or shared with third parties',
      ],
      streams: [
        { key: 'following', label: 'Who you follow', detail: 'Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists.' },
        { key: 'posts', label: 'Your posts', detail: 'Post captions, dates, and media types since Dec 31, 2024. No comments, likes, or private messages.' },
      ],
      optional: {
        key: 'ad_targeting',
        label: 'Ad interest categories',
        detail: 'Ad categories, sources, and confidence scores. No browsing history or purchase data.',
        consequenceOn: 'Improves study accuracy. Not required for the grant.',
        consequenceOff: 'Turned off. The rest of the grant is unaffected.',
      },
      accessMode: 'continuous',
      technical: { clientId: 'audience_lens_v1', purposeCode: 'research', grantExpires: 'Apr 5, 2027' },
    },
  },
  {
    // Axes: 1=single_use, 2=personalization, 6=null(no expiry), 7=all required, 8=time_range, 15=absent, 17=single stream
    label: 'Single use, no expiry',
    axes: 'single_use, personalization, no expiry, no optional, time_range, no commitments, single stream',
    data: {
      requester: { name: 'Concert Finder', monogram: 'CF', verified: true },
      purpose: 'Concert Finder wants your top artists to recommend upcoming shows near you.',
      commitments: [],
      streams: [
        { key: 'top_artists', label: 'Your top artists', detail: 'Artist names, genres, and popularity scores from the last 6 months. No listening timestamps or play counts.' },
      ],
      accessMode: 'single_use',
      technical: { clientId: 'concert_finder', purposeCode: 'personalization', grantExpires: 'No expiry' },
    },
  },
  {
    // Axes: 2=ai_training(#3), 4=anonymize, 12=present, 13=unverified, 14=logo suppressed
    label: 'AI training, unverified',
    axes: 'ai_training (explicit consent), unverified client, retention:anonymize, continuous',
    data: {
      requester: { name: 'DataCo ML Pipeline', monogram: 'DC', verified: false },
      purpose: 'DataCo ML Pipeline wants to use your social media data to train recommendation models.',
      commitments: [
        'Model weights only, raw data not retained',
      ],
      streams: [
        { key: 'posts', label: 'Your posts', detail: 'Post captions, dates, and engagement metrics. No private messages or stories.' },
        { key: 'following', label: 'Who you follow', detail: 'Account IDs and usernames. No DMs or profile details.' },
      ],
      accessMode: 'continuous',
      technical: { clientId: 'dataco_ml_v2', purposeCode: 'ai_training', grantExpires: 'Jan 1, 2028' },
    },
  },
  {
    // Axes: 2=export, 4=absent(no retention), 5=absent, 15=absent, 16=absent(no purpose_description)
    label: 'Self-export, minimal',
    axes: 'export, single_use, no retention, no commitments, no purpose_description fallback',
    data: {
      requester: { name: 'PDPP Export Tool', monogram: 'PE', verified: true },
      purpose: 'Export your data for personal use.',
      commitments: [],
      streams: [
        { key: 'following', label: 'Who you follow', detail: 'Complete following list with account IDs and usernames.' },
        { key: 'posts', label: 'Your posts', detail: 'All post data including captions, dates, media types, and locations.' },
        { key: 'ad_targeting', label: 'Ad interest categories', detail: 'Full ad targeting profile with categories, sources, and confidence scores.' },
      ],
      accessMode: 'single_use',
      technical: { clientId: 'pdpp_export', purposeCode: 'export', grantExpires: '24 hours' },
    },
  },
  {
    // Axes: 2=agent_context, 1=continuous, 6=null, 17=single, 12=absent(client_display missing, fall back to client_id)
    label: 'AI agent, no display',
    axes: 'agent_context, continuous, no expiry, no client_display (client_id fallback)',
    data: {
      requester: { name: 'agt_personal_v3', monogram: 'AG', verified: false },
      purpose: 'Requesting ongoing access to provide personalized context to your AI agent.',
      commitments: [
        'Data processed locally, never sent to external servers',
      ],
      streams: [
        { key: 'messages', label: 'Your messages', detail: 'Message content, timestamps, and participants. Includes DMs.' },
      ],
      accessMode: 'continuous',
      technical: { clientId: 'agt_personal_v3', purposeCode: 'agent_context', grantExpires: 'No expiry' },
    },
  },
  {
    // Axes: 2=analytics, 8=since+until, 18=profile used
    label: 'Analytics, time-bounded',
    axes: 'analytics, single_use, time_range with since+until, profile-based',
    data: {
      requester: { name: 'Sleep Insights', monogram: 'SI', verified: true },
      purpose: 'Sleep Insights wants to analyze your sleep data from Q1 2026 to identify patterns.',
      commitments: [
        'Analysis results shared back with you',
        'Raw data deleted after analysis completes',
      ],
      streams: [
        { key: 'sleep_sessions', label: 'Sleep sessions', detail: 'Sleep duration, scores, and stage breakdowns for Jan-Mar 2026. No heart rate or HRV data.' },
      ],
      accessMode: 'single_use',
      technical: { clientId: 'sleep_insights_v1', purposeCode: 'analytics', grantExpires: '7 days' },
    },
  },
];

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

type GrantStream = {
  name: string;
  label: string;              // manifest display.label
  detail?: string;            // manifest display.detail
  fields?: string[];          // granted field allowlist, absent = all
  view?: string;              // informational — which view was selected
  timeRange?: { since?: string; until?: string };
};

type GrantInspectorProps = {
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

function GrantInspector({
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
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Issued</div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{issuedAt}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Expires</div>
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{expiresAt ?? 'Never'}</div>
            </div>
            <div>
              <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Access</div>
              <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{accessModeLabel}</div>
            </div>
            {retention && (
              <div>
                <div className="text-xs mb-0.5" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>Retention</div>
                <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                  {retention.onExpiry === 'delete' ? 'Deleted' : 'Anonymized'} after {retention.duration}
                </div>
              </div>
            )}
          </div>

          {/* Purpose code — technical */}
          <div className="font-mono text-xs mt-3" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
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
                      <span style={{ opacity: 0.6 }}>View: </span>
                      <span className="px-1 py-px rounded" style={{ backgroundColor: 'var(--muted)' }}>{view}</span>
                    </div>
                  )}
                  {fields && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.6 }}>Fields: </span>{fields.join(', ')}
                    </div>
                  )}
                  {timeRange?.since && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                      <span style={{ opacity: 0.6 }}>Since: </span>{timeRange.since}
                    </div>
                  )}
                  {!fields && !view && (
                    <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
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

// ─── Grant Inspector specimens ──────────────────────────────────────────────
// Coverage: axes 19 (status), 20 (consumed), plus grant-specific field combos

const GRANT_SPECIMENS: { label: string; axes: string; data: GrantInspectorProps }[] = [
  {
    label: 'Active, continuous',
    axes: 'active, continuous, retention:delete, view + fields, time_range',
    data: {
      grantId: 'grt_8f3a2b1c',
      issuedAt: 'Apr 6, 2026',
      status: 'active',
      client: { clientId: 'audience_lens_v1', name: 'Audience Lens' },
      purposeCode: 'research',
      purposeDescription: 'Influencer network study',
      accessMode: 'continuous',
      expiresAt: 'Apr 5, 2027',
      retention: { duration: '90 days', onExpiry: 'delete' },
      streams: [
        { name: 'following_accounts', label: 'Who you follow', detail: 'Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists.', view: 'social_graph', fields: ['id', 'username'] },
        { name: 'posts', label: 'Your posts', detail: 'Post captions, dates, and media types since Dec 31, 2024. No comments, likes, or private messages.', view: 'summary', fields: ['id', 'caption', 'taken_at', 'media_type'], timeRange: { since: 'Dec 31, 2024' } },
      ],
    },
  },
  {
    label: 'Expired',
    axes: 'expired, single_use, no retention, no view (all fields)',
    data: {
      grantId: 'grt_a1b2c3d4',
      issuedAt: 'Mar 1, 2026',
      status: 'expired',
      client: { clientId: 'concert_finder', name: 'Concert Finder' },
      purposeCode: 'personalization',
      purposeDescription: 'Concert recommendations',
      accessMode: 'single_use',
      expiresAt: 'Mar 2, 2026',
      streams: [
        { name: 'top_artists', label: 'Your top artists', detail: 'Artist names, genres, and popularity scores.' },
      ],
    },
  },
  {
    label: 'Revoked',
    axes: 'revoked, continuous, retention:anonymize, no expiry',
    data: {
      grantId: 'grt_rev0ked1',
      issuedAt: 'Jan 15, 2026',
      status: 'revoked',
      client: { clientId: 'dataco_ml_v2', name: 'DataCo ML Pipeline' },
      purposeCode: 'ai_training',
      purposeDescription: 'Recommendation model training',
      accessMode: 'continuous',
      expiresAt: null,
      retention: { duration: '6 months', onExpiry: 'anonymize' },
      streams: [
        { name: 'posts', label: 'Your posts', fields: ['id', 'caption', 'taken_at', 'media_type'] },
        { name: 'following_accounts', label: 'Who you follow', fields: ['id', 'username'] },
      ],
    },
  },
  {
    label: 'Single use, all fields',
    axes: 'active, single_use, no fields (all authorized), time_range since+until',
    data: {
      grantId: 'grt_sleep001',
      issuedAt: 'Apr 1, 2026',
      status: 'active',
      client: { clientId: 'sleep_insights_v1', name: 'Sleep Insights' },
      purposeCode: 'analytics',
      purposeDescription: 'Q1 2026 sleep pattern analysis',
      accessMode: 'single_use',
      expiresAt: 'Apr 8, 2026',
      retention: { duration: '30 days', onExpiry: 'delete' },
      streams: [
        { name: 'sleep_sessions', label: 'Sleep sessions', detail: 'Sleep duration, scores, and stage breakdowns.', timeRange: { since: 'Jan 1, 2026', until: 'Apr 1, 2026' } },
      ],
    },
  },
];

// ─── Stream Inventory ────────────────────────────────────────────────────────

// Props contract — all fields are server-authoritative:
//
// FROM connector manifest (server-trusted):
//   connectorName, streams[].name, streams[].label, streams[].detail,
//   streams[].semantics
//
// FROM resource server (runtime state):
//   streams[].recordCount, streams[].lastSynced

type InventoryStream = {
  name: string;
  label: string;              // manifest display.label
  detail?: string;            // manifest display.detail
  semantics: 'append_only' | 'mutable_state';
  recordCount: number;
  lastSynced?: string;        // human-readable date, absent if never synced
};

type StreamInventoryProps = {
  connectorName: string;
  connectorVersion: string;
  streams: InventoryStream[];
};

function StreamInventory({ connectorName, connectorVersion, streams }: StreamInventoryProps) {
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

// ─── Stream Inventory specimens ──────────────────────────────────────────────
// Coverage: axes 21-27 (semantics, consent_time_field, selection caps, views, sync state, counts)

const INVENTORY_SPECIMENS: { label: string; axes: string; data: StreamInventoryProps }[] = [
  {
    label: 'Instagram (populated)',
    axes: 'mutable_state + append_only, all synced, nonzero counts',
    data: {
      connectorName: 'Instagram',
      connectorVersion: '1.2.0',
      streams: [
        { name: 'following_accounts', label: 'Who you follow', detail: 'Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists.', semantics: 'mutable_state', recordCount: 106, lastSynced: 'Apr 6, 2026' },
        { name: 'posts', label: 'Your posts', detail: 'Post captions, dates, and media types. No comments, likes, or private messages.', semantics: 'append_only', recordCount: 22, lastSynced: 'Apr 6, 2026' },
        { name: 'ad_targeting', label: 'Ad interest categories', detail: 'Ad categories, sources, and confidence scores. No browsing history or purchase data.', semantics: 'mutable_state', recordCount: 47, lastSynced: 'Apr 6, 2026' },
      ],
    },
  },
  {
    label: 'Spotify (fresh)',
    axes: 'append_only dominant, one never synced, zero count stream',
    data: {
      connectorName: 'Spotify',
      connectorVersion: '2.0.0',
      streams: [
        { name: 'top_artists', label: 'Your top artists', detail: 'Artist names, genres, and popularity scores. No listening timestamps or play counts.', semantics: 'mutable_state', recordCount: 48, lastSynced: 'Apr 5, 2026' },
        { name: 'play_events', label: 'Play history', detail: 'Track plays with timestamps and durations. No skip or repeat data.', semantics: 'append_only', recordCount: 1243, lastSynced: 'Apr 5, 2026' },
        { name: 'saved_tracks', label: 'Saved tracks', detail: 'Tracks in your library with save dates.', semantics: 'mutable_state', recordCount: 0 },
      ],
    },
  },
  {
    label: 'Oura (single stream)',
    axes: 'single stream, append_only only, never synced',
    data: {
      connectorName: 'Oura Ring',
      connectorVersion: '1.0.0',
      streams: [
        { name: 'sleep_sessions', label: 'Sleep sessions', detail: 'Sleep duration, scores, and stage breakdowns. No heart rate or HRV data.', semantics: 'append_only', recordCount: 0 },
      ],
    },
  },
];

// ─── 08 Status ───────────────────────────────────────────────────────────────

function StatusSection() {
  return (
    <SectionWrap id="status">
      <SectionHeader
        title="Status Indicators"
        description="Inline patterns for communicating state. Consistent across all panels."
      />

      <div className="flex flex-col gap-12">
        <div>
          <SubLabel>Status dot</SubLabel>
          <div className="overflow-x-auto" style={{ borderTop: '1px solid var(--border)' }}>
          <table className="w-full" style={{ borderCollapse: 'collapse', tableLayout: 'fixed', minWidth: '320px', maxWidth: '600px' }}>
            <colgroup>
              <col style={{ width: '28px' }} />
              <col style={{ width: '160px' }} />
              <col style={{ width: '140px' }} />
              <col className="hidden md:table-column" />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: '1px solid var(--border)' }}>
                {['', 'State', 'Token', 'Usage'].map((h, i) => (
                  <th key={h} className={`text-left pb-2 pt-3 pr-6 text-xs font-medium${i === 3 ? ' hidden md:table-cell' : ''}`} style={{ color: 'var(--muted-foreground)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {[
                { tokenVal: '--border',      label: 'Offline / idle',       token: '--border',      usage: 'Uninitiated, not started' },
                { tokenVal: '--primary',     label: 'Active / in progress', token: '--primary',     usage: 'Running, loading, processing' },
                { tokenVal: '--success',     label: 'Success / complete',   token: '--success',     usage: 'Done, granted, synced' },
                { tokenVal: '--warning',     label: 'Warning / pending',    token: '--warning',     usage: 'Pending review, attention needed' },
                { tokenVal: '--destructive', label: 'Error',                token: '--destructive', usage: 'Failed, rejected, revoked' },
              ].map(({ tokenVal, label, token, usage }) => (
                <tr key={tokenVal}>
                  <td className="py-2.5 pr-3" style={{ verticalAlign: 'middle' }}>
                    <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: `var(${tokenVal})` }} />
                  </td>
                  <td className="py-2.5 pr-6" style={{ verticalAlign: 'baseline' }}><span className="text-xs">{label}</span></td>
                  <td className="py-2.5 pr-6" style={{ verticalAlign: 'baseline' }}><code className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>{token}</code></td>
                  <td className="py-2.5 hidden md:table-cell" style={{ verticalAlign: 'baseline' }}><span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{usage}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        </div>

        <div>
          <SubLabel>Spinner</SubLabel>
          <div
            className="flex items-center gap-4 px-5 py-4 rounded-lg"
            style={{ border: '1px solid var(--border)' }}
          >
            <span
              className="w-4 h-4 rounded-full shrink-0"
              style={{
                border: '2px solid var(--border)',
                borderTopColor: 'var(--primary)',
                display: 'inline-block',
                animation: 'spin 0.8s linear infinite',
              }}
            />
            <code className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>border: --border · borderTopColor: --primary · spin 0.8s linear</code>
          </div>
        </div>

        <div>
          <SubLabel>Spec citation</SubLabel>
          <div
            className="flex items-center gap-3 px-5 py-4 rounded-lg"
            style={{ border: '1px solid var(--border)' }}
          >
            <a href="#" className="font-mono text-xs transition-colors" style={{ color: 'var(--edu-fg)' }}>§4.2 Selection Request</a>
            <span style={{ color: 'var(--muted-foreground)' }} className="text-xs">·</span>
            <a href="#" className="font-mono text-xs transition-colors" style={{ color: 'var(--edu-fg)' }}>§6.1 Stream Metadata</a>
            <code className="font-mono text-xs ml-auto" style={{ color: 'var(--muted-foreground)' }}>color: --edu-fg · font-mono text-xs</code>
          </div>
        </div>
      </div>
    </SectionWrap>
  );
}

// ─── 09 Rules ────────────────────────────────────────────────────────────────

const RULE_GROUPS = [
  {
    label: 'Color',
    rules: [
      { bad: 'bg-green-500',         good: '--success',                  why: 'Raw palette class. Breaks when the theme changes.' },
      { bad: 'text-blue-600',        good: '--primary',                  why: 'Raw palette class. There is one blue in this system.' },
      { bad: "color: '#187adc'",     good: 'var(--primary)',             why: 'Hardcoded hex. Add to :root if it doesn\'t exist.' },
      { bad: 'Multiple accent colors', good: '--primary + status tokens only', why: 'One signature color. Everything else is neutral or a status.' },
    ],
  },
  {
    label: 'Typography',
    rules: [
      { bad: 'text-[13px]',          good: 'text-xs / text-sm',         why: 'Arbitrary size. Standard scale enforces rhythm across the system.' },
      { bad: 'font-mono on UI copy', good: 'font-sans',                  why: 'Mono signals protocol data. UI copy is always sans.' },
      { bad: 'font-sans on IDs, stream names, spec refs', good: 'font-mono', why: 'Mono signals "this came from the protocol." Never break this contract.' },
      { bad: '§ citation in non-mono', good: 'font-mono + --edu-fg',    why: 'Spec citations are their own visual layer. Never styled as regular text.' },
    ],
  },
  {
    label: 'Motion',
    rules: [
      { bad: 'transition: all',      good: 'opacity, transform only',   why: 'Layout properties trigger reflow. GPU-composited properties only.' },
      { bad: 'Animation without state change', good: 'Motion earns its existence', why: 'Every animation must answer: does this help the user understand what changed?' },
      { bad: 'Per-component prefers-reduced-motion', good: ':root duration reset', why: 'One rule in globals.css covers the entire system. No per-component overrides.' },
    ],
  },
  {
    label: 'Tokens',
    rules: [
      { bad: 'New token not on this page', good: 'Add to :root + /design first', why: 'This page is the source of truth. If it\'s not here, it doesn\'t exist yet.' },
      { bad: 'data-[attr] with no CSS rule', good: 'Define semantic, then derive visual', why: 'The attribute encodes what something is. CSS derives what it looks like. Never reverse this.' },
      { bad: 'Inline opacity on muted-foreground', good: 'Use the token as-is', why: 'oklch(0.50 0 0) is already calibrated. Stacking opacity creates uncalibrated contrast.' },
    ],
  },
  {
    label: 'Surface Temperature',
    rules: [
      { bad: 'oklch(0.52 0.09 45) inline',  good: 'var(--human)',                       why: 'Human color is a named token. Never hardcode it — the token carries the semantic meaning.' },
      { bad: 'Warm tone on protocol data',   good: '--human on identity/consent only',   why: 'Warm = person. If it\'s a token ID, stream name, or spec ref, it stays cool.' },
      { bad: 'Cool tone on the person row',  good: '--human on name, handle, owner',     why: 'Protocol blue on a person\'s name breaks the duality contract.' },
      { bad: 'Temperature on neutral UI',    good: 'No temperature on structural chrome', why: 'Headers, nav, and empty states have no owner — they are neutral. Adding temperature here dilutes the signal.' },
    ],
  },
];

function RulesSection() {
  return (
    <SectionWrap id="rules">
      <SectionHeader
        title="Rules"
        description="Hard constraints, not guidelines. Each exists because someone violated it. Check here before reaching for any custom value."
      />

      <div className="flex flex-col gap-10">
        {RULE_GROUPS.map(({ label, rules }) => (
          <div key={label}>
            <SubLabel>{label}</SubLabel>
            <div style={{ borderTop: '1px solid var(--border)' }}>
              {rules.map(({ bad, good, why }, i, arr) => (
                <div
                  key={bad}
                  className="py-3"
                  style={{
                    borderBottom: i < arr.length - 1
                      ? '1px solid color-mix(in oklch, var(--border) 40%, transparent)'
                      : 'none',
                  }}
                >
                  <div className="text-xs mb-2 leading-relaxed" style={{ color: 'var(--foreground)' }}>{why}</div>
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-8">
                    <div className="flex items-center gap-2">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="translate-y-px shrink-0" style={{ color: 'var(--destructive)' }}>
                        <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                      </svg>
                      <code className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{bad}</code>
                    </div>
                    <div className="flex items-center gap-2">
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" className="translate-y-px shrink-0" style={{ color: 'var(--success)' }}>
                        <path d="M1.5 5l2.5 2.5L8.5 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      <code className="font-mono text-[11px]" style={{ color: 'var(--muted-foreground)' }}>{good}</code>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </SectionWrap>
  );
}
