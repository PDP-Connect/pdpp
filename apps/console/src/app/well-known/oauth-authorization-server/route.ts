// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { proxyReferenceRequest } from "../../reference-proxy.ts";

const path = [".well-known", "oauth-authorization-server"] as const;

export const GET = (request: Request) => proxyReferenceRequest(request, "as", path);
