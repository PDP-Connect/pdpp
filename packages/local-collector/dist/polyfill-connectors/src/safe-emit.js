const JSONL_TERMINATOR = /[\u2028\u2029]/g;
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);
function bigIntSafeReplacer(_key, value) {
    if (typeof value === "bigint") {
        return value <= MAX_SAFE && value >= MIN_SAFE ? Number(value) : value.toString();
    }
    return value;
}
function escapeJsonlTerminator(c) {
    return c === "\u2028" ? "\\u2028" : "\\u2029";
}
export function stringifyForJsonl(msg) {
    return `${JSON.stringify(msg, bigIntSafeReplacer).replace(JSONL_TERMINATOR, escapeJsonlTerminator)}\n`;
}
export function emitToStdout(msg) {
    const line = stringifyForJsonl(msg);
    const ok = process.stdout.write(line);
    if (ok) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        process.stdout.once("drain", () => {
            resolve();
        });
    });
}
export function parseJsonlLine(line) {
    return JSON.parse(line);
}
