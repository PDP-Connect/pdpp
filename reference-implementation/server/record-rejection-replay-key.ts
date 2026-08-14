// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";

export const RECORD_REJECTION_GENERATION = "record-rejection-v2";

export function recordRejectionReplayKey(input: {
  readonly connectorInstanceId: string;
  readonly ownerSubjectId: string;
  readonly payload: Buffer;
  readonly reasonCode: string;
  readonly stream: string;
}): string {
  const digest = createHash("sha256").update(input.payload).digest("hex");
  return createHash("sha256")
    .update(
      JSON.stringify([
        input.ownerSubjectId,
        input.connectorInstanceId,
        input.stream,
        digest,
        input.reasonCode,
        RECORD_REJECTION_GENERATION,
      ]),
      "utf8"
    )
    .digest("hex");
}
