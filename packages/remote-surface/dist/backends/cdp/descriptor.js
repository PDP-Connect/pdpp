import { parseSafeRemoteSurfaceBackendDescriptor } from "../../protocol/index.js";
export const CDP_BACKEND_CAPABILITIES = {
    eventChannel: "sse",
    input: ["pointer", "keyboard", "text", "paste", "touch", "scroll"],
    clipboard: ["local_to_remote", "remote_to_local", "manual_fallback"],
    viewport: ["report", "resize", "classify_occlusion"],
    diagnostics: ["events", "replay", "redacted_buffer"],
    ownerBrowser: true,
    serverSideAutomationEndpoint: true,
};
export function buildCdpSafeClientDescriptor({ capabilities = CDP_BACKEND_CAPABILITIES, } = {}) {
    return parseCdpSafeClientDescriptor({ backend: "cdp", capabilities });
}
export function parseCdpSafeClientDescriptor(value) {
    const descriptor = parseSafeRemoteSurfaceBackendDescriptor(value);
    if (descriptor.backend !== "cdp" || descriptor.proxy || descriptor.session) {
        throw new TypeError("CDP client descriptors must not expose proxy or session endpoints");
    }
    return descriptor;
}
//# sourceMappingURL=descriptor.js.map