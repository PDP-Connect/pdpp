// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextRequest, NextResponse } from "next/server";
import { SigningUnavailableError, verifyToken } from "@/lib/signing/index.ts";
import { withdrawSignatory } from "@/lib/signing/providers.ts";
import { withdrawOutcome } from "@/lib/signing/signing-outcome.ts";
import { siteFlags } from "@/lib/site-config.ts";

// GET /api/sign/withdraw?token=... — the withdrawal link from the one email.
//
// The withdraw token is deliberately NOT single-use and NOT short-lived in
// practice: a signatory keeps the confirmation email and may act on it a year
// later. Its 48-hour expiry applies to the confirm token; a withdrawal link
// that expired would leave someone with no way out except asking a person,
// which is exactly the friction the Principles say ending should not have.
//
// Withdrawing twice is harmless: the second call finds no file and reports the
// same outcome, so a signatory who clicks again sees what they expect.

export const runtime = "nodejs";

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!siteFlags.signingLive) {
    return withdrawOutcome(request, "closed", { error: "Signing is not open.", status: 404 });
  }

  const token = new URL(request.url).searchParams.get("token");
  // Verified against a far-future expiry so a link kept for years still works;
  // the signature is what authorises it, not its age.
  const id = token ? verifyToken(token, "withdraw", 0) : null;
  if (!id) {
    return withdrawOutcome(request, "invalid", { error: "Withdrawal link is invalid.", status: 400 });
  }

  try {
    await withdrawSignatory(id);
    // Reports done whether or not a file was found, for the same reason the
    // confirm route has one failure state: a link holder learning whether an
    // id is on the register is a disclosure, and the signatory's outcome is
    // identical either way.
    return withdrawOutcome(request, "done");
  } catch (error) {
    if (error instanceof SigningUnavailableError) {
      console.error("[sign/withdraw] unavailable:", error.message);
    } else {
      console.error("[sign/withdraw] unexpected:", error);
    }
    return withdrawOutcome(request, "error", { error: "Signing is temporarily unavailable.", status: 503 });
  }
}
