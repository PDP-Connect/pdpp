import { createReadStream } from "node:fs";
export const BOUNDED_PREVIEW_MAX_BYTES = 64 * 1024;
function trailingIncompleteUtf8Bytes(buf) {
    let i = buf.length - 1;
    let continuation = 0;
    while (i >= 0) {
        const byte = buf[i];
        if (byte === undefined || (byte & 0b1100_0000) !== 0b1000_0000) {
            break;
        }
        continuation++;
        i--;
        if (continuation > 3) {
            return 0;
        }
    }
    const lead = i >= 0 ? buf[i] : undefined;
    if (lead === undefined) {
        return 0;
    }
    let expected;
    if ((lead & 0b1000_0000) === 0) {
        expected = 1;
    }
    else if ((lead & 0b1110_0000) === 0b1100_0000) {
        expected = 2;
    }
    else if ((lead & 0b1111_0000) === 0b1110_0000) {
        expected = 3;
    }
    else if ((lead & 0b1111_1000) === 0b1111_0000) {
        expected = 4;
    }
    else {
        return 0;
    }
    const have = continuation + 1;
    return have < expected ? have : 0;
}
export async function readBoundedFilePreview(path, maxBytes = BOUNDED_PREVIEW_MAX_BYTES) {
    if (maxBytes <= 0) {
        return { buffer: Buffer.alloc(0), bytesRead: 0, truncated: false };
    }
    return await new Promise((resolve) => {
        const chunks = [];
        let collected = 0;
        let sawMore = false;
        const stream = createReadStream(path, { start: 0, end: maxBytes });
        stream.on("data", (chunk) => {
            const buf = chunk;
            const remaining = maxBytes - collected;
            if (remaining <= 0) {
                sawMore = true;
                return;
            }
            if (buf.length > remaining) {
                chunks.push(buf.subarray(0, remaining));
                collected += remaining;
                sawMore = true;
            }
            else {
                chunks.push(buf);
                collected += buf.length;
            }
        });
        stream.on("error", () => resolve(null));
        stream.on("end", () => {
            let buffer = chunks.length === 1 && chunks[0] ? chunks[0] : Buffer.concat(chunks, collected);
            const trim = trailingIncompleteUtf8Bytes(buffer);
            if (trim > 0) {
                buffer = buffer.subarray(0, buffer.length - trim);
            }
            resolve({ buffer, bytesRead: buffer.length, truncated: sawMore });
        });
    });
}
