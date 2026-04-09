/**
 * POST /api/grant/approve
 * Approves a pending consent request.
 * Accepts optional ai_training_consented flag for ai_training purpose grants.
 */
import { NextResponse } from 'next/server';

const AS_URL = process.env.PDPP_AS_URL || 'http://localhost:7662';

export async function POST(req: Request) {
  const { device_code, ai_training_consented } = await req.json();
  try {
    const resp = await fetch(`${AS_URL}/consent/${device_code}/approve-api`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subject_id: 'instagram_demo_user', ai_training_consented }),
    });
    if (!resp.ok) throw new Error(`Approve failed: ${resp.status}`);
    const data = await resp.json();
    return NextResponse.json(data);
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}
