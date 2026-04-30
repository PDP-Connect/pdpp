"use server";

import { revalidatePath } from "next/cache";
import { createDeviceEnrollmentCode, type DeviceEnrollmentCode, revokeDeviceExporter } from "../lib/ref-client.ts";

type EnrollmentActionState = { ok: false; message: string } | { code: DeviceEnrollmentCode; ok: true } | { ok: null };

export async function createEnrollmentCodeAction(
  _previous: EnrollmentActionState,
  formData: FormData
): Promise<EnrollmentActionState> {
  const connectorId = String(formData.get("connector_id") ?? "").trim();
  const localBindingName = String(formData.get("local_binding_name") ?? "").trim();
  const displayName = String(formData.get("display_name") ?? "").trim();
  const expiresRaw = String(formData.get("expires_in_seconds") ?? "").trim();

  if (!(connectorId && localBindingName)) {
    return { ok: false, message: "Connector id and local binding name are required." };
  }

  const expiresInSeconds = expiresRaw ? Number(expiresRaw) : undefined;
  if (expiresInSeconds !== undefined && !Number.isInteger(expiresInSeconds)) {
    return { ok: false, message: "Expiration must be a whole number of seconds." };
  }

  try {
    const code = await createDeviceEnrollmentCode({
      connector_id: connectorId,
      display_name: displayName || undefined,
      expires_in_seconds: expiresInSeconds,
      local_binding_name: localBindingName,
    });
    revalidatePath("/dashboard/device-exporters");
    return { ok: true, code };
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

export async function revokeDeviceExporterAction(formData: FormData): Promise<void> {
  const deviceId = String(formData.get("device_id") ?? "").trim();
  if (!deviceId) {
    return;
  }
  await revokeDeviceExporter(deviceId);
  revalidatePath("/dashboard/device-exporters");
}
