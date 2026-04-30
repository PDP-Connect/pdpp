// Thin, boring URL / body builders used by the CLI, dashboard, tests, and
// future agent-facing tooling.
//
// These helpers intentionally accept loose, JSON-ish inputs (the CLI
// ultimately feeds them from argv / interactive prompts), normalize them,
// and emit a stable shape that matches the `@pdpp/reference-contract`
// request schemas. They do not validate — validation happens at the HTTP
// boundary via the schemas in `src/validate.ts` (AJV).

// The input surface is deliberately permissive: callers pass whatever they
// have (often `unknown` from JSON) and we coerce. `PrimitiveValue` captures
// every scalar we accept as a form-urlencoded value source; anything outside
// this set is either an array (handled separately) or ignored.
type PrimitiveValue = string | number | boolean | null | undefined;

type ObjectLike = Record<string, unknown>;

function isPrimitive(value: unknown): value is PrimitiveValue {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

function isPlainObject(value: unknown): value is ObjectLike {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isPresent(value: unknown): boolean {
  return value !== undefined && value !== null && value !== "";
}

function normalizeStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return values
    .flatMap((entry) => String(entry ?? "").split(","))
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compactObject<T extends ObjectLike>(input: T): ObjectLike {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => isPresent(value) && (!Array.isArray(value) || value.length > 0))
  );
}

export interface ExpandParamsInput {
  expand?: unknown;
  expand_limit?: unknown;
}

export interface ExpandParamsOutput {
  expand?: string[];
  expand_limit?: ObjectLike;
}

export function buildExpandParams(params: ExpandParamsInput = {}): ExpandParamsOutput {
  const expand = Array.from(new Set(normalizeStringList(params.expand)));
  const expandLimitInput = isPlainObject(params.expand_limit) ? params.expand_limit : {};
  const expand_limit = compactObject(expandLimitInput);
  return compactObject({
    expand: expand.length ? expand : undefined,
    expand_limit: Object.keys(expand_limit).length ? expand_limit : undefined,
  }) as ExpandParamsOutput;
}

export type RecordsQueryInput = ExpandParamsInput & {
  limit?: unknown;
  cursor?: unknown;
  order?: unknown;
  changes_since?: unknown;
  fields?: unknown;
  view?: unknown;
  filter?: unknown;
  connector_id?: unknown;
  subject_id?: unknown;
};

export function buildRecordsQuery(params: RecordsQueryInput = {}): ObjectLike {
  const expandParams = buildExpandParams(params);
  return compactObject({
    limit: params.limit,
    cursor: params.cursor,
    order: params.order,
    changes_since: params.changes_since,
    fields: Array.isArray(params.fields) ? params.fields.join(",") : params.fields,
    view: params.view,
    filter: isPlainObject(params.filter) ? params.filter : undefined,
    connector_id: params.connector_id,
    subject_id: params.subject_id,
    ...expandParams,
  });
}

export interface OwnerDeviceAuthorizationInput {
  client_id?: unknown;
  [key: string]: unknown;
}

export function buildOwnerDeviceAuthorizationRequest(params: OwnerDeviceAuthorizationInput = {}): URLSearchParams {
  const clientId = String(params.client_id ?? "").trim();
  if (!clientId) {
    throw new Error("client_id is required");
  }

  const form = new URLSearchParams();
  form.set("client_id", clientId);

  for (const [key, value] of Object.entries(params)) {
    if (key === "client_id" || !isPresent(value)) {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        if (isPresent(item)) {
          form.append(key, String(item));
        }
      }
      continue;
    }
    if (isPrimitive(value)) {
      form.set(key, String(value));
    }
    // Non-array objects in a form-urlencoded body are meaningless; skip.
  }

  return form;
}

export interface ParRequestInput {
  access_mode?: unknown;
  authorization_details?: unknown;
  client_display?: unknown;
  client_id?: unknown;
  purpose_code?: unknown;
  purpose_description?: unknown;
  request_context?: unknown;
  retention?: unknown;
  scenario_id?: unknown;
  source?: unknown;
  streams?: unknown;
  type?: unknown;
}

function assertNoLegacySourceKeys(input: object): void {
  if ("connector_id" in input || "provider_id" in input) {
    throw new Error(
      "buildParRequest no longer accepts top-level connector_id/provider_id; pass source: { kind: 'connector' | 'provider_native', id }"
    );
  }
}

export function buildParRequest(input: ParRequestInput = {}): ObjectLike {
  assertNoLegacySourceKeys(input);
  if (Array.isArray(input.authorization_details) && input.authorization_details.length) {
    return { ...input };
  }

  const detail = compactObject({
    type: input.type ?? "https://pdpp.org/data-access",
    source: isPlainObject(input.source) ? input.source : undefined,
    purpose_code: input.purpose_code,
    purpose_description: input.purpose_description,
    access_mode: input.access_mode,
    retention: input.retention,
    streams: Array.isArray(input.streams) ? input.streams : undefined,
  });

  return compactObject({
    client_id: input.client_id,
    client_display: input.client_display,
    scenario_id: input.scenario_id ?? (typeof input.request_context === "string" ? input.request_context : undefined),
    authorization_details: Object.keys(detail).length > 1 ? [detail] : undefined,
  });
}
