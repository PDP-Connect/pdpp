import { z } from "zod";
import { safeTextPreview } from "./safe-text-preview.js";
export const pdppSafeText = z
    .string()
    .refine((s) => {
    const result = safeTextPreview(s);
    return result.kind === "text" || result.kind === "empty";
}, {
    message: "must be PDPP-safe Unicode text (no U+0000, no forbidden control characters, valid UTF-8). " +
        "Binary or control-rich payloads MUST be stored in the blobs table.",
})
    .brand();
export const nullablePdppSafeText = pdppSafeText.nullable();
