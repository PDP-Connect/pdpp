'use client';

import { useState } from 'react';
import { DemoPhase } from '@/lib/types';
import { SPEC, SpecRef } from '@/lib/spec-refs';
import { PurposeDocument } from './PurposeDocument';
import { SpecAnnotation } from './SpecAnnotation';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';

interface Props {
  phase: DemoPhase;
  researchGrant: Record<string, unknown> | null;
  researchGrantIssuedAt: string | null;
  seeded: { following_accounts: number; posts: number; ad_targeting: number } | null;
  clientResults: Record<string, unknown[]>;
  rawResults: Record<string, unknown[]>;
  tokenSpent: boolean;
  grantRevoked: boolean;
  aiGrantApproved: boolean;
  gmailConnected: boolean;
  gmailSummary: { total_threads: number; label_counts: Record<string, number> } | null;
  onStart: () => void;
  onRevoke: () => void;
  onQueryAgain: () => void;
  onStartScrape: () => void;
  onIncrementalSync?: () => void;
  incrementalPostCount: number | null;
  syncStateUpdated: boolean;
  onConnectGmail: (onCredsCollected: () => void) => Promise<void> | void;
}

export function ClientPanel({
  phase, researchGrant, researchGrantIssuedAt, seeded,
  clientResults, rawResults,
  tokenSpent, grantRevoked, aiGrantApproved,
  gmailConnected, gmailSummary,
  onStart, onRevoke, onQueryAgain, onIncrementalSync, incrementalPostCount, syncStateUpdated,
  onConnectGmail,
}: Props) {
  const [grantOpen, setGrantOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<'following' | 'posts' | 'ads'>('following');

  const clientFollowing = (clientResults.following_accounts || []) as Record<string, unknown>[];
  const clientPosts     = (clientResults.posts || []) as Record<string, unknown>[];
  const ownerFollowing  = (rawResults.following_accounts || []) as Record<string, unknown>[];
  const ownerPosts      = (rawResults.posts || []) as Record<string, unknown>[];
  const ownerAds        = (rawResults.ad_targeting || []) as Record<string, unknown>[];
  const adRecord = ownerAds[0] as { data?: { topics?: string[]; advertisers?: string[]; categories?: string[] } } | undefined;
  const adTopics      = adRecord?.data?.topics      || [];
  const adAdvertisers = adRecord?.data?.advertisers || [];
  const adCategories  = adRecord?.data?.categories  || [];

  const isIdle       = phase === 'idle';
  const isRequesting = phase === 'requesting';
  const isConsenting = phase === 'consenting_research';
  const isScraping   = phase === 'scraping' || phase === 'authenticating';
  const hasResults   = phase === 'showing_results' || phase === 'consenting_ai' || phase === 'done';

  return (
    <div className="flex flex-col h-full overflow-hidden bg-background">
      <div className="flex items-center gap-2 px-4 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-muted-foreground">Client App</span>
        <div className="flex-1" />
        <StatusDot phase={phase} />
      </div>

      <div className="flex-1 overflow-auto flex flex-col">

        {isIdle && (
          <div className="flex-1 flex flex-col items-center justify-center gap-4 px-6 py-8 text-center">
            <div className="flex flex-col gap-1.5">
              <div className="text-sm font-semibold text-foreground">Audience Lens</div>
              <div className="text-xs text-muted-foreground leading-relaxed max-w-[220px]">
                An influencer analytics platform requesting access to your Instagram social graph.
              </div>
            </div>
            <Button onClick={onStart} className="w-full max-w-[200px]">
              Connect Instagram
            </Button>
            <p className="text-xs text-muted-foreground max-w-[220px]">
              Your personal server already has your Instagram data. No live scraping required.
            </p>
          </div>
        )}

        {isRequesting && (
          <div className="flex-1 flex flex-col justify-center p-5 gap-3">
            <div className="flex items-center gap-2">
              <Spinner />
              <span className="text-sm text-muted-foreground">Starting personal server…</span>
            </div>
            {seeded && (
              <p className="text-xs text-muted-foreground">
                Seeding {seeded.following_accounts} accounts · {seeded.posts} posts · ad targeting data
              </p>
            )}
          </div>
        )}

        {isConsenting && (
          <div className="p-4 flex flex-col gap-3">
            <SectionLabel>Grant request</SectionLabel>
            <GrantRequestCard grant={{
              client_id: 'audience_lens_app',
              purpose_code: 'https://pdpp.org/purpose/research',
              access_mode: 'single_use',
              streams: [
                { name: 'following_accounts', view: 'social_graph', fields: ['id', 'username'] },
                { name: 'posts', view: 'summary', fields: ['id', 'shortcode', 'taken_at', 'media_type'], time_range: true },
              ],
            }} />
            <p className="text-xs text-muted-foreground">
              Waiting for your approval in the personal server
            </p>
          </div>
        )}

        {isScraping && (
          <div className="p-4 flex flex-col gap-3">
            <SectionLabel>Live sync in progress</SectionLabel>
            <div className="flex items-center gap-2">
              <Spinner />
              <div>
                <div className="text-sm font-medium text-foreground">Personal server collecting from Instagram</div>
                <div className="text-xs text-muted-foreground">Audience Lens has no direct Instagram access</div>
              </div>
            </div>
          </div>
        )}

        {hasResults && (
          <div className="p-4 flex flex-col gap-3">

            {researchGrant && (
              <div>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setGrantOpen(v => !v)}
                  className="w-full justify-between font-mono text-xs"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-primary">grant</span>
                    <span className="text-muted-foreground">{String(researchGrant.grant_id).slice(0, 18)}…</span>
                  </span>
                  <span className="text-muted-foreground">{grantOpen ? '▲' : '▼'}</span>
                </Button>
                {grantOpen && (
                  <div className="mt-1 p-3 rounded-md overflow-auto max-h-48 border border-border bg-card">
                    <pre className="font-mono text-xs leading-relaxed whitespace-pre-wrap break-words m-0 text-muted-foreground">
                      {JSON.stringify(researchGrant, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            )}

            <SpecFeatureList
              tokenSpent={tokenSpent}
              grantRevoked={grantRevoked}
              aiGrantApproved={aiGrantApproved}
              clientPosts={clientPosts}
              ownerPosts={ownerPosts}
              syncStateUpdated={syncStateUpdated}
              incrementalPostCount={incrementalPostCount}
            />

            <div>
              <div className="flex gap-1 mb-2">
                {(['following', 'posts', 'ads'] as const).map(tab => (
                  <Button
                    key={tab}
                    size="sm"
                    variant={activeTab === tab ? 'secondary' : 'ghost'}
                    onClick={() => setActiveTab(tab)}
                    className="flex-1 text-xs"
                  >
                    {tab === 'following' ? 'Following' : tab === 'posts' ? 'Posts' : 'Ads'}
                  </Button>
                ))}
              </div>
              {activeTab === 'following' && <FollowingComparison clientFollowing={clientFollowing} ownerFollowing={ownerFollowing} />}
              {activeTab === 'posts' && <PostsComparison clientPosts={clientPosts} ownerPosts={ownerPosts} grantIssuedAt={researchGrantIssuedAt} />}
              {activeTab === 'ads' && <AdsComparison adTopics={adTopics} adAdvertisers={adAdvertisers} adCategories={adCategories} />}
            </div>

            <div className="flex flex-col gap-2 pt-1">
              <Separator />
              <SectionLabel>Test enforcement</SectionLabel>

              {!grantRevoked && !tokenSpent && (
                <div className="flex gap-1.5">
                  <Button variant="outline" size="sm" onClick={onQueryAgain} className="flex-1 text-xs"
                    title="single_use grant was consumed on first query — should return 403">
                    Query again
                  </Button>
                  <Button variant="destructive" size="sm" onClick={onRevoke} className="flex-1 text-xs"
                    title="Revoke the grant — all future queries return 403 grant_revoked">
                    Revoke grant
                  </Button>
                </div>
              )}

              {tokenSpent && <EnforcementResult variant="primary" title="single_use enforced" body="The grant was consumed on first query. RS returned 403 on the second attempt." spec={SPEC.accessModes} />}
              {grantRevoked && <EnforcementResult variant="destructive" title="Grant revoked" body="RS returned 403 grant_revoked. Propagates via token introspection within 60s." spec={SPEC.revocation} />}

              {phase === 'done' && incrementalPostCount !== null && (
                <div className="p-3 rounded-md border border-border">
                  <div className="text-xs font-medium text-foreground mb-1">changes_since: {incrementalPostCount} new posts</div>
                  <div className="text-xs text-muted-foreground">RS returned only records with version &gt; cursor — incremental sync complete.</div>
                  <div className="font-mono text-xs mt-1 text-muted-foreground">
                <SpecLink spec={SPEC.listRecords} /> · <SpecLink spec={SPEC.collectionProfile} />
              </div>
                </div>
              )}

              {onIncrementalSync && (
                <Button variant="outline" size="sm" onClick={onIncrementalSync} className="w-full text-xs"
                  title="Re-scrape incrementally — connector resumes from saved cursor">
                  Incremental sync (from cursor)
                </Button>
              )}
            </div>
          </div>
        )}

        {!isIdle && (
          <div className="px-4 pb-4">
            <GmailConnectorCard connected={gmailConnected} summary={gmailSummary} onConnect={onConnectGmail} />
          </div>
        )}
      </div>
    </div>
  );
}

function FollowingComparison({ clientFollowing, ownerFollowing }: {
  clientFollowing: Record<string, unknown>[];
  ownerFollowing: Record<string, unknown>[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <CompareHeader left={`${clientFollowing.length} accounts — id, username only`} right={`${ownerFollowing.length} accounts — all fields`} leftLabel="Client received" rightLabel="Owner sees" specNote={SPEC.streamMetadata} />
      <div className="grid grid-cols-2 gap-1.5">
        <Card size="sm" className="overflow-hidden border-primary/25">
          <CardContent className="p-0">
            {clientFollowing.slice(0, 6).map((a, i) => {
              const d = a.data as Record<string, unknown> | undefined;
              return (
                <div key={i} className="px-2 py-1.5 text-xs leading-snug border-b border-border last:border-0">
                  <span className="font-medium text-foreground">@{d?.username as string}</span>
                </div>
              );
            })}
            {clientFollowing.length > 6 && <div className="px-2 py-1 text-xs text-muted-foreground border-t border-border">+{clientFollowing.length - 6} more</div>}
          </CardContent>
        </Card>
        <Card size="sm" className="overflow-hidden">
          <CardContent className="p-0">
            {ownerFollowing.slice(0, 6).map((a, i) => {
              const d = a.data as Record<string, unknown> | undefined;
              return (
                <div key={i} className="px-2 py-1.5 text-xs leading-snug border-b border-border last:border-0">
                  <span className="font-medium text-foreground">@{d?.username as string}</span>
                  {d?.full_name && <span className="text-muted-foreground ml-1">{d.full_name as string}</span>}
                  {d?.is_verified && <span className="ml-1 text-xs text-primary">✓</span>}
                </div>
              );
            })}
            {ownerFollowing.length > 6 && <div className="px-2 py-1 text-xs text-muted-foreground border-t border-border">+{ownerFollowing.length - 6} more</div>}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function PostsComparison({ clientPosts, ownerPosts, grantIssuedAt }: {
  clientPosts: Record<string, unknown>[];
  ownerPosts: Record<string, unknown>[];
  grantIssuedAt: string | null;
}) {
  const consentTime = grantIssuedAt
    ? new Date(grantIssuedAt).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : 'now';
  return (
    <div className="flex flex-col gap-2">
      <CompareHeader left={`${clientPosts.length} posts — after ${consentTime}`} right={`${ownerPosts.length} posts — all time`} leftLabel="Client received" rightLabel="Owner sees" specNote={SPEC.manifestFormat} />
      <div className="grid grid-cols-2 gap-1.5">
        <Card size="sm" className="border-primary/25">
          <CardContent className="flex flex-col items-center justify-center min-h-20 gap-1 p-3">
            <div className="text-3xl font-bold tabular-nums text-foreground">{clientPosts.length}</div>
            <div className="text-xs text-muted-foreground text-center">posts since consent</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex flex-col items-center justify-center min-h-20 gap-1 p-3">
            <div className="text-3xl font-bold tabular-nums text-foreground">{ownerPosts.length}</div>
            <div className="text-xs text-muted-foreground text-center">posts total (owner)</div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function AdsComparison({ adTopics, adAdvertisers, adCategories }: {
  adTopics: string[];
  adAdvertisers: string[];
  adCategories: string[];
}) {
  return (
    <div className="flex flex-col gap-2">
      <CompareHeader left="Stream not in grant" right={`${adTopics.length} topics · ${adAdvertisers.length} advertisers`} leftLabel="Client received" rightLabel="Owner sees" specNote={SPEC.errors} />
      <div className="grid grid-cols-2 gap-1.5">
        <Card size="sm">
          <CardContent className="flex flex-col items-center justify-center min-h-20 p-3">
            <div className="text-xs text-muted-foreground text-center font-mono">403 grant_stream_not_allowed</div>
          </CardContent>
        </Card>
        <Card size="sm">
          <CardContent className="flex flex-col gap-1 min-h-20 p-2.5">
            {adTopics.slice(0, 3).map((t, i) => <Badge key={i} variant="secondary" className="text-xs w-fit">{t}</Badge>)}
            {adAdvertisers.slice(0, 2).map((a, i) => <Badge key={i} variant="outline" className="text-xs w-fit">{a}</Badge>)}
            {(adTopics.length + adAdvertisers.length) > 5 && (
              <span className="text-xs text-muted-foreground">+{adTopics.length + adAdvertisers.length + adCategories.length - 5} more</span>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function SpecFeatureList({ tokenSpent, grantRevoked, aiGrantApproved, clientPosts, ownerPosts, syncStateUpdated, incrementalPostCount }: {
  tokenSpent: boolean; grantRevoked: boolean; aiGrantApproved: boolean;
  clientPosts: Record<string, unknown>[]; ownerPosts: Record<string, unknown>[];
  syncStateUpdated: boolean; incrementalPostCount: number | null;
}) {
  const features: { label: string; done: boolean; spec: SpecRef }[] = [
    { label: 'Purpose binding',     done: true,                                              spec: SPEC.selectionRequest },
    { label: 'Field projection',    done: true,                                              spec: SPEC.streamMetadata },
    { label: 'Stream isolation',    done: true,                                              spec: SPEC.errors },
    { label: 'Temporal gating',     done: ownerPosts.length > 0 && clientPosts.length === 0, spec: SPEC.manifestFormat },
    { label: 'resources filter',    done: ownerPosts.length > 0,                             spec: SPEC.selectionRequest },
    { label: 'filter[field] query', done: ownerPosts.length > 0,                             spec: SPEC.listRecords },
    { label: 'Incremental STATE',   done: syncStateUpdated,                                  spec: SPEC.collectionProfile },
    { label: 'changes_since query', done: incrementalPostCount !== null,                     spec: SPEC.listRecords },
    { label: 'AI training consent', done: aiGrantApproved,                                   spec: SPEC.aiTrainingConsent },
    { label: 'single_use expiry',   done: tokenSpent,                                        spec: SPEC.accessModes },
    { label: 'Grant revocation',    done: grantRevoked,                                      spec: SPEC.revocation },
  ];

  return (
    <SpecAnnotation label="Spec features active">
      <div className="flex flex-col gap-1">
        {features.map(({ label, done, spec }) => (
          <div key={label} className="flex items-center gap-2">
            <span className="text-xs w-3 text-center shrink-0 text-muted-foreground">{done ? '✓' : '○'}</span>
            <span className={`text-xs flex-1 ${done ? 'text-foreground' : 'text-muted-foreground'}`}>{label}</span>
            <SpecLink spec={spec} />
          </div>
        ))}
      </div>
    </SpecAnnotation>
  );
}

function GrantRequestCard({ grant }: { grant: Record<string, unknown> }) {
  const streams = (grant.streams as Array<Record<string, unknown>>) || [];
  return (
    <Card size="sm">
      <CardContent className="p-3 flex flex-col gap-2">
        <div className="flex gap-3 flex-wrap items-start">
          <FieldPair label="client" value={String(grant.client_id)} />
          <div className="flex flex-col gap-0.5">
            <div className="text-xs text-muted-foreground">purpose</div>
            <PurposeDocument purposeUri={String(grant.purpose_code)} />
          </div>
          <FieldPair label="mode" value={String(grant.access_mode)} />
        </div>
        <div className="flex flex-col gap-1">
          {streams.map((s, i) => (
            <div key={i} className="flex items-center gap-1.5 text-xs rounded px-2 py-1 bg-muted">
              <span className="text-foreground">—</span>
              <span className="font-medium text-foreground">{String(s.name)}</span>
              {s.view && <span className="text-muted-foreground">view: {String(s.view)}</span>}
              {s.time_range && <Badge variant="outline" className="text-xs ml-auto">time-gated</Badge>}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}

function CompareHeader({ left, right, leftLabel, rightLabel, specNote }: {
  left: string; right: string; leftLabel: string; rightLabel: string; specNote: SpecRef;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex justify-between">
        <div>
          <div className="text-xs font-medium text-primary">{leftLabel}</div>
          <div className="text-xs text-muted-foreground">{left}</div>
        </div>
        <div className="text-right">
          <div className="text-xs text-muted-foreground">{rightLabel}</div>
          <div className="text-xs text-muted-foreground">{right}</div>
        </div>
      </div>
      <SpecLink spec={specNote} />
    </div>
  );
}

function SpecLink({ spec }: { spec: SpecRef }) {
  return (
    <a href={spec.url} target="_blank" rel="noopener noreferrer" className="font-mono text-xs text-muted-foreground hover:text-foreground">
      {spec.label}
    </a>
  );
}

function EnforcementResult({ variant, title, body, spec }: {
  variant: 'primary' | 'destructive'; title: string; body: string; spec: SpecRef;
}) {
  return (
    <div className="rounded-md p-3 border border-border">
      <div className="flex items-center gap-1.5 mb-1">
        <span className={`text-xs font-medium ${variant === 'destructive' ? 'text-destructive' : 'text-primary'}`}>{title}</span>
        <span className="ml-auto"><SpecLink spec={spec} /></span>
      </div>
      <div className="text-xs text-muted-foreground">{body}</div>
    </div>
  );
}

function GmailConnectorCard({ connected, summary, onConnect }: {
  connected: boolean;
  summary: { total_threads: number; label_counts: Record<string, number> } | null;
  onConnect: (onCredsCollected: () => void) => Promise<void> | void;
}) {
  const [connecting, setConnecting] = useState(false);
  const handleClick = async () => {
    if (connected || connecting) return;
    await onConnect(() => setConnecting(true));
    setConnecting(false);
  };
  const labelOrder = ['inbox', 'work', 'commerce', 'newsletters', 'travel', 'security'];

  return (
    <div className="flex flex-col gap-2 pt-3">
      <Separator />
      <div className="flex items-center gap-2 pt-1">
        <SectionLabel>Second connector</SectionLabel>
        <Badge variant="outline" className="font-mono text-xs">api_key</Badge>
      </div>
      <Card size="sm" className="overflow-hidden">
        <CardContent className="p-0">
          <div className="p-3 flex items-center gap-2.5">
            <div className="w-8 h-8 rounded shrink-0 bg-muted flex items-center justify-center text-xs font-mono text-muted-foreground">G</div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-foreground">Gmail</div>
              <div className="text-xs text-muted-foreground">IMAP · email_threads stream</div>
            </div>
            {connected && <Badge variant="outline" className="text-xs shrink-0">Synced</Badge>}
          </div>
          {!connected && (
            <>
              <div className="px-3 pb-2 text-xs text-muted-foreground leading-relaxed">
                No browser needed — IMAP app password authenticates directly. Only headers collected: subject, sender, labels, date.
              </div>
              <div className="px-3 pb-3">
                <Button onClick={handleClick} disabled={connecting} className="w-full" size="sm">
                  {connecting ? 'Connecting…' : 'Connect Gmail'}
                </Button>
              </div>
            </>
          )}
          {connected && summary && (
            <div className="px-3 py-2.5 border-t border-border">
              <div className="text-xs text-muted-foreground mb-2">{summary.total_threads} threads in personal server</div>
              <div className="flex flex-wrap gap-1">
                {labelOrder.map(label => {
                  const count = summary.label_counts[label];
                  if (!count) return null;
                  return <Badge key={label} variant="secondary" className="text-xs">{count} {label}</Badge>;
                })}
              </div>
              <div className="text-xs mt-2"><SpecLink spec={SPEC.collectionProfile} /></div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return <div className="text-xs font-medium text-muted-foreground">{children}</div>;
}

function FieldPair({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="text-xs font-mono text-foreground">{value}</div>
    </div>
  );
}

function StatusDot({ phase }: { phase: DemoPhase }) {
  const color = phase === 'done' || phase === 'showing_results' ? 'var(--success)'
    : phase === 'error' ? 'var(--destructive)'
    : phase === 'idle' ? 'var(--border)'
    : 'var(--primary)';
  const label = phase === 'done' ? 'Connected'
    : phase === 'showing_results' || phase === 'consenting_ai' ? 'Grant active'
    : phase === 'error' ? 'Error'
    : phase === 'idle' ? 'Offline'
    : 'Active';
  return (
    <div className="flex items-center gap-1.5 shrink-0">
      <div className="w-1.5 h-1.5 rounded-full" style={{ background: color }} />
      <span className="text-xs text-muted-foreground">{label}</span>
    </div>
  );
}

function Spinner() {
  return (
    <span className="w-3 h-3 rounded-full inline-block shrink-0" style={{
      border: '2px solid var(--border)',
      borderTopColor: 'var(--primary)',
      animation: 'spin 0.8s linear infinite',
    }} />
  );
}
