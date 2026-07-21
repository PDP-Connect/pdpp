import type { CurrentReplacementReceipt } from "./ephemeral-health-projection.ts";

/** Luna owns this store and its current-generation selection semantics. */
export interface CurrentReplacementReceiptReader {
  selectCurrent(input: {
    readonly connection_id: string;
    readonly surface_subject_id?: string;
    readonly current_generation_hash?: string;
  }): Promise<CurrentReplacementReceipt | null>;
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
 * Read one already-selected ledger receipt. A failure stays distinguished from
 * an honest empty selection so the health projection can fail closed only for
 * the process-bound continuity axis.
 */
export async function readCurrentReplacementReceipt(input: {
  readonly connection_id: string;
  readonly current_generation_hash?: string;
  readonly reader: CurrentReplacementReceiptReader | null;
  readonly surface_subject_id?: string;
}): Promise<CurrentReplacementReceiptRead> {
  if (!input.reader) {
    return { state: "unavailable", receipt: null };
  }
  try {
    const receipt = await input.reader.selectCurrent({
      connection_id: input.connection_id,
      ...(input.surface_subject_id ? { surface_subject_id: input.surface_subject_id } : {}),
      ...(input.current_generation_hash ? { current_generation_hash: input.current_generation_hash } : {}),
    });
    return isScopedCurrentReceipt(receipt, input.connection_id, input.surface_subject_id)
      ? { state: "available", receipt }
      : { state: "available", receipt: null };
  } catch {
    return { state: "unavailable", receipt: null };
  }
}
