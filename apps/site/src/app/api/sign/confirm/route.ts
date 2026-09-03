// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from "next/server";
import { buildRecord, recordPath, SigningUnavailableError, verifyToken } from "@/lib/signing/index.ts";
import { takePending, writeSignatory } from "@/lib/signing/providers.ts";
import { siteFlags } from "@/lib/site-config.ts";

// GET /api/sign/confirm?token=... — the single-use confirmation link.
//
// SINGLE USE is enforced by takePending, which reads and deletes in one store
// operation. The signature check cannot enforce it: an HMAC is stateless and a
// valid token stays valid until it expires. Checking the signature, then
// reading, then deleting would leave a window where two clicks both see the
// pending record and both write a file.
//
// This is the ONLY place a signatory file is written, and it happens after the
// person who owns the address has acted. Everything before this point is
// reversible by doing nothing: an unconfirmed submission expires on its own.

export const runtime = "nodejs";

function outcome(request: NextRequest, state: string): NextResponse {
  return NextResponse.redirect(new URL(`/principles?signed=${state}`, request.url), 303);
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  if (!siteFlags.signingLive) {
    return NextResponse.json({ error: "Signing is not open." }, { status: 404 });
  }

  const token = new URL(request.url).searchParams.get("token");
  const id = token ? verifyToken(token, "confirm") : null;
  // One outcome for a bad signature, an expired link and an already-used link.
  // Distinguishing them would tell a holder of a stolen link which kind of
  // wrong it is, and the person who owns the address cannot act on the
  // difference anyway.
  if (!id) {
    return outcome(request, "invalid");
  }

  try {
    const submission = await takePending(id);
    if (!submission) {
      return outcome(request, "invalid");
    }

    const record = buildRecord(id, submission);
    await writeSignatory(record, recordPath(record));

    // The public register does not change here. It changes when the publish
    // script next runs, which is what keeps the public site free of any code
    // path that reads the private store.
    return outcome(request, "confirmed");
  } catch (error) {
    if (error instanceof SigningUnavailableError) {
      console.error("[sign/confirm] unavailable:", error.message);
    } else {
      console.error("[sign/confirm] unexpected:", error);
    }
    return outcome(request, "error");
  }
}
