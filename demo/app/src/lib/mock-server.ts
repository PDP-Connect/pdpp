/**
 * In-memory PDPP mock server
 *
 * Implements the core protocol operations client-side:
 * - Grant issuance from a selection request
 * - Query with field projection enforcement
 * - Incremental sync (changes_since) with projection-aware deltas
 * - Revocation
 * - Self-export via owner token
 *
 * This is NOT a toy mock — it enforces the same constraints as a real RS.
 * The grant is the enforcement boundary. Field projection strips unauthorized
 * fields from every response. Revoked grants return 403.
 *
 * Can be swapped for a real server connection via the same interface.
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type Record = {
  key: string;
  data: { [field: string]: unknown };
  emitted_at: string;
};

export type Stream = {
  name: string;
  semantics: 'append_only' | 'mutable_state';
  records: Record[];
  schema_fields: string[]; // all fields the stream has
};

export type Grant = {
  grant_id: string;
  issued_at: string;
  status: 'active' | 'revoked' | 'expired';
  client_id: string;
  purpose_code: string;
  purpose_description: string;
  access_mode: 'continuous' | 'single_use';
  expires_at: string | null;
  retention: { max_duration: string; on_expiry: 'delete' | 'anonymize' } | null;
  streams: GrantStream[];
};

export type GrantStream = {
  name: string;
  fields: string[] | null; // null = all fields
  view: string | null;
  time_range: { since?: string; until?: string } | null;
};

export type QueryResult = {
  status: number;
  error?: string;
  records?: Record[];
  has_more: boolean;
  next_changes_since?: string;
};

// ─── Mock Server ────────────────────────────────────────────────────────────

export class MockPDPPServer {
  private streams: Map<string, Stream> = new Map();
  private grants: Map<string, Grant> = new Map();
  private syncCursors: Map<string, number> = new Map(); // grant_id -> record index
  private version = 0;

  // ── Data seeding ──

  addStream(stream: Stream) {
    this.streams.set(stream.name, stream);
  }

  addRecord(streamName: string, record: Record) {
    const stream = this.streams.get(streamName);
    if (!stream) throw new Error(`Unknown stream: ${streamName}`);
    stream.records.push(record);
    this.version++;
  }

  // ── Grant management ──

  issueGrant(grant: Omit<Grant, 'status'>): Grant {
    const issued: Grant = { ...grant, status: 'active' };
    this.grants.set(grant.grant_id, issued);
    // Initialize sync cursor at 0 (full sync on first query)
    this.syncCursors.set(grant.grant_id, 0);
    return issued;
  }

  revokeGrant(grantId: string): boolean {
    const grant = this.grants.get(grantId);
    if (!grant || grant.status !== 'active') return false;
    grant.status = 'revoked';
    return true;
  }

  getGrant(grantId: string): Grant | null {
    return this.grants.get(grantId) || null;
  }

  // ── Query (client token path) ──

  query(grantId: string, streamName: string): QueryResult {
    const grant = this.grants.get(grantId);
    if (!grant) return { status: 403, error: 'grant_invalid', records: [], has_more: false };
    if (grant.status === 'revoked') return { status: 403, error: 'grant_revoked', records: [], has_more: false };
    if (grant.status === 'expired') return { status: 403, error: 'grant_expired', records: [], has_more: false };

    // Check stream is in grant
    const grantStream = grant.streams.find(s => s.name === streamName);
    if (!grantStream) return { status: 403, error: 'insufficient_scope', records: [], has_more: false };

    const stream = this.streams.get(streamName);
    if (!stream) return { status: 404, error: 'stream_not_found', records: [], has_more: false };

    // Apply field projection
    const records = stream.records.map(r => this.projectRecord(r, grantStream.fields, stream.schema_fields));

    return { status: 200, records, has_more: false };
  }

  // ── Incremental sync (changes_since) ──

  queryChangesSince(grantId: string, streamName: string, cursor?: string): QueryResult {
    const grant = this.grants.get(grantId);
    if (!grant) return { status: 403, error: 'grant_invalid', records: [], has_more: false };
    if (grant.status === 'revoked') return { status: 403, error: 'grant_revoked', records: [], has_more: false };

    const grantStream = grant.streams.find(s => s.name === streamName);
    if (!grantStream) return { status: 403, error: 'insufficient_scope', records: [], has_more: false };

    const stream = this.streams.get(streamName);
    if (!stream) return { status: 404, error: 'stream_not_found', records: [], has_more: false };

    // Parse cursor (index into records array)
    const startIdx = cursor ? parseInt(cursor, 10) : 0;
    if (isNaN(startIdx)) return { status: 410, error: 'cursor_expired', records: [], has_more: false };

    const newRecords = stream.records.slice(startIdx);
    const projected = newRecords.map(r => this.projectRecord(r, grantStream.fields, stream.schema_fields));

    return {
      status: 200,
      records: projected,
      has_more: false,
      next_changes_since: String(stream.records.length),
    };
  }

  // ── Self-export (owner token path) ──

  selfExport(streamName: string): QueryResult {
    const stream = this.streams.get(streamName);
    if (!stream) return { status: 404, error: 'stream_not_found', records: [], has_more: false };

    // Owner sees all fields, no projection
    return { status: 200, records: [...stream.records], has_more: false };
  }

  // ── Field projection ──

  private projectRecord(record: Record, allowedFields: string[] | null, _allFields: string[]): Record {
    if (!allowedFields) return record; // null = all fields authorized

    const projected: { [field: string]: unknown } = {};
    for (const field of allowedFields) {
      if (field in record.data) {
        projected[field] = record.data[field];
      }
    }

    return {
      key: record.key,
      data: projected,
      emitted_at: record.emitted_at,
    };
  }

  // ── Introspection (for completeness) ──

  introspect(grantId: string): { active: boolean; grant: Grant | null } {
    const grant = this.grants.get(grantId);
    if (!grant) return { active: false, grant: null };
    return { active: grant.status === 'active', grant };
  }

  // ── Stats ──

  getStreamStats(): { name: string; recordCount: number; fields: string[] }[] {
    return Array.from(this.streams.values()).map(s => ({
      name: s.name,
      recordCount: s.records.length,
      fields: s.schema_fields,
    }));
  }
}

// ─── Seeded instance for the reference page ─────────────────────────────────

export function createSeededServer(): MockPDPPServer {
  const server = new MockPDPPServer();

  // Instagram connector streams
  const postFields = ['id', 'caption', 'taken_at', 'media_type', 'like_count', 'comment_count', 'location', 'is_pinned'];
  const followingFields = ['id', 'username'];
  const adFields = ['category', 'source', 'confidence'];

  server.addStream({
    name: 'following_accounts',
    semantics: 'mutable_state',
    schema_fields: followingFields,
    records: Array.from({ length: 106 }, (_, i) => ({
      key: `follow_${i}`,
      data: { id: `user_${i}`, username: `user${i}` },
      emitted_at: '2026-04-06T12:00:00Z',
    })),
  });

  server.addStream({
    name: 'posts',
    semantics: 'append_only',
    schema_fields: postFields,
    records: Array.from({ length: 22 }, (_, i) => ({
      key: `post_${i}`,
      data: {
        id: `post_${i}`,
        caption: `Post caption ${i + 1}`,
        taken_at: new Date(2025, 0, 1 + i * 15).toISOString(),
        media_type: i % 3 === 0 ? 'VIDEO' : 'IMAGE',
        like_count: Math.floor(Math.random() * 500),
        comment_count: Math.floor(Math.random() * 50),
        location: i % 4 === 0 ? 'New York' : null,
        is_pinned: i === 0,
      },
      emitted_at: '2026-04-06T12:00:00Z',
    })),
  });

  server.addStream({
    name: 'ad_targeting',
    semantics: 'mutable_state',
    schema_fields: adFields,
    records: Array.from({ length: 47 }, (_, i) => ({
      key: `ad_${i}`,
      data: {
        category: ['Fashion', 'Tech', 'Travel', 'Food', 'Fitness'][i % 5],
        source: ['browsing', 'engagement', 'demographic'][i % 3],
        confidence: (0.5 + Math.random() * 0.5).toFixed(2),
      },
      emitted_at: '2026-04-06T12:00:00Z',
    })),
  });

  return server;
}
