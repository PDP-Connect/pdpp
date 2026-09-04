// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from "next/server";
import { type SignatoryRecord, SigningUnavailableError, type Submission } from "./index.ts";
import { signedOutcome } from "./signing-outcome.ts";

const NO_STORE = { "cache-control": "no-store" };

export interface ConfirmationDependencies {
  buildRecord: (id: string, submission: Submission) => SignatoryRecord;
  deletePending: (id: string) => Promise<void>;
  hasSameImmutableFields: (expected: SignatoryRecord, actual: SignatoryRecord) => boolean;
  isSigningLive: () => boolean;
  readPending: (id: string) => Promise<Submission | null>;
  readSignatory: (filePath: string) => Promise<SignatoryRecord | null>;
  recordPath: (record: SignatoryRecord) => string;
  verifyToken: (token: string, purpose: "confirm") => string | null;
  writeSignatory: (record: SignatoryRecord, filePath: string) => Promise<void>;
}

function noStore(response: NextResponse): NextResponse {
  response.headers.set("cache-control", "no-store");
  return response;
}

function confirmationPage(token: string, method: "GET" | "HEAD"): NextResponse {
  if (method === "HEAD") {
    return new NextResponse(null, { headers: NO_STORE });
  }
  // A verified token contains only base64url characters and a dot. Keep it in
  // the form only; it never appears in a URL, response text, or log.
  return new NextResponse(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="robots" content="noindex"><title>Confirm your signature</title></head><body><main><h1>Confirm your signature</h1><p>Confirming adds your signature to the private register.</p><form action="/api/sign/confirm" method="post"><input name="token" type="hidden" value="${token}"><button type="submit">Confirm signature</button></form></main></body></html>`,
    { headers: { ...NO_STORE, "content-type": "text/html; charset=utf-8" } }
  );
}

export function createConfirmationHandlers(dependencies: ConfirmationDependencies) {
  const invalid = (request: NextRequest) =>
    noStore(signedOutcome(request, "invalid", { error: "Confirmation link is invalid or expired.", status: 400 }));
  const closed = (request: NextRequest) =>
    noStore(signedOutcome(request, "closed", { error: "Signing is not open.", status: 404 }));
  const unavailable = (request: NextRequest) =>
    noStore(signedOutcome(request, "error", { error: "Signing is temporarily unavailable.", status: 503 }));

  function landing(request: NextRequest, method: "GET" | "HEAD"): NextResponse {
    if (!dependencies.isSigningLive()) {
      return closed(request);
    }
    const token = new URL(request.url).searchParams.get("token");
    if (!(token && dependencies.verifyToken(token, "confirm"))) {
      return invalid(request);
    }
    return confirmationPage(token, method);
  }

  return {
    GET: (request: NextRequest): NextResponse => landing(request, "GET"),
    HEAD: (request: NextRequest): NextResponse => landing(request, "HEAD"),
    POST: async (request: NextRequest): Promise<NextResponse> => {
      if (!dependencies.isSigningLive()) {
        return closed(request);
      }
      const token = (await request.formData()).get("token");
      const id = typeof token === "string" ? dependencies.verifyToken(token, "confirm") : null;
      if (!id) {
        return invalid(request);
      }

      try {
        const submission = await dependencies.readPending(id);
        if (!submission) {
          return invalid(request);
        }
        const record = dependencies.buildRecord(id, submission);
        const filePath = dependencies.recordPath(record);
        try {
          await dependencies.writeSignatory(record, filePath);
        } catch (error) {
          // A concurrent request can lose the create. It succeeds only when the
          // durable record is exactly the immutable statement this token names.
          const existing = await dependencies.readSignatory(filePath);
          if (!(existing && dependencies.hasSameImmutableFields(record, existing))) {
            throw new SigningUnavailableError("private record could not be confirmed", { cause: error });
          }
        }
        await dependencies.deletePending(id);
        return noStore(signedOutcome(request, "confirmed", { error: "", status: 303 }));
      } catch (error) {
        if (error instanceof SigningUnavailableError) {
          console.error("[sign/confirm] unavailable:", error.message);
        } else {
          console.error("[sign/confirm] unexpected:", error);
        }
        return unavailable(request);
      }
    },
  };
}
