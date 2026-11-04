// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Server-side readers for the two files /apps reads from this repository.
// Both ship in the repo and hold no personal data, so they are read at build
// time. The Supporters register has its own reader in public-supporters.ts.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { ConnectorSnapshot, RegisterEntry } from "./app-directory.ts";

const SNAPSHOT_PATH = ["src", "data", "connector-catalog.json"] as const;
const REGISTER_PATH = ["public", "register", "index.json"] as const;

const snapshotSchema = z.object({
  connectors: z.array(
    z.object({
      display_name: z.string(),
      key: z.string(),
      labels: z.array(z.string()),
      source_path: z.string().nullable(),
      tier: z.enum(["supported", "preview", "development"]),
    })
  ),
  generated_at: z.string(),
  layer_digest: z.string(),
  manifest_digest: z.string(),
  source: z.string(),
  source_commit: z.string(),
});

const registerSchema = z.array(
  z.object({
    organisation: z.string(),
    role: z.string(),
    since: z.string(),
    specVersion: z.string(),
    state: z.string(),
    status: z.string(),
  })
);

export async function readConnectorSnapshot(): Promise<ConnectorSnapshot> {
  const file = path.join(process.cwd(), ...SNAPSHOT_PATH);
  return snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

/** The conformance register. Empty until Registered and Verified open. */
export async function readRegisterEntries(): Promise<readonly RegisterEntry[]> {
  const file = path.join(process.cwd(), ...REGISTER_PATH);
  return registerSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
