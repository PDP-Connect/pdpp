const IOS_RE = /\b(iPad|iPhone|iPod)\b/i;
const ANDROID_RE = /\bAndroid\b/i;
const MOBILE_RE = /\b(Android|iPhone|iPad|iPod|Mobile)\b/i;
const SAFARI_RE = /\bSafari\//i;
const CHROMIUM_RE = /\b(Chrome|Chromium|CriOS|Edg|OPR|SamsungBrowser)\//i;
const FIREFOX_RE = /\b(Firefox|FxiOS)\//i;
export function classifyClipboardBrowser(userAgent) {
    if (FIREFOX_RE.test(userAgent)) {
        return "firefox";
    }
    if (CHROMIUM_RE.test(userAgent)) {
        return "chromium";
    }
    if (SAFARI_RE.test(userAgent)) {
        return "safari";
    }
    return "unknown";
}
export function inferMobileLike({ pointerCoarse, userAgent = "", }) {
    return pointerCoarse || MOBILE_RE.test(userAgent) || IOS_RE.test(userAgent) || ANDROID_RE.test(userAgent);
}
export function assessClipboardCapabilities(input) {
    const mobileLike = inferMobileLike(input);
    const readPermissionGranted = input.readPermission === "granted";
    const writePermissionGranted = input.writePermission === "granted";
    return {
        ...input,
        mobileLike,
        needsManualReadFallback: mobileLike ||
            !input.isSecureContext ||
            !input.readTextAvailable ||
            input.browserFamily === "safari" ||
            input.browserFamily === "firefox" ||
            input.readPermission === "denied",
        needsOwnerGestureForRead: mobileLike || !readPermissionGranted || input.browserFamily === "safari" || input.browserFamily === "firefox",
        needsOwnerGestureForWrite: mobileLike || !writePermissionGranted || input.browserFamily === "safari" || input.browserFamily === "firefox",
        supportsClipboardChangeEvent: Boolean(input.clipboardChangeEventAvailable),
    };
}
export function decideClipboardPolicy({ capabilities, directionPolicy, hasStreamSession, helperMode, sessionBackend, }) {
    const localToRemote = directionPolicy === "local-to-remote" || directionPolicy === "bidirectional-text";
    const remoteToLocal = directionPolicy === "remote-to-local" || directionPolicy === "bidirectional-text";
    const disabled = !hasStreamSession || directionPolicy === "disabled";
    let surface = "desktop-inline";
    if (disabled) {
        surface = "disabled";
    }
    else if (capabilities.mobileLike) {
        surface = "mobile-sheet";
    }
    return {
        allowAssistivePageHelpers: helperMode === "assistive",
        canForwardNativePasteEvent: !disabled && localToRemote && capabilities.topLevel,
        canReadLocalClipboard: !disabled &&
            localToRemote &&
            capabilities.isSecureContext &&
            capabilities.topLevel &&
            capabilities.readTextAvailable,
        canWriteLocalClipboard: !disabled &&
            remoteToLocal &&
            capabilities.isSecureContext &&
            capabilities.topLevel &&
            capabilities.writeTextAvailable,
        directionPolicy,
        helperMode,
        showClipboardSheet: surface === "mobile-sheet" && (localToRemote || remoteToLocal),
        showDesktopCopyButton: false,
        showDesktopPasteButton: false,
        // Ruling 1 (step 5): show the soft-keyboard button only for n.eko
        // (remote-surface) sessions on mobile-like surfaces. cdp backend and
        // desktop keep it hidden as before.
        showKeyboardButton: !disabled && sessionBackend === "neko" && capabilities.mobileLike,
        showMobileCopyButton: surface === "mobile-sheet" && remoteToLocal,
        showMobilePasteButton: surface === "mobile-sheet" && localToRemote,
        surface,
    };
}
export function clipboardLengthBucket(text) {
    const length = text.length;
    if (length === 0) {
        return "0";
    }
    if (length <= 16) {
        return "1-16";
    }
    if (length <= 64) {
        return "17-64";
    }
    if (length <= 256) {
        return "65-256";
    }
    if (length <= 1024) {
        return "257-1024";
    }
    return "1025+";
}
//# sourceMappingURL=clipboard-policy.js.map