export interface NekoTouchScrollBridgeEnvironment {
  coarsePointer: boolean;
  landscape: boolean;
  nativeTouchSupported: boolean | null;
}

export interface NekoTouchScrollIntentInput {
  currentX: number;
  currentY: number;
  startX: number;
  startY: number;
  thresholdPx?: number;
  verticalBias?: number;
}

export interface NekoTouchPointRect {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export const NEKO_TOUCH_SCROLL_POLICY = {
  clickMaxDurationMs: 700,
  scrollIntentThresholdPx: 10,
  scrollStepPx: 50,
  verticalBias: 1.1,
} as const;

export function shouldUseNekoTouchScrollBridge({
  coarsePointer,
  landscape,
  nativeTouchSupported,
}: NekoTouchScrollBridgeEnvironment): boolean {
  return coarsePointer && landscape && nativeTouchSupported !== true;
}

export function isNekoTouchScrollIntent({
  currentX,
  currentY,
  startX,
  startY,
  thresholdPx = NEKO_TOUCH_SCROLL_POLICY.scrollIntentThresholdPx,
  verticalBias = NEKO_TOUCH_SCROLL_POLICY.verticalBias,
}: NekoTouchScrollIntentInput): boolean {
  const dx = currentX - startX;
  const dy = currentY - startY;
  return Math.hypot(dx, dy) >= thresholdPx && Math.abs(dy) >= Math.abs(dx) * verticalBias;
}

export function isNekoTouchPointInsideRect({
  clientX,
  clientY,
  rect,
}: {
  clientX: number;
  clientY: number;
  rect: NekoTouchPointRect;
}): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

export function takeNekoTouchScrollSteps(
  accumulatedPx: number,
  stepPx = NEKO_TOUCH_SCROLL_POLICY.scrollStepPx
): { remainderPx: number; steps: number } {
  if (!(Number.isFinite(accumulatedPx) && Number.isFinite(stepPx) && stepPx > 0)) {
    return { remainderPx: 0, steps: 0 };
  }
  const steps = accumulatedPx > 0 ? Math.floor(accumulatedPx / stepPx) : Math.ceil(accumulatedPx / stepPx);
  return {
    remainderPx: accumulatedPx - steps * stepPx,
    steps,
  };
}

export function nekoTouchScrollStepsToControlDelta(steps: number): number {
  return steps === 0 ? 0 : -Math.sign(steps);
}
