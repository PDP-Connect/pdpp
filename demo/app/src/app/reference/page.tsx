'use client';

import React, { useState, useEffect, useRef, useCallback } from 'react';
import {
  ConsentCard,
  GrantInspector,
  StreamInventory,
  ConnectorCard,
  SpecCitationGroup,
} from '@/components/pdpp';
import type {
  ConsentCardProps,
  GrantInspectorProps,
  StreamInventoryProps,
  ConnectorCardProps,
  SpecCitationProps,
} from '@/components/pdpp';

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

const SPEC_CITATIONS: SpecCitationProps[] = [
  { section: '5', label: 'Selection Request', href: '/spec-core#selection-request' },
  { section: '6', label: 'Grant', href: '/spec-core#grant' },
  { section: '7', label: 'Manifest', href: '/spec-core#manifest-format' },
  { section: '8', label: 'Resource Server', href: '/spec-core#resource-server' },
  { section: 'A', label: 'Purpose Codes', href: '/spec-core#purpose-codes' },
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

// ─── Section shell ──────────────────────────────────────────────────────────

function Section({
  config,
  children,
}: {
  config: SectionConfig;
  children: React.ReactNode;
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
        <div className="flex justify-center">
          {children}
        </div>
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
      <Section config={SECTION_CONTENT[0]}>
        <ConnectorCard {...CONNECTOR_SPECIMEN} />
      </Section>

      {/* 2. Inventory */}
      <Section config={SECTION_CONTENT[1]}>
        <StreamInventory {...INVENTORY_SPECIMEN} />
      </Section>

      {/* 3. Request — placeholder for selection request visualization */}
      <Section config={SECTION_CONTENT[2]}>
        <div
          data-surface="protocol"
          className="rounded-xl overflow-hidden px-5 py-6"
          style={{ maxWidth: '440px', width: '100%' }}
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
      <Section config={SECTION_CONTENT[3]}>
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

      {/* 5. Grant — reads from protocol state */}
      <Section config={SECTION_CONTENT[4]}>
        {protocol.phase === 'pending' ? (
          <div className="text-xs text-center py-12" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>
            Grant the request in the previous section to see the grant inspector.
          </div>
        ) : (
          <GrantInspector
            {...grantProps}
            onRevoke={protocol.phase === 'granted' ? handleRevoke : undefined}
          />
        )}
      </Section>

      {/* 6. Enforce — field projection, reads granted fields from state */}
      <Section config={SECTION_CONTENT[5]}>
        {protocol.phase === 'pending' ? (
          <div className="text-xs text-center py-12" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>
            Grant the request to see field projection enforcement.
          </div>
        ) : protocol.phase === 'revoked' ? (
          <div
            data-surface="protocol"
            className="rounded-xl overflow-hidden px-5 py-8 text-center"
            style={{ maxWidth: '440px', width: '100%' }}
          >
            <div className="font-mono text-xs mb-2" style={{ color: 'var(--destructive)' }}>
              403 grant_revoked
            </div>
            <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
              The grant has been revoked. No further queries will be served.
            </div>
          </div>
        ) : (
          <div
            data-surface="protocol"
            className="rounded-xl overflow-hidden px-5 py-6"
            style={{ maxWidth: '440px', width: '100%' }}
          >
            <div className="font-mono text-xs mb-4" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
              GET /v1/streams/posts/records
            </div>

            <div className="flex flex-col gap-4">
              <div>
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>
                  Record on server ({ALL_POST_FIELDS.length} fields)
                </div>
                <div className="flex flex-wrap gap-1">
                  {ALL_POST_FIELDS.map(f => {
                    const granted = protocol.grantedFields.includes(f);
                    return (
                      <span
                        key={f}
                        className="font-mono text-xs px-1.5 py-0.5 rounded"
                        style={{
                          backgroundColor: granted ? 'oklch(0.52 0.15 150 / 0.1)' : 'var(--muted)',
                          color: granted ? 'var(--success)' : 'var(--muted-foreground)',
                          opacity: granted ? 1 : 0.5,
                        }}
                      >
                        {f}
                      </span>
                    );
                  })}
                </div>
              </div>

              <div className="flex items-center gap-2">
                <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
                <span className="text-xs font-mono" style={{ color: 'var(--muted-foreground)' }}>grant filter</span>
                <div className="flex-1 h-px" style={{ backgroundColor: 'var(--border)' }} />
              </div>

              <div>
                <div className="text-xs font-medium mb-2" style={{ color: 'var(--success)' }}>
                  Response to client ({protocol.grantedFields.length} fields)
                </div>
                <div className="flex flex-wrap gap-1">
                  {protocol.grantedFields.map(f => (
                    <span
                      key={f}
                      className="font-mono text-xs px-1.5 py-0.5 rounded"
                      style={{ backgroundColor: 'oklch(0.52 0.15 150 / 0.1)', color: 'var(--success)' }}
                    >
                      {f}
                    </span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}
      </Section>

      {/* 7. Sync — placeholder for incremental sync animation */}
      <Section config={SECTION_CONTENT[6]}>
        <div
          data-surface="protocol"
          className="rounded-xl overflow-hidden px-5 py-6"
          style={{ maxWidth: '440px', width: '100%' }}
        >
          <div className="flex flex-col gap-4">
            <div>
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>First query: 22 posts</div>
              <div className="flex items-center gap-1">
                {Array.from({ length: 22 }, (_, i) => (
                  <div key={i} className="w-1.5 h-3 rounded-sm" style={{ backgroundColor: 'var(--primary)', opacity: 0.6 }} />
                ))}
              </div>
              <div className="font-mono text-xs mt-1" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                next_changes_since: "cursor_a8f2..."
              </div>
            </div>

            <div className="h-px" style={{ backgroundColor: 'var(--border)' }} />

            <div>
              <div className="text-xs font-medium mb-2" style={{ color: 'var(--muted-foreground)' }}>
                Sync one week later: <span style={{ color: 'var(--success)' }}>3 new posts</span>
              </div>
              <div className="flex items-center gap-1">
                {Array.from({ length: 22 }, (_, i) => (
                  <div key={i} className="w-1.5 h-3 rounded-sm" style={{ backgroundColor: 'var(--border)' }} />
                ))}
                {Array.from({ length: 3 }, (_, i) => (
                  <div key={`new-${i}`} className="w-1.5 h-3 rounded-sm" style={{ backgroundColor: 'var(--success)' }} />
                ))}
              </div>
              <div className="font-mono text-xs mt-1" style={{ color: 'var(--muted-foreground)', opacity: 0.6 }}>
                changes_since: "cursor_a8f2..." → 3 records returned
              </div>
            </div>
          </div>
        </div>
      </Section>

      {/* 8. Revoke — connected to protocol state */}
      <Section config={SECTION_CONTENT[7]}>
        {protocol.phase === 'pending' ? (
          <div className="text-xs text-center py-12" style={{ color: 'var(--muted-foreground)', opacity: 0.5 }}>
            Grant the request to see revocation.
          </div>
        ) : protocol.phase === 'revoked' ? (
          <div className="flex flex-col items-center gap-3" style={{ maxWidth: '440px', width: '100%' }}>
            <div
              className="w-full rounded-xl px-6 py-8 flex flex-col items-center gap-3 text-center"
              style={{ border: '1px solid var(--border)', backgroundColor: 'var(--card)' }}
            >
              <div className="w-8 h-8 rounded-full flex items-center justify-center text-sm" style={{ backgroundColor: 'var(--destructive)', color: 'white' }}>
                ×
              </div>
              <div className="text-sm font-medium">Grant revoked</div>
              <div className="text-xs" style={{ color: 'var(--muted-foreground)' }}>
                Access has been revoked. Scroll up to section 6 to see the 403 response.
              </div>
            </div>
            <button
              className="font-mono text-xs px-0.5"
              style={{ color: 'var(--muted-foreground)' }}
              onClick={handleReset}
            >
              ↺ reset entire flow
            </button>
          </div>
        ) : (
          <GrantInspector {...grantProps} onRevoke={handleRevoke} />
        )}
      </Section>

      {/* 9. Export — placeholder for self-export visualization */}
      <Section config={SECTION_CONTENT[8]}>
        <div
          data-surface="human"
          className="rounded-xl overflow-hidden px-5 py-6"
          style={{ maxWidth: '440px', width: '100%' }}
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
        <div className="flex flex-col gap-4" style={{ maxWidth: '440px', width: '100%' }}>
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

      {/* 11. Spec */}
      <Section config={SECTION_CONTENT[10]}>
        <div className="flex flex-col items-center gap-6" style={{ maxWidth: '440px', width: '100%' }}>
          <SpecCitationGroup citations={SPEC_CITATIONS} />
          <a
            href="https://pdpp.vercel.app/spec-core"
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm font-medium transition-opacity hover:opacity-70"
            style={{ color: 'var(--primary)' }}
          >
            Read the specification →
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
