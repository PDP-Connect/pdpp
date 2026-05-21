export const PDPP_PREVIEW_MAX_CHARS = 4000;
function isForbiddenCodePoint(codeUnit) {
    if (codeUnit === 0x00_00) {
        return true;
    }
    if (codeUnit >= 0x00_01 && codeUnit <= 0x00_08) {
        return true;
    }
    if (codeUnit === 0x00_0b) {
        return true;
    }
    if (codeUnit === 0x00_0c) {
        return true;
    }
    if (codeUnit >= 0x00_0e && codeUnit <= 0x00_1f) {
        return true;
    }
    if (codeUnit === 0x00_7f) {
        return true;
    }
    if (codeUnit >= 0x00_80 && codeUnit <= 0x00_9f) {
        return true;
    }
    return false;
}
function checkStringForForbidden(value) {
    for (let i = 0; i < value.length; i++) {
        const codeUnit = value.charCodeAt(i);
        if (isForbiddenCodePoint(codeUnit)) {
            return {
                isSafe: false,
                firstOffendingIndex: i,
                offendingCodeUnit: codeUnit,
            };
        }
    }
    return { isSafe: true };
}
function decodeBuffer(buf) {
    const bufferWithUtf8 = Buffer;
    const isUtf8 = bufferWithUtf8.isUtf8;
    if (typeof isUtf8 === "function" && buf instanceof Buffer) {
        if (!isUtf8(buf)) {
            return { success: false, reason: "invalid UTF-8 sequence in buffer" };
        }
        return { success: true, text: buf.toString("utf-8") };
    }
    try {
        const decoder = new TextDecoder("utf-8", { fatal: true });
        const text = decoder.decode(buf);
        return { success: true, text };
    }
    catch {
        return { success: false, reason: "invalid UTF-8 sequence in buffer" };
    }
}
function truncateString(text, maxChars) {
    if (text.length <= maxChars) {
        return { result: text, wasTruncated: false };
    }
    let truncateAt = maxChars;
    if (truncateAt > 0 && truncateAt < text.length) {
        const codeUnitAtTruncate = text.charCodeAt(truncateAt - 1);
        if (codeUnitAtTruncate >= 0xd8_00 && codeUnitAtTruncate <= 0xdb_ff) {
            truncateAt--;
        }
    }
    const truncated = `${text.slice(0, truncateAt)}…`;
    return { result: truncated, wasTruncated: true };
}
export function safeTextPreview(value, maxChars = PDPP_PREVIEW_MAX_CHARS) {
    let text = null;
    let originalLength = 0;
    if (value === null || value === undefined) {
        return {
            kind: "empty",
            preview: null,
            truncated: false,
            originalLength: 0,
            reason: null,
        };
    }
    if (typeof value === "string") {
        text = value;
        originalLength = text.length;
    }
    else if (Buffer.isBuffer(value)) {
        originalLength = value.length;
        const decoded = decodeBuffer(value);
        if (!decoded.success) {
            return {
                kind: "binary",
                preview: null,
                truncated: false,
                originalLength,
                reason: decoded.reason || "invalid UTF-8",
            };
        }
        text = decoded.text;
    }
    else if (value instanceof Uint8Array) {
        originalLength = value.length;
        const decoded = decodeBuffer(value);
        if (!decoded.success) {
            return {
                kind: "binary",
                preview: null,
                truncated: false,
                originalLength,
                reason: decoded.reason || "invalid UTF-8",
            };
        }
        text = decoded.text;
    }
    else {
        return {
            kind: "empty",
            preview: null,
            truncated: false,
            originalLength: 0,
            reason: null,
        };
    }
    if (text === "") {
        return {
            kind: "empty",
            preview: null,
            truncated: false,
            originalLength: 0,
            reason: null,
        };
    }
    const forbidden = checkStringForForbidden(text);
    if (!forbidden.isSafe) {
        const offendingIndex = forbidden.firstOffendingIndex;
        const codeUnit = forbidden.offendingCodeUnit;
        const reason = codeUnit === 0x00_00
            ? `U+0000 at offset ${offendingIndex}`
            : `U+${codeUnit.toString(16).toUpperCase().padStart(4, "0")} at offset ${offendingIndex}`;
        return {
            kind: "binary",
            preview: null,
            truncated: false,
            originalLength,
            reason,
        };
    }
    const truncated = truncateString(text, maxChars);
    return {
        kind: "text",
        preview: truncated.result,
        truncated: truncated.wasTruncated,
        originalLength,
        reason: null,
    };
}
