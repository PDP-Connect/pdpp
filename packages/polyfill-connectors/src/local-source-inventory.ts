import { createHash } from "node:crypto";
import { type Dirent, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { RecordData } from "./connector-runtime.ts";

export type SourceClassification = "collect" | "collect_redacted" | "inventory_only" | "exclude" | "defer";
export type CoverageStatus = "collected" | "inventory_only" | "excluded" | "deferred" | "missing" | "unsupported";

export interface KnownLocalStore {
  classification: SourceClassification;
  reason: string;
  relativePath: string;
  store: string;
  stream: string | null;
}

export interface InventoryRecord extends RecordData {
  classification: "inventory_only" | "defer";
  id: string;
  mtime_epoch: number | null;
  path_hash: string;
  reason: string;
  relative_path: string;
  size_bytes: number | null;
  store: string;
  type: "directory" | "file" | "missing" | "other";
}

export interface CoverageRecord extends RecordData {
  id: string;
  reason: string;
  status: CoverageStatus;
  store: string;
  stream: string | null;
}

export interface InventoryPlan {
  coverage: CoverageRecord[];
  recordsByStream: Map<string, InventoryRecord[]>;
}

function pathHash(tool: string, relativePath: string): string {
  return createHash("sha256").update(`${tool}:${relativePath}`).digest("hex");
}

function inventoryEntryType(st: { isDirectory: () => boolean; isFile: () => boolean }): InventoryRecord["type"] {
  if (st.isDirectory()) {
    return "directory";
  }
  if (st.isFile()) {
    return "file";
  }
  return "other";
}

function coverageStatus(classification: SourceClassification, exists: boolean): CoverageStatus {
  if (!exists) {
    return "missing";
  }
  if (classification === "collect") {
    return "collected";
  }
  if (classification === "inventory_only") {
    return "inventory_only";
  }
  if (classification === "exclude") {
    return "excluded";
  }
  if (classification === "defer" || classification === "collect_redacted") {
    return "deferred";
  }
  return "unsupported";
}

async function statKind(path: string): Promise<{
  exists: boolean;
  mtimeEpoch: number | null;
  sizeBytes: number | null;
  type: InventoryRecord["type"];
}> {
  try {
    const st = await stat(path);
    return {
      exists: true,
      mtimeEpoch: Math.floor(st.mtimeMs / 1000),
      sizeBytes: st.isFile() ? st.size : null,
      type: inventoryEntryType(st),
    };
  } catch {
    return { exists: false, mtimeEpoch: null, sizeBytes: null, type: "missing" };
  }
}

export async function buildLocalSourceInventory(
  tool: string,
  sourceHome: string,
  stores: readonly KnownLocalStore[]
): Promise<InventoryPlan> {
  const recordsByStream = new Map<string, InventoryRecord[]>();
  const coverage: CoverageRecord[] = [];

  for (const store of stores) {
    const fullPath = join(sourceHome, store.relativePath);
    const pathMeta = await statKind(fullPath);
    const status = coverageStatus(store.classification, pathMeta.exists);
    coverage.push({
      id: `${store.store}:${status}`,
      store: store.store,
      stream: store.stream,
      status,
      reason: store.reason,
    });

    if (
      !(pathMeta.exists && store.stream) ||
      (store.classification !== "inventory_only" && store.classification !== "defer")
    ) {
      continue;
    }
    const records = recordsByStream.get(store.stream) ?? [];
    records.push({
      id: `${store.store}:${pathHash(tool, store.relativePath)}`,
      store: store.store,
      relative_path: store.relativePath,
      path_hash: pathHash(tool, store.relativePath),
      type: pathMeta.type,
      size_bytes: pathMeta.sizeBytes,
      mtime_epoch: pathMeta.mtimeEpoch,
      classification: store.classification,
      reason: store.reason,
    });
    recordsByStream.set(store.stream, records);
  }

  return { coverage, recordsByStream };
}

export async function listDirectoryInventory(input: {
  reason: string;
  relativeRoot: string;
  sourceHome: string;
  store: string;
  stream: string;
  tool: string;
}): Promise<InventoryRecord[]> {
  const root = join(input.sourceHome, input.relativeRoot);
  let entries: Dirent[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }

  const records: InventoryRecord[] = [];
  for (const ent of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (ent.name.startsWith(".")) {
      continue;
    }
    const rel = `${input.relativeRoot}/${ent.name}`;
    const full = join(root, ent.name);
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    records.push({
      id: `${input.store}:${pathHash(input.tool, rel)}`,
      store: input.store,
      relative_path: rel,
      path_hash: pathHash(input.tool, rel),
      type: inventoryEntryType(st),
      size_bytes: st.isFile() ? st.size : null,
      mtime_epoch: Math.floor(st.mtimeMs / 1000),
      classification: "inventory_only",
      reason: input.reason,
    });
  }
  return records;
}
