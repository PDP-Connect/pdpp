const DEFAULT_RECT_TOLERANCE_PX = 4;
export function formFieldToControlHint(field) {
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
export function createFormOverlayReconciliationState() {
    return { entries: [], nextGeneratedId: 1, sequence: 0 };
}
export function reconcileFormOverlayFields(previousState, fields, { rectTolerancePx = DEFAULT_RECT_TOLERANCE_PX } = {}) {
    const sequence = previousState.sequence + 1;
    const unusedPrevious = new Set(previousState.entries);
    const changes = [];
    const nextEntries = [];
    let nextGeneratedId = previousState.nextGeneratedId;
    for (const field of fields) {
        const identityKey = durableIdentityKey(field);
        const matched = findMatchingEntry(field, identityKey, unusedPrevious, rectTolerancePx);
        if (matched) {
            unusedPrevious.delete(matched);
            const next = {
                field,
                identityKey: matched.identityKey,
                lastSeenSequence: sequence,
                overlayId: matched.overlayId,
            };
            nextEntries.push(next);
            if (!rectsWithinTolerance(matched.field, field, rectTolerancePx)) {
                changes.push({ type: "moved", overlayId: matched.overlayId, field, previous: matched.field });
            }
            else if (!fieldsEquivalentIgnoringRect(matched.field, field)) {
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
export function planFormOverlayValueCommit({ currentValue, fieldState, isComposing = false, previousValue, }) {
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
export function planFormOverlaySpecialKeyCommit({ code, fieldState, isComposing = false, key, modifiers = [], }) {
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
    }
    else {
        operations.push({ type: "key_press", key, code: keyCode, modifiers });
    }
    return { status: "committed", operations };
}
function focusIfNeeded(fieldState) {
    if (fieldState.field.focused) {
        return [];
    }
    return [{ type: "focus_field", overlayId: fieldState.overlayId, field: fieldState.field }];
}
function findMatchingEntry(field, identityKey, candidates, rectTolerancePx) {
    if (identityKey) {
        for (const candidate of candidates) {
            if (candidate.identityKey === identityKey) {
                return candidate;
            }
        }
    }
    for (const candidate of candidates) {
        if (candidate.field.tag === field.tag &&
            candidate.field.inputType === field.inputType &&
            rectsWithinTolerance(candidate.field, field, rectTolerancePx)) {
            return candidate;
        }
    }
    return null;
}
function durableIdentityKey(field) {
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
function anonymousIdentityKey(field) {
    return `anonymous:${field.tag}:${field.inputType}:${Math.round(field.x)}:${Math.round(field.y)}:${Math.round(field.width)}:${Math.round(field.height)}`;
}
function rectsWithinTolerance(previous, next, tolerancePx) {
    return (Math.abs(previous.x - next.x) <= tolerancePx &&
        Math.abs(previous.y - next.y) <= tolerancePx &&
        Math.abs(previous.width - next.width) <= tolerancePx &&
        Math.abs(previous.height - next.height) <= tolerancePx);
}
function fieldsEquivalentIgnoringRect(previous, next) {
    return (previous.fieldId === next.fieldId &&
        previous.tag === next.tag &&
        previous.inputType === next.inputType &&
        previous.placeholder === next.placeholder &&
        previous.name === next.name &&
        previous.id === next.id &&
        previous.value === next.value &&
        previous.focused === next.focused &&
        previous.disabled === next.disabled &&
        previous.readonly === next.readonly);
}
//# sourceMappingURL=planner.js.map