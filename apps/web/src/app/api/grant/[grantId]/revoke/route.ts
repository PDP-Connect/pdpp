/**
 * POST /api/grant/[grantId]/revoke
 * Revokes an active grant via the AS.
 */
import { NextResponse } from 'next/server';

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';

export async function POST(_req: Request, { params }: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await params;
  const resp = await fetch(`${AS_URL}/grants/${grantId}/revoke`, { method: 'POST' });
  const data = await resp.json();
  return NextResponse.json(data);
}
