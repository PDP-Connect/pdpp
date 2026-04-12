/**
 * POST /api/gmail
 * Thin proxy — forwards Gmail credentials to the browser-server (personal server's
 * connector runtime). IMAP runs inside browser-server; credentials never leave
 * the personal server trust boundary.
 *
 * Architecture (correct per Collection Profile spec):
 *   Client UI → /api/gmail (proxy) → browser-server:/run-gmail → IMAP → RS ingest
 *
 * The Next.js API route is intentionally stateless — it just forwards the request.
 */
import { NextResponse } from 'next/server';

const BROWSER_SERVER_URL = process.env.BROWSER_SERVER_URL || 'http://localhost:3100';

export async function POST(req: Request) {
  try {
    const body = await req.json().catch(() => ({})) as { ownerToken?: string; gmailUser?: string; gmailPass?: string };
    const { ownerToken, gmailUser, gmailPass } = body;
    if (!ownerToken || !gmailUser || !gmailPass) {
      return NextResponse.json({ error: 'ownerToken, gmailUser and gmailPass required' }, { status: 400 });
    }

    const resp = await fetch(`${BROWSER_SERVER_URL}/run-gmail`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ownerToken, credentials: { gmail_user: gmailUser, gmail_pass: gmailPass } }),
      signal: AbortSignal.timeout(60_000), // 60s overall timeout
    });

    const data = await resp.json();
    if (!resp.ok) {
      return NextResponse.json({ error: data.error || 'Gmail connector failed' }, { status: resp.status });
    }
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
