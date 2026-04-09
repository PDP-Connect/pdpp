/**
 * useProtocol — React hook that drives the reference page from a MockPDPPServer
 *
 * This hook owns the protocol state machine. The reference page's sections
 * read from it instead of using hardcoded specimen data. The mock server
 * actually enforces field projection, computes deltas, and refuses revoked grants.
 *
 * Can be swapped to a real server by replacing MockPDPPServer with HTTP calls.
 */

import { useState, useCallback, useMemo, useRef } from 'react';
import { MockPDPPServer, createSeededServer, type Grant, type QueryResult } from './mock-server';

export type ProtocolPhase = 'idle' | 'granted' | 'revoked';

export type ProtocolState = {
  phase: ProtocolPhase;
  grant: Grant | null;
  queryResult: QueryResult | null;
  syncResult: QueryResult | null;
  syncCursor: string | null;
  exportResult: QueryResult | null;
  serverStats: { name: string; recordCount: number; fields: string[] }[];
};

const GRANT_TEMPLATE = {
  grant_id: 'grt_8f3a2b1c',
  issued_at: '2026-04-06T15:00:00Z',
  client_id: 'audience_lens_v1',
  purpose_code: 'research',
  purpose_description: 'Influencer network study',
  access_mode: 'continuous' as const,
  expires_at: '2027-04-05T00:00:00Z',
  retention: { max_duration: 'P90D', on_expiry: 'delete' as const },
  streams: [
    { name: 'following_accounts', fields: ['id', 'username'], view: 'social_graph', time_range: null },
    { name: 'posts', fields: ['id', 'caption', 'taken_at', 'media_type'], view: 'summary', time_range: null },
  ],
};

export function useProtocol() {
  const serverRef = useRef<MockPDPPServer>(createSeededServer());
  const server = serverRef.current;

  const [phase, setPhase] = useState<ProtocolPhase>('idle');
  const [grant, setGrant] = useState<Grant | null>(null);
  const [queryResult, setQueryResult] = useState<QueryResult | null>(null);
  const [syncResult, setSyncResult] = useState<QueryResult | null>(null);
  const [syncCursor, setSyncCursor] = useState<string | null>(null);
  const [exportResult, setExportResult] = useState<QueryResult | null>(null);

  const serverStats = useMemo(() => server.getStreamStats(), [server]);

  // ── Actions ──

  const approve = useCallback((accessMode: 'continuous' | 'single_use' = 'continuous') => {
    const issued = server.issueGrant({
      ...GRANT_TEMPLATE,
      access_mode: accessMode,
      expires_at: accessMode === 'single_use' ? '2026-04-07T15:00:00Z' : GRANT_TEMPLATE.expires_at,
    });
    setGrant(issued);
    setPhase('granted');

    // Immediately query to populate the enforce section
    const result = server.query(issued.grant_id, 'posts');
    setQueryResult(result);

    // Also do initial sync
    const sync = server.queryChangesSince(issued.grant_id, 'posts');
    setSyncResult(sync);
    setSyncCursor(sync.next_changes_since || null);
  }, [server]);

  const deny = useCallback(() => {
    setPhase('idle');
    setGrant(null);
    setQueryResult(null);
    setSyncResult(null);
    setSyncCursor(null);
  }, []);

  const revoke = useCallback(() => {
    if (grant) {
      server.revokeGrant(grant.grant_id);
      setGrant({ ...grant, status: 'revoked' });
      setPhase('revoked');

      // Query again to show 403
      const result = server.query(grant.grant_id, 'posts');
      setQueryResult(result);
    }
  }, [grant, server]);

  const addNewPosts = useCallback((count: number) => {
    for (let i = 0; i < count; i++) {
      const idx = 22 + i + Math.floor(Math.random() * 1000);
      server.addRecord('posts', {
        key: `post_new_${idx}`,
        data: {
          id: `post_new_${idx}`,
          caption: `New post ${i + 1}`,
          taken_at: new Date().toISOString(),
          media_type: 'IMAGE',
          like_count: 0,
          comment_count: 0,
          location: null,
          is_pinned: false,
        },
        emitted_at: new Date().toISOString(),
      });
    }

    // Re-sync to show the delta
    if (grant && phase === 'granted' && syncCursor) {
      const sync = server.queryChangesSince(grant.grant_id, 'posts', syncCursor);
      setSyncResult(sync);
      setSyncCursor(sync.next_changes_since || null);
    }
  }, [grant, phase, syncCursor, server]);

  const selfExport = useCallback((streamName: string) => {
    const result = server.selfExport(streamName);
    setExportResult(result);
  }, [server]);

  const reset = useCallback(() => {
    serverRef.current = createSeededServer();
    setPhase('idle');
    setGrant(null);
    setQueryResult(null);
    setSyncResult(null);
    setSyncCursor(null);
    setExportResult(null);
  }, []);

  return {
    phase,
    grant,
    queryResult,
    syncResult,
    syncCursor,
    exportResult,
    serverStats,
    approve,
    deny,
    revoke,
    addNewPosts,
    selfExport,
    reset,
  };
}
