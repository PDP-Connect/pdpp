export const NEKO_TOUCH_SCROLL_POLICY = {
    clickMaxDurationMs: 700,
    scrollIntentThresholdPx: 10,
    scrollStepPx: 50,
    verticalBias: 1.1,
};
export function shouldUseNekoTouchScrollBridge({ coarsePointer, landscape, nativeTouchSupported, }) {
    return coarsePointer && landscape && nativeTouchSupported !== true;
}
export function isNekoTouchScrollIntent({ currentX, currentY, startX, startY, thresholdPx = NEKO_TOUCH_SCROLL_POLICY.scrollIntentThresholdPx, verticalBias = NEKO_TOUCH_SCROLL_POLICY.verticalBias, }) {
    const dx = currentX - startX;
    const dy = currentY - startY;
    return Math.hypot(dx, dy) >= thresholdPx && Math.abs(dy) >= Math.abs(dx) * verticalBias;
}
export function isNekoTouchPointInsideRect({ clientX, clientY, rect, }) {
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}
export function takeNekoTouchScrollSteps(accumulatedPx, stepPx = NEKO_TOUCH_SCROLL_POLICY.scrollStepPx) {
    if (!(Number.isFinite(accumulatedPx) && Number.isFinite(stepPx) && stepPx > 0)) {
        return { remainderPx: 0, steps: 0 };
    }
    const steps = accumulatedPx > 0 ? Math.floor(accumulatedPx / stepPx) : Math.ceil(accumulatedPx / stepPx);
    return {
        remainderPx: accumulatedPx - steps * stepPx,
        steps,
    };
}
export function nekoTouchScrollStepsToControlDelta(steps) {
    return steps === 0 ? 0 : -Math.sign(steps);
}
//# sourceMappingURL=touch-scroll.js.map