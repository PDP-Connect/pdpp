const SIGNALS_TO_HOOK = ["SIGTERM", "SIGINT"];
const SIGNAL_EXIT_CODES = {
    SIGTERM: 128 + 15,
    SIGINT: 128 + 2,
};
function writeShutdownStderr(message) {
    try {
        process.stderr.write(message);
    }
    catch {
    }
}
async function runStepSwallowing(fn, label, signal) {
    if (!fn) {
        return;
    }
    try {
        await fn();
    }
    catch (err) {
        writeShutdownStderr(`[shutdown-hook] ${label}() rejected during ${signal}: ${err instanceof Error ? err.message : String(err)}\n`);
    }
}
export function withShutdownRelease(release, options = {}) {
    let firing = false;
    const { finalize } = options;
    const handle = (signal) => async () => {
        if (firing) {
            return;
        }
        firing = true;
        try {
            await runStepSwallowing(finalize, "finalize", signal);
            await runStepSwallowing(release, "release", signal);
        }
        finally {
            process.exit(SIGNAL_EXIT_CODES[signal]);
        }
    };
    const listeners = [];
    for (const signal of SIGNALS_TO_HOOK) {
        const fn = handle(signal);
        process.on(signal, fn);
        listeners.push({ signal, fn });
    }
    return function dispose() {
        for (const { signal, fn } of listeners) {
            process.removeListener(signal, fn);
        }
    };
}
