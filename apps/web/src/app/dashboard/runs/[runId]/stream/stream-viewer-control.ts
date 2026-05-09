import type { ViewportPayload } from "./stream-geometry.ts";
import {
  assessNekoMediaSettle,
  createNekoMediaSettleState,
  type NekoMediaSettleSample,
  type NekoMediaSettleState,
} from "./stream-media-settle.ts";
import { classifyViewportTransition, type ViewportObservation } from "./stream-viewport-classifier.ts";

export type StreamViewerControlEvent =
  | {
      observation: ViewportObservation;
      source: string;
      type: "viewport.observed";
      viewport: ViewportPayload;
    }
  | {
      sample: NekoMediaSettleSample;
      type: "media.sampled";
    };

export type StreamViewerCommand =
  | {
      reason: string;
      source: string;
      type: "viewport.hold";
    }
  | {
      reason: string;
      source: string;
      type: "viewport.post";
      viewport: ViewportPayload;
    }
  | {
      reasons: string[];
      type: "media.degraded";
    }
  | {
      type: "media.settled";
    };

export interface StreamViewerControlState {
  media: NekoMediaSettleState;
  viewport: {
    orientationSettle: OrientationSettleState | null;
    previousObservation: ViewportObservation | null;
  };
}

export interface StreamViewerControlStep {
  commands: StreamViewerCommand[];
  state: StreamViewerControlState;
}

export interface StreamViewerControlPolicy {
  orientationSettleMs: number;
  orientationStableSamples: number;
  orientationStableTolerancePx: number;
}

interface OrientationSettleState {
  lastSize: { height: number; width: number };
  stableSamples: number;
  startedAtMs: number;
}

const DEFAULT_CONTROL_POLICY: StreamViewerControlPolicy = {
  // Mobile rotation emits several transient layout/visual viewport samples.
  // Hold n.eko until at least one follow-up sample confirms the final box.
  orientationSettleMs: 300,
  orientationStableSamples: 2,
  orientationStableTolerancePx: 2,
};
const ORIENTATION_SOURCE_RE = /orientation|screen\.orientation/i;
const ORIENTATION_START_SOURCES = new Set(["orientationchange", "screen.orientation.change"]);

export function presentationViewportsMatch(
  a: { height: number; width: number } | null,
  b: { height: number; width: number } | null,
  tolerancePx = 1
): boolean {
  if (!(a && b)) {
    return false;
  }
  return sizesMatch(a, b, tolerancePx);
}

export interface PresentationViewportLike {
  height: number;
  screenHeight?: number;
  screenWidth?: number;
  width: number;
}

function captureSize(viewport: PresentationViewportLike): { height: number; width: number } {
  return {
    height: viewport.screenHeight ?? viewport.height,
    width: viewport.screenWidth ?? viewport.width,
  };
}

export function localSurfaceCanDisplayPresentation(
  local: PresentationViewportLike | null,
  presentation: PresentationViewportLike | null
): boolean {
  if (!presentation) {
    return false;
  }
  if (!local) {
    return true;
  }
  if (presentationViewportsMatch(local, presentation) && presentationViewportsMatch(captureSize(local), captureSize(presentation))) {
    return true;
  }
  return (
    presentationViewportsMatch(
      { height: presentation.height, width: local.width },
      { height: presentation.height, width: presentation.width }
    ) &&
    presentationViewportsMatch(
      { height: captureSize(presentation).height, width: captureSize(local).width },
      captureSize(presentation)
    )
  );
}

export function stablePresentationContainerRect(
  actual: { height: number; width: number } | null,
  presentation: PresentationViewportLike | null
): { height: number; width: number } | null {
  if (!(actual && presentation)) {
    return actual;
  }
  if (presentationViewportsMatch(actual, presentation)) {
    return actual;
  }
  return {
    height: presentation.height,
    width: presentation.width,
  };
}

export function nextPresentationOrientationHoldUntilMs({
  currentHoldUntilMs,
  holdMs,
  nowMs,
  source,
}: {
  currentHoldUntilMs: number;
  holdMs: number;
  nowMs: number;
  source: string;
}): number {
  if (!ORIENTATION_START_SOURCES.has(source)) {
    return currentHoldUntilMs;
  }
  return Math.max(currentHoldUntilMs, nowMs + holdMs);
}

export function shouldDebouncePresentationViewportUpdate({
  nowMs,
  orientationHoldUntilMs,
  source,
}: {
  nowMs: number;
  orientationHoldUntilMs: number;
  source: string;
}): boolean {
  return orientationSource(source) || nowMs < orientationHoldUntilMs;
}

export function nextPresentationKeyboardHoldUntilMs({
  currentHoldUntilMs,
  isKeyboardActive,
  holdMs,
  nowMs,
}: {
  currentHoldUntilMs: number;
  holdMs: number;
  isKeyboardActive: boolean;
  nowMs: number;
}): number {
  if (!isKeyboardActive) {
    return currentHoldUntilMs;
  }
  return Math.max(currentHoldUntilMs, nowMs + holdMs);
}

export function shouldHoldPresentationViewportForKeyboard({
  isMobileViewport,
  keyboardActive,
  keyboardHoldUntilMs,
  nowMs,
  source,
}: {
  isMobileViewport: boolean;
  keyboardActive: boolean;
  keyboardHoldUntilMs: number;
  nowMs: number;
  source: string;
}): boolean {
  return isMobileViewport && !orientationSource(source) && (keyboardActive || nowMs < keyboardHoldUntilMs);
}

export function createStreamViewerControlState(): StreamViewerControlState {
  return {
    media: createNekoMediaSettleState(),
    viewport: {
      orientationSettle: null,
      previousObservation: null,
    },
  };
}

function observationTimeMs(observation: ViewportObservation): number {
  return Number.isFinite(Number(observation.timestampMs)) ? Number(observation.timestampMs) : Date.now();
}

function sizesMatch(
  a: { height: number; width: number },
  b: { height: number; width: number },
  tolerancePx: number
): boolean {
  return Math.abs(a.width - b.width) <= tolerancePx && Math.abs(a.height - b.height) <= tolerancePx;
}

function orientationSource(source: string): boolean {
  return ORIENTATION_SOURCE_RE.test(source);
}

function advanceOrientationSettle({
  current,
  nowMs,
  policy,
  size,
}: {
  current: OrientationSettleState | null;
  nowMs: number;
  policy: StreamViewerControlPolicy;
  size: { height: number; width: number };
}): OrientationSettleState {
  if (!current) {
    return { lastSize: size, stableSamples: 1, startedAtMs: nowMs };
  }
  const stableSamples = sizesMatch(current.lastSize, size, policy.orientationStableTolerancePx)
    ? current.stableSamples + 1
    : 1;
  return {
    lastSize: size,
    stableSamples,
    startedAtMs: current.startedAtMs,
  };
}

export function reduceStreamViewerControl(
  state: StreamViewerControlState,
  event: StreamViewerControlEvent,
  policy: StreamViewerControlPolicy = DEFAULT_CONTROL_POLICY
): StreamViewerControlStep {
  if (event.type === "viewport.observed") {
    const transition = classifyViewportTransition(state.viewport.previousObservation, event.observation);
    const nowMs = observationTimeMs(event.observation);
    const orientationSettle =
      transition.kind === "orientation-change" || state.viewport.orientationSettle || orientationSource(event.source)
        ? advanceOrientationSettle({
            current: state.viewport.orientationSettle,
            nowMs,
            policy,
            size: event.viewport,
          })
        : null;
    const orientationSettled =
      orientationSettle &&
      nowMs - orientationSettle.startedAtMs >= policy.orientationSettleMs &&
      orientationSettle.stableSamples >= policy.orientationStableSamples;
    const nextState = {
      ...state,
      viewport: {
        orientationSettle: orientationSettled ? null : orientationSettle,
        previousObservation: event.observation,
      },
    };
    if (orientationSettle && !orientationSettled) {
      return {
        commands: [
          {
            reason: "orientation-settling",
            source: event.source,
            type: "viewport.hold",
          },
        ],
        state: nextState,
      };
    }
    if (orientationSettled) {
      return {
        commands: [
          {
            reason: "orientation-settled",
            source: event.source,
            type: "viewport.post",
            viewport: event.viewport,
          },
        ],
        state: nextState,
      };
    }
    if (transition.remoteResize === "post") {
      return {
        commands: [
          {
            reason: transition.reason,
            source: event.source,
            type: "viewport.post",
            viewport: event.viewport,
          },
        ],
        state: nextState,
      };
    }
    return {
      commands: [
        {
          reason: transition.reason,
          source: event.source,
          type: "viewport.hold",
        },
      ],
      state: nextState,
    };
  }

  const media = assessNekoMediaSettle({ sample: event.sample, state: state.media });
  const nextState = { ...state, media: media.state };
  if (media.status === "settled") {
    return { commands: [{ type: "media.settled" }], state: nextState };
  }
  if (media.status === "degraded") {
    return { commands: [{ reasons: media.reasons, type: "media.degraded" }], state: nextState };
  }
  return { commands: [], state: nextState };
}

export function replayStreamViewerControl(
  events: StreamViewerControlEvent[],
  initialState = createStreamViewerControlState(),
  policy: StreamViewerControlPolicy = DEFAULT_CONTROL_POLICY
): StreamViewerControlStep {
  let state = initialState;
  const commands: StreamViewerCommand[] = [];
  for (const event of events) {
    const step = reduceStreamViewerControl(state, event, policy);
    state = step.state;
    commands.push(...step.commands);
  }
  return { commands, state };
}
