// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Platform-owned authority for whether a connector config option shapes
 * collection scope or only transport tuning.
 *
 * D10 (scripts/canary/otp-posture.ts): "qualification is proven, never
 * self-declared." A manifest's `options_schema[key].declared_option_kind`
 * is that connector's CLAIM. This registry is the platform's decision, and
 * it is the one connector_instance_config_store.propose() actually trusts
 * -- a manifest cannot widen its own eligibility by mislabeling a
 * collection-shaping knob as "transport" (which self-activates without
 * owner confirmation) instead of "collection_scope" (which does not).
 *
 * Deliberately asymmetric like the OTP posture derivation: a key absent
 * from this registry is NOT trusted as "transport" by omission -- callers
 * must look it up and treat an unknown key as collection_scope (the safer,
 * more restrictive default) rather than silently trusting whatever the
 * manifest wrote. See connector-config-option-kind-honesty.test.ts, which
 * fails the build if a manifest's declared_option_kind disagrees with this
 * registry for any key both sides know about.
 */

export type ConfigOptionKind = "collection_scope" | "transport";

interface ConnectorOptionKinds {
  readonly [optionKey: string]: ConfigOptionKind;
}

/**
 * connector_key -> option key -> platform-decided kind. Only connectors
 * migrated onto the config spine need an entry; a connector absent here
 * has no options_schema wired yet and is not affected by this registry.
 */
const PLATFORM_OPTION_KINDS: Readonly<Record<string, ConnectorOptionKinds>> = Object.freeze({
  slack: Object.freeze({
    CHANNEL_ALLOWLIST: "collection_scope",
    CHANNEL_TYPES: "collection_scope",
    MEMBER_ONLY: "collection_scope",
    LOOKBACK_DAYS: "collection_scope",
    SKIP_FILES: "transport",
    RECLAIM_UPLOADS: "transport",
  }),
});

/**
 * The platform's decision for a given connector+option key. Absence (an
 * unregistered connector, or a key the registry has not classified) is
 * NOT a green light -- callers MUST treat `null` as "not yet proven
 * transport" and default to the collection_scope (never-self-activating)
 * path, never to transport.
 */
export function platformOptionKind(connectorKey: string, optionKey: string): ConfigOptionKind | null {
  return PLATFORM_OPTION_KINDS[connectorKey]?.[optionKey] ?? null;
}

/**
 * Resolve the kind the runtime will actually enforce for a manifest-declared
 * option: the platform's classification when registered, otherwise the
 * conservative collection_scope default -- never the manifest's own claim.
 */
export function resolveEnforcedOptionKind(connectorKey: string, optionKey: string): ConfigOptionKind {
  return platformOptionKind(connectorKey, optionKey) ?? "collection_scope";
}
