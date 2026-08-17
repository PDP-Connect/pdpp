// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { NextResponse } from "next/server";

/** Resolve the browser-facing origin using the same proxy headers as setup routes. */
export function publicOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto =
    request.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}`;
}

/** Redirect to a local route while preserving the public host/protocol. */
export function redirectToPublicPath(request: Request, path: string): NextResponse {
  return NextResponse.redirect(new URL(path, publicOrigin(request)), 303);
}

/** Accept same-origin form posts and reject cross-origin or malformed Origin headers. */
export function originMatchesHost(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) {
    return true;
  }
  const host = request.headers.get("host");
  if (!host) {
    return false;
  }
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}
