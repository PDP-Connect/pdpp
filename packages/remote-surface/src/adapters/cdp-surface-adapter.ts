// CdpSurfaceAdapter — fallback / legacy / debug RemoteSurface implementation.
//
// TODO(remote-surface): wrap the existing BrowserSurface + cdp-adapter path
// used by the current dashboard streaming viewer. Keep this adapter behind a
// feature flag once NekoSurfaceAdapter is the default; CDP remains useful
// for debugging Playwright captures where n.eko isn't available.
// Reference: §54-62 of docs/5-12-26-chatgpt-remote-surface-brief-response.txt.

import type {
  FocusTextInputOptions,
  RemoteKeysymEvent,
  RemotePointerEvent,
  RemoteSurface,
  RemoteSurfaceConfig,
  RemoteSurfaceLifecycleState,
} from "../types.ts";
import type { RemoteSurfaceLogger } from "./neko-surface-adapter.ts";

export type CdpSurfaceConfig = Extract<RemoteSurfaceConfig, { kind: "cdp" }>;

export class CdpSurfaceAdapter implements RemoteSurface {
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: scaffold
  private container: HTMLElement | null = null;

  // Handle to the underlying BrowserSurface / CDP session. Typed as
  // `unknown` until the integration step imports the real type.
  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: scaffold
  private cdp: unknown = null;

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: scaffold
  private lifecycleState: RemoteSurfaceLifecycleState = "idle";

  // biome-ignore lint/correctness/noUnusedPrivateClassMembers: scaffold
  private readonly log: RemoteSurfaceLogger;

  constructor(
    _config: CdpSurfaceConfig,
    log: RemoteSurfaceLogger = () => {
      /* no-op default logger */
    },
  ) {
    this.log = log;
    // Silence TS6133 for scaffold fields that are populated in real impl.
    void this.container;
    void this.cdp;
    void this.lifecycleState;
    void this.log;
  }

  mount(_el: HTMLElement): Promise<void> {
    throw new Error("CdpSurfaceAdapter.mount: not implemented yet");
  }

  unmount(): Promise<void> {
    throw new Error("CdpSurfaceAdapter.unmount: not implemented yet");
  }

  focusTextInput(_opts?: FocusTextInputOptions): void {
    throw new Error("CdpSurfaceAdapter.focusTextInput: not implemented yet");
  }

  sendPointer(_event: RemotePointerEvent): Promise<void> {
    throw new Error("CdpSurfaceAdapter.sendPointer: not implemented yet");
  }

  sendKeysym(_event: RemoteKeysymEvent): Promise<void> {
    throw new Error("CdpSurfaceAdapter.sendKeysym: not implemented yet");
  }

  sendText(_text: string): Promise<void> {
    throw new Error("CdpSurfaceAdapter.sendText: not implemented yet");
  }
}
