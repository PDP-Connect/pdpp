// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { NextRequest, NextResponse } from "next/server";
import { formValuesForRetry, type RestoredSigningForm } from "@/lib/signing/form-restoration.ts";
import {
  createToken,
  newSubmissionId,
  organisationDomainMatches,
  SigningRejectedError,
  SigningUnavailableError,
  submissionSchema,
} from "@/lib/signing/index.ts";
import { putPending, sendConfirmationEmail, withinRateLimit } from "@/lib/signing/providers.ts";
import { signedOutcome } from "@/lib/signing/signing-outcome.ts";
import { siteFlags } from "@/lib/site-config.ts";

// POST /api/sign — accept a Supporter submission and send one confirmation.
//
// Nothing is published by this route. It writes a pending record that expires
// on its own and sends one email. A signature only becomes real when the
// confirmation link is used, which is what stops anyone signing in someone
// else's name: the person who owns the address is the one who completes it.
//
// ORDER MATTERS. Read the form to retain safe retry fields, then rate limit,
// parse, apply the domain rule, store, and send. The rate limit runs before
// validation because it is the cheapest policy check that protects the mail
// provider; the send runs last because it is the only effect outside this
// system.

export const runtime = "nodejs";

function clientIp(request: NextRequest): string {
  // Vercel sets x-forwarded-for; the leftmost entry is the client. Anything
  // further right is a proxy the client cannot control. Falling back to a
  // constant means an unknown-IP caller shares one bucket, which throttles
  // rather than exempts them.
  const forwarded = request.headers.get("x-forwarded-for");
  return forwarded?.split(",")[0]?.trim() || "unknown";
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  // The flag gates the ROUTE, not just the form. A form hidden in the UI while
  // the endpoint still accepts posts is not switched off.
  if (!siteFlags.signingLive) {
    return signedOutcome(request, "closed", { error: "Signing is not open.", status: 404 });
  }

  let restoredForm: RestoredSigningForm | undefined;
  try {
    const form = await request.formData();
    restoredForm = formValuesForRetry(form);
    if (!(await withinRateLimit(clientIp(request)))) {
      return signedOutcome(
        request,
        "ratelimited",
        { error: "Too many submissions. Try again later.", status: 429 },
        restoredForm
      );
    }

    const parsed = submissionSchema.safeParse(Object.fromEntries(form));
    if (!parsed.success) {
      // The individual field errors are deliberately not returned: they
      // describe a schema an attacker would otherwise get to probe, and the
      // form already states what it needs.
      throw new SigningRejectedError("That submission was not complete. Check the required fields and try again.");
    }

    const submission = parsed.data;
    if (!organisationDomainMatches(submission)) {
      throw new SigningRejectedError("An organisation must sign from an address at its own domain.");
    }

    const id = newSubmissionId();
    await putPending(id, submission);

    const { origin } = new URL(request.url);
    await sendConfirmationEmail({
      confirmUrl: `${origin}/api/sign/confirm?token=${createToken(id, "confirm")}`,
      to: submission.email,
      withdrawUrl: `${origin}/api/sign/withdraw?token=${createToken(id, "withdraw")}`,
    });

    return signedOutcome(request, "pending", { error: "", status: 303 });
  } catch (error) {
    if (error instanceof SigningRejectedError) {
      return signedOutcome(request, "incomplete", { error: error.message, status: 400 }, restoredForm);
    }
    // An unprovisioned seam is a 503, with no detail: which environment
    // variable is missing is not a fact the public needs.
    if (error instanceof SigningUnavailableError) {
      console.error("[sign] unavailable:", error.message);
      return signedOutcome(
        request,
        "unavailable",
        { error: "Signing is temporarily unavailable.", status: 503 },
        restoredForm
      );
    }
    console.error("[sign] unexpected:", error);
    return signedOutcome(
      request,
      "unavailable",
      { error: "Signing is temporarily unavailable.", status: 503 },
      restoredForm
    );
  }
}
