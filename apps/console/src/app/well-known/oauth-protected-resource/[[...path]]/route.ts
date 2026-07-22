// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { proxyReferenceCatchAll } from "../../../reference-proxy.ts";

const prefix = [".well-known", "oauth-protected-resource"] as const;

export const GET = (request: Request, context: Parameters<typeof proxyReferenceCatchAll>[3]) =>
  proxyReferenceCatchAll(request, "rs", prefix, context);
