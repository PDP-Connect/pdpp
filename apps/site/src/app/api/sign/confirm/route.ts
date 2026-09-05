// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { createConfirmationHandlers } from "@/lib/signing/confirmation.ts";
import { buildRecord, hasSameImmutableFields, recordPath, verifyToken } from "@/lib/signing/index.ts";
import { deletePending, readPending, readSignatory, writeSignatory } from "@/lib/signing/providers.ts";
import { siteFlags } from "@/lib/site-config.ts";

export const runtime = "nodejs";

const handlers = createConfirmationHandlers({
  buildRecord,
  deletePending,
  hasSameImmutableFields,
  isSigningLive: () => siteFlags.signingLive,
  readPending,
  readSignatory,
  recordPath,
  verifyToken,
  writeSignatory,
});

export const { GET, HEAD, POST } = handlers;
