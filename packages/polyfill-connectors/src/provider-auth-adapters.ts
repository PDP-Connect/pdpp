// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The one place that lists which provider-auth adapter modules exist, and
 * the only place that registers them.
 *
 * Registration is inverted rather than self-registering: each adapter module
 * exports its `ProviderAuthAdapter` object and the `exchanger_kind` it
 * implements, and this barrel binds the two. That keeps every adapter's
 * dependency on provider-auth-adapter.ts type-only, so there is no runtime
 * import cycle (an adapter that imported `registerProviderAuthAdapter` as a
 * value would close the loop registry -> adapter -> registry).
 *
 * Registration is also deterministic rather than import-order-dependent:
 * the list below is eagerly loaded once, memoized, before any resolution, so
 * a lookup never depends on which caller imported an adapter file first.
 * Adding a new `exchanger_kind` means adding one entry here — nowhere else.
 */

import {
  _clearProviderAuthAdapterRegistryForTests,
  getRegisteredProviderAuthAdapter,
  type ProviderAuthAdapter,
  registerProviderAuthAdapter,
} from "./provider-auth-adapter.ts";

const ADAPTER_MODULES: readonly (() => Promise<{
  readonly kind: string;
  readonly adapter: ProviderAuthAdapter;
}>)[] = [
  async () => {
    const { OAUTH2_GENERIC_EXCHANGER_KIND, oauth2GenericAdapter } = await import("./oauth2-generic-provider-auth.ts");
    return { adapter: oauth2GenericAdapter, kind: OAUTH2_GENERIC_EXCHANGER_KIND };
  },
  async () => {
    const { GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND, googleDataPortabilityAdapter } = await import(
      "../connectors/google_maps_data_portability/provider-auth.ts"
    );
    return { adapter: googleDataPortabilityAdapter, kind: GOOGLE_DATA_PORTABILITY_EXCHANGER_KIND };
  },
];

let loaded: Promise<void> | null = null;

export function loadProviderAuthAdapterModules(): Promise<void> {
  loaded ??= Promise.all(ADAPTER_MODULES.map((load) => load())).then((entries) => {
    for (const { adapter, kind } of entries) {
      registerProviderAuthAdapter(kind, adapter);
    }
  });
  return loaded;
}

/**
 * Resolves a manifest-declared `exchanger_kind` to its adapter. Always
 * awaits the deterministic eager-load of every module above first, so the
 * result never depends on call order or on which caller ran first.
 */
export async function resolveProviderAuthAdapter(kind: string): Promise<ProviderAuthAdapter | null> {
  await loadProviderAuthAdapterModules();
  return getRegisteredProviderAuthAdapter(kind);
}

/**
 * Test-only: drops both the memoized eager-load and the registry contents so
 * a harness can re-run registration from scratch.
 */
export function _resetProviderAuthAdapterRegistryForTests(): void {
  loaded = null;
  _clearProviderAuthAdapterRegistryForTests();
}
