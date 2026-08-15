// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Reference-only owner-session provider app-registration configuration.
//
// Lets an operator configure deployment-level provider app-registration
// values (e.g. an OAuth client id/secret) through the DB-backed
// `ProviderAppConfigStore`, as an alternative to setting env vars directly.
// This module carries zero connector/provider-specific knowledge: every
// field it reads and writes is a manifest-declared `logical_key`/`label`, and
// values are grouped by the manifest-declared, opaque `provider_identity_group`
// token — never by a connector id or provider name.
//
// Two routes:
//
//   GET /_ref/provider-app-config?identity_group=...
//     Owner-session only. Returns the opaque identity_group token itself
//     (a hidden addressing value, so the client can make the matching POST
//     call — never rendered as UI copy) plus display metadata for the group
//     (label + each logical field's label/secret/configured flag) — never
//     `env_alias`, never a stored value, configured or not.
//
//   GET /_ref/provider-app-config (no identity_group)
//     Owner-session only. Lists every distinct provider_identity_group any
//     registered connector manifest declares, each in the same shape as the
//     single-group response above. This is the Console's discovery surface —
//     it does not know which identity groups exist ahead of time.
//
//   POST /_ref/provider-app-config
//     Owner-session only. Body `{ identity_group, values: {logicalKey:value} }`.
//     Validates every key against the group's manifest-declared logical keys
//     BEFORE any write; requires every currently-unconfigured declared key be
//     present on first setup (partial client-id/secret setup is impossible);
//     allows blanks/omission for already-configured or already
//     env-satisfied keys; commits every value in exactly one
//     `store.setMany` call so the write is atomic.

import type { MiddlewareHandler, PdppErrorFn, RouteArg } from "./_route-contract.ts";

// ---------------------------------------------------------------------------
// Injectable store interface
// ---------------------------------------------------------------------------

/**
 * Encrypted, deployment-global config store keyed by (identity_group,
 * logical_key). Implemented elsewhere (SQLite/Postgres factories); this
 * route only depends on the interface.
 */
export interface ProviderAppConfigStore {
  listConfiguredKeys: (identityGroup: string) => Promise<readonly string[]>;
  setMany: (args: {
    identityGroup: string;
    values: Readonly<Record<string, string>>;
    updatedAt: string;
  }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Manifest-derived group descriptor
// ---------------------------------------------------------------------------

export interface ProviderAppConfigLogicalField {
  readonly envAlias: string | null;
  readonly label: string;
  readonly logicalKey: string;
  readonly secret: boolean;
}

export interface ProviderIdentityGroupDescriptor {
  readonly fields: readonly ProviderAppConfigLogicalField[];
  readonly identityGroup: string;
  readonly providerIdentityLabel: string | null;
}

// ---------------------------------------------------------------------------
// Shared route types
// ---------------------------------------------------------------------------

interface RouteRequest {
  readonly body?: unknown;
  ownerSession?: { readonly sub?: string | null } | null;
  readonly query?: Readonly<Record<string, string | string[] | undefined>>;
}

interface RouteResponse {
  json: (body: unknown) => unknown;
  status: (code: number) => RouteResponse;
}

type RouteHandler = (req: RouteRequest, res: RouteResponse) => unknown | Promise<unknown>;

interface AppLike {
  get: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
  post: (path: string, ...args: RouteArg<RouteHandler>[]) => AppLike;
}

export interface MountRefProviderAppConfigContext {
  createRequestProviderAppConfigStore: () => ProviderAppConfigStore;
  handleError: (res: unknown, err: unknown) => void;
  /** True when the given env_alias currently resolves to a non-blank value
   * in the process environment — used only to decide whether a field counts
   * as "configured" for the first-setup completeness check; the alias name
   * itself is never returned to the caller. */
  isEnvAliasSatisfied: (envAlias: string) => boolean;
  now?: () => string;
  pdppError: PdppErrorFn;
  requireOwnerSession: MiddlewareHandler;
  /** Resolves every manifest sharing the given `provider_identity_group` and
   * returns the group's display label plus the union of their declared
   * `deployment_config` logical fields. Absent/unknown group -> null. */
  resolveProviderIdentityGroup: (identityGroup: string) => Promise<ProviderIdentityGroupDescriptor | null>;
  /** Every distinct `provider_identity_group` declared by a registered
   * connector manifest, each already resolved to its descriptor — same
   * shape `resolveProviderIdentityGroup` returns for one group. Used only
   * by the no-`identity_group` GET (list) path. */
  listProviderIdentityGroups: () => Promise<readonly ProviderIdentityGroupDescriptor[]>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function firstQueryValue(raw: string | readonly string[] | undefined): string | undefined {
  if (typeof raw === "string") {
    return raw;
  }
  return Array.isArray(raw) ? raw[0] : undefined;
}

function requestedIdentityGroup(req: RouteRequest): string | null {
  const value = firstQueryValue(req.query?.identity_group);
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

// biome-ignore lint/suspicious/useAwait: interface contract is async; this implementation happens to resolve synchronously.
async function fieldIsAlreadyConfigured(
  ctx: MountRefProviderAppConfigContext,
  field: ProviderAppConfigLogicalField,
  configuredKeys: ReadonlySet<string>
): Promise<boolean> {
  if (configuredKeys.has(field.logicalKey)) {
    return true;
  }
  return Boolean(field.envAlias && ctx.isEnvAliasSatisfied(field.envAlias));
}

// ---------------------------------------------------------------------------
// GET /_ref/provider-app-config
// ---------------------------------------------------------------------------

async function projectGroupResponse(
  ctx: MountRefProviderAppConfigContext,
  descriptor: ProviderIdentityGroupDescriptor
): Promise<Record<string, unknown>> {
  const store = ctx.createRequestProviderAppConfigStore();
  const configuredKeys = new Set(await store.listConfiguredKeys(descriptor.identityGroup));
  const logicalKeys = await Promise.all(
    descriptor.fields.map(async (field) => ({
      configured: await fieldIsAlreadyConfigured(ctx, field, configuredKeys),
      label: field.label,
      logical_key: field.logicalKey,
      secret: field.secret,
    }))
  );
  return {
    // The opaque identity_group token itself is returned as a hidden
    // addressing value (so the client can make the matching POST call) —
    // never rendered as UI copy. `provider_identity_label` is the only
    // group-level display-safe text.
    identity_group: descriptor.identityGroup,
    logical_keys: logicalKeys,
    object: "provider_app_config_group",
    provider_identity_label: descriptor.providerIdentityLabel,
  };
}

export function mountRefProviderAppConfigGet(app: AppLike, ctx: MountRefProviderAppConfigContext): void {
  app.get("/_ref/provider-app-config", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const identityGroup = requestedIdentityGroup(req);
      if (!identityGroup) {
        const descriptors = await ctx.listProviderIdentityGroups();
        const groups = await Promise.all(descriptors.map((descriptor) => projectGroupResponse(ctx, descriptor)));
        res.status(200).json({ groups, object: "provider_app_config_list" });
        return;
      }
      const descriptor = await ctx.resolveProviderIdentityGroup(identityGroup);
      if (!descriptor) {
        ctx.pdppError(res, 404, "not_found", `No connector declares provider_identity_group '${identityGroup}'.`);
        return;
      }
      res.status(200).json(await projectGroupResponse(ctx, descriptor));
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}

// ---------------------------------------------------------------------------
// POST /_ref/provider-app-config
// ---------------------------------------------------------------------------

function parseValuesBody(body: unknown): { identityGroup: string; values: Record<string, string> } | null {
  if (!isPlainObject(body)) {
    return null;
  }
  const identityGroup = typeof body.identity_group === "string" ? body.identity_group.trim() : "";
  if (!(identityGroup && isPlainObject(body.values))) {
    return null;
  }
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.values)) {
    if (typeof value === "string" && value.trim()) {
      values[key] = value.trim();
    }
  }
  return { identityGroup, values };
}

function unknownLogicalKeys(
  values: Readonly<Record<string, string>>,
  fieldsByKey: ReadonlyMap<string, ProviderAppConfigLogicalField>
): readonly string[] {
  return Object.keys(values).filter((key) => !fieldsByKey.has(key));
}

/** Every declared field with no submitted value and no existing
 * configuration (store or env) — required on first setup, but may be
 * omitted once configured. Checked concurrently: no field's check depends
 * on another's outcome. */
async function missingRequiredLogicalKeys(
  ctx: MountRefProviderAppConfigContext,
  descriptor: ProviderIdentityGroupDescriptor,
  values: Readonly<Record<string, string>>,
  configuredKeys: ReadonlySet<string>
): Promise<readonly string[]> {
  const unresolved = descriptor.fields.filter((field) => !values[field.logicalKey]);
  const alreadyConfigured = await Promise.all(
    unresolved.map((field) => fieldIsAlreadyConfigured(ctx, field, configuredKeys))
  );
  return unresolved.filter((_field, index) => !alreadyConfigured[index]).map((field) => field.logicalKey);
}

async function validatedPostRequest(
  ctx: MountRefProviderAppConfigContext,
  res: RouteResponse,
  req: RouteRequest
): Promise<{ identityGroup: string; values: Readonly<Record<string, string>> } | "rejected"> {
  const parsed = parseValuesBody(req.body);
  if (!parsed) {
    ctx.pdppError(
      res,
      400,
      "provider_app_config_body_invalid",
      "Body must be { identity_group: string, values: Record<string, string> }."
    );
    return "rejected";
  }
  const { identityGroup, values } = parsed;

  const descriptor = await ctx.resolveProviderIdentityGroup(identityGroup);
  if (!descriptor) {
    ctx.pdppError(res, 404, "not_found", `No connector declares provider_identity_group '${identityGroup}'.`);
    return "rejected";
  }
  const fieldsByKey = new Map(descriptor.fields.map((field) => [field.logicalKey, field]));

  // Validate ALL keys before any write.
  const unknownKeys = unknownLogicalKeys(values, fieldsByKey);
  if (unknownKeys.length > 0) {
    ctx.pdppError(
      res,
      400,
      "provider_app_config_unknown_key",
      `Unrecognized logical key(s) for group '${identityGroup}': ${unknownKeys.join(", ")}.`
    );
    return "rejected";
  }

  // Require every currently-missing declared key on first setup;
  // already-configured (store or env-satisfied) fields may be omitted.
  const store = ctx.createRequestProviderAppConfigStore();
  const configuredKeys = new Set(await store.listConfiguredKeys(identityGroup));
  const missingRequired = await missingRequiredLogicalKeys(ctx, descriptor, values, configuredKeys);
  if (missingRequired.length > 0) {
    ctx.pdppError(
      res,
      400,
      "provider_app_config_missing_required",
      `Group '${identityGroup}' is missing required field(s) on first setup: ${missingRequired.join(", ")}.`
    );
    return "rejected";
  }

  return { identityGroup, values };
}

export function mountRefProviderAppConfigPost(app: AppLike, ctx: MountRefProviderAppConfigContext): void {
  app.post("/_ref/provider-app-config", ctx.requireOwnerSession, async (req: RouteRequest, res: RouteResponse) => {
    try {
      const validated = await validatedPostRequest(ctx, res, req);
      if (validated === "rejected") {
        return;
      }
      const { identityGroup, values } = validated;

      if (Object.keys(values).length === 0) {
        // Nothing to write (every declared field was already configured
        // and none were sent) — a no-op success, not an error.
        res.status(200).json({ identity_group: identityGroup, object: "provider_app_config_update", written: [] });
        return;
      }

      const now = ctx.now ? ctx.now() : new Date().toISOString();
      // One atomic write for every value in this request — never a loop of
      // individual sets, so a mid-write failure can't leave the group
      // half-configured.
      const store = ctx.createRequestProviderAppConfigStore();
      await store.setMany({ identityGroup, updatedAt: now, values });

      res.status(200).json({
        identity_group: identityGroup,
        object: "provider_app_config_update",
        written: Object.keys(values),
      });
    } catch (err) {
      ctx.handleError(res, err);
    }
  });
}
