/**
 * POST /api/grant
 * Initiates a PDPP grant request and immediately auto-approves it (demo mode).
 * Returns the grant object and a client access token.
 */
import { NextResponse } from 'next/server';

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';

export async function POST(req: Request) {
  const { connectorId, streams, clientId, purposeCode, purposeDescription, accessMode } = await req.json();

  try {
    // Initiate grant request
    const initResp = await fetch(`${AS_URL}/grants/initiate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: clientId,
        connector_id: connectorId,
        purpose_code: purposeCode,
        purpose_description: purposeDescription,
        access_mode: accessMode || 'single_use',
        streams,
      }),
    });
    if (!initResp.ok) throw new Error(`Grant initiation failed: ${initResp.status}`);
    const { device_code } = await initResp.json();

    // Return device code so the UI can show the consent card, then caller approves
    return NextResponse.json({ device_code });
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
