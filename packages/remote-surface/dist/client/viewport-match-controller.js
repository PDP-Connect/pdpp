import { buildViewportPayload, assessMobileKeyboardViewportResize, createMobileKeyboardResizeState, viewportPayloadsAreEquivalent, } from "./geometry.js";
import { classifyViewportTransition, } from "./viewport-classifier.js";
const DEFAULT_DEBOUNCE_MS = 180;
const DEFAULT_MATCHED_THRESHOLD_PX = 2;
const ZERO_BARS = {
    bottom: 0,
    left: 0,
    right: 0,
    top: 0,
};
const defaultClock = {
    clearTimeout(handle) {
        clearTimeout(handle);
    },
    now() {
        return Date.now();
    },
    setTimeout(callback, delayMs) {
        return setTimeout(callback, delayMs);
    },
};
function roundCssPixel(value) {
    return Number.isFinite(value) ? Math.max(1, Math.round(value)) : 1;
}
function currentWindow() {
    return typeof window === "undefined" ? null : window;
}
function activeElementIsEditable() {
    const doc = typeof document === "undefined" ? null : document;
    const active = doc?.activeElement;
    if (!active) {
        return false;
    }
    if ((typeof HTMLInputElement !== "undefined" && active instanceof HTMLInputElement) ||
        (typeof HTMLTextAreaElement !== "undefined" && active instanceof HTMLTextAreaElement) ||
        (typeof HTMLSelectElement !== "undefined" && active instanceof HTMLSelectElement)) {
        return true;
    }
    if (typeof HTMLElement !== "undefined" && active instanceof HTMLElement) {
        return active.isContentEditable || active.getAttribute("role") === "textbox";
    }
    return false;
}
function defaultViewportDefaults(geometry) {
    const win = currentWindow();
    const nav = typeof navigator === "undefined" ? null : navigator;
    const hasTouch = Boolean(nav && nav.maxTouchPoints > 0);
    const coarsePointer = Boolean(win?.matchMedia?.("(pointer: coarse)").matches);
    return {
        deviceScaleFactor: win?.devicePixelRatio ?? 1,
        hasTouch,
        mobile: hasTouch && (coarsePointer || Math.min(geometry.containerBox.width, geometry.containerBox.height) <= 900),
        userAgent: nav?.userAgent ?? "",
    };
}
function resolveViewportDefaults(defaults, geometry) {
    if (!defaults) {
        return defaultViewportDefaults(geometry);
    }
    return typeof defaults === "function" ? defaults(geometry) : defaults;
}
function screenOrientationSample() {
    const orientation = currentWindow()?.screen?.orientation;
    if (!orientation) {
        return null;
    }
    return {
        angle: typeof orientation.angle === "number" ? orientation.angle : 0,
        type: typeof orientation.type === "string" ? orientation.type : "",
    };
}
function visualViewportSample() {
    const visual = currentWindow()?.visualViewport;
    if (!visual) {
        return null;
    }
    return {
        height: visual.height,
        offsetLeft: visual.offsetLeft,
        offsetTop: visual.offsetTop,
        pageLeft: visual.pageLeft,
        pageTop: visual.pageTop,
        scale: visual.scale,
        width: visual.width,
    };
}
function defaultObservationFromGeometry(geometry) {
    const defaults = defaultViewportDefaults(geometry);
    const observation = {
        editableFocused: activeElementIsEditable(),
        layout: {
            height: roundCssPixel(geometry.containerBox.height),
            width: roundCssPixel(geometry.containerBox.width),
        },
        timestampMs: defaultClock.now(),
    };
    if (typeof defaults.mobile === "boolean") {
        observation.mobile = defaults.mobile;
    }
    const orientation = screenOrientationSample();
    if (orientation) {
        observation.orientation = orientation;
    }
    const visual = visualViewportSample();
    if (visual) {
        observation.visual = visual;
    }
    return observation;
}
function maxLetterboxPx(bars) {
    return Math.max(bars.left, bars.right, bars.top, bars.bottom);
}
function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function buildTargetViewport(geometry, defaults) {
    const input = {
        deviceScaleFactor: defaults.deviceScaleFactor ?? 1,
        hasTouch: defaults.hasTouch ?? false,
        height: geometry.containerBox.height,
        mobile: defaults.mobile ?? false,
        userAgent: defaults.userAgent ?? "",
        width: geometry.containerBox.width,
    };
    if (defaults.screenHeight !== undefined) {
        input.screenHeight = defaults.screenHeight;
    }
    if (defaults.screenWidth !== undefined) {
        input.screenWidth = defaults.screenWidth;
    }
    return buildViewportPayload(input);
}
function mobileViewportSampleFromObservation(observation) {
    return {
        height: observation.layout.height,
        mobile: observation.mobile === true,
        width: observation.layout.width,
    };
}
function localViewportSampleFromObservation(observation) {
    return {
        height: observation.layout.height,
        visualHeight: observation.visual?.height ?? null,
        visualWidth: observation.visual?.width ?? null,
        width: observation.layout.width,
    };
}
function telemetryFromGeometry({ geometry, lastAppliedViewport, lastError, matchedThresholdPx, pendingViewport, targetViewport, transition, }) {
    const bars = geometry?.letterboxBars ?? ZERO_BARS;
    const mismatch = maxLetterboxPx(bars);
    return {
        actualViewport: geometry?.viewport ?? null,
        containerBox: geometry?.containerBox ?? null,
        displayRect: geometry?.displayRect ?? null,
        lastAppliedViewport,
        lastError,
        letterboxBars: bars,
        matched: Boolean(geometry) && mismatch <= matchedThresholdPx,
        maxLetterboxPx: mismatch,
        pendingViewport,
        targetViewport,
        transition,
    };
}
export function createViewportMatchController({ applyViewport, options = {}, surface, }) {
    const clock = options.clock ?? defaultClock;
    const debounceMs = options.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    const matchedThresholdPx = options.matchedThresholdPx ?? DEFAULT_MATCHED_THRESHOLD_PX;
    const observationFromGeometry = options.observationFromGeometry ?? defaultObservationFromGeometry;
    const snapViewport = options.snapViewport ?? ((viewport) => viewport);
    const listeners = new Set();
    let disposed = false;
    let lastAppliedViewport = null;
    let lastError = null;
    let lastGeometry = surface.getGeometry();
    let mobileKeyboardState = createMobileKeyboardResizeState();
    let previousObservation = null;
    let pendingTimer = null;
    let pendingViewport = null;
    let targetViewport = null;
    let transition = null;
    function currentTelemetry() {
        return telemetryFromGeometry({
            geometry: lastGeometry,
            lastAppliedViewport,
            lastError,
            matchedThresholdPx,
            pendingViewport,
            targetViewport,
            transition,
        });
    }
    function notify() {
        const telemetry = currentTelemetry();
        for (const listener of listeners) {
            listener(telemetry);
        }
    }
    function clearPending() {
        if (pendingTimer !== null) {
            clock.clearTimeout(pendingTimer);
            pendingTimer = null;
        }
        pendingViewport = null;
    }
    function flushPending() {
        pendingTimer = null;
        const viewport = pendingViewport;
        pendingViewport = null;
        if (disposed || !viewport) {
            notify();
            return;
        }
        if (viewportPayloadsAreEquivalent(lastAppliedViewport, viewport)) {
            notify();
            return;
        }
        Promise.resolve(applyViewport(viewport))
            .then(() => {
            if (disposed) {
                return;
            }
            lastAppliedViewport = viewport;
            lastError = null;
            notify();
        })
            .catch((error) => {
            if (disposed) {
                return;
            }
            lastError = errorMessage(error);
            notify();
        });
        notify();
    }
    function scheduleApply(viewport) {
        if (viewportPayloadsAreEquivalent(pendingViewport, viewport)) {
            return;
        }
        pendingViewport = viewport;
        if (pendingTimer !== null) {
            clock.clearTimeout(pendingTimer);
        }
        pendingTimer = clock.setTimeout(flushPending, debounceMs);
    }
    function observationForGeometry(geometry) {
        const rawObservation = observationFromGeometry(geometry);
        return {
            ...rawObservation,
            timestampMs: rawObservation.timestampMs ?? clock.now(),
        };
    }
    function scheduleMatch(geometry, observation, nextTransition) {
        const defaults = resolveViewportDefaults(options.viewportDefaults, geometry);
        const snapped = snapViewport(buildTargetViewport(geometry, defaults), {
            geometry,
            observation,
            transition: nextTransition,
        });
        targetViewport = snapped;
        scheduleApply(snapped);
    }
    function observeGeometry(geometry) {
        if (disposed) {
            return;
        }
        lastGeometry = geometry;
        const observation = observationForGeometry(geometry);
        const previous = previousObservation;
        transition = classifyViewportTransition(previous, observation);
        const keyboardAssessment = assessMobileKeyboardViewportResize({
            hasLocalTextInputFocus: observation.editableFocused,
            next: mobileViewportSampleFromObservation(observation),
            nextLocal: localViewportSampleFromObservation(observation),
            previous: previous ? mobileViewportSampleFromObservation(previous) : null,
            previousLocal: previous ? localViewportSampleFromObservation(previous) : null,
            state: mobileKeyboardState,
        });
        mobileKeyboardState = keyboardAssessment.state;
        if (keyboardAssessment.suppress && transition.remoteResize === "post") {
            transition = {
                keyboardInsetBottom: Math.max(0, (previous?.layout.height ?? observation.layout.height) - observation.layout.height),
                kind: "keyboard-occlusion",
                reason: "mobile-keyboard-viewport-assessment",
                remoteResize: "hold",
            };
        }
        previousObservation = observation;
        if (transition.remoteResize === "post") {
            scheduleMatch(geometry, observation, transition);
        }
        else if (transition.kind !== "stable") {
            clearPending();
        }
        notify();
    }
    const unsubscribeSurface = surface.subscribe(observeGeometry);
    return {
        dispose() {
            if (disposed) {
                return;
            }
            disposed = true;
            clearPending();
            unsubscribeSurface();
            listeners.clear();
        },
        getTelemetry() {
            return currentTelemetry();
        },
        requestMatch() {
            if (disposed || !lastGeometry) {
                return;
            }
            const observation = observationForGeometry(lastGeometry);
            transition = {
                keyboardInsetBottom: 0,
                kind: "layout-resize",
                reason: "requested-match",
                remoteResize: "post",
            };
            previousObservation = observation;
            scheduleMatch(lastGeometry, observation, transition);
            notify();
        },
        subscribe(listener) {
            listeners.add(listener);
            listener(currentTelemetry());
            return () => {
                listeners.delete(listener);
            };
        },
    };
}
//# sourceMappingURL=viewport-match-controller.js.map