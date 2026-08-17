// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import type { CurrentReplacementReceipt } from "./ephemeral-health-projection.ts";

/** Luna owns this store and its current-generation selection semantics. */
export interface CurrentReplacementReceiptReader {
  selectCurrent: (input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }) => CurrentReplacementReceipt | null | Promise<CurrentReplacementReceipt | null>;
  selectSystemActionable?: (input: {
    readonly connection_id: string;
    readonly profile_key: string;
    readonly surface_subject_id?: string;
  }) => CurrentReplacementReceipt | null | Promise<CurrentReplacementReceipt | null>;
}

export type CurrentReplacementReceiptRead =
  | { readonly state: "available"; readonly receipt: CurrentReplacementReceipt | null }
  | { readonly state: "unavailable"; readonly receipt: null };

export type CurrentReplacementReceiptReaderFactory = () => CurrentReplacementReceiptReader;

let defaultReaderFactory: Promise<CurrentReplacementReceiptReaderFactory | null> | null = null;

/**
 * Cache the Luna module/factory, never a backend-bound store instance. A
 * process that switches SQLite/Postgres must obtain a fresh default store for
 * each read.
 */
export function loadDefaultCurrentReplacementReceiptReaderFactory(): Promise<CurrentReplacementReceiptReaderFactory | null> {
  if (defaultReaderFactory) {
    return defaultReaderFactory;
  }
  defaultReaderFactory = (async () => {
    try {
      const moduleSpecifier = "../../server/stores/browser-surface-replacement-ledger-store.ts";
      const module = (await import(moduleSpecifier)) as {
        getDefaultBrowserSurfaceReplacementReceiptStore?: CurrentReplacementReceiptReaderFactory;
      };
      return module.getDefaultBrowserSurfaceReplacementReceiptStore ?? null;
    } catch {
      return null;
    }
  })();
  return defaultReaderFactory;
}

function isScopedCurrentReceipt(
  value: CurrentReplacementReceipt | null,
  connectionId: string,
  surfaceSubjectId: string | undefined
): value is CurrentReplacementReceipt {
  return (
    value !== null &&
    value.connection_id === connectionId &&
    value.replacement_id.length > 0 &&
    // A supplied subject is an exact additional scope. Its omission means the
    // connection is a single-instance scope, where connection identity remains
    // the canonical boundary.
    (surfaceSubjectId === undefined || value.surface_subject_id === surfaceSubjectId)
  );
}

/**
 * Run a ledger selector and scope its result to the requested connection. A
 * failure stays distinguished from an honest empty selection so the health
 * projection can fail closed only for the process-bound continuity axis.
 */
async function readScopedReceipt(
  select: () => Promise<CurrentReplacementReceipt | null> | CurrentReplacementReceipt | null,
  connectionId: string,
  surfaceSubjectId: string | undefined
): Promise<CurrentReplacementReceiptRead> {
  try {
    const receipt = await select();
    return isScopedCurrentReceipt(receipt, connectionId, surfaceSubjectId)
      ? { receipt, state: "available" }
      : { receipt: null, state: "available" };
  } catch {
    return { receipt: null, state: "unavailable" };
  }
}

export async function readCurrentReplacementReceipt(input: {
  readonly connection_id: string;
  readonly current_generation_hash?: string;
  readonly reader: CurrentReplacementReceiptReader | null;
  readonly surface_subject_id?: string;
}): Promise<CurrentReplacementReceiptRead> {
  if (!input.reader) {
    return { receipt: null, state: "unavailable" };
  }
  return await readScopedReceipt(
    () =>
      input.reader?.selectCurrent({
        connection_id: input.connection_id,
        ...(input.surface_subject_id ? { surface_subject_id: input.surface_subject_id } : {}),
        ...(input.current_generation_hash ? { current_generation_hash: input.current_generation_hash } : {}),
      }) ?? null,
    input.connection_id,
    input.surface_subject_id
  );
}

export async function readSystemActionableReplacementReceipt(input: {
  readonly connection_id: string;
  readonly profile_key: string;
  readonly reader: CurrentReplacementReceiptReader | null;
  readonly surface_subject_id?: string;
}): Promise<CurrentReplacementReceiptRead> {
  const { reader } = input;
  if (!reader?.selectSystemActionable) {
    return { receipt: null, state: reader ? "available" : "unavailable" };
  }
  return await readScopedReceipt(
    () =>
      reader.selectSystemActionable?.({
        connection_id: input.connection_id,
        profile_key: input.profile_key,
        ...(input.surface_subject_id ? { surface_subject_id: input.surface_subject_id } : {}),
      }) ?? null,
    input.connection_id,
    input.surface_subject_id
  );
}
