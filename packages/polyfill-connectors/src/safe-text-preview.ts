/**
 * Maximum char count for any preview field across PDPP connectors. Fields
 * MAY use a smaller max; they MUST NOT exceed this.
 */
export const PDPP_PREVIEW_MAX_CHARS = 4000;

/**
 * Result kind returned by safeTextPreview.
 * - "text":      input was acceptable, possibly truncated.
 * - "binary":    input contained content unsafe for a text/JSONB field
 *                (NUL byte, invalid UTF-8 sequence). Caller MUST route
 *                the original bytes to a blob and set the preview to null.
 * - "empty":     input was null/undefined/empty after coercion.
 */
export type SafeTextPreviewKind = "text" | "binary" | "empty";

export interface SafeTextPreviewResult {
  kind: SafeTextPreviewKind;
  /** Total length of the original input in code units, or the buffer
      byte length when input was a Buffer/Uint8Array. */
  originalLength: number;
  /** The cleaned, truncated preview text, or null for "binary"/"empty". */
  preview: string | null;
  /** When kind === "binary", a short string identifying the first
      offending byte/codepoint for telemetry. e.g. "U+0000 at offset 342"
      or "invalid UTF-8 at byte 12". */
  reason: string | null;
  /** Whether the original was truncated to fit `maxChars`. */
  truncated: boolean;
}

/**
 * Check whether a code point is forbidden in a preview text field.
 * Forbidden: U+0000, all other C0 controls, DEL, C1 controls.
 * Allowed exceptions: \t (U+0009), \n (U+000A), \r (U+000D).
 */
function isForbiddenCodePoint(codeUnit: number): boolean {
  // U+0000 (NUL)
  if (codeUnit === 0x00_00) {
    return true;
  }
  // C0 controls U+0001–U+0008
  if (codeUnit >= 0x00_01 && codeUnit <= 0x00_08) {
    return true;
  }
  // U+0009 (TAB) — allowed
  // U+000A (LF) — allowed
  // U+000B (VT) — forbidden
  if (codeUnit === 0x00_0b) {
    return true;
  }
  // U+000C (FF) — forbidden
  if (codeUnit === 0x00_0c) {
    return true;
  }
  // U+000D (CR) — allowed
  // C0 controls U+000E–U+001F
  if (codeUnit >= 0x00_0e && codeUnit <= 0x00_1f) {
    return true;
  }
  // U+007F (DEL)
  if (codeUnit === 0x00_7f) {
    return true;
  }
  // C1 controls U+0080–U+009F
  if (codeUnit >= 0x00_80 && codeUnit <= 0x00_9f) {
    return true;
  }
  return false;
}

/**
 * Check if a string contains any forbidden code points.
 * Returns { isSafe: boolean, firstOffendingIndex?: number, offendingCodeUnit?: number }
 */
function checkStringForForbidden(value: string): {
  isSafe: boolean;
  firstOffendingIndex?: number;
  offendingCodeUnit?: number;
} {
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

/**
 * Decode a buffer to UTF-8 with validation. Returns { success: boolean, text?: string, reason?: string }
 */
function decodeBuffer(buf: Buffer | Uint8Array): {
  success: boolean;
  text?: string;
  reason?: string;
} {
  // Prefer Buffer.isUtf8 if available (Node 19+).
  // Use type assertion since this function is available in Node 19+ but not in older TS type definitions.
  const isUtf8 = (Buffer as unknown as { isUtf8?: (buf: Buffer) => boolean }).isUtf8;
  if (typeof isUtf8 === "function" && buf instanceof Buffer) {
    if (!isUtf8(buf)) {
      return { success: false, reason: "invalid UTF-8 sequence in buffer" };
    }
    return { success: true, text: buf.toString("utf-8") };
  }

  // Fallback: use TextDecoder with fatal: true.
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const text = decoder.decode(buf);
    return { success: true, text };
  } catch (err) {
    return { success: false, reason: "invalid UTF-8 sequence in buffer" };
  }
}

/**
 * Truncate a string to maxChars, avoiding surrogate pair splits.
 * If truncated, appends U+2026 (…).
 */
function truncateString(text: string, maxChars: number): { result: string; wasTruncated: boolean } {
  if (text.length <= maxChars) {
    return { result: text, wasTruncated: false };
  }

  let truncateAt = maxChars;
  // Check if we're about to split a surrogate pair.
  // High surrogate is U+D800–U+DBFF.
  if (truncateAt > 0 && truncateAt < text.length) {
    const codeUnitAtTruncate = text.charCodeAt(truncateAt - 1);
    // If the last code unit we're keeping is a high surrogate, back off by 1.
    if (codeUnitAtTruncate >= 0xd8_00 && codeUnitAtTruncate <= 0xdb_ff) {
      truncateAt--;
    }
  }

  const truncated = text.slice(0, truncateAt) + "…";
  return { result: truncated, wasTruncated: true };
}

/**
 * Decide whether a value is safe to render into a text/JSONB preview
 * field and, if so, return a bounded human-readable string. The
 * invariant: every returned `preview` string is
 *   - free of U+0000
 *   - free of C0 control characters except \t, \n, \r
 *   - valid UTF-8 (when the input was bytes)
 *   - at most `maxChars` characters long
 *
 * Input types accepted:
 *   - string  : checked directly for forbidden code units.
 *   - Buffer / Uint8Array : decoded via TextDecoder("utf-8", {fatal:true}).
 *                           A decoding failure → kind "binary".
 *   - null / undefined    → kind "empty".
 *   - anything else       → kind "empty" (caller can JSON.stringify
 *                           explicitly first if they want the structured
 *                           form previewed).
 *
 * When the result is "text" and the input was longer than maxChars, the
 * preview is truncated to maxChars characters and a U+2026 (`…`)
 * sentinel is appended. The truncation point is at a code-unit
 * boundary (not byte) and avoids splitting a surrogate pair.
 */
export function safeTextPreview(value: unknown, maxChars: number = PDPP_PREVIEW_MAX_CHARS): SafeTextPreviewResult {
  // Coerce input and compute originalLength.
  let text: string | null = null;
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
  } else if (Buffer.isBuffer(value)) {
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
    text = decoded.text!;
  } else if (value instanceof Uint8Array) {
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
    text = decoded.text!;
  } else {
    // Any other type (number, object, etc.) → empty.
    return {
      kind: "empty",
      preview: null,
      truncated: false,
      originalLength: 0,
      reason: null,
    };
  }

  // Handle empty string (legitimate string, just empty).
  if (text === "") {
    return {
      kind: "empty",
      preview: null,
      truncated: false,
      originalLength: 0,
      reason: null,
    };
  }

  // Check for forbidden code points in the decoded/original string.
  const forbidden = checkStringForForbidden(text);
  if (!forbidden.isSafe) {
    const offendingIndex = forbidden.firstOffendingIndex!;
    const codeUnit = forbidden.offendingCodeUnit!;
    const reason =
      codeUnit === 0x00_00
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

  // Text is safe; truncate if necessary.
  const truncated = truncateString(text, maxChars);
  return {
    kind: "text",
    preview: truncated.result,
    truncated: truncated.wasTruncated,
    originalLength,
    reason: null,
  };
}
