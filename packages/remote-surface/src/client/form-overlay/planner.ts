import type {
  RemoteSurfaceFormFieldRect,
  RemoteSurfaceKeyModifier,
} from "../../protocol/index.ts";

const DEFAULT_RECT_TOLERANCE_PX = 4;

export interface FormOverlayControlHint {
  autocomplete: "current-password" | "on";
  element: "input" | "textarea";
  inputType: string;
  password: boolean;
  readOnly: boolean;
  disabled: boolean;
}

export interface FormOverlayFieldState {
  field: RemoteSurfaceFormFieldRect;
  identityKey: string;
  lastSeenSequence: number;
  overlayId: string;
}

export interface FormOverlayReconciliationState {
  entries: readonly FormOverlayFieldState[];
  nextGeneratedId: number;
  sequence: number;
}

export type FormOverlayReconciliationChange =
  | { type: "appeared"; overlayId: string; field: RemoteSurfaceFormFieldRect }
  | { type: "moved"; overlayId: string; field: RemoteSurfaceFormFieldRect; previous: RemoteSurfaceFormFieldRect }
  | { type: "updated"; overlayId: string; field: RemoteSurfaceFormFieldRect; previous: RemoteSurfaceFormFieldRect }
  | { type: "disappeared"; overlayId: string; field: RemoteSurfaceFormFieldRect };

export interface FormOverlayReconciliationResult {
  changes: readonly FormOverlayReconciliationChange[];
  state: FormOverlayReconciliationState;
}

export type FormOverlayCommitOperation =
  | { type: "focus_field"; overlayId: string; field: RemoteSurfaceFormFieldRect }
  | { type: "select_all" }
  | { type: "clear" }
  | { type: "insert_text"; text: string }
  | { type: "key_press"; key: string; code: string; modifiers: readonly RemoteSurfaceKeyModifier[] }
  | { type: "submit"; key: "Enter" | "Tab"; code: string; modifiers: readonly RemoteSurfaceKeyModifier[] }
  | { type: "defer"; reason: "composition_active" };

export interface FormOverlayCommitPlan {
  operations: readonly FormOverlayCommitOperation[];
  status: "committed" | "deferred" | "noop";
}

export function formFieldToControlHint(field: RemoteSurfaceFormFieldRect): FormOverlayControlHint {
  const password = field.tag === "input" && field.inputType.toLowerCase() === "password";
  return {
    autocomplete: password ? "current-password" : "on",
    element: field.tag === "textarea" ? "textarea" : "input",
    inputType: field.tag === "input" ? field.inputType || "text" : "",
    password,
    readOnly: field.readonly === true,
    disabled: field.disabled === true,
  };
}

export function createFormOverlayReconciliationState(): FormOverlayReconciliationState {
  return { entries: [], nextGeneratedId: 1, sequence: 0 };
}

export function reconcileFormOverlayFields(
  previousState: FormOverlayReconciliationState,
  fields: readonly RemoteSurfaceFormFieldRect[],
  { rectTolerancePx = DEFAULT_RECT_TOLERANCE_PX }: { rectTolerancePx?: number } = {},
): FormOverlayReconciliationResult {
  const sequence = previousState.sequence + 1;
  const unusedPrevious = new Set(previousState.entries);
  const changes: FormOverlayReconciliationChange[] = [];
  const nextEntries: FormOverlayFieldState[] = [];
  let nextGeneratedId = previousState.nextGeneratedId;

  for (const field of fields) {
    const identityKey = durableIdentityKey(field);
    const matched = findMatchingEntry(field, identityKey, unusedPrevious, rectTolerancePx);
    if (matched) {
      unusedPrevious.delete(matched);
      const next: FormOverlayFieldState = {
        field,
        identityKey: matched.identityKey,
        lastSeenSequence: sequence,
        overlayId: matched.overlayId,
      };
      nextEntries.push(next);
      if (!rectsWithinTolerance(matched.field, field, rectTolerancePx)) {
        changes.push({ type: "moved", overlayId: matched.overlayId, field, previous: matched.field });
      } else if (!fieldsEquivalentIgnoringRect(matched.field, field)) {
        changes.push({ type: "updated", overlayId: matched.overlayId, field, previous: matched.field });
      }
      continue;
    }

    const overlayId = `field-${nextGeneratedId.toString()}`;
    nextGeneratedId += 1;
    nextEntries.push({
      field,
      identityKey: identityKey ?? anonymousIdentityKey(field),
      lastSeenSequence: sequence,
      overlayId,
    });
    changes.push({ type: "appeared", overlayId, field });
  }

  for (const entry of unusedPrevious) {
    changes.push({ type: "disappeared", overlayId: entry.overlayId, field: entry.field });
  }

  return {
    changes,
    state: { entries: nextEntries, nextGeneratedId, sequence },
  };
}

export function planFormOverlayValueCommit({
  currentValue,
  fieldState,
  isComposing = false,
  previousValue,
}: {
  currentValue: string;
  fieldState: FormOverlayFieldState;
  isComposing?: boolean;
  previousValue: string;
}): FormOverlayCommitPlan {
  if (isComposing) {
    return { status: "deferred", operations: [{ type: "defer", reason: "composition_active" }] };
  }
  if (currentValue === previousValue) {
    return { status: "noop", operations: [] };
  }

  const operations = focusIfNeeded(fieldState);
  if (currentValue.length === 0) {
    operations.push({ type: "select_all" }, { type: "clear" });
    return { status: "committed", operations };
  }
  if (currentValue.length > previousValue.length && currentValue.startsWith(previousValue)) {
    operations.push({ type: "insert_text", text: currentValue.slice(previousValue.length) });
    return { status: "committed", operations };
  }
  if (currentValue.length < previousValue.length && previousValue.startsWith(currentValue)) {
    for (let index = 0; index < previousValue.length - currentValue.length; index += 1) {
      operations.push({ type: "key_press", key: "Backspace", code: "Backspace", modifiers: [] });
    }
    return { status: "committed", operations };
  }

  operations.push({ type: "select_all" });
  operations.push({ type: "insert_text", text: currentValue });
  return { status: "committed", operations };
}

export function planFormOverlaySpecialKeyCommit({
  code,
  fieldState,
  isComposing = false,
  key,
  modifiers = [],
}: {
  code?: string;
  fieldState: FormOverlayFieldState;
  isComposing?: boolean;
  key: string;
  modifiers?: readonly RemoteSurfaceKeyModifier[];
}): FormOverlayCommitPlan {
  const special = key.length > 1 && key !== "Unidentified" && key !== "Process";
  if (!special) {
    return { status: "noop", operations: [] };
  }
  if (isComposing) {
    return { status: "deferred", operations: [{ type: "defer", reason: "composition_active" }] };
  }

  const operations = focusIfNeeded(fieldState);
  const keyCode = code ?? key;
  if (key === "Enter" || key === "Tab") {
    operations.push({ type: "submit", key, code: keyCode, modifiers });
  } else {
    operations.push({ type: "key_press", key, code: keyCode, modifiers });
  }
  return { status: "committed", operations };
}

function focusIfNeeded(fieldState: FormOverlayFieldState): FormOverlayCommitOperation[] {
  if (fieldState.field.focused) {
    return [];
  }
  return [{ type: "focus_field", overlayId: fieldState.overlayId, field: fieldState.field }];
}

function findMatchingEntry(
  field: RemoteSurfaceFormFieldRect,
  identityKey: string | null,
  candidates: ReadonlySet<FormOverlayFieldState>,
  rectTolerancePx: number,
): FormOverlayFieldState | null {
  if (identityKey) {
    for (const candidate of candidates) {
      if (candidate.identityKey === identityKey) {
        return candidate;
      }
    }
  }
  for (const candidate of candidates) {
    if (
      candidate.field.tag === field.tag &&
      candidate.field.inputType === field.inputType &&
      rectsWithinTolerance(candidate.field, field, rectTolerancePx)
    ) {
      return candidate;
    }
  }
  return null;
}

function durableIdentityKey(field: RemoteSurfaceFormFieldRect): string | null {
  if (field.fieldId) {
    return `field-id:${field.fieldId}`;
  }
  if (field.id) {
    return `dom-id:${field.tag}:${field.id}`;
  }
  if (field.name) {
    return `name:${field.tag}:${field.inputType}:${field.name}`;
  }
  return null;
}

function anonymousIdentityKey(field: RemoteSurfaceFormFieldRect): string {
  return `anonymous:${field.tag}:${field.inputType}:${Math.round(field.x)}:${Math.round(field.y)}:${Math.round(
    field.width,
  )}:${Math.round(field.height)}`;
}

function rectsWithinTolerance(
  previous: Pick<RemoteSurfaceFormFieldRect, "height" | "width" | "x" | "y">,
  next: Pick<RemoteSurfaceFormFieldRect, "height" | "width" | "x" | "y">,
  tolerancePx: number,
): boolean {
  return (
    Math.abs(previous.x - next.x) <= tolerancePx &&
    Math.abs(previous.y - next.y) <= tolerancePx &&
    Math.abs(previous.width - next.width) <= tolerancePx &&
    Math.abs(previous.height - next.height) <= tolerancePx
  );
}

function fieldsEquivalentIgnoringRect(previous: RemoteSurfaceFormFieldRect, next: RemoteSurfaceFormFieldRect): boolean {
  return (
    previous.fieldId === next.fieldId &&
    previous.tag === next.tag &&
    previous.inputType === next.inputType &&
    previous.placeholder === next.placeholder &&
    previous.name === next.name &&
    previous.id === next.id &&
    previous.value === next.value &&
    previous.focused === next.focused &&
    previous.disabled === next.disabled &&
    previous.readonly === next.readonly
  );
}
