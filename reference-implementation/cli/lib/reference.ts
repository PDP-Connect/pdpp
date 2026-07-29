// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CliFlags } from "./args.ts";
import { resolveAsUrl, resolveRsUrl } from "./common.ts";
import { discoverProvider } from "./discovery.ts";

export async function resolveReferenceAsUrl(flags: CliFlags): Promise<string | true> {
  if (flags["as-url"] || process.env.PDPP_AS_URL || process.env.AS_URL) {
    return resolveAsUrl(flags);
  }

  if (flags["rs-url"] || process.env.PDPP_RS_URL || process.env.RS_URL) {
    const discovered = await discoverProvider({
      ...flags,
      "rs-url": resolveRsUrl(flags),
    });
    return discovered.authorizationServer;
  }

  return resolveAsUrl(flags);
}
