import { assessNekoMediaSettle, createNekoMediaSettleState, } from "../backends/neko/media-settle.js";
import { classifyViewportTransition } from "./viewport-classifier.js";
const DEFAULT_CONTROL_POLICY = {
    // Mobile rotation emits several transient layout/visual viewport samples.
    // Hold n.eko until at least one follow-up sample confirms the final box.
    orientationSettleMs: 300,
    orientationStableSamples: 2,
    orientationStableTolerancePx: 2,
};
const ORIENTATION_SOURCE_RE = /orientation|screen\.orientation/i;
const ORIENTATION_START_SOURCES = new Set(["orientationchange", "screen.orientation.change"]);
export function presentationViewportsMatch(a, b, tolerancePx = 1) {
    if (!(a && b)) {
        return false;
    }
    return sizesMatch(a, b, tolerancePx);
}
function captureSize(viewport) {
    return {
        height: viewport.screenHeight ?? viewport.height,
        width: viewport.screenWidth ?? viewport.width,
    };
}
export function localSurfaceCanDisplayPresentation(local, presentation) {
    if (!presentation) {
        return false;
    }
    if (!local) {
        return true;
    }
    if (presentationViewportsMatch(local, presentation) && presentationViewportsMatch(captureSize(local), captureSize(presentation))) {
        return true;
    }
    return (presentationViewportsMatch({ height: presentation.height, width: local.width }, { height: presentation.height, width: presentation.width }) &&
        presentationViewportsMatch({ height: captureSize(presentation).height, width: captureSize(local).width }, captureSize(presentation)));
}
export function stablePresentationContainerRect(actual, presentation) {
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
export function nextPresentationOrientationHoldUntilMs({ currentHoldUntilMs, holdMs, nowMs, source, }) {
    if (!ORIENTATION_START_SOURCES.has(source)) {
        return currentHoldUntilMs;
    }
    return Math.max(currentHoldUntilMs, nowMs + holdMs);
}
export function shouldDebouncePresentationViewportUpdate({ nowMs, orientationHoldUntilMs, source, }) {
    return orientationSource(source) || nowMs < orientationHoldUntilMs;
}
export function nextPresentationKeyboardHoldUntilMs({ currentHoldUntilMs, isKeyboardActive, holdMs, nowMs, }) {
    if (!isKeyboardActive) {
        return currentHoldUntilMs;
    }
    return Math.max(currentHoldUntilMs, nowMs + holdMs);
}
export function shouldHoldPresentationViewportForKeyboard({ isMobileViewport, keyboardActive, keyboardHoldUntilMs, nowMs, source, }) {
    return isMobileViewport && !orientationSource(source) && (keyboardActive || nowMs < keyboardHoldUntilMs);
}
export function createStreamViewerControlState() {
    return {
        media: createNekoMediaSettleState(),
        viewport: {
            orientationSettle: null,
            previousObservation: null,
        },
    };
}
function observationTimeMs(observation) {
    return Number.isFinite(Number(observation.timestampMs)) ? Number(observation.timestampMs) : Date.now();
}
function sizesMatch(a, b, tolerancePx) {
    return Math.abs(a.width - b.width) <= tolerancePx && Math.abs(a.height - b.height) <= tolerancePx;
}
function orientationSource(source) {
    return ORIENTATION_SOURCE_RE.test(source);
}
function advanceOrientationSettle({ current, nowMs, policy, size, }) {
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
export function reduceStreamViewerControl(state, event, policy = DEFAULT_CONTROL_POLICY) {
    if (event.type === "viewport.observed") {
        const transition = classifyViewportTransition(state.viewport.previousObservation, event.observation);
        const nowMs = observationTimeMs(event.observation);
        const orientationSettle = transition.kind === "orientation-change" || state.viewport.orientationSettle || orientationSource(event.source)
            ? advanceOrientationSettle({
                current: state.viewport.orientationSettle,
                nowMs,
                policy,
                size: event.viewport,
            })
            : null;
        const orientationSettled = orientationSettle &&
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
export function replayStreamViewerControl(events, initialState = createStreamViewerControlState(), policy = DEFAULT_CONTROL_POLICY) {
    let state = initialState;
    const commands = [];
    for (const event of events) {
        const step = reduceStreamViewerControl(state, event, policy);
        state = step.state;
        commands.push(...step.commands);
    }
    return { commands, state };
}
//# sourceMappingURL=stream-viewer-control.js.map