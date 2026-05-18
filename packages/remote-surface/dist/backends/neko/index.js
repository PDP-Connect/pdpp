import { parseSafeRemoteSurfaceBackendDescriptor } from "../../protocol/index.js";
export * from "./media-settle.js";
export * from "./layout.js";
export * from "./pointer-diagnostics.js";
export * from "./touch-scroll.js";
export const NEKO_BACKEND_CAPABILITIES = {
    eventChannel: "sse",
    input: ["pointer", "keyboard", "keysym", "text", "paste", "touch", "scroll"],
    clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
    viewport: ["report", "resize", "classify_occlusion"],
    diagnostics: ["events", "replay", "redacted_buffer"],
    ownerBrowser: true,
    serverSideAutomationEndpoint: true,
};
export function buildNekoSafeClientDescriptor({ proxyPath, sessionPath, allowedMethods, expiresAt, capabilities = NEKO_BACKEND_CAPABILITIES, }) {
    return parseNekoSafeClientDescriptor({
        backend: "neko",
        capabilities,
        proxy: {
            path: proxyPath,
            sameOrigin: true,
            ...(allowedMethods === undefined ? {} : { allowedMethods }),
        },
        ...(sessionPath === undefined
            ? {}
            : {
                session: {
                    path: sessionPath,
                    sameOrigin: true,
                    ...(expiresAt === undefined ? {} : { expiresAt }),
                },
            }),
    });
}
export function parseNekoSafeClientDescriptor(value) {
    const descriptor = parseSafeRemoteSurfaceBackendDescriptor(value);
    if (descriptor.backend !== "neko" || !descriptor.proxy) {
        throw new TypeError("n.eko client descriptors must include a same-origin proxy path");
    }
    return descriptor;
}
//# sourceMappingURL=index.js.map