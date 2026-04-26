"use server";

import { revalidatePath } from "next/cache";
import {
  deleteConnectorSchedule,
  pauseConnectorSchedule,
  resumeConnectorSchedule,
  saveConnectorSchedule,
} from "../lib/operator-runs.ts";

type ScheduleActionResult = { ok: true } | { ok: false; message: string };

export async function upsertScheduleAction(
  connectorId: string,
  input: { every: string; jitter?: string; enabled: boolean }
): Promise<ScheduleActionResult & { policy_warning?: string | null }> {
  try {
    const body = (await saveConnectorSchedule(connectorId, input)) as {
      policy_warning?: string | null;
    };
    revalidatePath("/dashboard/schedules");
    revalidatePath("/dashboard/records");
    return { ok: true, policy_warning: body?.policy_warning ?? null };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function pauseScheduleAction(connectorId: string): Promise<ScheduleActionResult> {
  try {
    await pauseConnectorSchedule(connectorId);
    revalidatePath("/dashboard/schedules");
    revalidatePath("/dashboard/records");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function resumeScheduleAction(connectorId: string): Promise<ScheduleActionResult> {
  try {
    await resumeConnectorSchedule(connectorId);
    revalidatePath("/dashboard/schedules");
    revalidatePath("/dashboard/records");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function deleteScheduleAction(connectorId: string): Promise<ScheduleActionResult> {
  try {
    await deleteConnectorSchedule(connectorId);
    revalidatePath("/dashboard/schedules");
    revalidatePath("/dashboard/records");
    return { ok: true };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}
