// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Deferred by Batch 19. A Vana Context Gateway client adapter needs a binding
 * that points the gateway's outbound AS/RS traffic at ClientFixture.url and
 * exposes the gateway's request log. Until that binding exists, the gateway
 * cannot be assessed through ClientUnderTest without replacing its transport
 * with a test double, so this batch intentionally leaves the adapter absent.
 */
export const VANA_CONTEXT_GATEWAY_CLIENT_ADAPTER_STUB = {
  status: "deferred",
  needs: "a gateway binding that routes the client to the client fixture",
} as const;
