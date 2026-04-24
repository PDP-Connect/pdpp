'use server';

import { revalidatePath } from 'next/cache';
import { requireDashboardAccess } from '../../lib/dashboard-access';
import { submitRunInteraction } from '../../lib/operator-runs';

function asString(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : 'Unexpected interaction submission failure';
}

export type RunInteractionActionState = {
  error: string | null;
  status: 'success' | 'cancelled' | null;
};

export async function submitRunInteractionAction(
  _prev: RunInteractionActionState,
  formData: FormData,
): Promise<RunInteractionActionState> {
  const runId = asString(formData.get('run_id'));
  if (!runId) return { error: 'Missing run_id', status: null };
  await requireDashboardAccess(`/dashboard/runs/${encodeURIComponent(runId)}`);

  const interactionId = asString(formData.get('interaction_id'));
  const rawStatus = asString(formData.get('status'));
  const status =
    rawStatus === 'success' || rawStatus === 'cancelled' ? rawStatus : null;
  if (!interactionId || !status) {
    return { error: 'Missing interaction_id or status', status: null };
  }

  // Pull every other form field as interaction data. The form is schema-shaped
  // server-side so only declared fields ride along. Values are forwarded to
  // the runtime as the current INTERACTION_RESPONSE and not stored anywhere
  // durable on the dashboard side — no cookies, no logs, no localStorage.
  const data: Record<string, string> = {};
  if (status === 'success') {
    for (const [key, value] of formData.entries()) {
      if (key === 'run_id' || key === 'interaction_id' || key === 'status') continue;
      if (typeof value !== 'string') continue;
      data[key] = value;
    }
  }

  try {
    await submitRunInteraction(runId, {
      interactionId,
      status,
      data: Object.keys(data).length > 0 ? data : undefined,
    });
  } catch (err) {
    return { error: errorMessage(err), status: null };
  }

  revalidatePath(`/dashboard/runs/${runId}`);
  return { error: null, status };
}
