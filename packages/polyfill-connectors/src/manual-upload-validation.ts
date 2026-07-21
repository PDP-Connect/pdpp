// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { validateGoogleMapsTimelineArtifact } from "../connectors/google_maps/validation.ts";
import { validateWhatsAppChatExportArtifact } from "../connectors/whatsapp/validation.ts";

export type ManualUploadValidationResult =
  | ReturnType<typeof validateGoogleMapsTimelineArtifact>
  | ReturnType<typeof validateWhatsAppChatExportArtifact>;

export interface ManualUploadValidationOptions {
  readonly fileName?: string | null;
  readonly maxFileBytes?: number | null;
}

export function validateManualUploadArtifactByKind(
  kind: string | null,
  input: Buffer | Uint8Array | string,
  options: ManualUploadValidationOptions = {}
): ManualUploadValidationResult | null {
  const maxFileBytes = options.maxFileBytes ?? null;
  if (kind === "google_maps_timeline") {
    return validateGoogleMapsTimelineArtifact(input, { maxFileBytes });
  }
  if (kind === "whatsapp_chat_export") {
    return validateWhatsAppChatExportArtifact(input, {
      fileName: options.fileName ?? null,
      maxFileBytes,
    });
  }
  return null;
}
