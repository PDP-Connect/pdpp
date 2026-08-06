// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Claim a popup notice only when the wire identity proves it is the same
 * browser transition. A target ID is scoped to a browser session; URL and
 * arrival time are deliberately not used because OAuth flows can create
 * several legitimate child pages close together.
 */
export interface PopupNoticeSeenRegistry {
  keys: Set<string>;
}

export interface PopupNoticeIdentity {
  browserSessionId: string | null;
  targetId: string;
}

export type PopupNoticeClaim = "claimed" | "duplicate" | "unkeyable";

export function createPopupNoticeSeenRegistry(): PopupNoticeSeenRegistry {
  return { keys: new Set() };
}

export function claimPopupNotice(registry: PopupNoticeSeenRegistry, identity: PopupNoticeIdentity): PopupNoticeClaim {
  if (identity.browserSessionId === null || identity.browserSessionId.length === 0 || identity.targetId.length === 0) {
    // An unscoped target cannot prove it is a replay. Keep the notice rather
    // than silently dropping a real browser transition.
    return "unkeyable";
  }
  const key = `${identity.browserSessionId}\u0000${identity.targetId}`;
  if (registry.keys.has(key)) {
    return "duplicate";
  }
  registry.keys.add(key);
  return "claimed";
}
