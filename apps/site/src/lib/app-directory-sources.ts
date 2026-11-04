// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Server-side readers for /apps: the connector catalogue (live, with a copy in
// the repo as the fallback) and the conformance register (in the repo). Neither
// holds personal data. The Supporters register has its own reader in
// public-supporters.ts.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { unstable_cache } from "next/cache";
import { z } from "zod";
import type { ConnectorSnapshot, RegisterEntry } from "./app-directory.ts";
import { loadConnectorSnapshot } from "./connector-catalog.mjs";

const SNAPSHOT_PATH = ["src", "data", "connector-catalog.json"] as const;
const REGISTER_PATH = ["public", "register", "index.json"] as const;
// The catalogue changes when a connector is published, a few times a week at
// most. An hour keeps the page close to it at about 60 requests an hour.
const CATALOGUE_REVALIDATE_SECONDS = 3600;

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

interface ReadConnectorSnapshotOptions {
  loadLive?: () => Promise<unknown>;
  readBundled?: () => Promise<ConnectorSnapshot>;
}

/** The copy in the repo, refreshed by scripts/sync-connector-catalog.mjs. */
export async function readBundledConnectorSnapshot(): Promise<ConnectorSnapshot> {
  const file = path.join(process.cwd(), ...SNAPSHOT_PATH);
  return snapshotSchema.parse(JSON.parse(await readFile(file, "utf8")));
}

// One cache entry for the whole load. Caching each request on its own would
// key the registry requests by their short-lived token and miss every time.
const loadLiveCached = unstable_cache(() => loadConnectorSnapshot(), ["connector-catalog"], {
  revalidate: CATALOGUE_REVALIDATE_SECONDS,
});

// Reads the live catalogue, so a newly published connector shows within the
// hour without a deploy. Any failure, or an empty catalogue, falls back to the
// copy in the repo: the page always renders.
export async function readConnectorSnapshot(options: ReadConnectorSnapshotOptions = {}): Promise<ConnectorSnapshot> {
  const readBundled = options.readBundled ?? readBundledConnectorSnapshot;
  try {
    const live = snapshotSchema.parse(await (options.loadLive ?? loadLiveCached)());
    if (live.connectors.length === 0) {
      throw new Error("The live connector catalogue is empty");
    }
    return live;
  } catch {
    // Same rule as the Supporters reader: no payloads or messages in the log.
    console.warn("Unable to load the live connector catalogue; using the copy in the repo.");
    return await readBundled();
  }
}

/** The conformance register. Empty until Registered and Verified open. */
export async function readRegisterEntries(): Promise<readonly RegisterEntry[]> {
  const file = path.join(process.cwd(), ...REGISTER_PATH);
  return registerSchema.parse(JSON.parse(await readFile(file, "utf8")));
}
