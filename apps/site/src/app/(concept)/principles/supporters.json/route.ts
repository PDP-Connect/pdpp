// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readPublicSupporters } from "@/lib/public-supporters.ts";

export async function GET(): Promise<Response> {
  return Response.json(await readPublicSupporters(), {
    headers: { "Cache-Control": "public, max-age=60" },
  });
}
