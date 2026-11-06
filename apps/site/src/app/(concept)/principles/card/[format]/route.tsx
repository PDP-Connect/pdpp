// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { isShareCardFormat, SHARE_CARD_FORMAT_NAMES } from "@/lib/share-card/copy.ts";
import { renderShareCard } from "@/lib/share-card/render.tsx";
import { shareCardEnabled } from "@/lib/site-config.ts";

// The supporter card is the same image for everyone, so each size is built once
// at build time. Only the two known formats exist; anything else is a 404.
export const dynamicParams = false;

export function generateStaticParams(): { format: string }[] {
  return SHARE_CARD_FORMAT_NAMES.map((format) => ({ format }));
}

export async function GET(_request: Request, context: { params: Promise<{ format: string }> }): Promise<Response> {
  const { format } = await context.params;
  if (!(shareCardEnabled() && isShareCardFormat(format))) {
    return new Response("Not found", { status: 404 });
  }
  return await renderShareCard(format);
}
