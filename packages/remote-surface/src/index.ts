export type {
  FocusTextInputOptions,
  RemoteKeysymEvent,
  RemotePointerEvent,
  RemoteSurface,
  RemoteSurfaceConfig,
  RemoteSurfaceLifecycleState,
} from "./types.ts";
export type * from "./protocol/index.ts";
export type * from "./server/index.ts";
export type * from "./client/index.ts";
export type * from "./backends/types.ts";
export type * from "./backends/neko/index.ts";
export type * from "./backends/cdp/index.ts";
export {
  buildNekoSafeClientDescriptor,
  NEKO_BACKEND_CAPABILITIES,
  parseNekoSafeClientDescriptor,
} from "./backends/neko/index.ts";
export {
  buildCdpSafeClientDescriptor,
  CDP_BACKEND_CAPABILITIES,
  parseCdpSafeClientDescriptor,
} from "./backends/cdp/index.ts";
export {
  createDiagnosticsBuffer,
  redactDiagnosticsEvent,
} from "./diagnostics/index.ts";
export type {
  RedactDiagnosticsOptions,
  RemoteSurfaceDiagnosticsBuffer,
  RemoteSurfaceDiagnosticsEvent,
  RemoteSurfaceDiagnosticsReadResult,
} from "./diagnostics/index.ts";
export {
  BROWSER_SURFACE_BACKEND_NEKO,
  BROWSER_SURFACE_LEASE_STATUSES,
  BROWSER_SURFACE_PRIORITY_CLASSES,
  BROWSER_SURFACE_WAIT_REASONS,
  BrowserSurfaceLeaseManager,
  DEFAULT_NEKO_IDLE_TTL_MS,
  DEFAULT_NEKO_LEASE_WAIT_TIMEOUT_MS,
  DEFAULT_NEKO_PRIORITY_CLASS,
  DEFAULT_NEKO_PRIORITY_RANKS,
  TERMINAL_BROWSER_SURFACE_LEASE_STATUSES,
  isTerminalBrowserSurfaceLeaseStatus,
  projectBrowserSurfaceLease,
} from "./leases/index.ts";
export type {
  AcquireBrowserSurfaceLeaseRequest,
  BrowserSurface,
  BrowserSurfaceAllocator,
  BrowserSurfaceBackend,
  BrowserSurfaceHealth,
  BrowserSurfaceLease,
  BrowserSurfaceLeaseConfig,
  BrowserSurfaceLeaseManagerOptions,
  BrowserSurfaceLeaseResult,
  BrowserSurfaceLeaseStatus,
  BrowserSurfaceMode,
  BrowserSurfacePriorityClass,
  BrowserSurfaceProjection,
  BrowserSurfaceWaitReason,
  CleanupIdleBrowserSurfacesResult,
  CompleteBrowserSurfaceCapacityReclaimResult,
  EnsureBrowserSurfaceRequest,
  EnsureStartingBrowserSurfaceRequest,
  ReconcileBrowserSurfaceLeasesAfterRestartRequest,
  ReconcileBrowserSurfaceLeasesAfterRestartResult,
  ReleaseBrowserSurfaceLeaseRequest,
  ReleaseBrowserSurfaceLeaseResult,
  StopBrowserSurfaceRequest,
  TerminalBrowserSurfaceLeaseResult,
} from "./leases/index.ts";
export {
  type CdpSurfaceConfig,
  CdpSurfaceAdapter,
  type NekoClientApi,
  type NekoSurfaceConfig,
  NekoSurfaceAdapter,
  type RemoteSurfaceLogger,
} from "./adapters/index.ts";
export {
  type NekoControlPos,
  type NekoPointerControl,
  type NekoPointerControllerDeps,
  NekoPointerController,
} from "./controllers/index.ts";
export {
  type Keysym,
  type MobileTextInputControllerDeps,
  MobileTextInputController,
  XK_BackSpace,
  XK_Delete,
  XK_Down,
  XK_End,
  XK_Escape,
  XK_Home,
  XK_Left,
  XK_PageDown,
  XK_PageUp,
  XK_Return,
  XK_Right,
  XK_Tab,
  XK_Up,
} from "./ime/index.ts";
