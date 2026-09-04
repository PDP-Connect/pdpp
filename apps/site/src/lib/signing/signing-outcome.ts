// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { type NextRequest, NextResponse } from "next/server";
import { type RestoredSigningForm, restoredFormCookie } from "./form-restoration.ts";

interface Outcome {
  error: string;
  status: number;
}

function acceptsJson(request: NextRequest): boolean {
  return request.headers.get("accept")?.toLowerCase().includes("application/json") ?? false;
}

function redirect(request: NextRequest, parameter: "signed" | "withdraw", state: string): NextResponse {
  return NextResponse.redirect(new URL(`/principles?${parameter}=${state}#sign`, request.url), 303);
}

export function signedOutcome(
  request: NextRequest,
  state: string,
  outcome: Outcome,
  restoredForm?: RestoredSigningForm
): NextResponse {
  if (outcome.status >= 400 && acceptsJson(request)) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  const response = redirect(request, "signed", state);
  if (restoredForm) {
    const cookie = restoredFormCookie(restoredForm);
    response.cookies.set(cookie.name, cookie.value, {
      httpOnly: true,
      maxAge: cookie.maxAge,
      path: "/principles",
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
    });
  } else if (state === "pending") {
    response.cookies.delete({ name: "pdpp_signing_form", path: "/principles" });
  }
  return response;
}

export function withdrawOutcome(request: NextRequest, state: string, outcome?: Outcome): NextResponse {
  if (outcome && acceptsJson(request)) {
    return NextResponse.json({ error: outcome.error }, { status: outcome.status });
  }
  return redirect(request, "withdraw", state);
}
