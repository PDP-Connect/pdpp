// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/** Legacy gap rows without an instance belong only to the connector default. */
export function matchesRecoveryInstance(
  rowInstanceId: unknown,
  requestedInstanceId: string,
  defaultInstanceId: string
): boolean {
  return (rowInstanceId || defaultInstanceId) === requestedInstanceId;
}

export async function mergeMarkerEvidence(inMemory: boolean, durable: Promise<boolean>): Promise<boolean> {
  return [inMemory, await durable].includes(true);
}

export async function hasDurableLegacyMarker(
  checker: (
    connectorId: string,
    connectorInstanceId: string,
    prefix: string,
    reasonClass: string,
    sinceCompletedAt: string | null
  ) => Promise<boolean> | boolean,
  connectorId: string,
  connectorInstanceId: string,
  prefix: string,
  reasonClass: string,
  history: readonly { status: string; completedAt: string }[]
): Promise<boolean> {
  const sinceCompletedAt = history.findLast((record) => record.status === "succeeded")?.completedAt ?? null;
  return await checker(connectorId, connectorInstanceId, prefix, reasonClass, sinceCompletedAt);
}

export async function resolveSchedulerMarker(
  inMemory: boolean,
  checker: Parameters<typeof hasDurableLegacyMarker>[0],
  connectorId: string,
  connectorInstanceId: string,
  prefix: string,
  reasonClass: string,
  history: readonly { status: string; completedAt: string }[]
): Promise<boolean> {
  return await mergeMarkerEvidence(
    inMemory,
    hasDurableLegacyMarker(checker, connectorId, connectorInstanceId, prefix, reasonClass, history)
  );
}

export async function resolveSchedulerMarkers(
  checker: Parameters<typeof hasDurableLegacyMarker>[0],
  connectorId: string,
  connectorInstanceId: string,
  history: readonly { status: string; completedAt: string }[],
  reasonClass: string,
  backoffStarted: boolean,
  gaveUp: boolean
): Promise<{ readonly backoffStarted: boolean; readonly gaveUp: boolean }> {
  const [resolvedBackoffStarted, resolvedGaveUp] = await Promise.all([
    resolveSchedulerMarker(
      backoffStarted,
      checker,
      connectorId,
      connectorInstanceId,
      "schedule.back_off.started:",
      reasonClass,
      history
    ),
    resolveSchedulerMarker(
      gaveUp,
      checker,
      connectorId,
      connectorInstanceId,
      "schedule.gave_up:",
      reasonClass,
      history
    ),
  ]);
  return { backoffStarted: resolvedBackoffStarted, gaveUp: resolvedGaveUp };
}
