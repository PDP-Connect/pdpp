const STDOUT_DRAIN_TIMEOUT_MS = 3000;
const RUNTIME_ACK_TIMEOUT_MS = 30 * 60 * 1000;
export function flushAndExitAfterRuntimeAck(code, options = {}) {
    const stdin = options.stdin ?? process.stdin;
    const stdout = options.stdout ?? process.stdout;
    const exit = options.exit ?? process.exit;
    const stdoutDrainTimeoutMs = options.stdoutDrainTimeoutMs ?? STDOUT_DRAIN_TIMEOUT_MS;
    const runtimeAckTimeoutMs = options.runtimeAckTimeoutMs ?? RUNTIME_ACK_TIMEOUT_MS;
    let finished = false;
    let drainTimer = null;
    let ackTimer = null;
    const finish = () => {
        if (finished) {
            return;
        }
        finished = true;
        if (drainTimer) {
            clearTimeout(drainTimer);
        }
        if (ackTimer) {
            clearTimeout(ackTimer);
        }
        exit(code);
    };
    const waitForRuntimeAck = () => {
        if (drainTimer) {
            clearTimeout(drainTimer);
            drainTimer = null;
        }
        if (stdin.readableEnded || stdin.destroyed) {
            finish();
            return;
        }
        const cleanup = () => {
            stdin.off("close", onRuntimeAck);
            stdin.off("end", onRuntimeAck);
            stdin.off("error", onRuntimeAck);
        };
        const onRuntimeAck = () => {
            cleanup();
            finish();
        };
        stdin.once("close", onRuntimeAck);
        stdin.once("end", onRuntimeAck);
        stdin.once("error", onRuntimeAck);
        ackTimer = setTimeout(() => {
            cleanup();
            finish();
        }, runtimeAckTimeoutMs);
        ackTimer.unref();
    };
    if (stdout.writableLength > 0) {
        stdout.once("drain", waitForRuntimeAck);
        drainTimer = setTimeout(() => {
            stdout.off("drain", waitForRuntimeAck);
            waitForRuntimeAck();
        }, stdoutDrainTimeoutMs);
        drainTimer.unref();
        return;
    }
    waitForRuntimeAck();
}
