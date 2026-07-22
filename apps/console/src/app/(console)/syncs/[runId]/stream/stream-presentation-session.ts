// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Presentation geometry belongs to one remote browser session. A new browser
 * session may reuse the same n.eko client-config URL, so URL equality is not
 * a valid lifecycle boundary for the visible frame or its settled viewport.
 */
export interface PresentationSessionState<Viewport> {
  browserSessionId: string | null;
  localSurfaceViewport: Viewport | null;
  presentationViewport: Viewport | null;
  stablePresentationViewport: Viewport | null;
}

export interface PresentationSessionTransition<Viewport> {
  reset: boolean;
  state: PresentationSessionState<Viewport>;
}

/**
 * Start the presentation state for an SSE attachment. Re-attaching the same
 * browser session preserves its settled frame; a different browser session
 * must not inherit the prior session's geometry.
 */
export function beginPresentationSession<Viewport>(
  state: PresentationSessionState<Viewport>,
  browserSessionId: string
): PresentationSessionTransition<Viewport> {
  if (state.browserSessionId === browserSessionId) {
    return { reset: false, state };
  }
  return {
    reset: true,
    state: {
      browserSessionId,
      localSurfaceViewport: null,
      presentationViewport: null,
      stablePresentationViewport: null,
    },
  };
}
