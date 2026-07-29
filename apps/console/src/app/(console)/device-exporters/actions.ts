"use server";

// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { revalidatePath } from "next/cache";
import { isSupportedLocalCollectorConnector } from "../lib/connection-modality.ts";
import { createDeviceEnrollmentCode, type DeviceEnrollmentCode, revokeDeviceExporter } from "../lib/ref-client.ts";

type EnrollmentActionState =
  | { ok: false; message: string }
  | { code: DeviceEnrollmentCode; deviceLabel: string | null; ok: true }
  | { ok: null };

export async function createEnrollmentCodeAction(
  _previous: EnrollmentActionState,
  formData: FormData
): Promise<EnrollmentActionState> {
  const connectorId = String(formData.get("connector_id") ?? "").trim();
  const localBindingName = String(formData.get("local_binding_name") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const expiresRaw = String(formData.get("expires_in_seconds") ?? "").trim();

  if (!(connectorId && localBindingName)) {
    return { message: "Connector id and local binding name are required.", ok: false };
  }
  if (!isSupportedLocalCollectorConnector(connectorId)) {
    return {
      message:
        "This setup form only creates packaged local collector enrollments. Browser-based sources will use the dashboard browser setup flow when it ships.",
      ok: false,
    };
  }

  const expiresInSeconds = expiresRaw ? Number(expiresRaw) : undefined;
  if (expiresInSeconds !== undefined && !Number.isInteger(expiresInSeconds)) {
    return { message: "Expiration must be a whole number of seconds.", ok: false };
  }

  try {
    const code = await createDeviceEnrollmentCode({
      connector_id: connectorId,
      display_name: displayName || undefined,
      expires_in_seconds: expiresInSeconds,
      local_binding_name: localBindingName,
    });
    revalidatePath("/device-exporters");
    return { code, deviceLabel: displayName || null, ok: true };
  } catch (err) {
    return { message: err instanceof Error ? err.message : String(err), ok: false };
  }
}

export async function revokeDeviceExporterAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get("device_id") ?? "").trim();
  if (!deviceId) {
    return;
  }
  await revokeDeviceExporter(deviceId);
  revalidatePath("/device-exporters");
}
