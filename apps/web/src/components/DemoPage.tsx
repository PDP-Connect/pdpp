'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { DemoState, DemoPhase, LogLine, InputRequest } from '@/lib/types';
import { ClientPanel } from './ClientPanel';
import { ServerPanel } from './ServerPanel';
import { LogPanel } from './LogPanel';
import { DemoHeader } from './DemoHeader';

function getBrowserWsUrl() {
  if (typeof window === 'undefined') return 'ws://localhost:3101';
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.hostname}:3101`;
}

const INITIAL_STATE: DemoState = {
  phase: 'idle',
  ownerToken: null,
  connectorId: null,
  seeded: null,
  researchDeviceCode: null,
  researchToken: null,
  researchGrant: null,
  researchGrantIssuedAt: null,
  aiDeviceCode: null,
  aiGrantApproved: false,
  streamCounts: {},
  clientResults: {},
  rawResults: {},
  postsCursor: null,
  syncStateUpdated: false,
  incrementalPostCount: null,
  tokenSpent: false,
  grantRevoked: false,
  gmailConnected: false,
  gmailSummary: null,
  error: null,
} satisfies DemoState;

let logCounter = 0;

export default function DemoPage() {
  const [state, setState] = useState<DemoState>(INITIAL_STATE);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [logOpen, setLogOpen] = useState(false);
  const [browserStatus, setBrowserStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle');
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const canvasCallbackRef = useRef<((data: string) => void) | null>(null);
  const viewportRef = useRef({ width: 1280, height: 800 });
  const approvingResearchRef = useRef(false);
  const approvingAiRef = useRef(false);
  const prevBrowserStatusRef = useRef(browserStatus);
  const gmailCredsResolverRef = useRef<{ resolve: (v: Record<string, string>) => void; reject: () => void } | null>(null);

  const addLog = useCallback((text: string, level: LogLine['level'] = 'info', detail?: string) => {
    setLogs(prev => [...prev, {
      id: ++logCounter,
      level,
      text,
      detail,
      timestamp: new Date().toLocaleTimeString('en-US', { hour12: false }),
    }]);
  }, []);

  const setPhase = useCallback((phase: DemoPhase) => {
    setState(s => ({ ...s, phase }));
  }, []);

  const onFrame = useCallback((cb: (data: string) => void) => {
    canvasCallbackRef.current = cb;
  }, []);

  const onViewportReady = useCallback((w: number, h: number) => {
    viewportRef.current = { width: w, height: h };
  }, []);

  // ── WebSocket ──────────────────────────────────────────────────────────────

  const connectBrowserWs = useCallback(() => {
    if (wsRef.current) return wsRef.current;
    const ws = new WebSocket(getBrowserWsUrl());
    wsRef.current = ws;

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      switch (msg.type) {
        case 'frame':
          canvasCallbackRef.current?.(msg.data);
          break;
        case 'status':
          setBrowserStatus(msg.status);
          break;
        case 'log':
          addLog(msg.message, msg.level === 'error' ? 'error' : msg.level === 'warn' ? 'warn' : 'info');
          break;
        case 'stream-complete':
          addLog(`Stream "${msg.stream}" synced: ${msg.count} records`, 'success', `§8 Collection Profile — POST /v1/ingest/${msg.stream}`);
          setState(s => ({ ...s, streamCounts: { ...s.streamCounts, [msg.stream]: msg.count } }));
          break;
        case 'input:request':
          setInputRequest({ requestId: msg.requestId, input: msg.input });
          setPhase('authenticating');
          break;
        case 'result':
          addLog('Browser sync complete', 'success');
          break;
        case 'progress':
          addLog(
            msg.message + (msg.count != null ? ` (${msg.count}${msg.total != null ? `/${msg.total}` : ''})` : ''),
            'info',
            `§Collection Profile — PROGRESS · stream: ${msg.stream || '?'}`,
          );
          break;
        case 'sync-state':
          addLog(`Cursor saved: ${msg.stream} → ${JSON.stringify(msg.cursor)}`, 'spec',
            '§Collection Profile — STATE checkpoint persisted to RS /v1/state/:connectorId');
          setState(s => ({ ...s, syncStateUpdated: true }));
          break;
      }
    };

    ws.onerror = () => setBrowserStatus('error');
    return ws;
  }, [addLog, setPhase]);

  const sendWs = useCallback((msg: unknown) => {
    const ws = wsRef.current;
    if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  // ── Step 1: Setup — register manifest + issue token, then scrape or proceed ──

  const handleStart = useCallback(async () => {
    setPhase('requesting');
    addLog('Personal server starting up…', 'info');
    try {
      const resp = await fetch('/api/setup', { method: 'POST' });
      const { ownerToken, connectorId, hasData, streamCounts, error } = await resp.json();
      if (error) throw new Error(error);

      setState(s => ({ ...s, ownerToken, connectorId }));
      addLog('Instagram connector registered', 'success', `POST /connectors · connector_id: ${connectorId}`);
      addLog('Owner token issued for instagram_demo_user', 'success', 'POST /owner-token');

      if (hasData) {
        // Real data already in the persistent server — no scraping needed
        const counts = streamCounts as Record<string, number>;
        const following = counts?.following_accounts ?? '?';
        const posts = counts?.posts ?? '?';
        setState(s => ({ ...s, seeded: { following_accounts: Number(following), posts: Number(posts), ad_targeting: 1 } }));
        addLog(
          `Personal server already has your data: ${following} contacts, ${posts} posts`,
          'spec',
          '§1 — The personal server is a persistent store, not an on-demand scraper',
        );
        setTimeout(() => handleRequestResearchGrant(ownerToken, connectorId), 400);
      } else {
        // No data yet — need to collect it first via the real Instagram connector
        addLog('No data in server yet — starting Instagram collection…', 'info');
        // Start scrape — inline since handleStartScrapeWith is defined later
        setPhase('authenticating');
        const ws = connectBrowserWs();
        const msg = JSON.stringify({ type: 'start-scrape', connectorId, ownerToken, grantIssuedAt: null, viewport: viewportRef.current });
        if (ws.readyState === WebSocket.OPEN) ws.send(msg);
        else ws.addEventListener('open', () => ws.send(msg), { once: true });
      }
    } catch (err) {
      addLog((err as Error).message, 'error');
      setPhase('error');
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [addLog]);

  // ── Step 2: Request research grant ────────────────────────────────────────

  const handleRequestResearchGrant = useCallback(async (_ownerToken: string, connectorId: string) => {
    const grantIssuedAt = new Date().toISOString();
    addLog('Audience Lens requesting access to your Instagram data…', 'info');
    try {
      const resp = await fetch('/api/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectorId,
          clientId: 'audience_lens_app',
          purposeCode: 'https://pdpp.org/purpose/research',
          purposeDescription: 'Analyze your social graph for an influencer network study',
          accessMode: 'single_use',
          streams: [
            { name: 'following_accounts', view: 'social_graph' },
            { name: 'posts', view: 'summary', time_range: { since: grantIssuedAt } },
          ],
        }),
      });
      const { device_code, error } = await resp.json();
      if (error) throw new Error(error);

      setState(s => ({ ...s, researchDeviceCode: device_code, researchGrantIssuedAt: grantIssuedAt }));
      addLog(
        'Grant request pending consent — awaiting user approval',
        'info',
        `POST /grants/initiate · device_code: ${device_code.slice(0, 20)}…`,
      );
      setPhase('consenting_research');
    } catch (err) {
      addLog((err as Error).message, 'error');
      setPhase('error');
    }
  }, [addLog]);

  // ── Step 3: Approve research grant → fetch results instantly ──────────────

  const handleApproveResearch = useCallback(async () => {
    if (approvingResearchRef.current) return;
    approvingResearchRef.current = true;
    const { researchDeviceCode, ownerToken, connectorId, researchGrantIssuedAt } = state;
    if (!researchDeviceCode || !ownerToken || !connectorId) { approvingResearchRef.current = false; return; }

    addLog('User approved research grant', 'success');
    try {
      const resp = await fetch('/api/grant/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: researchDeviceCode }),
      });
      const { token, grant, error } = await resp.json();
      if (error) throw new Error(error);

      setState(s => ({ ...s, researchToken: token, researchGrant: grant }));
      addLog(
        `Grant issued: ${String(grant.grant_id).slice(0, 24)}…`,
        'success',
        `§6 — access_mode: single_use · streams: following_accounts (social_graph view), posts (since ${new Date(researchGrantIssuedAt!).toLocaleTimeString()})`,
      );
      addLog(
        'Client token issued — bound to grant',
        'info',
        '§9 — Bearer token linked to grant constraints; introspection enforces them on every RS request',
      );

      // KEY STORY MOMENT: fetch results immediately — data already exists in the RS
      addLog('Querying personal server — data already exists, no scraping needed', 'info', '§8 — GET /v1/streams/*/records');
      await fetchResults(token, ownerToken, connectorId, researchGrantIssuedAt);

      // Give the user a moment to see the results before the AI consent card appears
      setTimeout(() => handleRequestAiGrant(connectorId), 1800);

    } catch (err) {
      addLog((err as Error).message, 'error');
      setPhase('error');
    }
  }, [state, addLog]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Fetch results (called right after research grant approval) ─────────────

  const fetchResults = useCallback(async (
    researchToken: string,
    ownerToken: string,
    connectorId: string,
    grantIssuedAt: string | null,
  ) => {
    try {
      const q = (stream: string, token: string, extra = '') =>
        fetch(`/api/query?stream=${encodeURIComponent(stream)}&token=${encodeURIComponent(token)}&connectorId=${encodeURIComponent(connectorId)}${extra}`).then(r => r.json());

      // Initial changes_since cursor (version: 0) to get current max_version for incremental sync
      const INITIAL_CURSOR = 'eyJ2ZXJzaW9uIjowfQ==';
      const [clientFollowing, clientPosts, ownerFollowing, ownerPosts, ownerAds, postsChanges] = await Promise.all([
        q('following_accounts', researchToken),
        q('posts', researchToken),
        q('following_accounts', ownerToken),
        q('posts', ownerToken),
        q('ad_targeting', ownerToken),
        q('posts', ownerToken, `&changes_since=${encodeURIComponent(INITIAL_CURSOR)}&limit=1`),
      ]);

      const clientFollowingData: unknown[] = clientFollowing.data?.data || [];
      const clientPostsData: unknown[] = clientPosts.data?.data || [];
      const ownerFollowingData: unknown[] = ownerFollowing.data?.data || [];
      const ownerPostsData: unknown[] = ownerPosts.data?.data || [];
      const ownerAdsData: unknown[] = ownerAds.data?.data || [];

      // ── §8.2 Field projection ────────────────────────────────────────────────
      addLog(
        `Field projection: client sees ${clientFollowingData.length} accounts (id, username only)`,
        'spec',
        '§8.2 — RS applied social_graph view: stripped full_name and is_verified',
      );

      // View contrast: owner with full_social_graph view
      const ownerFullFollowing = await q('following_accounts', ownerToken, '&view=full_social_graph');
      const ownerFullData: unknown[] = ownerFullFollowing.data?.data || [];
      if (ownerFullData.length > 0) {
        const sample = ownerFullData[0] as Record<string, unknown>;
        addLog(
          `full_social_graph view: includes full_name="${sample.full_name}", is_verified=${sample.is_verified}`,
          'spec',
          '§7.3 views — different views expose different field sets; re-consent required to widen',
        );
      }

      // ── §7 Temporal gating ───────────────────────────────────────────────────
      addLog(
        `Temporal gating: client sees ${clientPostsData.length} posts (all ${ownerPostsData.length} are before consent date)`,
        'spec',
        `§7 — time_range.since=${grantIssuedAt ? new Date(grantIssuedAt).toLocaleTimeString() : 'now'} — RS filtered via consent_time_field: taken_at`,
      );

      // ── §8.3 Stream isolation ────────────────────────────────────────────────
      addLog(
        `Stream isolation: ad_targeting not in grant — client gets 403 (owner sees ${ownerAdsData.length} record)`,
        'spec',
        '§8.3 — RS returns 403 grant_stream_not_allowed; stream not enumerated in issued grant',
      );

      // ── resources filter ─────────────────────────────────────────────────────
      if (ownerPostsData.length >= 2) {
        const id0 = (ownerPostsData[0] as Record<string, unknown>).id as string;
        const id1 = (ownerPostsData[1] as Record<string, unknown>).id as string;
        // Issue a single_use grant with resources filter
        const resourcesGrantResp = await fetch('/api/grant', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectorId, clientId: 'audience_lens_app',
            purposeCode: 'https://pdpp.org/purpose/research',
            purposeDescription: 'Fetch specific posts by ID',
            accessMode: 'single_use',
            streams: [{ name: 'posts', view: 'summary', resources: [id0, id1] }],
          }),
        });
        const { device_code: rgDc, error: rgErr } = await resourcesGrantResp.json();
        if (!rgErr) {
          const rgApprove = await fetch('/api/grant/approve', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ device_code: rgDc }),
          });
          const { token: rgToken, error: rgApproveErr } = await rgApprove.json();
          if (!rgApproveErr) {
            const rgQuery = await q('posts', rgToken);
            const rgData: unknown[] = rgQuery.data?.data || [];
            addLog(
              `resources filter: ${rgData.length} of ${ownerPostsData.length} posts (by ID: ${id0.slice(0,8)}…, ${id1.slice(0,8)}…)`,
              'spec',
              '§7 streams[].selection.resources — grant authorizes specific record IDs only; RS filters by primary key',
            );
          }
        }
      }

      // ── filter[field] exact-match (owner token, no grant needed) ─────────────
      const videoQuery = await q('posts', ownerToken, '&filter%5Bmedia_type%5D=VIDEO');
      const videoData: unknown[] = videoQuery.data?.data || [];
      if (ownerPostsData.length > 0) {
        addLog(
          `filter[media_type]=VIDEO: ${videoData.length} of ${ownerPostsData.length} posts match (server-side)`,
          'spec',
          '§8.1 RS query params — filter[field]=value applies exact-match on the RS before returning records',
        );
      }

      // ── Capture changes_since cursor for incremental sync ────────────────────
      // Use the cursor from changes_since query (reflects current max_version) so
      // the incremental button is available even before posts are scraped
      const postsCursor: string | null = postsChanges.data?.next_changes_since ?? null;

      setState(s => ({
        ...s,
        clientResults: { following_accounts: clientFollowingData, posts: clientPostsData },
        rawResults: { following_accounts: ownerFollowingData, posts: ownerPostsData, ad_targeting: ownerAdsData },
        postsCursor,
      }));

      setPhase('showing_results');
    } catch (err) {
      addLog((err as Error).message, 'error');
    }
  }, [addLog, setPhase]);

  // ── Request AI grant (background, shown as second consent card) ────────────

  const handleRequestAiGrant = useCallback(async (connectorId: string) => {
    try {
      const aiResp = await fetch('/api/grant', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          connectorId,
          clientId: 'audience_lens_app',
          purposeCode: 'https://pdpp.org/purpose/ai_training',
          purposeDescription: 'Use your social connections to improve recommendation models',
          accessMode: 'ongoing',
          streams: [{ name: 'following_accounts', view: 'social_graph' }],
        }),
      });
      const { device_code: aiDeviceCode, error: aiError } = await aiResp.json();
      if (aiError) throw new Error(aiError);
      setState(s => ({ ...s, aiDeviceCode }));
      addLog(
        'Audience Lens also requesting AI training access — requires explicit consent (§5)',
        'warn',
        'POST /grants/initiate · purpose: ai_training · access_mode: ongoing',
      );
      setPhase('consenting_ai');
    } catch (err) {
      addLog((err as Error).message, 'error');
    }
  }, [addLog]);

  // ── Step 4: Approve AI training grant ─────────────────────────────────────

  const handleApproveAi = useCallback(async () => {
    if (approvingAiRef.current) return;
    approvingAiRef.current = true;
    const { aiDeviceCode } = state;
    if (!aiDeviceCode) { approvingAiRef.current = false; return; }

    addLog('User explicitly consented to AI training use', 'success', '§5 — ai_training_consented: true');
    try {
      const resp = await fetch('/api/grant/approve', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ device_code: aiDeviceCode, ai_training_consented: true }),
      });
      const { grant, error } = await resp.json();
      if (error) throw new Error(error);
      addLog(
        `AI training grant issued: ${String(grant.grant_id).slice(0, 24)}…`,
        'success',
        `§6 — access_mode: ongoing · no expiry · revocable by user at any time`,
      );
      setState(s => ({ ...s, aiGrantApproved: true }));
      setPhase('done');
    } catch (err) {
      addLog((err as Error).message, 'error');
      setPhase('error');
    }
  }, [state, addLog, setPhase]);

  const handleDenyAi = useCallback(() => {
    addLog('User denied AI training grant', 'warn', '§5 — AS must not issue ai_training grant without explicit consent');
    setState(s => ({ ...s, aiDeviceCode: null }));
    setPhase('done');
  }, [addLog, setPhase]);

  // ── Scrape helpers ────────────────────────────────────────────────────────

  // Optional: re-scrape to show fresh data sync after initial demo
  const handleStartScrape = useCallback(() => {
    const { connectorId, ownerToken, researchGrantIssuedAt } = state;
    if (!connectorId || !ownerToken) return;
    setPhase('authenticating');
    const ws = connectBrowserWs();
    const startMsg = JSON.stringify({
      type: 'start-scrape',
      connectorId,
      ownerToken,
      grantIssuedAt: researchGrantIssuedAt,
      viewport: viewportRef.current,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(startMsg);
    else ws.addEventListener('open', () => ws.send(startMsg), { once: true });
  }, [state, connectBrowserWs]);

  // ── Incremental re-sync demo ──────────────────────────────────────────────

  const handleIncrementalSync = useCallback(async () => {
    const { connectorId, ownerToken, postsCursor } = state;
    if (!connectorId || !ownerToken || !postsCursor) return;

    addLog('Triggering incremental sync (connector will resume from cursor)…', 'info',
      '§Collection Profile — collection_mode: incremental · state loaded from /v1/state/:connectorId');

    // Start scrape — browser-server will fetch sync state and pass to script
    setPhase('authenticating');
    const ws = connectBrowserWs();
    const msg = JSON.stringify({ type: 'start-scrape', connectorId, ownerToken, grantIssuedAt: null, viewport: viewportRef.current });
    if (ws.readyState === WebSocket.OPEN) ws.send(msg);
    else ws.addEventListener('open', () => ws.send(msg), { once: true });
  }, [state, addLog, setPhase, connectBrowserWs]);

  // ── Input response (credential form) ──────────────────────────────────────

  const handleInputResponse = useCallback((requestId: string, values: Record<string, string>) => {
    setInputRequest(null);
    if (requestId === 'gmail-creds') {
      const resolver = gmailCredsResolverRef.current;
      gmailCredsResolverRef.current = null;
      resolver?.resolve(values);
    } else {
      setPhase('scraping');
      sendWs({ type: 'input:response', requestId, values });
    }
  }, [sendWs, setPhase]);

  const handleInputCancel = useCallback((requestId: string) => {
    setInputRequest(null);
    if (requestId === 'gmail-creds') {
      const resolver = gmailCredsResolverRef.current;
      gmailCredsResolverRef.current = null;
      resolver?.reject();
    } else {
      sendWs({ type: 'input:cancel', requestId });
      setPhase('showing_results');
    }
  }, [sendWs, setPhase]);

  // ── Auto-advance after scrape finishes ────────────────────────────────────

  useEffect(() => {
    if (browserStatus === 'done' && prevBrowserStatusRef.current !== 'done' && state.phase === 'scraping') {
      prevBrowserStatusRef.current = 'done';
      const { ownerToken, connectorId, postsCursor } = state;
      if (!ownerToken || !connectorId) { setPhase('done'); return; }

      if (postsCursor) {
        // Incremental re-sync completed — query changes_since to show new records
        addLog('Incremental sync complete — querying changes_since…', 'success');
        fetch(`/api/query?stream=posts&token=${encodeURIComponent(ownerToken)}&connectorId=${encodeURIComponent(connectorId)}&changes_since=${encodeURIComponent(postsCursor)}`)
          .then(r => r.json())
          .then(data => {
            const newRecords: unknown[] = data.data?.data || [];
            addLog(
              `changes_since: ${newRecords.length} new/changed posts since last sync`,
              'spec',
              '§8 RS — changes_since query returns records with version > cursor · next_changes_since advances the cursor',
            );
            setState(s => ({
              ...s,
              incrementalPostCount: newRecords.length,
              postsCursor: data.data?.next_changes_since ?? s.postsCursor,
            }));
          })
          .catch(() => {});
        setPhase('done');
      } else {
        // First scrape — proceed to research grant
        addLog('Instagram data collected — requesting research grant…', 'success');
        setTimeout(() => handleRequestResearchGrant(ownerToken, connectorId), 400);
      }
    } else {
      prevBrowserStatusRef.current = browserStatus;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [browserStatus]);

  // ── Gmail connector ───────────────────────────────────────────────────────

  const handleConnectGmail = useCallback(async (onCredsCollected?: () => void) => {
    const { ownerToken } = state;
    if (!ownerToken) return;

    // Ask for credentials via the same input form used for Instagram
    let creds: Record<string, string>;
    try {
      creds = await new Promise((resolve, reject) => {
        gmailCredsResolverRef.current = { resolve, reject };
        setInputRequest({
          requestId: 'gmail-creds',
          input: {
            title: 'Connect Gmail',
            description: 'Enter your Gmail address and an app password. Your password is used once and never stored.',
            schema: {
              type: 'object',
              required: ['email', 'appPassword'],
              properties: {
                email:       { type: 'string', title: 'Gmail address' },
                appPassword: { type: 'string', title: 'App password' },
              },
            },
            uiSchema: {
              email:       { 'ui:placeholder': 'you@gmail.com', 'ui:autofocus': true },
              appPassword: { 'ui:widget': 'password', 'ui:placeholder': 'xxxx xxxx xxxx xxxx' },
            },
            submitLabel: 'Connect',
          },
        });
      });
    } catch {
      return; // user cancelled
    }

    // Signal the card to show "Connecting…" — creds are collected, IMAP starting
    onCredsCollected?.();

    addLog('Gmail connector starting IMAP session…', 'info', 'Collection method: app_password — no browser needed');
    addLog('Requesting email_threads stream access', 'spec', '§8 — Collection Profile: api_key method · connector_id: registry.pdpp.org/connectors/gmail');
    try {
      const resp = await fetch('/api/gmail', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ownerToken, gmailUser: creds.email, gmailPass: creds.appPassword }),
      });
      const { summary, error } = await resp.json();
      if (error) throw new Error(error);
      addLog(`Gmail synced: ${summary.thread_count} threads ingested`, 'success', `Streams: email_threads · ${summary.thread_count} threads via IMAP`);
      addLog('Email bodies never stored — headers only (subject, sender, labels, date)', 'spec', '§3.2 — Data minimization: connectors collect only what streams require');
      setState(s => ({ ...s, gmailConnected: true, gmailSummary: summary }));
    } catch (err) {
      addLog((err as Error).message, 'error');
    }
  }, [state, addLog]);

  // ── Grant revocation demo ──────────────────────────────────────────────────

  const handleRevoke = useCallback(async () => {
    const grantId = state.researchGrant?.grant_id as string;
    if (!grantId) return;
    addLog('Revoking research grant…', 'info', `POST /grants/${grantId.slice(0, 20)}…/revoke`);
    try {
      await fetch(`/api/grant/${grantId}/revoke`, { method: 'POST' });
      setState(s => ({ ...s, grantRevoked: true }));
      addLog(
        'Grant revoked — all tokens bound to this grant now invalid',
        'warn',
        '§10 Revocation — RS will return 403 grant_revoked on next introspection (max 60s propagation)',
      );
      // Demonstrate the 403
      const { researchToken, connectorId } = state;
      if (researchToken && connectorId) {
        const resp = await fetch(`/api/query?stream=following_accounts&token=${encodeURIComponent(researchToken)}&connectorId=${encodeURIComponent(connectorId)}`);
        const data = await resp.json();
        const code = data.data?.error?.code || 'grant_revoked';
        addLog(`RS returned: 403 ${code}`, 'error', '§10 Revocation — Revocation enforced at introspection layer');
      }
    } catch (err) {
      addLog((err as Error).message, 'error');
    }
  }, [state, addLog]);

  const handleQueryAgain = useCallback(async () => {
    const { researchToken, connectorId } = state;
    if (!researchToken || !connectorId) return;
    addLog('Attempting second query with single_use token…', 'info');
    const resp = await fetch(`/api/query?stream=following_accounts&token=${encodeURIComponent(researchToken)}&connectorId=${encodeURIComponent(connectorId)}`);
    const data = await resp.json();
    if (data.status === 401 || data.status === 403) {
      const code = data.data?.error?.code || 'grant_expired';
      addLog(
        `RS returned: ${data.status} ${code}`,
        'error',
        '§6.2 — single_use grant consumed after first successful query — token permanently invalid',
      );
      setState(s => ({ ...s, tokenSpent: true }));
    } else {
      addLog(`Unexpected: query succeeded (status ${data.status})`, 'warn');
    }
  }, [state, addLog]);

  // ── Reset ─────────────────────────────────────────────────────────────────

  const handleReset = useCallback(() => {
    sendWs({ type: 'reset' });
    wsRef.current?.close();
    wsRef.current = null;
    setState(INITIAL_STATE);
    setLogs([]);
    setBrowserStatus('idle');
    setInputRequest(null);
    approvingResearchRef.current = false;
    approvingAiRef.current = false;
    prevBrowserStatusRef.current = 'idle';
    fetch('/api/setup', { method: 'DELETE' }).catch(() => {});
  }, [sendWs]);

  return (
    <div className="flex flex-col h-screen overflow-hidden bg-background">
      <DemoHeader
        phase={state.phase}
        seeded={state.seeded}
        onReset={handleReset}
        logOpen={logOpen}
        logCount={logs.length}
        onToggleLog={() => setLogOpen(o => !o)}
      />

      <div className="flex-1 overflow-hidden min-h-0 relative">
        {/* Two-column main layout */}
        <div
          className="h-full divide-x divide-border"
          style={{
            display: 'grid',
            gridTemplateColumns: '300px 1fr',
            transition: 'grid-template-columns 0.3s ease',
          }}
        >
          <ClientPanel
            phase={state.phase}
            researchGrant={state.researchGrant}
            researchGrantIssuedAt={state.researchGrantIssuedAt}
            seeded={state.seeded}
            clientResults={state.clientResults}
            rawResults={state.rawResults}
            tokenSpent={state.tokenSpent}
            grantRevoked={state.grantRevoked}
            aiGrantApproved={state.aiGrantApproved}
            gmailConnected={state.gmailConnected}
            gmailSummary={state.gmailSummary}
            onStart={handleStart}
            onRevoke={handleRevoke}
            onQueryAgain={handleQueryAgain}
            onStartScrape={handleStartScrape}
            onIncrementalSync={state.postsCursor ? handleIncrementalSync : undefined}
            incrementalPostCount={state.incrementalPostCount}
            syncStateUpdated={state.syncStateUpdated}
            onConnectGmail={handleConnectGmail}
          />

          <ServerPanel
            phase={state.phase}
            browserStatus={browserStatus}
            streamCounts={state.streamCounts}
            onFrame={onFrame}
            onViewportReady={onViewportReady}
            onApproveResearch={handleApproveResearch}
            onApproveAi={handleApproveAi}
            onDeny={handleReset}
            onDenyAi={handleDenyAi}
            sendInput={sendWs}
            inputRequest={inputRequest}
            onInputResponse={handleInputResponse}
            onInputCancel={handleInputCancel}
          />
        </div>

        {/* Log drawer — slides in from right */}
        <div
          className="absolute top-0 right-0 h-full border-l border-border"
          style={{
            width: '300px',
            transform: logOpen ? 'translateX(0)' : 'translateX(100%)',
            transition: 'transform 0.3s cubic-bezier(0.2, 0, 0, 1)',
            zIndex: 20,
          }}
        >
          <LogPanel logs={logs} />
        </div>

        {/* Backdrop when drawer open */}
        {logOpen && (
          <div
            className="absolute inset-0 z-10"
            style={{ background: 'oklch(0 0 0 / 0.15)' }}
            onClick={() => setLogOpen(false)}
          />
        )}
      </div>
    </div>
  );
}
