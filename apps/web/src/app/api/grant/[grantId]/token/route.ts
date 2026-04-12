/**
 * POST /api/grant/[grantId]/token
 * Demo helper: attempts to mint another client token for an existing grant.
 */
import { NextResponse } from 'next/server';

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';

export async function POST(_req: Request, { params }: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await params;
  const resp = await fetch(`${AS_URL}/grants/${grantId}/tokens`, { method: 'POST' });
  const data = await resp.json();
  return NextResponse.json({ status: resp.status, data });
}
