// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// Core Section 7 grant schema validator, transcribed from the normative field
// tables in `spec-core.md` "### Grant fields" and "### StreamGrant fields".
//
// Independent by construction: this reads the spec tables, not any target's
// validator. AS-3 must not use the implementation under test as its own oracle,
// and the reference implementation's `toAuthorizationDetail` projection is a
// narrower view than the grant, so neither is usable here.
//
// Input is `unknown` because the question under test is whether the artifact has
// the right shape. Returns every violation, not the first: a report naming one
// missing field per run makes a target fix them one round trip at a time.

/** A Section 7 field-table violation, quoting the table rule it breaks. */
export interface GrantSchemaViolation {
  readonly message: string;
  /** Dotted path into the artifact, e.g. `streams[0].instance_ids`. */
  readonly path: string;
}

/** This contract requires exactly this value (Section 7 `version` row). */
const REQUIRED_GRANT_VERSION = "0.1.0";
const ACCESS_MODES = new Set(["single_use", "continuous"]);
const ON_EXPIRY = new Set(["delete", "anonymize"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * The `issued_at`/`expires_at`/`max_duration`/`time_constraint` bound rows.
 *
 * Presence and string-ness only, deliberately. The Section 7 table says
 * "ISO 8601" and nothing more, and ISO 8601 admits far more than the examples
 * show: date-only (`2026-04-06`), numeric offsets, week dates, and fractional
 * duration components (`P0.5Y`) are all conforming. A hand-written pattern would
 * reject those, making the suite fail a target for a rule the spec never wrote —
 * a false conformance failure, which is worse than an unchecked row. Checking
 * against a target's own date parser is equally out: that makes the
 * implementation its own oracle. So this validator covers the table's SHAPE
 * obligations and leaves instant/duration lexical form to a normative source the
 * suite does not yet have; `docs`/AS-3 record it as a partial.
 */
function isTemporalScalar(value: unknown): boolean {
  return isNonEmptyString(value);
}

/**
 * A unique non-empty array of non-empty strings — the shape Section 7 requires
 * of `instance_ids`, `fields`, and (when present) `resources`.
 */
function stringListViolation(value: unknown, path: string, rule: string): GrantSchemaViolation | null {
  if (!Array.isArray(value)) {
    return { path, message: `${rule} Got ${JSON.stringify(value)}.` };
  }
  if (value.length === 0) {
    return { path, message: `${rule} Got an empty array.` };
  }
  if (!value.every(isNonEmptyString)) {
    return { path, message: `${rule} Got a non-string or empty-string member: ${JSON.stringify(value)}.` };
  }
  if (new Set(value).size !== value.length) {
    return { path, message: `${rule} Got duplicate members: ${JSON.stringify(value)}.` };
  }
  return null;
}

/** Exactly the listed keys, no more — the `subject`/`client`/`source` rows. */
function exactObjectViolation(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  rule: string
): GrantSchemaViolation[] {
  if (!isRecord(value)) {
    return [{ path, message: `${rule} Got ${JSON.stringify(value)}.` }];
  }
  const violations: GrantSchemaViolation[] = [];
  for (const key of required) {
    if (!isNonEmptyString(value[key])) {
      violations.push({
        path: `${path}.${key}`,
        message: `${rule} \`${key}\` is absent or not a non-empty string (got ${JSON.stringify(value[key])}).`,
      });
    }
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      violations.push({
        path: `${path}.${key}`,
        message: `${rule} \`${key}\` is not one of its permitted keys (${[...allowed].join(", ")}).`,
      });
    }
  }
  return violations;
}

const TIME_CONSTRAINT_RULE =
  "StreamGrant `time_constraint`, when present, is frozen `{ field, since?, until? }`: `field` is required and at least one bound is present.";

function timeConstraintViolations(tc: unknown, at: string): GrantSchemaViolation[] {
  if (!isRecord(tc)) {
    return [{ path: at, message: `${TIME_CONSTRAINT_RULE} Got ${JSON.stringify(tc)}.` }];
  }
  const violations: GrantSchemaViolation[] = [];
  if (!isNonEmptyString(tc.field)) {
    violations.push({ path: `${at}.field`, message: `${TIME_CONSTRAINT_RULE} \`field\` is absent.` });
  }
  if (tc.since === undefined && tc.until === undefined) {
    violations.push({ path: at, message: `${TIME_CONSTRAINT_RULE} Neither \`since\` nor \`until\` is present.` });
  }
  for (const bound of ["since", "until"] as const) {
    if (tc[bound] !== undefined && !isTemporalScalar(tc[bound])) {
      violations.push({
        path: `${at}.${bound}`,
        message: `${TIME_CONSTRAINT_RULE} \`${bound}\`, when present, is an ISO 8601 string. Got ${JSON.stringify(tc[bound])}.`,
      });
    }
  }
  return violations;
}

function streamNameViolations(name: unknown, at: string): GrantSchemaViolation[] {
  if (!isNonEmptyString(name)) {
    return [{ path: at, message: `StreamGrant \`name\` is required. Got ${JSON.stringify(name)}.` }];
  }
  if (name.includes("*")) {
    return [
      {
        path: at,
        message: `StreamGrant \`name\` is "always concrete; no wildcards in issued grants". Got ${JSON.stringify(name)}.`,
      },
    ];
  }
  return [];
}

function streamFieldsViolations(fields: unknown, at: string): GrantSchemaViolation[] {
  const shape = stringListViolation(
    fields,
    at,
    "StreamGrant `fields` is required: a unique non-empty resolved allowlist of top-level field names, authoritative for RS enforcement."
  );
  if (shape) {
    return [shape];
  }
  if ((fields as string[]).includes("*")) {
    return [
      {
        path: at,
        message: "StreamGrant `fields` must be resolved before issuance; a wildcard is not a resolved allowlist.",
      },
    ];
  }
  return [];
}

const RETENTION_RULE =
  "Section 7's `retention`, when present, is `{ max_duration, on_expiry }` with `max_duration` an ISO 8601 duration and `on_expiry` one of `delete` or `anonymize` (`archive` is not supported in v0.1).";

function retentionViolations(retention: unknown): GrantSchemaViolation[] {
  if (!isRecord(retention)) {
    return [{ path: "retention", message: `${RETENTION_RULE} Got ${JSON.stringify(retention)}.` }];
  }
  const violations: GrantSchemaViolation[] = [];
  if (!isTemporalScalar(retention.max_duration)) {
    violations.push({
      path: "retention.max_duration",
      message: `${RETENTION_RULE} \`max_duration\` is absent or not a string. Got ${JSON.stringify(retention.max_duration)}.`,
    });
  }
  if (!ON_EXPIRY.has(retention.on_expiry as string)) {
    violations.push({
      path: "retention.on_expiry",
      message: `${RETENTION_RULE} Got ${JSON.stringify(retention.on_expiry)}.`,
    });
  }
  return violations;
}

function streamViolations(stream: unknown, index: number): GrantSchemaViolation[] {
  const at = `streams[${index}]`;
  if (!isRecord(stream)) {
    return [
      {
        path: at,
        message: `Section 7 requires each \`streams\` member to be a StreamGrant object. Got ${JSON.stringify(stream)}.`,
      },
    ];
  }
  const violations: GrantSchemaViolation[] = [
    ...streamNameViolations(stream.name, `${at}.name`),
    ...streamFieldsViolations(stream.fields, `${at}.fields`),
  ];

  const instances = stringListViolation(
    stream.instance_ids,
    `${at}.instance_ids`,
    "StreamGrant `instance_ids` is required: unique non-empty opaque instance handles. Multiple handles authorize fan-in only when explicitly listed."
  );
  if (instances) {
    violations.push(instances);
  }

  if (stream.time_constraint !== undefined) {
    violations.push(...timeConstraintViolations(stream.time_constraint, `${at}.time_constraint`));
  }

  if (stream.resources !== undefined) {
    const resources = stringListViolation(
      stream.resources,
      `${at}.resources`,
      "StreamGrant `resources`, when present, is a non-empty list of authorized record IDs in canonical key string encoding; absent means all records."
    );
    if (resources) {
      violations.push(resources);
    }
  }

  return violations;
}

/**
 * Every way `artifact` departs from Section 7's grant field tables.
 *
 * Empty means conforming. Only the normative tables are checked: `purpose_code`
 * is required to be a URI-shaped non-empty string but its registry membership is
 * display-only (AS-6), and `client_claims` is deliberately NOT accepted here
 * because Section 7 requires it to stay outside the resolved grant.
 */
export function grantSchemaViolations(artifact: unknown): readonly GrantSchemaViolation[] {
  if (!isRecord(artifact)) {
    return [
      { path: "", message: `Section 7 requires the grant to be a JSON object. Got ${JSON.stringify(artifact)}.` },
    ];
  }
  const violations: GrantSchemaViolation[] = [];

  if (artifact.version !== REQUIRED_GRANT_VERSION) {
    violations.push({
      path: "version",
      message: `Section 7 requires \`version\` to be exactly "${REQUIRED_GRANT_VERSION}". Got ${JSON.stringify(artifact.version)}.`,
    });
  }
  if (!isNonEmptyString(artifact.grant_id)) {
    violations.push({
      path: "grant_id",
      message: `Section 7 requires \`grant_id\`. Got ${JSON.stringify(artifact.grant_id)}.`,
    });
  }
  if (!isTemporalScalar(artifact.issued_at)) {
    violations.push({
      path: "issued_at",
      message: `Section 7 requires \`issued_at\` as an ISO 8601 string. Got ${JSON.stringify(artifact.issued_at)}.`,
    });
  }

  violations.push(
    ...exactObjectViolation(
      artifact.subject,
      "subject",
      ["id"],
      [],
      "Section 7 requires `subject` to be exactly `{ id }`."
    )
  );
  violations.push(
    ...exactObjectViolation(
      artifact.client,
      "client",
      ["client_id"],
      ["client_display"],
      "Section 7 requires `client` to be exactly `{ client_id }` or `{ client_id, client_display }`."
    )
  );
  violations.push(
    ...exactObjectViolation(
      artifact.source,
      "source",
      ["kind", "id"],
      [],
      "Section 7 requires `source` to be exactly `{ kind, id }` retained from the accepted SourceDeclaration."
    )
  );
  violations.push(
    ...exactObjectViolation(
      artifact.source_declaration,
      "source_declaration",
      ["version"],
      [],
      "Section 7 requires `source_declaration` to be `{ version }` recording the opaque revision of the declaration snapshot used for consent and issuance."
    )
  );

  if (!isNonEmptyString(artifact.purpose_code)) {
    violations.push({
      path: "purpose_code",
      message: `Section 7 requires \`purpose_code\` as a URI. Got ${JSON.stringify(artifact.purpose_code)}.`,
    });
  }
  if (artifact.purpose_description !== undefined && !isNonEmptyString(artifact.purpose_description)) {
    violations.push({
      path: "purpose_description",
      message: `Section 7's optional \`purpose_description\` is a string when present. Got ${JSON.stringify(artifact.purpose_description)}.`,
    });
  }
  if (!ACCESS_MODES.has(artifact.access_mode as string)) {
    violations.push({
      path: "access_mode",
      message: `Section 7 requires \`access_mode\` to be exactly "single_use" or "continuous". Got ${JSON.stringify(artifact.access_mode)}.`,
    });
  }

  if (!Array.isArray(artifact.streams) || artifact.streams.length === 0) {
    violations.push({
      path: "streams",
      message: `Section 7 requires \`streams\` as a non-empty StreamGrant array, always expanded, no wildcards. Got ${JSON.stringify(artifact.streams)}.`,
    });
  } else {
    artifact.streams.forEach((stream, index) => {
      violations.push(...streamViolations(stream, index));
    });
    const names = artifact.streams.map((s) => (isRecord(s) ? s.name : undefined));
    if (new Set(names).size !== names.length) {
      violations.push({
        path: "streams",
        message: "Section 7 requires each stream `name` to be unique within the grant.",
      });
    }
  }

  if (artifact.selection_preset !== undefined && !isNonEmptyString(artifact.selection_preset)) {
    violations.push({
      path: "selection_preset",
      message: `Section 7's optional \`selection_preset\` is a string when present. Got ${JSON.stringify(artifact.selection_preset)}.`,
    });
  }

  if (artifact.retention !== undefined) {
    violations.push(...retentionViolations(artifact.retention));
  }

  if (artifact.expires_at !== undefined && !isTemporalScalar(artifact.expires_at)) {
    violations.push({
      path: "expires_at",
      message: `Section 7's optional \`expires_at\` is an ISO 8601 string when present; absent means no expiry. Got ${JSON.stringify(artifact.expires_at)}.`,
    });
  }

  if (artifact.client_claims !== undefined) {
    violations.push({
      path: "client_claims",
      message: "Section 7 requires `client_claims` to remain outside the resolved grant and RS enforcement context.",
    });
  }

  return violations;
}
