// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readFile } from "node:fs/promises";
import path from "node:path";

export interface PublicSupporter {
  country: string;
  principlesVersion: string;
  /** First name and last initial for individuals, organisation name otherwise. */
  publicName: string;
  signedOn: string;
  type: string;
}

// Read at build time from the public JSON. A fetch at request time would put a
// network hop in front of a file that ships in the repo, and would 500 the
// page when it failed; a missing or malformed file here degrades to the empty
// state, which is the honest rendering when the register cannot be read.
export async function readPublicSupporters(): Promise<readonly PublicSupporter[]> {
  try {
    const file = path.join(process.cwd(), "public", "principles", "supporters.json");
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return Array.isArray(parsed) ? (parsed as PublicSupporter[]) : [];
  } catch {
    return [];
  }
}
