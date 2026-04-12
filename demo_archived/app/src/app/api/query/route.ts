/**
 * GET /api/query?stream=top_artists&token=...&connectorId=...
 * Queries the RS on behalf of the client token.
 */
import { NextResponse } from 'next/server';

const RS_URL = process.env.PDPP_RS_URL || 'http://localhost:7663';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const stream = url.searchParams.get('stream')!;
  const token = url.searchParams.get('token')!;
  const connectorId = url.searchParams.get('connectorId');

  const rsUrl = new URL(`${RS_URL}/v1/streams/${encodeURIComponent(stream)}/records`);
  if (connectorId) rsUrl.searchParams.set('connector_id', connectorId);
  rsUrl.searchParams.set('limit', url.searchParams.get('limit') || '200');

  // Forward additional RS query params: changes_since, cursor, order, filter[*], view, fields
  const KNOWN = new Set(['stream', 'token', 'connectorId', 'limit']);
  for (const [key, value] of url.searchParams.entries()) {
    if (!KNOWN.has(key)) rsUrl.searchParams.set(key, value);
  }

  try {
    const resp = await fetch(rsUrl.toString(), {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const data = await resp.json();
    return NextResponse.json({ status: resp.status, data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
