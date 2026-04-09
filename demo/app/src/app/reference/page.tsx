'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ConsentCard,
  GrantInspector,
  StreamInventory,
  ConnectorCard,
} from '@/components/pdpp';
import type {
  ConsentCardProps,
  GrantInspectorProps,
  StreamInventoryProps,
  ConnectorCardProps,
} from '@/components/pdpp';
import { useProtocol } from '@/lib/use-protocol';

// ─── Config ─────────────────────────────────────────────────────────────────

const SPEC_BASE_URL = 'https://pdpp-smoky.vercel.app';

// ─── Section definitions ────────────────────────────────────────────────────

const SECTIONS = [
  { id: 'ingest',    label: 'Ingest',    num: 1 },
  { id: 'inventory', label: 'Inventory', num: 2 },
  { id: 'request',   label: 'Request',   num: 3 },
  { id: 'consent',   label: 'Consent',   num: 4 },
  { id: 'grant',     label: 'Grant',     num: 5 },
  { id: 'enforce',   label: 'Enforce',   num: 6 },
  { id: 'sync',      label: 'Sync',      num: 7 },
  { id: 'revoke',    label: 'Revoke',    num: 8 },
  { id: 'export',    label: 'Export',    num: 9 },
  { id: 'multi',     label: 'Multi',     num: 10 },
  { id: 'spec',      label: 'Spec',      num: 11 },
] as const;

type SectionId = typeof SECTIONS[number]['id'];

// ─── Specimen data ──────────────────────────────────────────────────────────

const CONNECTOR_SPECIMEN: ConnectorCardProps = {
  connectorId: 'https://registry.pdpp.org/connectors/instagram',
  displayName: 'Instagram',
  version: '1.2.0',
  streams: [
    { name: 'following_accounts', label: 'Who you follow', semantics: 'mutable_state', supportsFields: true, supportsResources: false, supportsTimeRange: false, viewCount: 2 },
    { name: 'posts', label: 'Your posts', semantics: 'append_only', supportsFields: true, supportsResources: false, supportsTimeRange: true, viewCount: 2 },
    { name: 'ad_targeting', label: 'Ad interest categories', semantics: 'mutable_state', supportsFields: true, supportsResources: false, supportsTimeRange: false, viewCount: 1 },
  ],
};

const INVENTORY_SPECIMEN: StreamInventoryProps = {
  connectorName: 'Instagram',
  connectorVersion: '1.2.0',
  streams: [
    { name: 'following_accounts', label: 'Who you follow', detail: 'Usernames and account IDs of accounts you follow. No DMs, profile details, or follower lists.', semantics: 'mutable_state', recordCount: 106, lastSynced: 'Apr 6, 2026' },
    { name: 'posts', label: 'Your posts', detail: 'Post captions, dates, and media types. No comments, likes, or private messages.', semantics: 'append_only', recordCount: 22, lastSynced: 'Apr 6, 2026' },
    { name: 'ad_targeting', label: 'Ad interest categories', detail: 'Ad categories, sources, and confidence scores. No browsing history or purchase data.', semantics: 'mutable_state', recordCount: 47, lastSynced: 'Apr 6, 2026' },
  ],
};

const CONSENT_SPECIMEN: ConsentCardProps = {
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
};

const GRANT_SPECIMEN: GrantInspectorProps = {
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
};

const MULTI_CONNECTORS: ConnectorCardProps[] = [
  CONNECTOR_SPECIMEN,
  {
    connectorId: 'https://registry.pdpp.org/connectors/spotify',
    displayName: 'Spotify',
    version: '2.0.0',
    streams: [
      { name: 'top_artists', label: 'Your top artists', semantics: 'mutable_state', supportsFields: true, supportsResources: false, supportsTimeRange: true, viewCount: 2 },
      { name: 'play_events', label: 'Play history', semantics: 'append_only', supportsFields: true, supportsResources: false, supportsTimeRange: true, viewCount: 0 },
    ],
  },
  {
    connectorId: 'https://registry.pdpp.org/connectors/oura',
    displayName: 'Oura Ring',
    version: '1.0.0',
    streams: [
      { name: 'sleep_sessions', label: 'Sleep sessions', semantics: 'append_only', supportsFields: true, supportsResources: false, supportsTimeRange: true, viewCount: 0 },
    ],
  },
];


// ─── Section content ────────────────────────────────────────────────────────

type SectionConfig = {
  id: SectionId;
  headline: string;
  narrative: string;
  surface: 'human' | 'protocol' | 'neutral';
};

const SECTION_CONTENT: SectionConfig[] = [
  {
    id: 'ingest',
    headline: 'Your data arrives automatically',
    narrative: 'Connectors collect your data from Instagram, Spotify, and other platforms and store it on your personal server. You never copy-paste or download anything.',
    surface: 'protocol',
  },
  {
    id: 'inventory',
    headline: 'Your data, your server',
    narrative: 'Everything lives on a server you control. Who you follow, your posts, your ad interests. Organized, counted, and ready to inspect.',
    surface: 'protocol',
  },
  {
    id: 'request',
    headline: 'An app asks for access',
    narrative: 'A research app called Audience Lens wants your following list and posts for a study. It identifies itself, states its purpose, and lists what it promises.',
    surface: 'protocol',
  },
  {
    id: 'consent',
    headline: 'You decide',
    narrative: 'Your server shows you exactly what is being requested. Who is asking. What data. What they promise. What your server will enforce. You decide.',
    surface: 'human',
  },
  {
    id: 'grant',
    headline: 'Your decision is recorded',
    narrative: 'You said yes. Your server created a permanent record of exactly what you authorized. Which data, which fields, for how long, under what terms. Locked at the moment of consent.',
    surface: 'protocol',
  },
  {
    id: 'enforce',
    headline: 'Your server enforces it',
    narrative: 'When Audience Lens queries your data, your server checks the authorization and strips everything that was not approved. Your posts have 8 fields. Only 4 were authorized. Only 4 are returned.',
    surface: 'protocol',
  },
  {
    id: 'sync',
    headline: 'Only what changed',
    narrative: 'A week later, you post 3 new photos. Audience Lens asks for updates and gets only the 3 new posts. Not the 22 it already has. Efficient, ongoing access without re-downloading everything.',
    surface: 'protocol',
  },
  {
    id: 'revoke',
    headline: 'You can take it back',
    narrative: 'You change your mind. One click. Access is revoked. The next time Audience Lens tries to query, your server refuses. Within 60 seconds.',
    surface: 'human',
  },
  {
    id: 'export',
    headline: 'Your data is yours to export',
    narrative: 'You can pull all of your own data at any time. Full access, every field, every stream. No third-party permission required.',
    surface: 'human',
  },
  {
    id: 'multi',
    headline: 'One protocol, every platform',
    narrative: 'Instagram, Spotify, health data, email. Different sources, same consent flow, same enforcement, same controls. The protocol works identically regardless of where the data comes from.',
    surface: 'neutral',
  },
  {
    id: 'spec',
    headline: 'Built on an open specification',
    narrative: 'Every component on this page implements a section of the PDPP specification. Published, versioned, and open for review.',
    surface: 'neutral',
  },
];

// ─── Stepper navigation ─────────────────────────────────────────────────────

const SECTION_TEMPERATURE: Record<SectionId, 'human' | 'protocol' | 'neutral'> = {
  ingest: 'protocol', inventory: 'protocol', request: 'protocol',
  consent: 'human', grant: 'protocol', enforce: 'protocol',
  sync: 'protocol', revoke: 'human', export: 'human',
  multi: 'neutral', spec: 'neutral',
};

function Stepper({ activeId, onNavigate }: { activeId: SectionId; onNavigate: (id: SectionId) => void }) {
  return (
    <nav className="fixed right-6 top-1/2 -translate-y-1/2 z-30 hidden lg:flex flex-col gap-0.5">
      {SECTIONS.map(({ id, label }) => {
        const isActive = id === activeId;
        const temp = SECTION_TEMPERATURE[id];
        const inactiveColor = temp === 'human' ? 'oklch(0.52 0.09 45 / 0.7)' : temp === 'protocol' ? 'oklch(0.580 0.172 253.7 / 0.5)' : 'var(--muted-foreground)';
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className="flex items-center gap-2 py-1 px-2 rounded-md text-right transition-colors"
            style={{
              backgroundColor: isActive ? 'var(--foreground)' : 'transparent',
              color: isActive ? 'var(--background)' : inactiveColor,
            }}
          >
            <span className="text-xs font-medium">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

// ─── Detail panel (Level 2 depth) ───────────────────────────────────────────

function DetailPanel({ spec, label, children }: { spec: string; label?: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="mt-6 w-full" style={{ maxWidth: '52ch' }}>
      <button
        className="text-xs flex items-center gap-1 mb-2"
        style={{ color: 'var(--muted-foreground)' }}
        onClick={() => setOpen(v => !v)}
      >
        <span
          className="text-xs inline-block"
          style={{ transform: open ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform 150ms' }}
        >&#x203A;</span>
        {label || 'Protocol details'}
        <span className="font-mono ml-1" style={{ color: 'var(--edu-fg)' }}>{spec}</span>
      </button>
      {open && (
        <div className="border-l-2 pl-3 text-xs leading-relaxed flex flex-col gap-2" style={{ borderColor: 'oklch(0.580 0.172 253.7 / 0.25)', color: 'var(--muted-foreground)' }}>
          {children}
        </div>
      )}
    </div>
  );
}

// ─── Field projection animation ─────────────────────────────────────────────

function FieldProjection({ grantedFields, allFields }: { grantedFields: string[]; allFields: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [phase, setPhase] = useState<'hidden' | 'show' | 'filter' | 'result'>('hidden');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPhase('show');
          setTimeout(() => setPhase('filter'), 800);
          setTimeout(() => setPhase('result'), 1400);
          obs.disconnect();
        }
      },
      { threshold: 0.3 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  const easeOut = 'cubic-bezier(0.16, 1, 0.3, 1)';

  return (
    <div
      ref={ref}
      className="w-full py-4"
      style={{ maxWidth: '580px' }}
    >
      <div
        className="font-mono text-xs mb-8"
        style={{
          color: 'var(--muted-foreground)', opacity: phase !== 'hidden' ? 0.5 : 0,
          transition: `opacity 300ms ${easeOut}`,
        }}
      >
        GET /v1/streams/posts/records
      </div>

      <div className="flex flex-col gap-6">
        {/* Record on server — all fields */}
        <div>
          <div
            className="text-xs font-medium mb-3"
            style={{
              color: 'var(--muted-foreground)',
              opacity: phase !== 'hidden' ? 1 : 0,
              transition: `opacity 300ms ${easeOut}`,
            }}
          >
            Record on server ({allFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allFields.map((f, i) => {
              const granted = grantedFields.includes(f);
              const isFiltered = phase === 'filter' || phase === 'result';
              return (
                <span
                  key={f}
                  className="font-mono text-xs px-2 py-1 rounded-md"
                  style={{
                    backgroundColor: granted ? 'oklch(0.52 0.15 150 / 0.1)' : 'var(--muted)',
                    color: granted ? 'var(--success)' : 'var(--muted-foreground)',
                    opacity: phase === 'hidden' ? 0 : (isFiltered && !granted) ? 0.15 : 1,
                    transform: phase === 'hidden'
                      ? 'translateY(12px)'
                      : (isFiltered && !granted)
                        ? 'translateX(8px) scale(0.95)'
                        : 'translateY(0)',
                    transition: `opacity 600ms ${easeOut} ${phase === 'hidden' ? i * 50 : 200}ms, transform 600ms ${easeOut} ${phase === 'hidden' ? i * 50 : 200}ms`,
                    textDecoration: (isFiltered && !granted) ? 'line-through' : 'none',
                  }}
                >
                  {f}
                </span>
              );
            })}
          </div>
        </div>

        {/* Grant filter line */}
        <div className="flex items-center gap-3 py-1">
          <div
            className="flex-1 h-px"
            style={{
              backgroundColor: phase === 'filter' || phase === 'result' ? 'var(--primary)' : 'var(--border)',
              opacity: phase !== 'hidden' ? 1 : 0,
              transition: `opacity 300ms ${easeOut} 400ms, background-color 400ms ${easeOut}`,
            }}
          />
          <span
            className="text-xs font-mono shrink-0"
            style={{
              color: phase === 'filter' || phase === 'result' ? 'var(--primary)' : 'var(--muted-foreground)',
              opacity: phase !== 'hidden' ? 1 : 0,
              transition: `opacity 300ms ${easeOut} 400ms, color 400ms ${easeOut}`,
            }}
          >
            grant filter
          </span>
          <div
            className="flex-1 h-px"
            style={{
              backgroundColor: phase === 'filter' || phase === 'result' ? 'var(--primary)' : 'var(--border)',
              opacity: phase !== 'hidden' ? 1 : 0,
              transition: `opacity 300ms ${easeOut} 400ms, background-color 400ms ${easeOut}`,
            }}
          />
        </div>

        {/* Response to client — only granted fields */}
        <div>
          <div
            className="text-xs font-medium mb-3"
            style={{
              color: 'var(--success)',
              opacity: phase === 'result' ? 1 : 0,
              transition: `opacity 400ms ${easeOut}`,
            }}
          >
            Response to client ({grantedFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1.5">
            {grantedFields.map((f, i) => (
              <span
                key={f}
                className="font-mono text-xs px-2 py-1 rounded-md"
                style={{
                  backgroundColor: 'oklch(0.52 0.15 150 / 0.15)',
                  color: 'var(--success)',
                  fontWeight: 500,
                  opacity: phase === 'result' ? 1 : 0,
                  transform: phase === 'result' ? 'translateY(0)' : 'translateY(12px)',
                  transition: `opacity 500ms ${easeOut} ${i * 80}ms, transform 500ms ${easeOut} ${i * 80}ms`,
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
  const [phase, setPhase] = useState<'hidden' | 'first' | 'delta'>('hidden');

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setPhase('first');
          setTimeout(() => setPhase('delta'), 1200);
          obs.disconnect();
        }
      },
      { threshold: 0.5 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      className="w-full py-4"
      style={{ maxWidth: '520px' }}
    >
      <div className="flex flex-col gap-6">
        {/* First query */}
        <div>
          <div
            className="text-xs font-medium mb-2"
            style={{
              color: 'var(--muted-foreground)',
              opacity: phase !== 'hidden' ? 1 : 0,
              transition: 'opacity 300ms',
            }}
          >
            First query: 22 posts
          </div>
          <div className="flex items-center gap-0.5 flex-wrap">
            {Array.from({ length: 22 }, (_, i) => (
              <div
                key={i}
                className="w-1.5 h-3 rounded-sm"
                style={{
                  backgroundColor: 'var(--primary)',
                  opacity: phase !== 'hidden' ? 0.6 : 0,
                  transform: phase !== 'hidden' ? 'scaleY(1)' : 'scaleY(0)',
                  transition: `opacity 200ms ${i * 30}ms, transform 200ms ${i * 30}ms`,
                  transformOrigin: 'bottom',
                }}
              />
            ))}
          </div>
          <div
            className="font-mono text-xs mt-1.5"
            style={{
              color: 'var(--muted-foreground)',
              opacity: phase !== 'hidden' ? 0.6 : 0,
              transition: `opacity 300ms ${22 * 30 + 200}ms`,
            }}
          >
            next_changes_since: "cursor_a8f2..."
          </div>
        </div>

        {/* Separator */}
        <div
          className="h-px"
          style={{
            backgroundColor: 'var(--border)',
            opacity: phase === 'delta' ? 1 : 0,
            transition: 'opacity 300ms',
          }}
        />

        {/* Delta sync */}
        <div>
          <div
            className="text-xs font-medium mb-2"
            style={{
              color: 'var(--muted-foreground)',
              opacity: phase === 'delta' ? 1 : 0,
              transition: 'opacity 300ms 100ms',
            }}
          >
            Sync one week later: <span style={{ color: 'var(--success)' }}>3 new posts</span>
          </div>
          <div className="flex items-center gap-0.5 flex-wrap">
            {/* Existing records (dimmed) */}
            {Array.from({ length: 22 }, (_, i) => (
              <div
                key={i}
                className="w-1.5 h-3 rounded-sm"
                style={{
                  backgroundColor: 'var(--border)',
                  opacity: phase === 'delta' ? 1 : 0,
                  transition: `opacity 200ms ${200 + i * 15}ms`,
                }}
              />
            ))}
            {/* New records (green, staggered) */}
            {Array.from({ length: 3 }, (_, i) => (
              <div
                key={`new-${i}`}
                className="w-1.5 h-3 rounded-sm"
                style={{
                  backgroundColor: 'var(--success)',
                  opacity: phase === 'delta' ? 1 : 0,
                  transform: phase === 'delta' ? 'scaleY(1)' : 'scaleY(0)',
                  transition: `opacity 300ms ${600 + i * 120}ms, transform 300ms ${600 + i * 120}ms`,
                  transformOrigin: 'bottom',
                }}
              />
            ))}
          </div>
          <div
            className="font-mono text-xs mt-1.5"
            style={{
              color: 'var(--muted-foreground)',
              opacity: phase === 'delta' ? 0.6 : 0,
              transition: 'opacity 300ms 1000ms',
            }}
          >
            changes_since: "cursor_a8f2..." → 3 records returned
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Scroll reveal ──────────────────────────────────────────────────────────

function Reveal({ children, delay = 0 }: { children: React.ReactNode; delay?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const prefersReduced = useRef(false);

  useEffect(() => {
    prefersReduced.current = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); obs.disconnect(); } },
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
        transform: visible || reduced ? 'translateY(0)' : 'translateY(24px)',
        transition: reduced
          ? `opacity 200ms ${delay}ms`
          : `opacity 700ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms, transform 700ms cubic-bezier(0.16, 1, 0.3, 1) ${delay}ms`,
      }}
    >
      {children}
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
  const borderColor = config.surface === 'human'
    ? 'var(--human)'
    : config.surface === 'protocol'
    ? 'var(--primary)'
    : 'var(--border)';

  return (
    <section
      id={config.id}
      className="py-20 md:py-28"
      style={{ borderLeft: `2px solid ${borderColor}` }}
    >
      <div className={`${wide ? 'max-w-5xl' : 'max-w-3xl'} mx-auto w-full px-6 md:px-12`}>
        <div className={wide ? 'grid grid-cols-1 lg:grid-cols-2 gap-12 items-start' : ''}>
          <Reveal>
            <div
              className="font-mono text-xs uppercase tracking-widest mb-3"
              style={{ color: borderColor, opacity: 0.7 }}
            >
              {config.id}
            </div>
            <h2
              className="text-2xl md:text-3xl font-semibold tracking-tight mb-4"
              style={{ color: 'var(--foreground)', lineHeight: 1.15 }}
            >
              {config.headline}
            </h2>
            <p
              className="text-sm md:text-base leading-relaxed"
              style={{ color: 'var(--muted-foreground)', maxWidth: '48ch' }}
            >
              {config.narrative}
            </p>
            {detail && <div className="mt-4">{detail}</div>}
          </Reveal>
          <Reveal delay={150}>
            <div className={wide ? '' : 'mt-8'}>
              {children}
            </div>
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
  const borderColor = config.surface === 'human' ? 'var(--human)' : 'var(--primary)';

  return (
    <section
      id={config.id}
      className="py-28 md:py-40"
      style={{
        borderLeft: `2px solid ${borderColor}`,
        background: config.surface === 'human'
          ? 'linear-gradient(to bottom, oklch(0.52 0.09 45 / 0.06), oklch(0.52 0.09 45 / 0.02) 30%, transparent 60%)'
          : 'linear-gradient(to bottom, oklch(0.580 0.172 253.7 / 0.03), oklch(0.580 0.172 253.7 / 0.01) 30%, transparent 60%)',
      }}
    >
      <div className="max-w-3xl mx-auto w-full px-6 md:px-12">
        <Reveal>
          <div
            className="font-mono text-xs uppercase tracking-widest mb-3"
            style={{ color: borderColor, opacity: 0.7 }}
          >
            {config.id}
          </div>
          <h2
            className="text-3xl md:text-4xl font-semibold tracking-tight mb-4"
            style={{ color: 'var(--foreground)', lineHeight: 1.1 }}
          >
            {config.headline}
          </h2>
          <p
            className="text-sm md:text-base leading-relaxed mb-12"
            style={{ color: 'var(--muted-foreground)', maxWidth: '48ch' }}
          >
            {config.narrative}
          </p>
        </Reveal>
        <Reveal delay={200}>
          <div className="flex justify-center">
            {children}
          </div>
        </Reveal>
        {detail && <Reveal delay={300}><div className="mt-8 max-w-xl">{detail}</div></Reveal>}
      </div>
    </section>
  );
}

// ─── Protocol state (driven by mock server) ─────────────────────────────────

const ALL_POST_FIELDS = ['id', 'caption', 'taken_at', 'media_type', 'like_count', 'comment_count', 'location', 'is_pinned'];
const GRANTED_POST_FIELDS = ['id', 'caption', 'taken_at', 'media_type'];

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ReferencePage() {
  const [activeSection, setActiveSection] = useState<SectionId>('ingest');
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Protocol state from mock server
  const protocol = useProtocol();

  // Map protocol phase to the old interface for sections that still use it
  const handleAllow = protocol.approve;
  const handleDeny = protocol.deny;
  const handleRevoke = protocol.revoke;
  const handleReset = protocol.reset;

  // Track active section via IntersectionObserver
  useEffect(() => {
    observerRef.current = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting && entry.intersectionRatio > 0.3) {
            setActiveSection(entry.target.id as SectionId);
          }
        }
      },
      { threshold: 0.3 }
    );

    for (const { id } of SECTIONS) {
      const el = document.getElementById(id);
      if (el) observerRef.current.observe(el);
    }

    return () => observerRef.current?.disconnect();
  }, []);

  const navigateTo = useCallback((id: SectionId) => {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  // Keyboard navigation
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight' || e.key === ' ') {
        e.preventDefault();
        const idx = SECTIONS.findIndex(s => s.id === activeSection);
        if (idx < SECTIONS.length - 1) navigateTo(SECTIONS[idx + 1].id);
      } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const idx = SECTIONS.findIndex(s => s.id === activeSection);
        if (idx > 0) navigateTo(SECTIONS[idx - 1].id);
      }
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [activeSection, navigateTo]);

  const [multiIdx, setMultiIdx] = useState(0);

  // Derive grant inspector props from protocol state
  const grantProps: GrantInspectorProps = protocol.grant ? {
    grantId: protocol.grant.grant_id,
    issuedAt: new Date(protocol.grant.issued_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }),
    status: protocol.grant.status,
    client: { clientId: protocol.grant.client_id, name: 'Audience Lens' },
    purposeCode: protocol.grant.purpose_code,
    purposeDescription: protocol.grant.purpose_description,
    accessMode: protocol.grant.access_mode,
    expiresAt: protocol.grant.expires_at ? new Date(protocol.grant.expires_at).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' }) : null,
    retention: protocol.grant.retention ? { duration: '90 days', onExpiry: protocol.grant.retention.on_expiry } : undefined,
    streams: protocol.grant.streams.map(s => ({
      name: s.name,
      label: s.name === 'following_accounts' ? 'Who you follow' : s.name === 'posts' ? 'Your posts' : s.name,
      fields: s.fields || undefined,
      view: s.view || undefined,
      timeRange: s.time_range || undefined,
    })),
  } : GRANT_SPECIMEN;

  // Get the granted fields for the posts stream (used by FieldProjection)
  const grantedPostFields = protocol.grant?.streams.find(s => s.name === 'posts')?.fields || GRANTED_POST_FIELDS;

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>

      {/* Sticky header */}
      <header
        className="sticky top-0 z-40 flex h-12 items-center px-4 md:px-6 gap-2 md:gap-3"
        style={{
          backgroundColor: 'var(--background)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-2 shrink-0">
          <div
            className="w-5 h-5 rounded flex items-center justify-center shrink-0"
            style={{ background: 'var(--primary)' }}
          >
            <span className="text-[9px] font-bold leading-none" style={{ color: 'var(--primary-foreground)' }}>P</span>
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>PDPP</span>
        </div>

        {/* Mobile: current section indicator */}
        <span
          className="md:hidden font-mono text-xs uppercase tracking-wide"
          style={{ color: 'var(--muted-foreground)' }}
        >
          {SECTIONS.find(s => s.id === activeSection)?.label}
        </span>

        <div className="flex-1" />

        {/* Inline stepper for medium screens */}
        <nav className="hidden md:flex lg:hidden items-center gap-0.5">
          {SECTIONS.map(({ id, label }) => (
            <button
              key={id}
              onClick={() => navigateTo(id)}
              className="text-xs px-1.5 py-0.5 rounded transition-colors"
              style={{
                backgroundColor: activeSection === id ? 'var(--foreground)' : 'transparent',
                color: activeSection === id ? 'var(--background)' : 'var(--muted-foreground)',
              }}
            >
              {label}
            </button>
          ))}
        </nav>

        <a
          href="/design"
          className="hidden md:inline text-xs transition-opacity hover:opacity-70"
          style={{ color: 'var(--muted-foreground)' }}
        >
          Design System
        </a>
        <span className="hidden md:inline font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>v0.1.0</span>
      </header>

      {/* Right-side stepper (large screens) */}
      <Stepper activeId={activeSection} onNavigate={navigateTo} />

      {/* Protocol state indicator — visible during sections 4-8 */}
      {['consent', 'grant', 'enforce', 'sync', 'revoke'].includes(activeSection) && (
        <div
          className="fixed bottom-6 left-6 z-30 flex items-center gap-2 px-3 py-1.5 rounded-full text-xs"
          style={{
            backgroundColor: 'var(--card)',
            border: '1px solid var(--border)',
            boxShadow: '0 4px 6px rgba(0,0,0,0.04), 0 10px 15px rgba(0,0,0,0.08)',
            opacity: 0.9,
          }}
        >
          <div
            className="w-1.5 h-1.5 rounded-full"
            style={{
              backgroundColor: protocol.phase === 'granted' ? 'var(--success)' : protocol.phase === 'revoked' ? 'var(--destructive)' : 'var(--border)',
            }}
          />
          <span style={{ color: 'var(--muted-foreground)' }}>
            Grant: {protocol.phase === 'granted' ? 'active' : protocol.phase === 'revoked' ? 'revoked' : 'idle'}
          </span>
        </div>
      )}

      {/* ── Hero ── */}
      <section className="pt-24 pb-16 md:pt-32 md:pb-24 px-6 md:px-12">
        <div className="max-w-3xl mx-auto">
          <Reveal>
            <h1
              className="text-4xl md:text-5xl lg:text-6xl font-semibold tracking-tight mb-6"
              style={{ color: 'var(--foreground)', lineHeight: 1.05 }}
            >
              Personal Data
              <br />
              Portability Protocol
            </h1>
          </Reveal>
          <Reveal delay={100}>
            <p className="text-base md:text-lg leading-relaxed mb-2" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}>
              An authorization and disclosure protocol for personal data. You decide what to share, with whom, for how long, for what purpose.
            </p>
          </Reveal>
          <Reveal delay={200}>
            <p className="text-sm leading-relaxed mb-10" style={{ color: 'var(--muted-foreground)', maxWidth: '52ch', opacity: 0.6 }}>
              This is the protocol, running. Every component below implements a section of the spec.
            </p>
          </Reveal>

          {/* Protocol flow signature — hidden on mobile, horizontal on desktop */}
          <Reveal delay={400}>
            <div className="hidden md:flex items-center gap-0 pb-2" style={{ maxWidth: '100%' }}>
              {[
                { label: 'Platform', color: 'var(--muted-foreground)', bg: 'var(--muted)' },
                { label: 'Connector', color: 'var(--primary)', bg: 'oklch(0.580 0.172 253.7 / 0.06)' },
                { label: 'Your Server', color: 'var(--primary)', bg: 'oklch(0.580 0.172 253.7 / 0.06)' },
                { label: 'Consent', color: 'var(--human)', bg: 'var(--human-wash)' },
                { label: 'Grant', color: 'var(--primary)', bg: 'oklch(0.580 0.172 253.7 / 0.06)' },
                { label: 'Enforce', color: 'var(--primary)', bg: 'oklch(0.580 0.172 253.7 / 0.06)' },
                { label: 'Client', color: 'var(--muted-foreground)', bg: 'var(--muted)' },
              ].map((step, i, arr) => (
                <React.Fragment key={step.label}>
                  <div
                    className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium"
                    style={{ backgroundColor: step.bg, color: step.color, border: `1px solid ${step.color}20` }}
                  >
                    {step.label}
                  </div>
                  {i < arr.length - 1 && (
                    <div className="shrink-0 w-6 h-px" style={{ backgroundColor: 'var(--border)' }} />
                  )}
                </React.Fragment>
              ))}
            </div>
          </Reveal>
        </div>
      </section>

      {/* ── Sections ── */}

      {/* 1. Ingest — wide layout: text left, card right */}
      <Section
        config={SECTION_CONTENT[0]}
        wide
        detail={
          <DetailPanel spec="§7 Manifest, Collection Profile" label="See the connector manifest">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`// Connector manifest (consent surface declaration)
{
  "connector_id": "https://registry.pdpp.org/connectors/instagram",
  "version": "1.2.0",
  "display_name": "Instagram",
  "streams": [{
    "name": "posts",
    "display": {
      "label": "Your posts",
      "detail": "Post captions, dates, and media types."
    },
    "semantics": "append_only",
    "selection": { "fields": true, "resources": false },
    "consent_time_field": "taken_at"
  }]
}`}
            </pre>
            <p>Connectors run as child processes with stdin/stdout JSONL:</p>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>runtime → connector:</span> START (collection_mode, state, bindings)</span>
              <span><span style={{ opacity: 0.5 }}>connector → runtime:</span> RECORD, STATE, INTERACTION, DONE</span>
              <span>The connector never sees the raw grant or token.</span>
            </div>
          </DetailPanel>
        }
      >
        <ConnectorCard {...CONNECTOR_SPECIMEN} />
      </Section>

      {/* 2. Inventory — wide layout */}
      <Section
        config={SECTION_CONTENT[1]}
        wide
        detail={
          <DetailPanel spec="§4 Record Model" label="See a record">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`// A PDPP record
{
  "stream": "posts",
  "key": "post_0",
  "data": {
    "id": "post_0",
    "caption": "Post caption 1",
    "taken_at": "2025-01-01T06:00:00.000Z",
    "media_type": "VIDEO",
    "like_count": 315,
    "comment_count": 46,
    "location": "New York",
    "is_pinned": true
  },
  "emitted_at": "2026-04-06T12:00:00Z"
}`}
            </pre>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>append_only</span> — immutable events (~95% of data). No version history needed.</span>
              <span><span style={{ opacity: 0.5 }}>mutable_state</span> — evolving entities. RS maintains version history for incremental sync.</span>
            </div>
            <p>Every stream has a primary key, a JSON Schema, and an optional consent_time_field for temporal filtering.</p>
          </DetailPanel>
        }
      >
        <StreamInventory
          connectorName="Instagram"
          connectorVersion="1.2.0"
          streams={protocol.serverStats.map(s => ({
            name: s.name,
            label: s.name === 'following_accounts' ? 'Who you follow' : s.name === 'posts' ? 'Your posts' : s.name === 'ad_targeting' ? 'Ad interest categories' : s.name,
            detail: INVENTORY_SPECIMEN.streams.find(is => is.name === s.name)?.detail || '',
            semantics: s.name === 'posts' ? 'append_only' as const : 'mutable_state' as const,
            recordCount: s.recordCount,
            lastSynced: 'Apr 6, 2026',
          }))}
        />
      </Section>

      {/* 3. Request — wide layout */}
      <Section
        config={SECTION_CONTENT[2]}
        wide
        detail={
          <DetailPanel spec="§5 Selection Request" label="See the HTTP request">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`POST /authorize HTTP/1.1
Content-Type: application/json

{
  "response_type": "code",
  "client_id": "audience_lens_v1",
  "client_display": { "name": "Audience Lens", ... },
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "connector_id": "https://registry.pdpp.org/connectors/instagram",
    "purpose_code": "research",
    "streams": [
      { "name": "following_accounts", "necessity": "required" },
      { "name": "posts", "necessity": "required" },
      { "name": "ad_targeting", "necessity": "optional" }
    ]
  }]
}`}
            </pre>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>client_display</span> — entity-scoped, self-asserted (GNAP-style inline)</span>
              <span><span style={{ opacity: 0.5 }}>client_claims</span> — request-scoped, rendered with "[name] says:" attribution</span>
              <span><span style={{ opacity: 0.5 }}>necessity</span> — required (included in grant) or optional (user choice)</span>
            </div>
            <p>The AS must accept any syntactically valid purpose code URI. It must not reject solely because a code is unrecognized.</p>
          </DetailPanel>
        }
      >
        <div
          data-surface="protocol"
          className="rounded-xl overflow-hidden w-full"
        >
          <div className="px-5 pt-5 pb-4">
            <div className="flex items-center justify-between mb-4">
              <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                POST /authorize
              </div>
              <span
                className="font-mono text-xs px-1.5 py-0.5 rounded"
                style={{ backgroundColor: 'oklch(0.62 0.15 70 / 0.1)', color: 'var(--warning)' }}
              >
                pending
              </span>
            </div>

            {/* Identity block */}
            <div className="flex items-center gap-2 mb-3">
              <div
                className="w-7 h-7 rounded-md shrink-0 flex items-center justify-center"
                style={{ backgroundColor: 'var(--muted)' }}
              >
                <span className="text-xs font-bold font-mono" style={{ color: 'var(--muted-foreground)' }}>AL</span>
              </div>
              <div>
                <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>Audience Lens</span>
                <span className="font-mono text-xs ml-1.5" style={{ color: 'var(--success)' }}>verified</span>
              </div>
            </div>

            <div className="text-xs mb-3" style={{ color: 'var(--foreground)' }}>
              Influencer network study
            </div>
          </div>

          {/* Requested streams */}
          <div className="px-5 pb-1" style={{ borderTop: '1px solid var(--border)' }}>
            {[
              { name: 'following_accounts', necessity: 'required' },
              { name: 'posts', necessity: 'required' },
              { name: 'ad_targeting', necessity: 'optional' },
            ].map(s => (
              <div key={s.name} className="flex items-center justify-between py-2" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="font-mono text-xs" style={{ color: 'var(--foreground)' }}>{s.name}</span>
                <span className="text-xs" style={{ color: s.necessity === 'optional' ? 'var(--muted-foreground)' : 'var(--foreground)', opacity: s.necessity === 'optional' ? 0.6 : 1 }}>
                  {s.necessity}
                </span>
              </div>
            ))}
          </div>

          {/* Commitments */}
          <div className="px-5 py-3">
            <div className="text-xs italic" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>
              Commits: data used only for this study, not sold or shared.
            </div>
          </div>
        </div>
      </Section>

      {/* 4. Consent — THE featured moment */}
      <FeaturedSection
        config={SECTION_CONTENT[3]}
        detail={
          <DetailPanel spec="§5.1 Client Display, §5.2 Client Claims" label="See the trust model">
            <p>Three content layers rendered with distinct visual treatment:</p>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ color: 'var(--foreground)' }}>Layer 1:</span> Protocol facts (from grant fields) — rendered as authoritative</span>
              <span><span style={{ color: 'var(--foreground)' }}>Layer 2:</span> Server descriptions (manifest display.label/detail) — trusted</span>
              <span><span style={{ color: 'var(--foreground)' }}>Layer 3:</span> Client claims (client_display, commitments) — attributed with "[name] says:"</span>
            </div>
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`// Selection request (RFC 9396 authorization_details)
{
  "client_display": {
    "name": "Audience Lens",
    "uri": "https://audiencelens.example",
    "logo_uri": "https://audiencelens.example/logo.png"
  },
  "authorization_details": [{
    "type": "https://pdpp.org/data-access",
    "purpose_code": "research",
    "purpose_description": "Influencer network study",
    "access_mode": "continuous",
    "streams": [
      { "name": "following_accounts", "necessity": "required" },
      { "name": "posts", "necessity": "required" },
      { "name": "ad_targeting", "necessity": "optional" }
    ],
    "client_claims": {
      "commitments": ["Data used only for this study"]
    }
  }]
}`}
            </pre>
            <p className="italic" style={{ opacity: 0.7 }}>
              The AS must treat logo_uri as untrusted content. For unverified clients, it generates a monogram instead of rendering the remote image.
            </p>
            <p>ai_training purpose code requires explicit affirmative consent — the sole protocol-level requirement.</p>
          </DetailPanel>
        }
      >
        {protocol.phase === 'idle' ? (
          <ConsentCard {...CONSENT_SPECIMEN} onAllow={handleAllow} onDeny={handleDeny} />
        ) : (
          <div className="flex flex-col items-center gap-3" style={{ maxWidth: '440px', width: '100%' }}>
            <div
              className="w-full rounded-xl px-6 py-8 flex flex-col items-center gap-3 text-center"
              style={{ border: '1px solid var(--border)', backgroundColor: 'var(--card)' }}
            >
              <div
                className="w-8 h-8 rounded-full flex items-center justify-center text-sm"
                style={{
                  backgroundColor: protocol.phase === 'granted' ? 'var(--success)' : 'var(--muted)',
                  color: protocol.phase === 'granted' ? 'white' : 'var(--muted-foreground)',
                }}
              >
                {protocol.phase === 'granted' ? '✓' : protocol.phase === 'revoked' ? '×' : '×'}
              </div>
              <div className="text-sm font-medium">
                {protocol.phase === 'granted' ? 'Access granted' : 'Access revoked'}
              </div>
              <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                {protocol.phase === 'granted'
                  ? 'Audience Lens may now query your personal server. Scroll down to see enforcement in action.'
                  : 'The grant has been revoked. Audience Lens can no longer access your data.'}
              </div>
            </div>
            <button
              className="font-mono text-xs px-0.5"
              style={{ color: 'var(--muted-foreground)' }}
              onClick={handleReset}
            >
              ↺ reset
            </button>
          </div>
        )}
      </FeaturedSection>

      {/* 5. Grant — wide layout */}
      <Section
        config={SECTION_CONTENT[4]}
        wide
        detail={
          <DetailPanel spec="§6 Grant" label="See the grant JSON">
            <p>The grant is an immutable consent artifact. Once issued, it cannot be modified. Changes require revoke-and-reissue.</p>
            {protocol.grant && (
              <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{JSON.stringify({
  grant_id: protocol.grant.grant_id,
  issued_at: protocol.grant.issued_at,
  status: protocol.grant.status,
  client: { client_id: protocol.grant.client_id },
  purpose_code: protocol.grant.purpose_code,
  access_mode: protocol.grant.access_mode,
  streams: protocol.grant.streams.map(s => ({
    name: s.name,
    fields: s.fields,
    view: s.view,
  })),
  retention: protocol.grant.retention,
  expires_at: protocol.grant.expires_at,
}, null, 2)}
              </pre>
            )}
            <p>Three orthogonal time concepts that must not be conflated:</p>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>grant validity:</span> issued_at / expires_at</span>
              <span><span style={{ opacity: 0.5 }}>data scope:</span> streams[].time_range</span>
              <span><span style={{ opacity: 0.5 }}>access pattern:</span> access_mode (single_use | continuous)</span>
            </div>
            <p className="italic" style={{ opacity: 0.7 }}>
              retention is a policy commitment by the client, not server-enforced. Enforcement is through legal agreements, consistent with how OAuth 2.0 treats scope compliance.
            </p>
          </DetailPanel>
        }
      >
        <GrantInspector
          {...grantProps}
          onRevoke={protocol.phase === 'granted' ? handleRevoke : undefined}
        />
      </Section>

      {/* 6. Enforce — featured: the "one screenshot" moment */}
      <FeaturedSection
        config={SECTION_CONTENT[5]}
        detail={
          <DetailPanel spec="§8 Resource Server" label="See the HTTP exchange">
            <p>The RS computes effective_filter = grant_filter AND request_filter. Request-time filters can only narrow, never widen.</p>
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`GET /v1/streams/posts/records HTTP/1.1
Authorization: Bearer <client_token>
PDPP-Version: 0.1.0

→ RS introspects token
→ Resolves grant: ${protocol.grant?.grant_id || 'grt_8f3a2b1c'}
→ Grant authorizes fields: [${grantedPostFields.join(', ')}]
→ Record has fields: [${ALL_POST_FIELDS.join(', ')}]
→ Response contains only: [${grantedPostFields.join(', ')}]
→ Stripped: [${ALL_POST_FIELDS.filter(f => !grantedPostFields.includes(f)).join(', ')}]`}
            </pre>
            <p>Edge cases:</p>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ color: 'var(--destructive)' }}>403 grant_revoked</span> — grant has been revoked</span>
              <span><span style={{ color: 'var(--destructive)' }}>403 field_not_granted</span> — filter targets unauthorized field</span>
              <span><span style={{ color: 'var(--destructive)' }}>403 insufficient_scope</span> — stream not in grant</span>
              <span><span style={{ color: 'var(--warning)' }}>410 Gone</span> — changes_since cursor has expired</span>
            </div>
          </DetailPanel>
        }
      >
        {protocol.phase === 'revoked' ? (
          <div
            data-surface="protocol"
            className="rounded-xl overflow-hidden px-5 py-8 text-center w-full"
          >
            <div className="font-mono text-xs mb-2" style={{ color: 'var(--destructive)' }}>
              403 grant_revoked
            </div>
            <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              The grant has been revoked. No further queries will be served.
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-6 items-center w-full">
            <FieldProjection grantedFields={grantedPostFields} allFields={ALL_POST_FIELDS} />
            {protocol.queryResult?.records?.[0] && (
              <div
                data-surface="protocol"
                className="rounded-xl overflow-hidden px-5 py-4 w-full"
                style={{ maxWidth: '440px' }}
              >
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--success)' }}>
                  Actual response (first record)
                </div>
                <pre className="font-mono text-xs overflow-x-auto" style={{ color: 'var(--muted-foreground)' }}>
                  {JSON.stringify(protocol.queryResult.records[0].data, null, 2)}
                </pre>
                <div className="text-xs mt-2 italic" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                  {Object.keys(protocol.queryResult.records[0].data).length} of {ALL_POST_FIELDS.length} fields returned.
                  {' '}{ALL_POST_FIELDS.length - Object.keys(protocol.queryResult.records[0].data).length} stripped by the grant filter.
                </div>
              </div>
            )}
          </div>
        )}
      </FeaturedSection>

      {/* 7. Sync — wide */}
      <Section
        config={SECTION_CONTENT[6]}
        wide
        detail={
          <DetailPanel spec="§4.1 Incremental Sync" label="See the sync protocol">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`GET /v1/streams/posts/records?changes_since=${protocol.syncCursor || '"cursor_a8f2..."'}
Authorization: Bearer <client_token>

→ RS finds records added/changed since cursor
→ Applies field projection to EACH record in the delta
→ Returns only records whose AUTHORIZED projection changed
→ Includes next_changes_since for subsequent sync`}
            </pre>
            <p><strong>Projection-aware deltas</strong> (the novel property): if unauthorized field <code className="font-mono">like_count</code> changes but the client is only authorized for <code className="font-mono">[id, caption, taken_at, media_type]</code>, the record does not appear in the delta. The client cannot infer that like_count changed.</p>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>cursor</span> — pagination within a single query (distinct token space)</span>
              <span><span style={{ opacity: 0.5 }}>changes_since</span> — sync state across sessions (distinct token space)</span>
              <span>A client MUST NOT use a next_cursor value as a changes_since parameter.</span>
            </div>
            <p className="italic" style={{ opacity: 0.7 }}>
              RS may expire version data. If a cursor is stale, RS returns 410 Gone. Client must full re-sync.
            </p>
            <p><strong>single_use grants</strong> do not support incremental sync. The runtime does not persist STATE from single_use collection runs. single_use is a one-shot export; continuous is for ongoing access.</p>
          </DetailPanel>
        }
      >
        {protocol.phase === 'granted' ? (
          <div className="flex flex-col gap-4 w-full">
            <IncrementalSync />
            <button
              className="text-xs self-start px-3 py-1.5 rounded-md transition-colors"
              style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}
              onClick={() => protocol.addNewPosts(3)}
            >
              + Add 3 new posts (simulates new data arriving)
            </button>
            {protocol.syncResult && protocol.syncResult.records && protocol.syncResult.records.length > 0 && (
              <div
                data-surface="protocol"
                className="rounded-xl overflow-hidden px-5 py-4 w-full"
              >
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--success)' }}>
                  Delta: {protocol.syncResult.records.length} record{protocol.syncResult.records.length !== 1 ? 's' : ''} returned
                </div>
                <div className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', maxHeight: '100px', overflowY: 'auto' }}>
                  {JSON.stringify(protocol.syncResult.records.slice(-3).map(r => r.data), null, 2)}
                </div>
                {protocol.syncCursor && (
                  <div className="font-mono text-xs mt-2" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                    next_changes_since: "{protocol.syncCursor}"
                  </div>
                )}
                <div className="text-xs mt-2 italic" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                  Only {grantedPostFields.length} of {ALL_POST_FIELDS.length} fields per record (projection applied to delta too).
                </div>
              </div>
            )}
          </div>
        ) : (
          <IncrementalSync />
        )}
      </Section>

      {/* 8. Revoke — wide */}
      <Section
        config={SECTION_CONTENT[7]}
        wide
        detail={
          <DetailPanel spec="§6.5 Revocation" label="See the revocation flow">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`// After revocation:
POST /revoke  →  AS marks grant.status = "revoked"

// Next client query:
GET /v1/streams/posts/records
Authorization: Bearer <client_token>
→ RS introspects token  →  active: false
→ 403 grant_revoked

// Propagation window:
Introspection cache TTL ≤ 60 seconds
RS sees revocation within max(token_exp, 60s)`}
            </pre>
            <p>Revocation stops <em>future</em> access only. Records already delivered are governed by the grant's retention policy and legal obligations. PDPP does not retroactively reach into client-side data stores.</p>
            <p>Grant narrowing is not supported in v0.1. Scope reduction: revoke the existing grant, issue a new narrower one.</p>
          </DetailPanel>
        }
      >
        {protocol.phase === 'revoked' ? (
          <div className="flex flex-col items-center gap-3 w-full">
            <div
              className="w-full rounded-xl px-6 py-8 flex flex-col items-center gap-3 text-center"
              style={{ border: '1px solid var(--border)', backgroundColor: 'var(--card)' }}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ backgroundColor: 'var(--destructive)', color: 'white' }}>
                ×
              </div>
              <div className="text-sm font-medium">Grant revoked</div>
              <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Access has been revoked. The enforcement section above now shows a 403 response.
              </div>
            </div>
            <button
              className="font-mono text-xs px-0.5"
              style={{ color: 'var(--muted-foreground)' }}
              onClick={handleReset}
            >
              ↺ reset flow
            </button>
          </div>
        ) : (
          <GrantInspector {...grantProps} onRevoke={protocol.phase === 'granted' ? handleRevoke : undefined} />
        )}
      </Section>

      {/* 9. Export — wide */}
      <Section
        config={SECTION_CONTENT[8]}
        wide
        detail={
          <DetailPanel spec="§8.3 Owner Tokens" label="See the token exchange">
            <pre className="font-mono text-xs p-3 rounded-md overflow-x-auto" style={{ backgroundColor: 'var(--muted)', color: 'var(--muted-foreground)' }}>
{`// Self-export: owner token, no grant required
GET /v1/streams/posts/records
Authorization: Bearer <owner_token>

→ RS introspects token
→ pdpp_token_kind: "owner"
→ subject_id: "user_abc123"
→ No grant needed — full access to own data
→ All ${ALL_POST_FIELDS.length} fields returned (no projection)`}
            </pre>
            <div className="font-mono text-xs flex flex-col gap-1">
              <span><span style={{ opacity: 0.5 }}>owner token</span> — ingest, state management, self-export</span>
              <span><span style={{ opacity: 0.5 }}>client token</span> — querying under a grant (field projection enforced)</span>
              <span>RS determines token kind from introspection, never from syntax.</span>
            </div>
          </DetailPanel>
        }
      >
        <div className="flex flex-col gap-4 w-full">
          <div
            data-surface="human"
            className="rounded-xl overflow-hidden px-5 py-6 w-full"
          >
            <div className="flex items-center gap-2 mb-4">
              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--success)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>Owner access</span>
              <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>No grant required</span>
            </div>
            <div className="flex flex-col">
              {protocol.serverStats.map(s => (
                <button
                  key={s.name}
                  className="flex items-center justify-between py-2 text-left"
                  style={{ borderBottom: '1px solid var(--border)' }}
                  onClick={() => protocol.selfExport(s.name)}
                >
                  <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{s.name}</span>
                  <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>
                    {s.fields.length} fields, {s.recordCount} records
                  </span>
                </button>
              ))}
            </div>
            <div className="text-xs mt-3" style={{ color: 'var(--muted-foreground)' }}>
              Click a stream to export. All fields returned, no projection.
            </div>
          </div>

          {/* Show export result */}
          {protocol.exportResult && protocol.exportResult.records && protocol.exportResult.records.length > 0 && (
            <div
              data-surface="protocol"
              className="rounded-xl overflow-hidden px-5 py-4 w-full"
            >
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--success)' }}>
                Exported {protocol.exportResult.records.length} records (all fields)
              </div>
              <div className="font-mono text-xs overflow-x-auto" style={{ color: 'var(--muted-foreground)', maxHeight: '120px', overflowY: 'auto' }}>
                {JSON.stringify(protocol.exportResult.records[0].data, null, 2)}
              </div>
              <div className="text-xs mt-2" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                Showing first record. Compare to the grant-projected response in the Enforce section.
              </div>
            </div>
          )}
        </div>
      </Section>

      {/* ── Separator ── */}
      <div className="max-w-2xl mx-auto px-6 md:px-12">
        <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />
      </div>

      {/* 10. Multi-connector */}
      <Section config={SECTION_CONTENT[9]}>
        <div className="flex flex-col gap-4 w-full">
          <div className="flex gap-1.5 mb-2">
            {MULTI_CONNECTORS.map((c, i) => (
              <button
                key={c.connectorId}
                onClick={() => setMultiIdx(i)}
                className="text-xs px-2 py-1 rounded transition-colors"
                style={{
                  backgroundColor: i === multiIdx ? 'var(--foreground)' : 'var(--muted)',
                  color: i === multiIdx ? 'var(--background)' : 'var(--muted-foreground)',
                }}
              >
                {c.displayName}
              </button>
            ))}
          </div>
          <ConnectorCard {...MULTI_CONNECTORS[multiIdx]} />
        </div>
      </Section>

      {/* 11. Spec — mapping of reference sections to spec sections */}
      <Section config={SECTION_CONTENT[10]}>
        <div className="w-full flex flex-col gap-6">
          <div className="flex flex-col gap-2">
            {[
              { ref: 'Ingest', spec: '§7 Manifest', desc: 'Connector manifest declares the consent surface' },
              { ref: 'Inventory', spec: '§4 Record Model', desc: 'Flat relational streams with primary keys' },
              { ref: 'Request', spec: '§5 Selection Request', desc: 'RFC 9396 authorization_details envelope' },
              { ref: 'Consent', spec: '§5.1, §5.2', desc: 'Client display, client claims, attribution' },
              { ref: 'Grant', spec: '§6 Grant', desc: 'Immutable consent artifact with three time axes' },
              { ref: 'Enforce', spec: '§8 Resource Server', desc: 'Field projection, effective filter composition' },
              { ref: 'Sync', spec: '§4.1 Incremental', desc: 'Projection-aware deltas via changes_since' },
              { ref: 'Revoke', spec: '§6.5 Revocation', desc: '60s propagation window, retention governs past data' },
              { ref: 'Export', spec: '§8.3 Owner Tokens', desc: 'Self-export via owner token, no grant required' },
            ].map(({ ref, spec, desc }) => (
              <div key={ref} className="flex items-baseline gap-3 py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="text-xs font-medium shrink-0 w-16" style={{ color: 'var(--foreground)' }}>{ref}</span>
                <span className="font-mono text-xs shrink-0" style={{ color: 'var(--edu-fg)' }}>{spec}</span>
                <span className="text-xs" style={{ color: 'var(--muted-foreground)' }}>{desc}</span>
              </div>
            ))}
          </div>
          <a
            href={`${SPEC_BASE_URL}/spec-core`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium transition-opacity hover:opacity-70"
            style={{ color: 'var(--primary)' }}
          >
            Read the full specification →
          </a>
        </div>
      </Section>

      {/* Footer */}
      <footer className="py-8 text-center">
        <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.4 }}>
          PDPP v0.1.0 — Personal Data Portability Protocol
        </span>
      </footer>
    </div>
  );
}
