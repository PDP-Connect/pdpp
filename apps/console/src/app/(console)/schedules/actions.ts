"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import {
  deleteConnectionSchedule,
  deleteConnectorSchedule,
  pauseConnectionSchedule,
  pauseConnectorSchedule,
  resumeConnectionSchedule,
  resumeConnectorSchedule,
  saveConnectionSchedule,
  saveConnectorSchedule,
} from "../lib/operator-runs.ts";

type ScheduleActionResult = { ok: true } | { ok: false; message: string };

export async function upsertScheduleAction(
  connectorId: string,
  input: { every: string; jitter?: string; enabled: boolean; connectionId?: string | null }
): Promise<ScheduleActionResult & { policy_warning?: string | null }> {
  try {
    const body = (await (input.connectionId
      ? saveConnectionSchedule(input.connectionId, input)
      : saveConnectorSchedule(connectorId, input))) as {
      policy_warning?: string | null;
    };
    revalidatePath("/schedules");
    revalidatePath("/sources");
    // biome-ignore lint/suspicious/noUnnecessaryConditions: runtime value, TS type is optimistic
    return { ok: true, policy_warning: body?.policy_warning ?? null };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
}

export async function pauseScheduleAction(
  connectorId: string,
  connectionId?: string | null
): Promise<ScheduleActionResult> {
  try {
    await (connectionId ? pauseConnectionSchedule(connectionId) : pauseConnectorSchedule(connectorId));
    revalidatePath("/schedules");
    revalidatePath("/sources");
    return { ok: true };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
}

export async function resumeScheduleAction(
  connectorId: string,
  connectionId?: string | null
): Promise<ScheduleActionResult> {
  try {
    await (connectionId ? resumeConnectionSchedule(connectionId) : resumeConnectorSchedule(connectorId));
    revalidatePath("/schedules");
    revalidatePath("/sources");
    return { ok: true };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
}

export async function deleteScheduleAction(
  connectorId: string,
  connectionId?: string | null
): Promise<ScheduleActionResult> {
  try {
    await (connectionId ? deleteConnectionSchedule(connectionId) : deleteConnectorSchedule(connectorId));
    revalidatePath("/schedules");
    revalidatePath("/sources");
    return { ok: true };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
}
