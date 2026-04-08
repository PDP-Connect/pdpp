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
    headline: 'A connector brings your data in',
    narrative: 'A connector is a program that knows how to talk to Instagram, Spotify, or any other platform. It collects your data and stores it on your personal server in structured streams.',
    surface: 'protocol',
  },
  {
    id: 'inventory',
    headline: 'Your data, your server',
    narrative: 'Your personal server holds your data. Who you follow, your posts, your ad interests — organized in streams with record counts you can inspect at any time.',
    surface: 'protocol',
  },
  {
    id: 'request',
    headline: 'An app wants access',
    narrative: 'Audience Lens, a research app, wants your following list and posts for an influencer study. It sends a request to your server, identifying itself and stating its purpose.',
    surface: 'protocol',
  },
  {
    id: 'consent',
    headline: 'You decide',
    narrative: 'Your server shows you exactly what is being asked for. Who is asking. What data. What they promise. What your server enforces. You decide.',
    surface: 'human',
  },
  {
    id: 'grant',
    headline: 'The grant freezes your consent',
    narrative: 'You said yes. Your server issued a grant — an immutable record of exactly what you authorized. Streams, fields, time range, access mode, retention. Frozen at the moment of consent.',
    surface: 'protocol',
  },
  {
    id: 'enforce',
    headline: 'Your server enforces your decision',
    narrative: 'Audience Lens queries your server. The resource server checks the grant and returns only what you authorized. Your posts have 8 fields. The grant authorized 4. The response has 4.',
    surface: 'protocol',
  },
  {
    id: 'sync',
    headline: 'Only what changed',
    narrative: 'Next week, you post 3 new photos. Audience Lens syncs again and gets only the 3 new posts, not the 22 it already has. Incremental sync makes continuous access practical at scale.',
    surface: 'protocol',
  },
  {
    id: 'revoke',
    headline: 'You can take it back',
    narrative: 'You change your mind. One click. The grant is revoked. The next query returns 403. Your server enforces this within 60 seconds.',
    surface: 'human',
  },
  {
    id: 'export',
    headline: 'Your data is yours to export',
    narrative: 'You can query your own server with full access. No grant needed. Every field, every stream. Your data, your export, your terms.',
    surface: 'human',
  },
  {
    id: 'multi',
    headline: 'Every connector, one protocol',
    narrative: 'Instagram, Spotify, health data, email — different sources, same protocol. The consent flow, the grant enforcement, the incremental sync — identical regardless of where the data comes from.',
    surface: 'neutral',
  },
  {
    id: 'spec',
    headline: 'The spec is the source of truth',
    narrative: 'Every component on this page implements a section of the PDPP specification. The spec is published, open, and versioned.',
    surface: 'neutral',
  },
];

// ─── Stepper navigation ─────────────────────────────────────────────────────

function Stepper({ activeId, onNavigate }: { activeId: SectionId; onNavigate: (id: SectionId) => void }) {
  return (
    <nav className="fixed right-6 top-1/2 -translate-y-1/2 z-30 hidden lg:flex flex-col gap-1">
      {SECTIONS.map(({ id, label }) => {
        const isActive = id === activeId;
        return (
          <button
            key={id}
            onClick={() => onNavigate(id)}
            className="flex items-center gap-2 py-1 px-2 rounded-md text-right transition-colors"
            style={{
              backgroundColor: isActive ? 'var(--foreground)' : 'transparent',
              color: isActive ? 'var(--background)' : 'var(--muted-foreground)',
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

function DetailPanel({ spec, children }: { spec: string; children: React.ReactNode }) {
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
        Protocol details
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
  const [animated, setAnimated] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setAnimated(true); obs.disconnect(); } },
      { threshold: 0.5 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <div
      ref={ref}
      data-surface="protocol"
      className="rounded-xl overflow-hidden px-5 py-6"
      style={{ maxWidth: '440px', width: '100%' }}
    >
      <div className="font-mono text-xs mb-4" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
        GET /v1/streams/posts/records
      </div>

      <div className="flex flex-col gap-4">
        {/* Record on server */}
        <div>
          <div className="text-xs font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>
            Record on server ({allFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1">
            {allFields.map((f, i) => {
              const granted = grantedFields.includes(f);
              return (
                <span
                  key={f}
                  className="font-mono text-xs px-1.5 py-0.5 rounded"
                  style={{
                    backgroundColor: granted ? 'oklch(0.52 0.15 150 / 0.1)' : 'var(--muted)',
                    color: granted ? 'var(--success)' : 'var(--muted-foreground)',
                    opacity: animated ? (granted ? 1 : 0.3) : 0,
                    transform: animated ? 'translateY(0)' : 'translateY(8px)',
                    transition: `opacity 400ms ${i * 60}ms, transform 400ms ${i * 60}ms`,
                  }}
                >
                  {f}
                </span>
              );
            })}
          </div>
        </div>

        {/* Grant filter line */}
        <div className="flex items-center gap-2">
          <div
            className="flex-1 h-px"
            style={{
              backgroundColor: 'var(--border)',
              opacity: animated ? 1 : 0,
              transition: `opacity 300ms ${allFields.length * 60 + 200}ms`,
            }}
          />
          <span
            className="text-xs font-mono"
            style={{
              color: 'var(--muted-foreground)',
              opacity: animated ? 1 : 0,
              transition: `opacity 300ms ${allFields.length * 60 + 200}ms`,
            }}
          >
            grant filter
          </span>
          <div
            className="flex-1 h-px"
            style={{
              backgroundColor: 'var(--border)',
              opacity: animated ? 1 : 0,
              transition: `opacity 300ms ${allFields.length * 60 + 200}ms`,
            }}
          />
        </div>

        {/* Response to client */}
        <div>
          <div
            className="text-xs font-medium mb-2"
            style={{
              color: 'var(--success)',
              opacity: animated ? 1 : 0,
              transition: `opacity 300ms ${allFields.length * 60 + 400}ms`,
            }}
          >
            Response to client ({grantedFields.length} fields)
          </div>
          <div className="flex flex-wrap gap-1">
            {grantedFields.map((f, i) => (
              <span
                key={f}
                className="font-mono text-xs px-1.5 py-0.5 rounded"
                style={{
                  backgroundColor: 'oklch(0.52 0.15 150 / 0.1)',
                  color: 'var(--success)',
                  opacity: animated ? 1 : 0,
                  transform: animated ? 'translateY(0)' : 'translateY(8px)',
                  transition: `opacity 400ms ${allFields.length * 60 + 500 + i * 80}ms, transform 400ms ${allFields.length * 60 + 500 + i * 80}ms`,
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
      data-surface="protocol"
      className="rounded-xl overflow-hidden px-5 py-6"
      style={{ maxWidth: '440px', width: '100%' }}
    >
      <div className="flex flex-col gap-4">
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

// ─── Section shell ──────────────────────────────────────────────────────────

function Section({
  config,
  children,
  detail,
}: {
  config: SectionConfig;
  children: React.ReactNode;
  detail?: React.ReactNode;
}) {
  const borderColor = config.surface === 'human'
    ? 'var(--human)'
    : config.surface === 'protocol'
    ? 'var(--primary)'
    : 'var(--border)';

  return (
    <section
      id={config.id}
      className="min-h-[80vh] flex flex-col justify-center py-16 md:py-24"
      style={{ borderLeft: `2px solid ${borderColor}` }}
    >
      <div className="max-w-2xl mx-auto w-full px-6 md:px-12">
        <h2
          className="text-2xl md:text-3xl font-semibold tracking-tight mb-4"
          style={{ color: 'var(--foreground)' }}
        >
          {config.headline}
        </h2>
        <p
          className="text-sm md:text-base leading-relaxed mb-8"
          style={{ color: 'var(--muted-foreground)', maxWidth: '52ch' }}
        >
          {config.narrative}
        </p>
        <div>
          {children}
        </div>
        {detail}
      </div>
    </section>
  );
}

// ─── Protocol state (connects sections 4-8) ────────────────────────────────

type ProtocolState = {
  phase: 'pending' | 'granted' | 'revoked';
  grantedStreams: string[];     // stream keys the user authorized
  grantedFields: string[];     // fields the grant authorizes (for the posts stream)
  optionalIncluded: boolean;   // whether the optional stream was included
};

const ALL_POST_FIELDS = ['id', 'caption', 'taken_at', 'media_type', 'like_count', 'comment_count', 'location', 'is_pinned'];
const DEFAULT_GRANTED_FIELDS = ['id', 'caption', 'taken_at', 'media_type'];

// ─── Page ───────────────────────────────────────────────────────────────────

export default function ReferencePage() {
  const [activeSection, setActiveSection] = useState<SectionId>('ingest');
  const observerRef = useRef<IntersectionObserver | null>(null);

  // Protocol state: flows from Consent (§4) through Grant (§5), Enforce (§6), Revoke (§8)
  const [protocol, setProtocol] = useState<ProtocolState>({
    phase: 'pending',
    grantedStreams: ['following', 'posts'],
    grantedFields: DEFAULT_GRANTED_FIELDS,
    optionalIncluded: false,
  });

  const handleAllow = useCallback(() => {
    setProtocol(prev => ({ ...prev, phase: 'granted' }));
  }, []);

  const handleDeny = useCallback(() => {
    setProtocol({ phase: 'pending', grantedStreams: [], grantedFields: [], optionalIncluded: false });
  }, []);

  const handleRevoke = useCallback(() => {
    setProtocol(prev => ({ ...prev, phase: 'revoked' }));
  }, []);

  const handleReset = useCallback(() => {
    setProtocol({ phase: 'pending', grantedStreams: ['following', 'posts'], grantedFields: DEFAULT_GRANTED_FIELDS, optionalIncluded: false });
  }, []);

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
  const grantProps: GrantInspectorProps = {
    ...GRANT_SPECIMEN,
    status: protocol.phase === 'revoked' ? 'revoked' : protocol.phase === 'granted' ? 'active' : 'active',
  };

  return (
    <div className="min-h-screen" style={{ backgroundColor: 'var(--background)', color: 'var(--foreground)' }}>

      {/* Sticky header */}
      <header
        className="sticky top-0 z-40 flex h-12 items-center px-6 gap-3"
        style={{
          backgroundColor: 'var(--background)',
          backdropFilter: 'blur(8px)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div className="flex items-center gap-2.5 shrink-0">
          <div
            className="w-5 h-5 rounded flex items-center justify-center shrink-0"
            style={{ background: 'var(--primary)' }}
          >
            <span className="text-[9px] font-bold leading-none" style={{ color: 'var(--primary-foreground)' }}>P</span>
          </div>
          <span className="text-sm font-semibold tracking-tight" style={{ color: 'var(--foreground)' }}>PDPP</span>
          <span style={{ color: 'var(--muted-foreground)', opacity: 0.4, margin: '0 2px' }}>/</span>
          <span className="text-sm" style={{ color: 'var(--muted-foreground)' }}>Reference</span>
        </div>
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
          className="text-xs transition-opacity hover:opacity-70"
          style={{ color: 'var(--muted-foreground)' }}
        >
          Design System
        </a>
        <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>v0.1.0</span>
      </header>

      {/* Right-side stepper (large screens) */}
      <Stepper activeId={activeSection} onNavigate={navigateTo} />

      {/* ── Sections ── */}

      {/* 1. Ingest */}
      <Section
        config={SECTION_CONTENT[0]}
        detail={
          <DetailPanel spec="§7 Manifest">
            <p>Each connector publishes a manifest declaring its consent surface: streams, fields, views, and selection capabilities. The manifest is the source of truth for what can be consented to.</p>
            <p>Connectors run as child processes. The runtime sends a START message (collection_mode, state, bindings) via stdin; the connector streams RECORD/STATE/DONE messages back via stdout JSONL.</p>
          </DetailPanel>
        }
      >
        <ConnectorCard {...CONNECTOR_SPECIMEN} />
      </Section>

      {/* 2. Inventory */}
      <Section
        config={SECTION_CONTENT[1]}
        detail={
          <DetailPanel spec="§4 Record Model">
            <p>Personal data is modeled as flat records in named streams. Every stream has a declared primary key, a semantic type (append_only or mutable_state), and a JSON Schema.</p>
            <p>append_only streams (~95% of data by volume) are immutable events. mutable_state streams are evolving entities that require version history for incremental sync.</p>
          </DetailPanel>
        }
      >
        <StreamInventory {...INVENTORY_SPECIMEN} />
      </Section>

      {/* 3. Request */}
      <Section
        config={SECTION_CONTENT[2]}
        detail={
          <DetailPanel spec="§5 Selection Request">
            <p>Selection requests use the RFC 9396 authorization_details envelope. The AS must accept any syntactically valid purpose code URI and must not reject solely because a code is unrecognized.</p>
            <p>client_display (name, URI, logo) is entity-scoped and self-asserted. client_claims.commitments are request-scoped and rendered with attribution.</p>
          </DetailPanel>
        }
      >
        <div
          data-surface="protocol"
          className="rounded-xl overflow-hidden px-5 py-6 w-full"
        >
          <div className="font-mono text-xs mb-3" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
            POST /authorize — authorization_details
          </div>
          <div className="flex flex-col gap-2">
            <div className="text-xs" style={{ color: 'var(--foreground)' }}>
              <span className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>client: </span>
              Audience Lens (verified)
            </div>
            <div className="text-xs" style={{ color: 'var(--foreground)' }}>
              <span className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>purpose: </span>
              <span style={{ color: 'var(--edu-fg)' }}>research</span>
            </div>
            <div className="text-xs" style={{ color: 'var(--foreground)' }}>
              <span className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>streams: </span>
              following_accounts, posts
            </div>
            <div className="text-xs" style={{ color: 'var(--foreground)' }}>
              <span className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>optional: </span>
              ad_targeting
            </div>
            <div className="text-xs" style={{ color: 'var(--foreground)' }}>
              <span className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>access_mode: </span>
              continuous
            </div>
            <div className="text-xs mt-2 italic" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>
              Audience Lens commits: data used only for this study, not sold or shared.
            </div>
          </div>
        </div>
      </Section>

      {/* 4. Consent — drives protocol state */}
      <Section
        config={SECTION_CONTENT[3]}
        detail={
          <DetailPanel spec="§5.1 Client Display, §5.2 Client Claims">
            <p>Three content layers: protocol facts (server-rendered from grant fields), server-trusted descriptions (manifest display.label and display.detail), and client-authored claims (rendered with "[name] says:" attribution).</p>
            <p>AI training purpose code requires explicit affirmative user consent. This is the sole protocol-level purpose code requirement.</p>
            <p>The AS must treat logo_uri as untrusted content. It must not render client-supplied logos unless the client is verified or the asset has been proxied and approved.</p>
          </DetailPanel>
        }
      >
        {protocol.phase === 'pending' ? (
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
      </Section>

      {/* 5. Grant — reads from protocol state, shows default when pending */}
      <Section
        config={SECTION_CONTENT[4]}
        detail={
          <DetailPanel spec="§6 Grant">
            <p>The grant is an immutable consent artifact. Once issued, it cannot be modified. Changes require revoke-and-reissue.</p>
            <p>Three orthogonal time concepts: grant validity period (issued_at/expires_at), data temporal scope (time_range), and access pattern (access_mode). These must not be conflated.</p>
            <p className="font-mono" style={{ color: 'var(--muted-foreground)', opacity: 0.7 }}>
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

      {/* 6. Enforce — field projection, shows 403 when revoked */}
      <Section
        config={SECTION_CONTENT[5]}
        detail={
          <DetailPanel spec="§8 Resource Server">
            <p>The RS computes effective_filter = grant_filter AND request_filter. Request-time filters can only narrow what the grant allows, never widen it.</p>
            <p>Field projection is enforced on every response. Schema-required fields are always included regardless of the grant's field list.</p>
            <p>If a client requests a filter on a field outside the grant's authorized projection, the RS returns 403 field_not_granted.</p>
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
          <FieldProjection grantedFields={protocol.grantedFields} allFields={ALL_POST_FIELDS} />
        )}
      </Section>

      {/* 7. Sync — incremental sync animation */}
      <Section
        config={SECTION_CONTENT[6]}
        detail={
          <DetailPanel spec="§4.1 Incremental Sync">
            <p>changes_since returns full current state of changed records, not field-level diffs. The RS maintains version history for mutable_state streams.</p>
            <p>Projection-aware deltas: if unauthorized field C changes but the client is only authorized for fields A and B, the record does not appear in the delta. The client cannot infer that C changed.</p>
            <p>cursor (pagination) and changes_since (sync) are opaque tokens from distinct token spaces. A client must not substitute one for the other.</p>
          </DetailPanel>
        }
      >
        <IncrementalSync />
      </Section>

      {/* 8. Revoke — shows grant with revoke action, or revoked state */}
      <Section
        config={SECTION_CONTENT[7]}
        detail={
          <DetailPanel spec="§6.5 Revocation">
            <p>Revocation stops future access only. Records already delivered before revocation are governed by the grant's retention policy.</p>
            <p>Revocation propagation is bounded by the introspection cache TTL (max 60 seconds). The AS reflects revocation immediately; the RS will serve a 403 no later than 60s after revocation.</p>
            <p>Grant narrowing is not supported. Scope reduction is achieved via revoke-and-reissue.</p>
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

      {/* 9. Export */}
      <Section
        config={SECTION_CONTENT[8]}
        detail={
          <DetailPanel spec="§8.3 Owner Tokens">
            <p>Two token types: owner tokens (for ingest, management, self-export) and client tokens (for querying under a grant). The RS determines token kind from the introspection response, never from syntax.</p>
            <p>Owner tokens are scoped to a single subject's data store. The RS derives subject_id from introspection and rejects any request outside that scope.</p>
          </DetailPanel>
        }
      >
        <div
          data-surface="human"
          className="rounded-xl overflow-hidden px-5 py-6 w-full"
        >
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full" style={{ backgroundColor: 'var(--success)' }} />
            <span className="text-xs font-medium" style={{ color: 'var(--success)' }}>Owner access</span>
            <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>No grant required</span>
          </div>
          <div className="flex flex-col gap-2">
            {['following_accounts', 'posts', 'ad_targeting'].map(s => (
              <div key={s} className="flex items-center justify-between py-1.5" style={{ borderBottom: '1px solid var(--border)' }}>
                <span className="text-xs font-medium" style={{ color: 'var(--foreground)' }}>{s}</span>
                <span className="font-mono text-xs" style={{ color: 'var(--muted-foreground)' }}>all fields</span>
              </div>
            ))}
          </div>
          <div className="text-xs mt-4" style={{ color: 'var(--muted-foreground)' }}>
            Your data, your export, your terms. No third-party authorization needed.
          </div>
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
