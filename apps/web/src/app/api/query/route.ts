/**
 * GET /api/query?stream=top_artists&token=...&connectorId=...
 * Queries the RS on behalf of the provided token.
 *
 * connectorId is optional and only forwarded for connector-bound owner queries.
 * Native and grant-bound client queries are token-scoped.
 */
import { NextResponse } from "next/server";
import { getRsInternalUrl } from "../../dashboard/lib/owner-token.ts";

export async function GET(req: Request) {
  const url = new URL(req.url);
  const stream = url.searchParams.get("stream");
  const token = url.searchParams.get("token");
  if (!stream) {
    return NextResponse.json({ error: "Missing required query parameter: stream" }, { status: 400 });
  }
  if (!token) {
    return NextResponse.json({ error: "Missing required query parameter: token" }, { status: 400 });
  }
  const connectorId = url.searchParams.get("connectorId");
  if (url.searchParams.has("providerId")) {
    return NextResponse.json(
      { error: "Query bridge does not accept providerId; native and grant-bound queries are token-scoped" },
      { status: 400 }
    );
  }

  const rsUrl = new URL(`${getRsInternalUrl()}/v1/streams/${encodeURIComponent(stream)}/records`);
  if (connectorId) {
    rsUrl.searchParams.set("connector_id", connectorId);
  }
  rsUrl.searchParams.set("limit", url.searchParams.get("limit") || "200");

  // Forward additional RS query params: changes_since, cursor, order, filter[*], view, fields
  const KNOWN = new Set(["stream", "token", "connectorId", "limit"]);
  for (const [key, value] of url.searchParams.entries()) {
    if (!KNOWN.has(key)) {
      rsUrl.searchParams.set(key, value);
    }
  }

  try {
    const resp = await fetch(rsUrl.toString(), {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await resp.json();
    return NextResponse.json({ status: resp.status, data });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
