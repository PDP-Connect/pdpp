// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
// biome-ignore-all lint/correctness/useImportExtensions: generated MJS is the native Node runtime artifact

// Typed import path for tests. The preload and this facade share the same
// generated runtime module, so explicit test grants affect the installed guard.
// biome-ignore lint/performance/noBarrelFile: tests need the same generated MJS instance as the preload
export {
  blockedOriginError,
  installHermeticNetworkGuard,
  isHermeticNetworkGuardInstalled,
  isOriginAllowed,
  registerEphemeralOrigin,
  unregisterEphemeralOrigin,
} from "./guard-runtime.mjs";
export type { HermeticGuardHandle } from "./guard-source.mts";
