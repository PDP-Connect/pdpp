import type { RemoteSurfaceFormFieldRect, RemoteSurfaceKeyModifier } from "../../protocol/index.ts";
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
export type FormOverlayReconciliationChange = {
    type: "appeared";
    overlayId: string;
    field: RemoteSurfaceFormFieldRect;
} | {
    type: "moved";
    overlayId: string;
    field: RemoteSurfaceFormFieldRect;
    previous: RemoteSurfaceFormFieldRect;
} | {
    type: "updated";
    overlayId: string;
    field: RemoteSurfaceFormFieldRect;
    previous: RemoteSurfaceFormFieldRect;
} | {
    type: "disappeared";
    overlayId: string;
    field: RemoteSurfaceFormFieldRect;
};
export interface FormOverlayReconciliationResult {
    changes: readonly FormOverlayReconciliationChange[];
    state: FormOverlayReconciliationState;
}
export type FormOverlayCommitOperation = {
    type: "focus_field";
    overlayId: string;
    field: RemoteSurfaceFormFieldRect;
} | {
    type: "select_all";
} | {
    type: "clear";
} | {
    type: "insert_text";
    text: string;
} | {
    type: "key_press";
    key: string;
    code: string;
    modifiers: readonly RemoteSurfaceKeyModifier[];
} | {
    type: "submit";
    key: "Enter" | "Tab";
    code: string;
    modifiers: readonly RemoteSurfaceKeyModifier[];
} | {
    type: "defer";
    reason: "composition_active";
};
export interface FormOverlayCommitPlan {
    operations: readonly FormOverlayCommitOperation[];
    status: "committed" | "deferred" | "noop";
}
export declare function formFieldToControlHint(field: RemoteSurfaceFormFieldRect): FormOverlayControlHint;
export declare function createFormOverlayReconciliationState(): FormOverlayReconciliationState;
export declare function reconcileFormOverlayFields(previousState: FormOverlayReconciliationState, fields: readonly RemoteSurfaceFormFieldRect[], { rectTolerancePx }?: {
    rectTolerancePx?: number;
}): FormOverlayReconciliationResult;
export declare function planFormOverlayValueCommit({ currentValue, fieldState, isComposing, previousValue, }: {
    currentValue: string;
    fieldState: FormOverlayFieldState;
    isComposing?: boolean;
    previousValue: string;
}): FormOverlayCommitPlan;
export declare function planFormOverlaySpecialKeyCommit({ code, fieldState, isComposing, key, modifiers, }: {
    code?: string;
    fieldState: FormOverlayFieldState;
    isComposing?: boolean;
    key: string;
    modifiers?: readonly RemoteSurfaceKeyModifier[];
}): FormOverlayCommitPlan;
//# sourceMappingURL=planner.d.ts.map