// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const BUNDLED_SUPPORTERS_PATH = ["public", "principles", "supporters.json"] as const;
const SUPPORTERS_URL =
  "https://raw.githubusercontent.com/PDP-Connect/pdpp/main/apps/site/public/principles/supporters.json";

const publicSupporterSchema = z.strictObject({
  country: z.string(),
  principlesVersion: z.string(),
  publicName: z.string(),
  signedOn: z.string(),
  type: z.string(),
});

const publicSupportersSchema = z.array(publicSupporterSchema);

export type PublicSupporter = z.infer<typeof publicSupporterSchema>;

type CachedFetch = (input: string, init?: RequestInit & { next?: { revalidate: number } }) => Promise<Response>;

interface ReadPublicSupportersOptions {
  fetch?: CachedFetch;
  now?: Date;
  readBundled?: () => Promise<readonly PublicSupporter[]>;
}

/** Returns a distinct raw-file URL for each minute, bypassing GitHub's five-minute raw cache. */
export function publicSupportersUrl(now = new Date()): string {
  const url = new URL(SUPPORTERS_URL);
  url.searchParams.set("minute", String(Math.floor(now.getTime() / 60_000)));
  return url.toString();
}

async function readBundledPublicSupporters(): Promise<readonly PublicSupporter[]> {
  const file = path.join(process.cwd(), ...BUNDLED_SUPPORTERS_PATH);
  return publicSupportersSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

// Reads the reviewed public register from main at runtime. The minute key
// bypasses GitHub's raw-file cache; Next deduplicates the request and may
// revalidate its result once per minute across dynamic page requests.
export async function readPublicSupporters(
  options: ReadPublicSupportersOptions = {}
): Promise<readonly PublicSupporter[]> {
  const readBundled = options.readBundled ?? readBundledPublicSupporters;

  try {
    const response = await (options.fetch ?? fetch)(publicSupportersUrl(options.now), {
      next: { revalidate: 60 },
    });
    if (!response.ok) {
      throw new Error(`Supporters register request returned ${response.status}`);
    }
    return publicSupportersSchema.parse(await response.json());
  } catch {
    // Do not include payloads or exception messages: this is public-site
    // operational context only, and the bundled register is the safe fallback.
    console.warn("Unable to load the live public supporters register; using the bundled register.");
    return await readBundled();
  }
}
