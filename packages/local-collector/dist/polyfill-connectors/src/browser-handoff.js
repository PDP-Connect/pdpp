import { randomBytes } from "node:crypto";
import { resolveStreamingRegistrationFromEnv, } from "./streaming-target-registration.js";
export async function resolveWsUrlForExactPage(page, opts) {
    const session = await page.context().newCDPSession(page);
    try {
        const { targetInfo } = (await session.send("Target.getTargetInfo"));
        if (targetInfo.type !== "page") {
            throw new Error(`expected page target, got type=${targetInfo.type}`);
        }
        return `ws://${opts.host}:${String(opts.port)}/devtools/page/${targetInfo.targetId}`;
    }
    finally {
        await session.detach().catch(() => undefined);
    }
}
const BROWSER_CDP_HOST_ENV = "PDPP_BROWSER_CDP_HOST";
const BROWSER_CDP_PORT_ENV = "PDPP_BROWSER_CDP_PORT";
const BROWSER_SURFACE_ID_ENV = "PDPP_BROWSER_SURFACE_ID";
const BROWSER_SURFACE_LEASE_ID_ENV = "PDPP_BROWSER_SURFACE_LEASE_ID";
const BROWSER_SURFACE_PROFILE_KEY_ENV = "PDPP_BROWSER_SURFACE_PROFILE_KEY";
const BROWSER_SURFACE_REQUIRED_ENV = "PDPP_BROWSER_SURFACE_REQUIRED";
const BROWSER_SURFACE_STREAM_BASE_URL_ENV = "PDPP_BROWSER_SURFACE_STREAM_BASE_URL";
function resolveCdpEndpointFromEnv(env) {
    const host = env[BROWSER_CDP_HOST_ENV]?.trim();
    const portRaw = env[BROWSER_CDP_PORT_ENV]?.trim();
    if (!(host && portRaw)) {
        return;
    }
    const port = Number.parseInt(portRaw, 10);
    if (!(Number.isFinite(port) && port > 0)) {
        return;
    }
    return { host, port };
}
function nonEmptyEnv(env, key) {
    const value = env[key]?.trim();
    return value ? value : undefined;
}
function isManagedNekoRequired(env) {
    return nonEmptyEnv(env, BROWSER_SURFACE_REQUIRED_ENV)?.toLowerCase() === "neko";
}
function resolveManagedNekoDescriptorFromEnv(env) {
    const baseUrl = nonEmptyEnv(env, BROWSER_SURFACE_STREAM_BASE_URL_ENV);
    const leaseId = nonEmptyEnv(env, BROWSER_SURFACE_LEASE_ID_ENV);
    const profileKey = nonEmptyEnv(env, BROWSER_SURFACE_PROFILE_KEY_ENV);
    if (!(baseUrl && leaseId && profileKey)) {
        return;
    }
    return {
        backend: "neko",
        base_url: baseUrl,
        lease_id: leaseId,
        profile_key: profileKey,
        ...(nonEmptyEnv(env, BROWSER_SURFACE_ID_ENV) ? { surface_id: nonEmptyEnv(env, BROWSER_SURFACE_ID_ENV) } : {}),
    };
}
function generateInteractionId() {
    return `int_${String(Date.now())}_${randomBytes(4).toString("hex")}`;
}
async function readManualActionPageMetadata(page) {
    let pageUrl;
    let pageTitle;
    try {
        pageUrl = page.url();
    }
    catch {
    }
    try {
        pageTitle = await page.title();
    }
    catch {
    }
    return {
        ...(pageUrl ? { pageUrl } : {}),
        ...(pageTitle ? { pageTitle } : {}),
    };
}
function registerManagedNekoManualActionTarget(args) {
    const nekoDescriptor = resolveManagedNekoDescriptorFromEnv(args.env);
    if (!nekoDescriptor) {
        process.stderr.write(`[browser-handoff] managed n.eko surface env is incomplete; streaming-companion target not registered for interaction ${args.interactionId}.\n`);
        return Promise.resolve(false);
    }
    return args.registration.register({
        backend: "neko",
        runId: args.registration.runId,
        interactionId: args.interactionId,
        descriptor: {
            ...nekoDescriptor,
            interaction_id: args.interactionId,
            ...(args.metadata.pageUrl ? { start_url: args.metadata.pageUrl } : {}),
        },
        ...(args.metadata.pageUrl ? { pageUrl: args.metadata.pageUrl } : {}),
        ...(args.metadata.pageTitle ? { pageTitle: args.metadata.pageTitle } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
    });
}
async function resolveCdpWsUrlForManualAction(args) {
    try {
        return await args.resolveWsUrl(args.page, args.endpoint);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[browser-handoff] could not resolve CDP page-target wsUrl for interaction ${args.interactionId}: ${message}; continuing without streaming.\n`);
        return;
    }
}
function registerCdpManualActionTarget(args) {
    return args.registration.register({
        runId: args.registration.runId,
        interactionId: args.interactionId,
        wsUrl: args.wsUrl,
        ...(args.metadata.pageUrl ? { pageUrl: args.metadata.pageUrl } : {}),
        ...(args.metadata.pageTitle ? { pageTitle: args.metadata.pageTitle } : {}),
        ...(args.reason ? { reason: args.reason } : {}),
    });
}
export async function prepareManualAction(args) {
    const env = args.env ?? process.env;
    const resolveStreamingRegistration = args.resolveStreamingRegistration ?? resolveStreamingRegistrationFromEnv;
    const resolveWsUrl = args.resolveWsUrl ?? resolveWsUrlForExactPage;
    const interactionId = generateInteractionId();
    const registration = await resolveStreamingRegistration(env);
    if (!registration) {
        return { interactionId, registered: false };
    }
    const metadata = await readManualActionPageMetadata(args.page);
    if (isManagedNekoRequired(env)) {
        const ok = await registerManagedNekoManualActionTarget({
            env,
            interactionId,
            metadata,
            registration,
            ...(args.reason ? { reason: args.reason } : {}),
        });
        return { interactionId, registered: ok };
    }
    const endpoint = resolveCdpEndpointFromEnv(env);
    if (!endpoint) {
        process.stderr.write(`[browser-handoff] ${BROWSER_CDP_HOST_ENV}/${BROWSER_CDP_PORT_ENV} not set; streaming-companion target not registered for interaction ${interactionId}.\n`);
        return { interactionId, registered: false };
    }
    const wsUrl = await resolveCdpWsUrlForManualAction({
        endpoint,
        interactionId,
        page: args.page,
        resolveWsUrl,
    });
    if (!wsUrl) {
        return { interactionId, registered: false };
    }
    const ok = await registerCdpManualActionTarget({
        interactionId,
        metadata,
        registration,
        wsUrl,
        ...(args.reason ? { reason: args.reason } : {}),
    });
    if (!ok) {
        return { interactionId, registered: false };
    }
    return { interactionId, registered: true };
}
function captureManualActionFixture(args) {
    if (!args.capture) {
        return;
    }
    try {
        const capture = args.capture.captureDom(args.page, `manual-action-${args.reason ?? "manual_action"}-${args.interactionId}`);
        capture.catch(() => undefined);
    }
    catch {
    }
}
export async function manualAction(args, sendInteraction) {
    const { interactionId } = await prepareManualAction({
        page: args.page,
        ...(args.reason ? { reason: args.reason } : {}),
        ...(args.env ? { env: args.env } : {}),
        ...(args.resolveStreamingRegistration ? { resolveStreamingRegistration: args.resolveStreamingRegistration } : {}),
        ...(args.resolveWsUrl ? { resolveWsUrl: args.resolveWsUrl } : {}),
    });
    captureManualActionFixture({
        ...(args.capture ? { capture: args.capture } : {}),
        interactionId,
        page: args.page,
        ...(args.reason ? { reason: args.reason } : {}),
    });
    return await sendInteraction({
        kind: "manual_action",
        request_id: interactionId,
        message: args.message,
        ...(args.schema ? { schema: args.schema } : {}),
        ...(args.timeoutSeconds === undefined ? {} : { timeout_seconds: args.timeoutSeconds }),
    });
}
export { BROWSER_CDP_HOST_ENV, BROWSER_CDP_PORT_ENV, BROWSER_SURFACE_ID_ENV, BROWSER_SURFACE_LEASE_ID_ENV, BROWSER_SURFACE_PROFILE_KEY_ENV, BROWSER_SURFACE_REQUIRED_ENV, BROWSER_SURFACE_STREAM_BASE_URL_ENV, };
