export { buildNekoSafeClientDescriptor, NEKO_BACKEND_CAPABILITIES, parseNekoSafeClientDescriptor, } from "./backends/neko/index.js";
export { buildCdpSafeClientDescriptor, CDP_BACKEND_CAPABILITIES, parseCdpSafeClientDescriptor, } from "./backends/cdp/index.js";
export { createDiagnosticsBuffer, redactDiagnosticsEvent, } from "./diagnostics/index.js";
export { BROWSER_SURFACE_BACKEND_NEKO, BROWSER_SURFACE_LEASE_STATUSES, BROWSER_SURFACE_PRIORITY_CLASSES, BROWSER_SURFACE_WAIT_REASONS, BrowserSurfaceLeaseManager, DEFAULT_NEKO_IDLE_TTL_MS, DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS, DEFAULT_NEKO_PRIORITY_CLASS, DEFAULT_NEKO_PRIORITY_RANKS, TERMINAL_BROWSER_SURFACE_LEASE_STATUSES, isTerminalBrowserSurfaceLeaseStatus, projectBrowserSurfaceLease, } from "./leases/index.js";
export { CdpSurfaceAdapter, NekoSurfaceAdapter, } from "./adapters/index.js";
export { NekoPointerController, } from "./controllers/index.js";
export { MobileTextInputController, XK_BackSpace, XK_Delete, XK_Down, XK_End, XK_Escape, XK_Home, XK_Left, XK_PageDown, XK_PageUp, XK_Return, XK_Right, XK_Tab, XK_Up, } from "./ime/index.js";
//# sourceMappingURL=index.js.map