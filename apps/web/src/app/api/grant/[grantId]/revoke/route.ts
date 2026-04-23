/**
 * POST /api/grant/[grantId]/revoke
 * Revokes an active grant via the AS.
 */
import { NextResponse } from 'next/server';
import { getAsInternalUrl } from '../../../../dashboard/lib/owner-token';

export async function POST(_req: Request, { params }: { params: Promise<{ grantId: string }> }) {
  const { grantId } = await params;
  const resp = await fetch(`${getAsInternalUrl()}/grants/${grantId}/revoke`, {
    method: 'POST',
  });
  const data = await resp.json();
  return NextResponse.json(data);
}
