import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { resolveAuth } from "./auth.js";
import { DEADLINE_TIMEOUT, manualAction, prepareBrowserInteractionTarget, withDeadline } from "./browser-handoff.js";
import { flushAndExitAfterRuntimeAck } from "./connector-exit.js";
import { createCaptureSession } from "./fixture-capture.js";
import { emitToStdout } from "./safe-emit.js";
import { resourceSet } from "./scope-filters.js";
const DEFAULT_RETRYABLE_PATTERN = /ECONN|ETIMEDOUT|timeout/i;
const TRACE_TIMESTAMP_UNSAFE = /[:.]/g;
class TerminalError extends Error {
    retryable;
    constructor(message, retryable = false) {
        super(message);
        this.name = "TerminalError";
        this.retryable = retryable;
    }
}
function isOutsideTimeRange(timeRange, dateValue) {
    if (typeof dateValue !== "string" || !dateValue) {
        return false;
    }
    if (timeRange.since && dateValue < timeRange.since.slice(0, 10)) {
        return true;
    }
    if (timeRange.until && dateValue >= timeRange.until.slice(0, 10)) {
        return true;
    }
    return false;
}
function makeShapeCheckSkip(stream, data, issues) {
    const message = `${String(data.id)}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`;
    return {
        type: "SKIP_RESULT",
        stream,
        reason: "shape_check_failed",
        message,
        diagnostics: { id: data.id, issues, record: data },
    };
}
export function buildDetailCoverageMessage(params) {
    const { stream, stateStream, requiredKeys, hydratedKeys, gapKeys, optionalSkipKeys, considered, covered } = params;
    return {
        type: "DETAIL_COVERAGE",
        reference_only: true,
        stream,
        state_stream: stateStream,
        required_keys: [...requiredKeys],
        hydrated_keys: [...hydratedKeys],
        ...(typeof considered === "number" && Number.isInteger(considered) && considered >= 0 ? { considered } : {}),
        ...(typeof covered === "number" && Number.isInteger(covered) && covered >= 0 ? { covered } : {}),
        ...(gapKeys?.length ? { gap_keys: [...gapKeys] } : {}),
        ...(optionalSkipKeys?.length ? { optional_skip_keys: [...optionalSkipKeys] } : {}),
    };
}
export function emitDetailCoverage(ctx, params) {
    return ctx.emit(buildDetailCoverageMessage(params));
}
export function buildDetailGap(params) {
    const { stream, recordKey, reason, locator, parentStream, listCursor, error } = params;
    let errorBlocks = {};
    if (error) {
        const sharedBlock = {
            class: error.class,
            ...(error.httpStatus == null ? {} : { http_status: error.httpStatus }),
            ...(error.networkPressure == null ? {} : { network_pressure: error.networkPressure }),
        };
        errorBlocks = {
            detail: sharedBlock,
            last_error: error.message == null ? sharedBlock : { ...sharedBlock, message: error.message },
        };
    }
    return {
        type: "DETAIL_GAP",
        stream,
        ...(parentStream == null ? {} : { parent_stream: parentStream }),
        record_key: recordKey,
        status: "pending",
        reason,
        detail_locator: locator,
        ...(listCursor === undefined ? {} : { list_cursor: listCursor }),
        retryable: true,
        reference_only: true,
        ...errorBlocks,
    };
}
export function emitDetailGap(ctx, params) {
    return ctx.emit(buildDetailGap(params));
}
export const nowIso = () => new Date().toISOString();
export const politeDelay = (ms) => new Promise((r) => setTimeout(r, ms));
export function runConnector(config) {
    if (!config.name) {
        throw new Error("runConnector: config.name required");
    }
    if (typeof config.collect !== "function") {
        throw new Error("runConnector: config.collect required");
    }
    const { name, validateRecord, collect, browser, retryablePattern = DEFAULT_RETRYABLE_PATTERN, timeRangeField = "date", isTombstone, auth, } = config;
    const ensureSession = browser ? config.ensureSession : undefined;
    const probeSession = browser ? config.probeSession : undefined;
    const timeRangeFieldFor = typeof timeRangeField === "function" ? timeRangeField : () => timeRangeField;
    const capture = createCaptureSession(name);
    const rl = createInterface({ input: process.stdin, terminal: false });
    const emit = (msg) => {
        if (capture && msg.type === "RECORD") {
            capture.recordRecord(msg);
        }
        return emitToStdout(msg);
    };
    if (capture) {
        const modeLabel = capture.keepOnSuccess
            ? "PDPP_CAPTURE_FIXTURES=1 (always retain)"
            : "PDPP_CAPTURE_ON_FAILURE=1 (retain on failure only)";
        process.stderr.write(`[capture] ${modeLabel}; writing to ${capture.baseDir}\n`);
    }
    const flushAndExit = (code) => {
        flushAndExitAfterRuntimeAck(code);
    };
    let observedCounters = null;
    const emitFailed = (message, retryable = false, records_emitted = observedCounters?.totalEmitted ?? 0) => {
        emit({
            type: "DONE",
            status: "failed",
            records_emitted,
            error: { message, retryable },
        }).catch(() => undefined);
        flushAndExit(1);
    };
    let interactionCounter = 0;
    const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;
    let assistanceCounter = 0;
    const nextAssistanceId = () => `asst_${Date.now()}_${++assistanceCounter}`;
    const sendInteraction = (req) => {
        const request_id = req.request_id ?? nextInteractionId();
        const wrapped = {
            type: "INTERACTION",
            request_id,
            kind: req.kind,
            message: req.message,
            ...(req.schema === undefined ? {} : { schema: req.schema }),
            ...(req.timeout_seconds === undefined ? {} : { timeout_seconds: req.timeout_seconds }),
        };
        emit(wrapped).catch(() => undefined);
        return new Promise((resolve, reject) => {
            const onLine = (line) => {
                try {
                    const parsed = JSON.parse(line);
                    if (parsed.type === "INTERACTION_RESPONSE" && parsed.request_id === request_id) {
                        rl.off("line", onLine);
                        resolve(parsed);
                    }
                }
                catch (err) {
                    reject(err instanceof Error ? err : new Error(String(err)));
                }
            };
            rl.on("line", onLine);
        });
    };
    const readStart = () => new Promise((resolve, reject) => {
        rl.once("line", (line) => {
            try {
                resolve(JSON.parse(line));
            }
            catch (err) {
                reject(err instanceof Error ? err : new Error(String(err)));
            }
        });
    });
    const progress = (message, extra = {}) => emit({ type: "PROGRESS", message, ...extra });
    const assist = async (req) => {
        const assistance_request_id = req.assistance_request_id ?? nextAssistanceId();
        await emit({ type: "ASSISTANCE", ...req, assistance_request_id });
        return assistance_request_id;
    };
    const completeAssistance = (assistanceRequestId, status, extra = {}) => emit({ type: "ASSISTANCE_STATUS", assistance_request_id: assistanceRequestId, status, ...extra });
    run().catch((err) => {
        if (err instanceof TerminalError) {
            emitFailed(err.message, err.retryable);
            return;
        }
        const message = err instanceof Error ? err.message : String(err);
        emitFailed(message, retryablePattern.test(message));
    });
    async function run() {
        const startMsg = await parseStart(readStart);
        const requested = buildRequested(startMsg);
        const credentials = await resolveCredentials(auth, {
            sendInteraction,
            connectorName: name,
        });
        const emitRecord = makeEmitRecord({
            requested,
            emit,
            emittedAt: nowIso(),
            validateRecord,
            isTombstone,
            timeRangeFieldFor,
        });
        observedCounters = emitRecord.counters;
        const emittedAt = nowIso();
        const baseCtx = {
            scope: startMsg.scope,
            state: startMsg.state ?? {},
            requested,
            credentials,
            emit,
            emitRecord: emitRecord.emit,
            assist,
            completeAssistance,
            progress,
            capture,
            sendInteraction,
            emittedAt,
            detailGaps: startMsg.detail_gaps ?? [],
        };
        if (browser) {
            await runInBrowser({
                browser,
                name,
                sendInteraction,
                assist,
                completeAssistance,
                progress,
                ensureSession,
                probeSession,
                collect,
                baseCtx,
            });
        }
        else {
            await collect(baseCtx);
        }
        await finalizeRun(emitRecord.counters, progress, emit);
        flushAndExit(0);
    }
}
async function parseStart(readStart) {
    const startMsg = await readStart();
    if (startMsg.type !== "START") {
        throw new TerminalError("Expected START message", false);
    }
    return startMsg;
}
function buildRequested(startMsg) {
    const requested = new Map((startMsg.scope.streams ?? []).map((s) => [s.name, s]));
    if (requested.size === 0) {
        throw new TerminalError("START.scope.streams is required", false);
    }
    return requested;
}
async function resolveCredentials(auth, ctx) {
    if (!auth) {
        return {};
    }
    try {
        return await resolveAuth(auth, ctx);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new TerminalError(message, false);
    }
}
function makeEmitRecord(deps) {
    const { requested, emit, emittedAt, validateRecord, isTombstone, timeRangeFieldFor } = deps;
    const counters = { totalEmitted: 0, totalSkipped: 0 };
    const resFilters = new Map();
    for (const [streamName, scope] of requested) {
        resFilters.set(streamName, resourceSet(scope));
    }
    const emitRecord = (stream, data) => {
        if (data.id == null) {
            return Promise.resolve();
        }
        const rs = resFilters.get(stream);
        if (rs && !rs.has(String(data.id))) {
            return Promise.resolve();
        }
        if (isTombstone?.(stream, data)) {
            counters.totalEmitted++;
            return emit({
                type: "RECORD",
                stream,
                key: data.id,
                data: { id: data.id },
                emitted_at: emittedAt,
                op: "delete",
            });
        }
        const streamScope = requested.get(stream);
        const field = timeRangeFieldFor(stream);
        if (streamScope?.time_range && isOutsideTimeRange(streamScope.time_range, data[field])) {
            return Promise.resolve();
        }
        if (validateRecord) {
            const result = validateRecord(stream, data);
            if (!result.ok) {
                counters.totalSkipped++;
                return emit(makeShapeCheckSkip(stream, data, result.issues));
            }
        }
        counters.totalEmitted++;
        return emit({
            type: "RECORD",
            stream,
            key: data.id,
            data,
            emitted_at: emittedAt,
        });
    };
    return { emit: emitRecord, counters };
}
async function runInBrowser(args) {
    const { browser, name, sendInteraction, assist, completeAssistance, progress, ensureSession, probeSession, collect, baseCtx, } = args;
    const { context: ctx, release } = await acquireBrowser(browser, name);
    const visibility = resolveBrowserRuntimeVisibility(browser, name);
    const { withShutdownRelease } = await import("./shutdown-hook.js");
    const tracer = makeTracer(ctx, name, baseCtx.capture);
    let traceFinalized = false;
    const finalizeDiagnostics = async () => {
        if (traceFinalized) {
            return;
        }
        traceFinalized = true;
        baseCtx.capture?.setTraceCheckpointHook?.(null);
        await tracer.stop();
    };
    const disposeShutdownHook = withShutdownRelease(release, { finalize: finalizeDiagnostics });
    await tracer.start();
    baseCtx.capture?.setTraceCheckpointHook?.((label) => tracer.checkpoint(label));
    let page = null;
    try {
        page = await ctx.newPage();
        const browserSendInteraction = makeBrowserInteractionKeepalive({
            context: ctx,
            diagnostics: process.env.PDPP_BROWSER_SURFACE_DIAGNOSTICS === "1",
            progress,
            sendInteraction: async (req) => {
                const decorated = decorateBrowserManualAction(req, visibility);
                if (decorated.kind !== "otp") {
                    return sendInteraction(decorated);
                }
                const { interactionId } = await prepareBrowserInteractionTarget({
                    page: page,
                    reason: "2fa",
                    ...(decorated.request_id ? { interactionId: decorated.request_id } : {}),
                });
                return sendInteraction({ ...decorated, request_id: interactionId });
            },
        });
        await captureBrowserPage(baseCtx.capture, page, "runtime-new-page");
        await closeBrowserContextPagesExcept(ctx, page);
        const watchdog = makeSessionEstablishWatchdog({
            capture: baseCtx.capture,
            name,
            page,
        });
        await watchdog.run(() => establishSession({ ensureSession, probeSession }, {
            assist,
            capture: baseCtx.capture,
            checkpoint: watchdog.checkpoint,
            completeAssistance,
            context: ctx,
            page: page,
            name,
            progress,
            sendInteraction: watchdog.wrapSendInteraction(browserSendInteraction),
        }));
        await captureBrowserPage(baseCtx.capture, page, "runtime-session-established");
        await captureBrowserPage(baseCtx.capture, page, "runtime-collect-start");
        await collect({ ...baseCtx, context: ctx, page, sendInteraction: browserSendInteraction });
        await captureBrowserPage(baseCtx.capture, page, "runtime-collect-complete");
        tracer.markSucceeded();
        baseCtx.capture?.markSucceeded?.();
    }
    catch (err) {
        if (page) {
            await captureBrowserPage(baseCtx.capture, page, "runtime-error");
        }
        throw err;
    }
    finally {
        await finalizeDiagnostics();
        await closeBrowserPage(page);
        await release().catch(() => undefined);
        disposeShutdownHook();
        baseCtx.capture?.finalize?.();
    }
}
const CAPTURE_DOM_DEADLINE_MS = 10_000;
const PAGE_CLOSE_DEADLINE_MS = 10_000;
export async function captureBrowserPage(capture, page, label, deadlineMs = CAPTURE_DOM_DEADLINE_MS) {
    if (!capture) {
        return;
    }
    if (page.isClosed()) {
        process.stderr.write(`[capture] page already closed at ${label}; skipping dom snapshot\n`);
        return;
    }
    const captureWork = capture.captureDom(page, label);
    captureWork.catch(() => undefined);
    await withDeadline(captureWork, deadlineMs, () => {
        process.stderr.write(`[capture] dom snapshot for ${label} exceeded ${String(deadlineMs)}ms (wedged renderer?); abandoning this capture.\n`);
    });
}
export async function closeBrowserContextPagesExcept(context, keepPage, deadlineMs = PAGE_CLOSE_DEADLINE_MS) {
    let pages;
    try {
        pages = context.pages();
    }
    catch {
        return 0;
    }
    let closed = 0;
    for (const page of pages) {
        if (page === keepPage || page.isClosed()) {
            continue;
        }
        if (await closeBrowserPage(page, deadlineMs)) {
            closed++;
        }
    }
    return closed;
}
export async function closeBrowserPage(page, deadlineMs = PAGE_CLOSE_DEADLINE_MS) {
    if (!page || page.isClosed()) {
        return false;
    }
    try {
        const closeWork = page.close();
        closeWork.catch(() => undefined);
        const result = await withDeadline(closeWork, deadlineMs, () => {
            process.stderr.write(`[browser-runtime] page.close() exceeded ${String(deadlineMs)}ms (wedged renderer?); abandoning close.\n`);
        });
        return result !== DEADLINE_TIMEOUT;
    }
    catch {
        return false;
    }
}
const BROWSER_INTERACTION_KEEPALIVE_INTERVAL_MS = 15_000;
export function makeBrowserInteractionKeepalive(args) {
    const { context, diagnostics = false, intervalMs = BROWSER_INTERACTION_KEEPALIVE_INTERVAL_MS, progress, sendInteraction, } = args;
    return async (req) => {
        await emitBrowserSurfaceDiagnostic({ context, diagnostics, phase: "interaction_start", progress, req });
        const keepalive = startBrowserConnectionKeepalive(context, intervalMs);
        try {
            const response = await sendInteraction(req);
            await emitBrowserSurfaceDiagnostic({
                context,
                diagnostics,
                keepalive: keepalive.stop(),
                phase: "interaction_response",
                progress,
                req,
                responseStatus: response.status,
            });
            return response;
        }
        catch (err) {
            await emitBrowserSurfaceDiagnostic({
                context,
                diagnostics,
                error: err,
                keepalive: keepalive.stop(),
                phase: "interaction_error",
                progress,
                req,
            });
            throw err;
        }
    };
}
async function emitBrowserSurfaceDiagnostic(args) {
    const { context, diagnostics, error, keepalive, phase, progress, req, responseStatus } = args;
    if (!(diagnostics && progress)) {
        return;
    }
    let errorMessage = null;
    if (error instanceof Error) {
        errorMessage = error.message;
    }
    else if (error != null) {
        errorMessage = String(error);
    }
    const payload = {
        phase,
        interaction_kind: req.kind,
        request_id: req.request_id ?? null,
        response_status: responseStatus ?? null,
        surface: describeBrowserSurface(context),
        keepalive: keepalive ?? null,
        error: errorMessage,
    };
    try {
        await progress(`browser_surface.diagnostic ${JSON.stringify(payload)}`);
    }
    catch (progressError) {
        const message = progressError instanceof Error ? progressError.message : String(progressError);
        process.stderr.write(`[browser-surface-diagnostics] progress emit failed: ${message}\n`);
    }
}
function describeBrowserSurface(context) {
    const browser = context.browser();
    let pages = [];
    try {
        pages = typeof context.pages === "function" ? context.pages() : [];
    }
    catch {
        pages = [];
    }
    return {
        browser_connected: Boolean(browser?.isConnected()),
        page_count: typeof context.pages === "function" ? pages.length : null,
        pages: pages.slice(0, 5).map((page) => ({
            closed: page.isClosed(),
            url: sanitizeDiagnosticUrl(page),
        })),
    };
}
function sanitizeDiagnosticUrl(page) {
    if (page.isClosed()) {
        return null;
    }
    try {
        const rawUrl = page.url();
        if (!rawUrl || rawUrl === "about:blank") {
            return rawUrl || null;
        }
        const url = new URL(rawUrl);
        return `${url.origin}${url.pathname}`;
    }
    catch {
        return "unparseable";
    }
}
function normalizeDiagnosticError(error) {
    const raw = error instanceof Error ? error.message : String(error);
    return raw.slice(0, 300);
}
function summarizeInactiveKeepalive(browser, startedAt) {
    return {
        browserConnectedAtStart: Boolean(browser?.isConnected()),
        browserConnectedAtStop: Boolean(browser?.isConnected()),
        elapsedMs: Date.now() - startedAt,
        disconnectEventCount: 0,
        pingAttempts: 0,
        pingFailures: 0,
        pingInFlight: false,
        pingSuccesses: 0,
        skippedDisconnected: 0,
    };
}
function startBrowserConnectionKeepalive(context, intervalMs) {
    const startedAt = Date.now();
    const browser = context.browser();
    if (intervalMs <= 0 || !browser?.isConnected()) {
        return { stop: () => summarizeInactiveKeepalive(browser, startedAt) };
    }
    let sessionPromise = null;
    let pingInFlight = false;
    let pingAttempts = 0;
    let pingFailures = 0;
    let pingSuccesses = 0;
    let skippedDisconnected = 0;
    let stopped = false;
    let lastError;
    let lastSuccessfulPingElapsedMs;
    let firstObservedDisconnectedElapsedMs;
    let disconnectEventElapsedMs;
    let disconnectEventCount = 0;
    const browserConnectedAtStart = browser.isConnected();
    const removeDisconnectedListener = attachBrowserDisconnectedDiagnostic(browser, () => {
        disconnectEventCount++;
        disconnectEventElapsedMs ??= Date.now() - startedAt;
        process.stderr.write(`[browser-keepalive] browser disconnected during interaction after ${disconnectEventElapsedMs}ms\n`);
    });
    const sessionFor = (connectedBrowser) => {
        sessionPromise ??= connectedBrowser.newBrowserCDPSession();
        return sessionPromise;
    };
    const ping = async () => {
        if (stopped || pingInFlight) {
            return;
        }
        if (!browser.isConnected()) {
            firstObservedDisconnectedElapsedMs ??= Date.now() - startedAt;
            skippedDisconnected++;
            return;
        }
        pingInFlight = true;
        pingAttempts++;
        try {
            const session = await sessionFor(browser);
            await session.send("Browser.getVersion");
            pingSuccesses++;
            lastSuccessfulPingElapsedMs = Date.now() - startedAt;
        }
        catch (err) {
            sessionPromise = null;
            pingFailures++;
            lastError = normalizeDiagnosticError(err);
            process.stderr.write(`[browser-keepalive] Browser.getVersion failed: ${lastError}\n`);
        }
        finally {
            pingInFlight = false;
        }
    };
    const timer = setInterval(ping, intervalMs);
    timer.unref?.();
    ping().catch(() => undefined);
    return {
        stop: () => {
            stopped = true;
            clearInterval(timer);
            removeDisconnectedListener();
            sessionPromise?.then((session) => session.detach()).catch(() => undefined);
            return {
                browserConnectedAtStart,
                browserConnectedAtStop: browser.isConnected(),
                disconnectEventCount,
                ...(disconnectEventElapsedMs === undefined ? {} : { disconnectEventElapsedMs }),
                elapsedMs: Date.now() - startedAt,
                ...(firstObservedDisconnectedElapsedMs === undefined ? {} : { firstObservedDisconnectedElapsedMs }),
                ...(lastSuccessfulPingElapsedMs === undefined ? {} : { lastSuccessfulPingElapsedMs }),
                pingAttempts,
                pingFailures,
                pingInFlight,
                pingSuccesses,
                skippedDisconnected,
                ...(lastError ? { lastError } : {}),
            };
        },
    };
}
function attachBrowserDisconnectedDiagnostic(browser, onDisconnected) {
    const eventTarget = browser;
    if (typeof eventTarget.on !== "function") {
        return () => undefined;
    }
    eventTarget.on("disconnected", onDisconnected);
    return () => {
        if (typeof eventTarget.off === "function") {
            eventTarget.off("disconnected", onDisconnected);
        }
    };
}
async function finalizeRun(counters, progress, emit) {
    if (counters.totalSkipped > 0) {
        await progress(`shape-check skipped ${String(counters.totalSkipped)} record(s); see SKIP_RESULT events above`);
    }
    await emit({
        type: "DONE",
        status: "succeeded",
        records_emitted: counters.totalEmitted,
    });
}
const MANUAL_ACTION_RECOVERY_RE = /\bheadless\b|local collector|rerun .*headed|PDPP_[A-Z0-9_]+_HEADLESS/iu;
export function resolveBrowserRuntimeVisibility(browser, name, env = process.env) {
    const profileName = browser.profileName ?? name;
    const envKey = `PDPP_${profileName.toUpperCase()}_HEADLESS`;
    return {
        envKey,
        headless: browser.headless ?? env[envKey] !== "0",
        profileName,
    };
}
export function resolveBrowserLaunchSource(visibility, env = process.env) {
    const managedRequired = env.PDPP_BROWSER_SURFACE_REQUIRED?.trim().toLowerCase() === "neko";
    const managedRemoteCdpUrl = env.PDPP_BROWSER_SURFACE_REMOTE_CDP_URL?.trim();
    if (managedRequired) {
        if (!managedRemoteCdpUrl) {
            throw new TerminalError("browser surface required: PDPP_BROWSER_SURFACE_REQUIRED=neko but PDPP_BROWSER_SURFACE_REMOTE_CDP_URL is missing", false);
        }
        return {
            kind: "managed_neko",
            remoteCdpUrl: managedRemoteCdpUrl,
            ...(env.PDPP_BROWSER_SURFACE_LEASE_ID?.trim() ? { leaseId: env.PDPP_BROWSER_SURFACE_LEASE_ID.trim() } : {}),
            ...(env.PDPP_BROWSER_SURFACE_PROFILE_KEY?.trim()
                ? { profileKey: env.PDPP_BROWSER_SURFACE_PROFILE_KEY.trim() }
                : {}),
        };
    }
    const legacyRemoteCdpEnvKey = `PDPP_${visibility.profileName.toUpperCase()}_REMOTE_CDP_URL`;
    const legacyRemoteCdpUrl = env[legacyRemoteCdpEnvKey]?.trim();
    if (legacyRemoteCdpUrl) {
        return {
            envKey: legacyRemoteCdpEnvKey,
            kind: "legacy_remote_cdp",
            remoteCdpUrl: legacyRemoteCdpUrl,
        };
    }
    return { kind: "isolated_local" };
}
export function decorateBrowserManualAction(req, visibility) {
    if (req.kind !== "manual_action") {
        return req;
    }
    if (!visibility.headless) {
        return req;
    }
    if (MANUAL_ACTION_RECOVERY_RE.test(req.message)) {
        return req;
    }
    return {
        ...req,
        message: `${req.message}\n\n` +
            "Open the streaming companion to drive the connector's browser from your phone or laptop. " +
            `Or rerun with ${visibility.envKey}=0 on a host desktop to use a visible local browser instead.`,
    };
}
async function acquireBrowser(browser, name) {
    const { acquireBrowserForConnector, HeadedBrowserUnavailableError } = await import("./browser-launch.js");
    const visibility = resolveBrowserRuntimeVisibility(browser, name);
    const { headless, profileName } = visibility;
    const streamingEnabled = Boolean(process.env.PDPP_RUN_ID?.trim()) &&
        Boolean(process.env.PDPP_REFERENCE_BASE_URL?.trim()) &&
        Boolean(process.env.PDPP_STREAMING_REGISTRATION_TOKEN?.trim() || process.env.PDPP_LOCAL_DEVICE_TOKEN?.trim());
    const launchSource = resolveBrowserLaunchSource(visibility);
    const remoteCdpUrl = launchSource.kind === "managed_neko" || launchSource.kind === "legacy_remote_cdp"
        ? launchSource.remoteCdpUrl
        : undefined;
    try {
        return await acquireBrowserForConnector({
            profileName,
            headless,
            ...(streamingEnabled ? { streamingEnabled: true } : {}),
            ...(remoteCdpUrl ? { remoteCdpUrl } : {}),
        });
    }
    catch (err) {
        if (err instanceof HeadedBrowserUnavailableError) {
            throw new TerminalError(`[${err.code}] ${err.message}`, false);
        }
        const message = err instanceof Error ? err.message : String(err);
        throw new TerminalError(`could not open browser profile: ${message}`, false);
    }
}
const DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS = 120_000;
const SESSION_ESTABLISH_WATCHDOG_ENV = "PDPP_SESSION_ESTABLISH_WATCHDOG_MS";
export function resolveSessionEstablishWatchdogMs(env = process.env) {
    const raw = env[SESSION_ESTABLISH_WATCHDOG_ENV]?.trim();
    if (!raw) {
        return DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    if (!(Number.isFinite(parsed) && parsed > 0)) {
        return DEFAULT_SESSION_ESTABLISH_WATCHDOG_MS;
    }
    return parsed;
}
export function makeSessionEstablishWatchdog(args) {
    const now = args.now ?? Date.now;
    const deadlineMs = args.deadlineMs ?? resolveSessionEstablishWatchdogMs();
    const pollIntervalMs = args.pollIntervalMs ?? Math.max(1, Math.min(1000, Math.floor(deadlineMs / 4)));
    let lastProgressAt = now();
    let lastLabel = null;
    let openInteractions = 0;
    let tripped = false;
    const markProgress = (label) => {
        lastProgressAt = now();
        if (label !== null) {
            lastLabel = label;
        }
    };
    const checkpoint = async (label) => {
        markProgress(label);
        try {
            await captureBrowserPage(args.capture, args.page, `session-establish-${label}`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            process.stderr.write(`[session-watchdog] checkpoint capture failed for ${label}: ${message}\n`);
        }
    };
    const wrapSendInteraction = (send) => async (req) => {
        openInteractions++;
        markProgress(null);
        try {
            return await send(req);
        }
        finally {
            openInteractions--;
            markProgress(null);
        }
    };
    const run = async (work) => {
        let timer;
        let tripInfo = null;
        const TRIP = Symbol("session-establish-trip");
        const tripPromise = new Promise((resolve) => {
            const onTick = () => {
                if (tripped || openInteractions > 0) {
                    return;
                }
                const sinceMs = now() - lastProgressAt;
                if (sinceMs <= deadlineMs) {
                    return;
                }
                tripped = true;
                if (timer) {
                    clearInterval(timer);
                }
                tripInfo = { lastLabel, sinceMs };
                args.onTrip?.(tripInfo);
                resolve(TRIP);
            };
            timer = setInterval(onTick, pollIntervalMs);
            timer.unref?.();
        });
        const workPromise = work();
        workPromise.catch(() => undefined);
        try {
            const outcome = await Promise.race([workPromise, tripPromise]);
            if (outcome === TRIP) {
                const info = tripInfo;
                const sinceMs = info?.sinceMs ?? deadlineMs;
                const lastCheckpoint = info?.lastLabel ?? "<none>";
                throw new TerminalError(`${args.name}_session_establish_timeout: no session-establishment progress for ${String(sinceMs)}ms ` +
                    `(last checkpoint: ${lastCheckpoint}); failing run closed`, true);
            }
        }
        finally {
            if (timer) {
                clearInterval(timer);
            }
        }
    };
    return { checkpoint, wrapSendInteraction, run };
}
async function establishSession(hooks, args) {
    const { ensureSession, probeSession } = hooks;
    const { assist, capture, checkpoint, completeAssistance, context, page, name, sendInteraction, progress } = args;
    await checkpoint("session-establish:begin");
    if (typeof ensureSession === "function") {
        try {
            await ensureSession({
                assist,
                capture,
                checkpoint,
                completeAssistance,
                context,
                page,
                sendInteraction,
                progress,
            });
            return;
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            throw new TerminalError(`${name}_session_failed: ${message}`, false);
        }
    }
    if (typeof probeSession !== "function") {
        return;
    }
    await checkpoint("session-establish:probe");
    if (await probeSession({ context, page })) {
        return;
    }
    await manualAction({
        page,
        reason: "login",
        message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
        timeoutSeconds: 1800,
    }, sendInteraction);
    await checkpoint("session-establish:probe-after-manual");
    if (await probeSession({ context, page })) {
        return;
    }
    throw new TerminalError(`${name}_session_required`, false);
}
export function isContextDisconnected(context) {
    try {
        const browser = context.browser?.();
        if (!browser) {
            return false;
        }
        if (typeof browser.isConnected === "function") {
            return browser.isConnected() === false;
        }
    }
    catch {
        return true;
    }
    return false;
}
export function makeTracer(context, name, capture) {
    const enabled = process.env.PDPP_TRACE === "1" || capture !== null;
    const traceName = `${name}-${new Date().toISOString().replace(TRACE_TIMESTAMP_UNSAFE, "-")}`;
    const tracePath = capture ? join(capture.baseDir, "traces", `${traceName}.zip`) : `/tmp/${traceName}.zip`;
    const traceBaseDir = capture ? join(capture.baseDir, "traces") : null;
    const tracing = context.tracing;
    let started = false;
    let chunkStarted = false;
    let chunkSeq = 0;
    let succeeded = false;
    const writtenTraceFiles = [];
    const safeChunkLabel = (label) => String(label)
        .replace(/[^A-Za-z0-9_.-]/g, "_")
        .slice(0, 80);
    const writeTraceDiagnostic = (phase, err) => {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[trace] ${phase} failed: ${message}\n`);
        if (!traceBaseDir) {
            return;
        }
        try {
            writeFileSync(join(traceBaseDir, `${traceName}-${String(chunkSeq).padStart(3, "0")}-${safeChunkLabel(phase)}.error.json`), JSON.stringify({
                captured_at: new Date().toISOString(),
                error: message,
                phase,
            }, null, 2));
        }
        catch {
        }
    };
    const startChunk = async (label) => {
        if (!traceBaseDir || typeof tracing.startChunk !== "function") {
            return;
        }
        try {
            await tracing.startChunk({ title: `${traceName}:${label}` });
            chunkStarted = true;
        }
        catch (err) {
            chunkStarted = false;
            writeTraceDiagnostic("start-chunk", err);
        }
    };
    const stopChunk = async (label) => {
        if (!(traceBaseDir && chunkStarted) || typeof tracing.stopChunk !== "function") {
            return;
        }
        chunkSeq += 1;
        const path = join(traceBaseDir, `${traceName}-${String(chunkSeq).padStart(3, "0")}-${safeChunkLabel(label)}.zip`);
        try {
            await tracing.stopChunk({ path });
            writtenTraceFiles.push(path);
        }
        catch (err) {
            writeTraceDiagnostic(`stop-chunk-${safeChunkLabel(label)}`, err);
        }
        finally {
            chunkStarted = false;
        }
    };
    const deleteWrittenTraces = () => {
        for (const path of writtenTraceFiles) {
            try {
                rmSync(path, { force: true });
            }
            catch (err) {
                writeTraceDiagnostic("delete-on-success", err);
            }
        }
        writtenTraceFiles.length = 0;
    };
    return {
        async start() {
            if (!enabled) {
                return;
            }
            try {
                await context.tracing.start({
                    name: traceName,
                    screenshots: true,
                    snapshots: true,
                    sources: true,
                });
                started = true;
            }
            catch (err) {
                writeTraceDiagnostic("start", err);
                return;
            }
            await startChunk("start");
            process.stderr.write(`[trace] tracing enabled; ${traceBaseDir ? `writing chunks under ${traceBaseDir}` : `will write ${tracePath} on exit`}\n`);
        },
        async checkpoint(label) {
            if (!(enabled && started && traceBaseDir) || typeof tracing.startChunk !== "function") {
                return;
            }
            await stopChunk(label);
            await startChunk(label);
        },
        markSucceeded() {
            succeeded = true;
        },
        async stop() {
            if (!(enabled && started)) {
                return;
            }
            started = false;
            if (isContextDisconnected(context)) {
                finalizeDisconnected();
                return;
            }
            try {
                if (traceBaseDir && typeof tracing.stopChunk === "function") {
                    await stopChunkedTrace();
                    return;
                }
                await stopSingleTrace();
            }
            catch (err) {
                writeTraceDiagnostic("stop", err);
            }
        },
    };
    function finalizeDisconnected() {
        writeTraceDiagnostic("stop-disconnected", new Error("browser disconnected before trace stop"));
        if (!traceBaseDir) {
            return;
        }
        if (succeeded) {
            deleteWrittenTraces();
            process.stderr.write(`[trace] run succeeded but browser disconnected; trace chunks deleted from ${traceBaseDir}\n`);
        }
        else {
            process.stderr.write(`[trace] browser disconnected before stop; chunks retained under ${traceBaseDir}\n`);
        }
    }
    async function stopChunkedTrace() {
        await stopChunk("final");
        await context.tracing.stop();
        if (succeeded) {
            deleteWrittenTraces();
            process.stderr.write(`[trace] run succeeded; trace chunks deleted from ${traceBaseDir}\n`);
        }
        else {
            process.stderr.write(`[trace] run failed; trace chunks retained under ${traceBaseDir}\n`);
        }
    }
    async function stopSingleTrace() {
        await context.tracing.stop({ path: tracePath });
        if (!succeeded) {
            process.stderr.write(`[trace] run failed; trace retained at ${tracePath}\n`);
            return;
        }
        try {
            rmSync(tracePath, { force: true });
            process.stderr.write(`[trace] run succeeded; trace deleted (${tracePath})\n`);
        }
        catch (err) {
            writeTraceDiagnostic("delete-on-success", err);
        }
    }
}
