/**
 * POST /api/setup
 * Registers the Instagram manifest and issues an owner token.
 * Returns { ownerToken, connectorId, hasData } — caller decides whether to scrape.
 *
 * DELETE /api/setup
 * No-op reset endpoint.
 */
import { NextResponse } from 'next/server';

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';
const RS_URL = process.env.PDPP_RS_URL || 'http://localhost:7663';

const CONNECTOR_ID = 'https://registry.pdpp.org/connectors/instagram';

const INSTAGRAM_MANIFEST = {
  protocol_version: '0.1.0',
  connector_id: CONNECTOR_ID,
  version: '1.0.0',
  display_name: 'Instagram',
  collection_method: 'browser_automation',
  capabilities: {
    human_interaction: ['credentials', 'otp', 'manual_action'],
  },
  streams: [
    {
      name: 'profile',
      semantics: 'mutable_state',
      schema: {
        type: 'object',
        properties: {
          username:       { type: 'string' },
          full_name:      { type: 'string' },
          bio:            { type: 'string' },
          follower_count: { type: 'integer' },
          following_count:{ type: 'integer' },
          is_verified:    { type: 'boolean' },
          profile_pic_url:{ type: 'string' },
        },
        required: ['username'],
      },
      primary_key: ['username'],
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [
        { id: 'public', label: 'Public profile', fields: ['username', 'full_name', 'follower_count', 'following_count', 'is_verified'] },
      ],
    },
    {
      name: 'following_accounts',
      semantics: 'mutable_state',
      schema: {
        type: 'object',
        properties: {
          id:          { type: 'string' },
          username:    { type: 'string' },
          full_name:   { type: 'string' },
          is_verified: { type: 'boolean' },
        },
        required: ['id', 'username'],
      },
      primary_key: ['id'],
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [
        { id: 'social_graph',      label: 'Social graph (usernames only)', fields: ['id', 'username'] },
        { id: 'full_social_graph', label: 'Full social graph',             fields: ['id', 'username', 'full_name', 'is_verified'] },
      ],
    },
    {
      name: 'posts',
      semantics: 'append_only',
      schema: {
        type: 'object',
        properties: {
          id:            { type: 'string' },
          shortcode:     { type: 'string' },
          caption:       { type: 'string' },
          like_count:    { type: 'integer' },
          comment_count: { type: 'integer' },
          taken_at:      { type: 'string', format: 'date-time' },
          media_type:    { type: 'string', enum: ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM'] },
        },
        required: ['id', 'taken_at'],
      },
      primary_key: ['id'],
      consent_time_field: 'taken_at',
      selection: { fields: true, resources: false },
      views: [
        { id: 'summary', label: 'Post summaries',  fields: ['id', 'shortcode', 'taken_at', 'media_type'] },
        { id: 'full',    label: 'Full post data',  fields: ['id', 'shortcode', 'caption', 'like_count', 'comment_count', 'taken_at', 'media_type'] },
      ],
      incremental: true,
    },
    {
      name: 'ad_targeting',
      semantics: 'mutable_state',
      schema: {
        type: 'object',
        properties: {
          topics:      { type: 'array', items: { type: 'string' } },
          advertisers: { type: 'array', items: { type: 'string' } },
          categories:  { type: 'array', items: { type: 'string' } },
        },
      },
      primary_key: ['record_id'],
      consent_time_field: null,
      selection: { fields: true, resources: false },
      views: [],
    },
  ],
};


export async function POST() {
  try {
    // 1. Register manifest (idempotent — 409 is fine)
    const regResp = await fetch(`${AS_URL}/connectors`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(INSTAGRAM_MANIFEST),
    });
    if (!regResp.ok && regResp.status !== 409) {
      throw new Error(`Failed to register connector: ${regResp.status}`);
    }

    // 2. Issue owner token
    const tokenResp = await fetch(`${AS_URL}/owner-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: 'instagram_demo_user' }),
    });
    if (!tokenResp.ok) throw new Error('Failed to issue owner token');
    const { token: ownerToken } = await tokenResp.json();

    // 3. Check whether real data already exists in the persistent RS
    let streamCounts: Record<string, number> = {};
    let hasData = false;
    try {
      const [followingResp, postsResp] = await Promise.all([
        fetch(`${RS_URL}/v1/streams/following_accounts/records?connector_id=${encodeURIComponent(CONNECTOR_ID)}&limit=1`, { headers: { 'Authorization': `Bearer ${ownerToken}` } }),
        fetch(`${RS_URL}/v1/streams/posts/records?connector_id=${encodeURIComponent(CONNECTOR_ID)}&limit=1`, { headers: { 'Authorization': `Bearer ${ownerToken}` } }),
      ]);
      if (followingResp.ok) {
        const body = await followingResp.json();
        const records = body.data?.data ?? body.records ?? body.data ?? [];
        streamCounts.following_accounts = body.data?.total ?? (Array.isArray(records) ? records.length : 0);
        if (Array.isArray(records) && records.length > 0) hasData = true;
      }
      if (postsResp.ok) {
        const body = await postsResp.json();
        const records = body.data?.data ?? body.records ?? body.data ?? [];
        streamCounts.posts = body.data?.total ?? (Array.isArray(records) ? records.length : 0);
      }
    } catch { /* best-effort */ }

    return NextResponse.json({ ownerToken, connectorId: CONNECTOR_ID, hasData, streamCounts });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export async function DELETE() {
  try {
    // Issue owner token so we can delete records
    const tokenResp = await fetch(`${AS_URL}/owner-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: 'instagram_demo_user' }),
    });
    if (!tokenResp.ok) return NextResponse.json({ ok: true }); // best-effort
    const { token: ownerToken } = await tokenResp.json();

    // Delete all records for each stream
    await Promise.all(
      ['profile', 'following_accounts', 'posts', 'ad_targeting', 'email_threads'].map(stream =>
        fetch(
          `${RS_URL}/v1/streams/${encodeURIComponent(stream)}/records?connector_id=${encodeURIComponent(CONNECTOR_ID)}`,
          { method: 'DELETE', headers: { 'Authorization': `Bearer ${ownerToken}` } },
        ).catch(() => null), // best-effort per stream
      )
    );

    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json({ ok: true }); // always succeed — reset is best-effort
  }
}
