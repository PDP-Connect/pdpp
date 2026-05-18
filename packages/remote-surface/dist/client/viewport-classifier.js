const VIEWPORT_TOLERANCE_PX = 2;
const CHROME_LAYOUT_JITTER_TOLERANCE_PX = 8;
const KEYBOARD_MIN_HEIGHT_DELTA_PX = 96;
const KEYBOARD_MIN_HEIGHT_DELTA_RATIO = 0.18;
const KEYBOARD_MAX_HEIGHT_DELTA_RATIO = 0.7;
const MOBILE_CHROME_HEIGHT_DELTA_RATIO = KEYBOARD_MIN_HEIGHT_DELTA_RATIO;
const ZOOM_SCALE_EPSILON = 0.03;
function heightDrop(previous, next) {
    return previous.height - next.height;
}
function sameWidth(previous, next) {
    return Math.abs(previous.width - next.width) <= VIEWPORT_TOLERANCE_PX;
}
function sameHeight(previous, next) {
    return Math.abs(previous.height - next.height) <= VIEWPORT_TOLERANCE_PX;
}
function sameSize(previous, next) {
    return sameWidth(previous, next) && sameHeight(previous, next);
}
function sameSizeWithin(previous, next, tolerancePx) {
    return Math.abs(previous.width - next.width) <= tolerancePx && Math.abs(previous.height - next.height) <= tolerancePx;
}
function isKeyboardSizedDrop(previous, next) {
    const drop = heightDrop(previous, next);
    const dropRatio = drop / previous.height;
    return (sameWidth(previous, next) &&
        drop >= KEYBOARD_MIN_HEIGHT_DELTA_PX &&
        dropRatio >= KEYBOARD_MIN_HEIGHT_DELTA_RATIO &&
        dropRatio <= KEYBOARD_MAX_HEIGHT_DELTA_RATIO);
}
function orientationChanged(previous, next) {
    if (previous.orientation && next.orientation && previous.orientation.type !== next.orientation.type) {
        return true;
    }
    const previousPortrait = previous.layout.height >= previous.layout.width;
    const nextPortrait = next.layout.height >= next.layout.width;
    return previousPortrait !== nextPortrait;
}
function explicitKeyboardInset(next) {
    const keyboard = next.virtualKeyboard;
    return keyboard && keyboard.height >= KEYBOARD_MIN_HEIGHT_DELTA_PX ? Math.round(keyboard.height) : 0;
}
function visualKeyboardInset(previous, next) {
    if (!(previous.visual && next.visual)) {
        return 0;
    }
    const drop = heightDrop(previous.visual, next.visual);
    if (isKeyboardSizedDrop(previous.visual, next.visual)) {
        return Math.round(drop);
    }
    // Keyboard animations often arrive in small same-width increments. Once the
    // browser reports editable focus, hold remote resize for those intermediate
    // occlusion frames rather than sending n.eko a false layout resize.
    return next.editableFocused && sameWidth(previous.visual, next.visual) && drop > 0 ? Math.round(drop) : 0;
}
function layoutKeyboardInset(previous, next) {
    const drop = heightDrop(previous.layout, next.layout);
    if (isKeyboardSizedDrop(previous.layout, next.layout)) {
        return Math.round(drop);
    }
    return next.editableFocused && sameWidth(previous.layout, next.layout) && drop > 0 ? Math.round(drop) : 0;
}
function visualViewportMoved(previous, next) {
    if (!(previous.visual && next.visual)) {
        return false;
    }
    return (Math.abs(previous.visual.offsetTop - next.visual.offsetTop) > VIEWPORT_TOLERANCE_PX ||
        Math.abs(previous.visual.pageTop - next.visual.pageTop) > VIEWPORT_TOLERANCE_PX ||
        !sameSize(previous.visual, next.visual));
}
function zoomChanged(previous, next) {
    if (!(previous.visual && next.visual)) {
        return false;
    }
    return Math.abs(previous.visual.scale - next.visual.scale) > ZOOM_SCALE_EPSILON || next.visual.scale > 1.01;
}
function mobileChromeHeightChanged(previous, next) {
    if (!(previous.mobile || next.mobile) || next.editableFocused || !sameWidth(previous.layout, next.layout)) {
        return false;
    }
    const delta = Math.abs(next.layout.height - previous.layout.height);
    const ratio = delta / Math.max(previous.layout.height, next.layout.height);
    return delta > CHROME_LAYOUT_JITTER_TOLERANCE_PX && ratio <= MOBILE_CHROME_HEIGHT_DELTA_RATIO;
}
export function classifyViewportTransition(previous, next) {
    if (!previous) {
        return {
            kind: "layout-resize",
            keyboardInsetBottom: 0,
            remoteResize: "post",
            reason: "initial-observation",
        };
    }
    if (orientationChanged(previous, next)) {
        return {
            kind: "orientation-change",
            keyboardInsetBottom: 0,
            remoteResize: "post",
            reason: "orientation-or-aspect-change",
        };
    }
    const keyboardInset = Math.max(
    // VirtualKeyboard geometry is explicit occlusion. Do not require local
    // editable focus here: IME/autofill and browser-managed focus paths can
    // expose geometry before the hidden local keyboard overlay is focused.
    explicitKeyboardInset(next), next.editableFocused ? visualKeyboardInset(previous, next) : 0, next.editableFocused ? layoutKeyboardInset(previous, next) : 0);
    if (keyboardInset > 0) {
        return {
            kind: "keyboard-occlusion",
            keyboardInsetBottom: keyboardInset,
            remoteResize: "hold",
            reason: "editable-focus-with-keyboard-shaped-occlusion",
        };
    }
    if (zoomChanged(previous, next)) {
        return {
            kind: "zoom",
            keyboardInsetBottom: 0,
            remoteResize: "hold",
            reason: "visual-viewport-scale-change",
        };
    }
    if (visualViewportMoved(previous, next) &&
        sameSizeWithin(previous.layout, next.layout, CHROME_LAYOUT_JITTER_TOLERANCE_PX)) {
        return {
            kind: "browser-chrome",
            keyboardInsetBottom: 0,
            remoteResize: "hold",
            reason: "visual-viewport-changed-with-stable-layout",
        };
    }
    if (mobileChromeHeightChanged(previous, next)) {
        return {
            kind: "browser-chrome",
            keyboardInsetBottom: 0,
            remoteResize: "hold",
            reason: "mobile-same-width-dynamic-viewport-height-change",
        };
    }
    if (!sameSize(previous.layout, next.layout)) {
        return {
            kind: "layout-resize",
            keyboardInsetBottom: 0,
            remoteResize: "post",
            reason: "layout-viewport-size-change",
        };
    }
    return {
        kind: "stable",
        keyboardInsetBottom: 0,
        remoteResize: "hold",
        reason: "no-material-viewport-change",
    };
}
//# sourceMappingURL=viewport-classifier.js.map