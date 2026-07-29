// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { loadSyncState, runConnector } from "../runtime/index.ts";
import {
  createCimdDocument,
  issueToken,
  parsePendingConsentRequestUri,
  revokeCimdClientAccessForSecurityMetadataChange,
} from "../server/auth.ts";
import { canonicalConnectorKey } from "../server/connector-key.ts";
import { getDb } from "../server/db.ts";
import { startServer } from "../server/index.ts";
import { ingestRecord } from "../server/records.ts";
import { makeDefaultAccountConnectorInstanceId } from "../server/stores/connector-instance-store.ts";

const REGEXP_1 = /Longview/;
const REGEXP_2 = /concert-recommendation profile/;
const REGEXP_3 = /top_artists/;
const REGEXP_4 = /Grant is malformed or no longer valid/;
const REGEXP_5 = /Grant is malformed or no longer valid/;
const REGEXP_6 = /Client identity/;
const REGEXP_7 = /https:\/\/pdpp\.example\.test/;
const REGEXP_8 = /Self-described app name/;
const REGEXP_9 = /Codex/;
const REGEXP_10 = /Requesting app/;
const REGEXP_11 = /authorization_details/;
const REGEXP_12 = /requires client_id/;
const REGEXP_13 = /^urn:pdpp:pending-consent:/;
const REGEXP_14 = /Unsupported request fields: code_challenge, redirect_uri, response_type/;
const REGEXP_15 = /Unsupported authorization_details type/;
const REGEXP_16 = /access_mode must be "single_use" or "continuous"/;
const REGEXP_17 = /streams must be a non-empty array/;
const REGEXP_18 = /Unsupported authorization_details fields: locations/;
const REGEXP_19 = /Unsupported stream selection fields on 'top_artists': expand/;
const REGEXP_20 = /Unknown source/;
const REGEXP_21 = /Unknown stream: not_a_real_stream/;
const REGEXP_22 = /Unknown view 'not_a_real_view' on stream 'top_artists'/;
const REGEXP_23 = /view and fields are mutually exclusive/;
const REGEXP_24 = /Unknown fields on stream 'top_artists': not_a_real_field/;
const REGEXP_25 = /fields must be a non-empty array of field names/;
const REGEXP_26 = /Unknown client_id/;
const REGEXP_27 = /malformed or no longer valid/;
const REGEXP_28 = /malformed or no longer valid/;
const REGEXP_29 = /Registered Longview/;
const REGEXP_30 = /Forged Display Name/;
const REGEXP_31 = /Updated Longview/;
const REGEXP_32 = /Persisted Forgery/;
const REGEXP_33 = /Longview/;
const REGEXP_34 = /source_binding must include only kind and id/;
const REGEXP_35 = /source_binding must include only kind and id/;
const REGEXP_36 = /source_binding must include only kind and id/;
const REGEXP_37 = /source_binding must include only kind and id/;
const REGEXP_38 = /Unknown client_id/;
const REGEXP_39 = /Unknown client_id/;
const REGEXP_40 = /Unknown client_id/;
const REGEXP_41 = /Access Denied/;
const REGEXP_42 = /malformed or no longer valid/;
const REGEXP_43 = /malformed or no longer valid/;
const REGEXP_44 = /Unknown client_id/;
const REGEXP_45 = /malformed or no longer valid/;
const REGEXP_46 = /denied the request/;
const REGEXP_47 = /malformed or no longer valid/;
const REGEXP_48 = /malformed or no longer valid/;
const REGEXP_49 = /Approve owner access/i;
const REGEXP_50 = /Unknown client_id/;
const REGEXP_51 = /Unknown client_id/;
const REGEXP_52 = /Approve owner access/i;
const REGEXP_53 = /malformed or no longer valid/;
const REGEXP_54 = /malformed or no longer valid/;
const REGEXP_55 = /Invalid initial access token/;
const REGEXP_56 = /Unsupported response_types/i;
const REGEXP_57 = /only registers public clients/i;
const REGEXP_58 = /Unsupported application_type/i;
const REGEXP_59 = /Unsupported client metadata fields: jwks_uri, scope/;
const REGEXP_60 = /redirect_uris must be a valid absolute URI/;
const REGEXP_61 = /client_uri must be a valid absolute URI/;
const REGEXP_62 = /does not support time_range/;
const REGEXP_63 = /provider_id is not allowed/;
const REGEXP_64 = /primary_key fields must exist in schema\.properties: missing_id/;
const REGEXP_65 = /view 'basic' references unknown fields: missing_value/;
const REGEXP_66 = /storage_binding is not allowed/;
const REGEXP_67 = /Unknown stream: not_a_real_stream/;
const REGEXP_68 = /Unknown stream: not_a_real_stream/;
const REGEXP_69 = /Unknown view 'not_a_real_view' on stream 'top_artists'/;
const REGEXP_70 = /Unknown view 'not_a_real_view' on stream 'top_artists'/;
const REGEXP_71 = /does not support time_range/;
const REGEXP_72 = /does not support time_range/;
const REGEXP_73 = /view and fields are mutually exclusive/;
const REGEXP_74 = /view and fields are mutually exclusive/;
const REGEXP_75 = /Unknown fields on stream 'top_artists': not_a_real_field/;
const REGEXP_76 = /Unknown fields on stream 'top_artists': not_a_real_field/;
const REGEXP_77 = /Unsupported pending request fields: redirect_uri/;
const REGEXP_78 = /Unsupported pending request fields: redirect_uri/;
const REGEXP_79 = /Unsupported pending stream selection fields on 'top_artists': expand/;
const REGEXP_80 = /Unsupported pending stream selection fields on 'top_artists': expand/;
const REGEXP_81 = /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/;
const REGEXP_82 = /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/;
const REGEXP_83 = /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/;
const REGEXP_84 = /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/;
const REGEXP_85 = /Pending consent request manifest_version '999\.0\.0' does not match current manifest version/;
const REGEXP_86 = /Access Denied/;
const REGEXP_87 = /source.*provider_native/;
const REGEXP_88 = /provider_native/;
const REGEXP_89 = /Grant is malformed or no longer valid/;
const REGEXP_90 = /Grant is malformed or no longer valid/;
const REGEXP_91 = /Grant is malformed or no longer valid/;
const REGEXP_92 = /Grant is malformed or no longer valid/;
const REGEXP_93 = /Grant is malformed or no longer valid/;
const REGEXP_94 = /Unknown connector: missing_spotify_connector/;
const REGEXP_95 = /Unknown connector: missing_spotify_connector/;
const REGEXP_96 = /Grant is malformed or no longer valid/;
const REGEXP_97 = /Grant is malformed or no longer valid/;
const REGEXP_98 = /Grant is malformed or no longer valid/;
const REGEXP_99 = /Grant is malformed or no longer valid/;
const REGEXP_100 = /Grant is malformed or no longer valid/;
const REGEXP_101 = /Grant is malformed or no longer valid/;
const REGEXP_102 = /Grant is malformed or no longer valid/;
const REGEXP_103 = /Grant is malformed or no longer valid/;
const REGEXP_104 = /Grant is malformed or no longer valid/;
const REGEXP_105 = /Grant is malformed or no longer valid/;
const REGEXP_106 = /Unknown source/;
const REGEXP_107 = /source: \{ kind/;
const REGEXP_108 = /source_binding is required/;
const REGEXP_109 = /source_binding is required/;
const REGEXP_110 = /source_binding must include only kind and id/;
const REGEXP_111 = /source_binding must include only kind and id/;
const REGEXP_112 = /source_binding\.id must match storage_binding\.connector_id/;
const REGEXP_113 = /source_binding\.id must match storage_binding\.connector_id/;
const REGEXP_114 = /provider_native/;
const REGEXP_115 = /Unknown connector: missing_spotify_connector/;
const REGEXP_116 = /Unknown connector: missing_spotify_connector/;
const REGEXP_117 = /connector_id must be a single non-empty string/;
const REGEXP_118 = /connector_id must be a single non-empty string/;
const REGEXP_119 = /connector_id must be a single non-empty string/;
const REGEXP_120 = /connector_id must be a single non-empty string/;
const REGEXP_121 = /connector_id must be a single non-empty string/;
const REGEXP_122 = /connector_id must be a single non-empty string/;
const REGEXP_123 = /Unknown connector: missing_spotify_connector/;
const REGEXP_124 = /Unknown connector: missing_spotify_connector/;
const REGEXP_125 = /Unknown connector: missing_spotify_connector/;
const REGEXP_126 = /Unknown grant: grant_missing_for_state/;
const REGEXP_127 = /Unknown grant: grant_missing_for_state/;
const REGEXP_128 = /Grant is malformed or no longer valid/;
const REGEXP_129 = /Grant is malformed or no longer valid/;
const REGEXP_130 = /Grant is malformed or no longer valid/;
const REGEXP_131 = /is not scoped to stream recently_played/;
const REGEXP_132 = /Grant is malformed or no longer valid/;
const REGEXP_133 = /Grant is malformed or no longer valid/;
const REGEXP_134 = /Grant is malformed or no longer valid/;
const REGEXP_135 = /Grant is malformed or no longer valid/;
const REGEXP_136 = /Unknown connector: missing_spotify_connector/;
const REGEXP_137 = /Unknown connector: missing_spotify_connector/;
const REGEXP_138 = /Unknown connector: missing_spotify_connector/;
const REGEXP_139 = /connector_id must be a single non-empty string/;
const REGEXP_140 = /connector_id must be a single non-empty string/;
const REGEXP_141 = /Connector manifest .* is malformed or no longer valid/;
const REGEXP_142 = /Stream 'recently_played' not in grant/;
const REGEXP_143 = /Stream 'recently_played' not in grant/;
const REGEXP_144 = /Stream 'recently_played' not in grant/;
const REGEXP_145 = /Stream 'recently_played' not in grant/;
const REGEXP_146 = /Stream 'saved_tracks' not in grant/;
const REGEXP_147 = /Stream 'saved_tracks' not in grant/;
const REGEXP_148 = /Record not found/;
const REGEXP_149 = /Record not found/;
const REGEXP_150 = /Record not found/;
const REGEXP_151 = /Record not found/;
const REGEXP_152 = /Filter on field 'popularity' not in grant/;
const REGEXP_153 = /Filter on field 'popularity' not in grant/;
const REGEXP_154 = /View includes fields not in grant: popularity/;
const REGEXP_155 = /View includes fields not in grant: popularity/;
const REGEXP_156 = /Filter on field 'popularity' not in grant/;
const REGEXP_157 = /Filter on field 'popularity' not in grant/;
const REGEXP_158 = /view and fields are mutually exclusive/;
const REGEXP_159 = /view and fields are mutually exclusive/;
const REGEXP_160 = /Stream 'not_a_stream' not found/;
const REGEXP_161 = /already been consumed/i;
const REGEXP_162 = /missing_native_storage_connector/;

const __dirname = dirname(fileURLToPath(import.meta.url));
const REFERENCE_IMPL_DIR = join(__dirname, "..");
const TEST_DCR_INITIAL_ACCESS_TOKEN = "pdpp-reference-test-initial-access-token";
// Registering the URL-shaped spotify manifest stores the catalog row, the
// connector_instances row, and records under the canonical connector key
// (Decision 1). Raw-SQL fixtures that target those rows by connector_id must
// use the canonical key, not the manifest URL, or they match zero rows.
const spotifyConnectorKey = canonicalConnectorKey("https://registry.pdpp.org/connectors/spotify");
if (spotifyConnectorKey === null) {
  throw new TypeError("canonical Spotify connector key must be present");
}
const SPOTIFY_CONNECTOR_KEY = spotifyConnectorKey;

type JsonRecord = Record<string, unknown>;

class CheckedJsonCollection extends Array<CheckedJsonValue> {
  readonly [index: number]: CheckedJsonValue;
  declare deleted: boolean;
  declare employer: string;
  declare genres: string[];
  declare id: string;

  constructor(value: unknown, description: string) {
    super();
    if (Array.isArray(value)) {
      // biome-ignore lint/suspicious/useIterableCallbackReturn: Callback intentionally performs side effects only.
      value.forEach((entry, index) => this.push(new CheckedJsonValue(entry, `${description}[${index}]`)));
    } else {
      const record = requireJsonRecord(value, description);
      if (record.deleted !== undefined) {
        requireBoolean(record.deleted, `${description}.deleted`);
      }
      if (record.employer !== undefined) {
        requireString(record.employer, `${description}.employer`);
      }
      if (record.genres !== undefined) {
        if (!Array.isArray(record.genres)) {
          throw new TypeError(`${description}.genres must be an array`);
        }
        record.genres.map((genre, index) => requireString(genre, `${description}.genres[${index}]`));
      }
      if (record.id !== undefined) {
        requireString(record.id, `${description}.id`);
      }
      Object.assign(this, record);
    }
  }
}

class CheckedJsonValue {
  private readonly raw: unknown;
  private readonly description: string;

  constructor(value: unknown, description: string) {
    this.raw = value;
    this.description = description;
  }

  get data(): CheckedJsonCollection {
    return new CheckedJsonCollection(requireJsonRecord(this.raw, this.description).data, `${this.description}.data`);
  }

  get deleted(): boolean {
    return requireBoolean(requireJsonRecord(this.raw, this.description).deleted, `${this.description}.deleted`);
  }

  get emitted_at(): string {
    return requireString(requireJsonRecord(this.raw, this.description).emitted_at, `${this.description}.emitted_at`);
  }

  get error(): ErrorResponse["error"] {
    return parseErrorResponse(this.raw).error;
  }

  get id(): string {
    return requireString(requireJsonRecord(this.raw, this.description).id, `${this.description}.id`);
  }

  get name(): string {
    return requireString(requireJsonRecord(this.raw, this.description).name, `${this.description}.name`);
  }

  get next_changes_since(): string {
    return requireString(
      requireJsonRecord(this.raw, this.description).next_changes_since,
      `${this.description}.next_changes_since`
    );
  }

  get next_cursor(): string {
    return requireString(requireJsonRecord(this.raw, this.description).next_cursor, `${this.description}.next_cursor`);
  }

  get object(): string {
    return requireString(requireJsonRecord(this.raw, this.description).object, `${this.description}.object`);
  }

  get record_count(): number {
    const value = requireJsonRecord(this.raw, this.description).record_count;
    if (typeof value !== "number") {
      throw new TypeError(`${this.description}.record_count must be a number`);
    }
    return value;
  }

  get state(): JsonRecord {
    return requireJsonRecord(requireJsonRecord(this.raw, this.description).state, `${this.description}.state`);
  }

  get updated_at(): string {
    return requireString(requireJsonRecord(this.raw, this.description).updated_at, `${this.description}.updated_at`);
  }

  unwrap(): unknown {
    return this.raw;
  }
}

interface ApprovedGrant {
  access_mode: string;
  client: {
    client_display: {
      name: string;
      uri: string | null | undefined;
    };
    client_id: string;
    registration_mode: string;
  };
  grant_id: string;
  retention: { max_duration: string } | null | undefined;
  source: JsonRecord;
  streams: JsonRecord[];
}

interface ApprovedGrantResponse {
  grant: ApprovedGrant;
  grant_id: string;
  token: string;
}

interface FetchJsonResult<T> {
  body: T;
  headers: Record<string, string>;
  status: number;
}

interface ParSuccessResponse {
  request_uri: string;
}

interface DynamicRegistrationResponse {
  client_id: string;
  client_name: string;
  token_endpoint_auth_method: string;
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    request_id: string | null | undefined;
  };
}

interface OAuthDeviceErrorResponse {
  error: string;
  error_description: string;
}

interface IntrospectionResponse {
  active: boolean;
  grant?:
    | {
        source: SourceDescriptor | null | undefined;
      }
    | undefined;
  inactive_reason: string | null | undefined;
}

interface StoredBatchPendingRequest {
  entries: Array<{
    source_binding: SourceDescriptor;
  }>;
  request_kind: string;
}

interface PersistedPendingConsentRequest extends JsonRecord {
  client: JsonRecord;
  selection: JsonRecord;
  source_binding: JsonRecord;
  storage_binding: JsonRecord;
}

interface SourceDescriptor {
  id: string;
  kind: string;
}

interface TraceEventError {
  code: string | null | undefined;
  message: string | null | undefined;
}

interface TraceEventData extends JsonRecord {
  auth_gate: boolean | undefined;
  error: TraceEventError | undefined;
  issuance_path: string | null | undefined;
  query_shape: string | null | undefined;
  source: SourceDescriptor | null | undefined;
  [key: string]: unknown;
}

interface ReferenceTraceEvent extends JsonRecord {
  client_id: string | null;
  data: TraceEventData;
  event_type: string;
  object_id: string;
  object_type: string;
  request_id: string | null;
  status: string;
  stream_id: string | null;
  trace_id: string;
}

interface ReferenceTraceResponse {
  data: ReferenceTraceEvent[];
}

interface GrantTimelineResponse extends ReferenceTraceResponse {
  trace_id: string;
}

interface ConnectorManifest extends JsonRecord {
  connector_id: string;
}

interface NativeManifest extends JsonRecord {
  provider_id: string;
  storage_binding: {
    connector_id: string;
  };
  streams: Array<{
    consent_time_field: string;
    name: string;
    primary_key: string;
    semantics: string;
  }>;
}

interface ResourceRecord extends JsonRecord {
  data: JsonRecord;
  emitted_at: string;
  id: string;
}

interface ResourceRecordListResponse {
  data: ResourceRecord[];
}

interface ResourceRecordPageResponse extends ResourceRecordListResponse {
  has_more: boolean;
  next_changes_since: string | null | undefined;
  next_cursor: string | null | undefined;
  object: string;
}

interface ResourceRecordDetailResponse extends ResourceRecord {}

interface ResourceStreamSummary extends JsonRecord {
  last_updated: string | null;
  name: string;
  record_count: number;
}

interface ResourceStreamListResponse {
  data: ResourceStreamSummary[];
}

interface ResourceStreamMetadataResponse extends JsonRecord {
  consent_time_field: string;
  name: string;
  object: string;
  primary_key: string[];
  schema: { properties: JsonRecord; required: string[] };
  semantics: string;
  views: Array<{ id: string }>;
}

interface Harness {
  asUrl: string;
  rsUrl: string;
  spotifyManifest: ConnectorManifest;
}

interface NativeHarness {
  asUrl: string;
  nativeManifest: NativeManifest;
  rsUrl: string;
}

interface GrantRequestParams {
  access_mode: string;
  client_display?: string | { name: string; uri?: string };
  client_id: string;
  connector_id?: string;
  provider_id?: string;
  purpose_code: string;
  purpose_description: string;
  retention?: unknown;
  source?: JsonRecord;
  streams: unknown;
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasCloseAllConnections(value: unknown): value is { closeAllConnections: () => void } {
  return isJsonRecord(value) && typeof value.closeAllConnections === "function";
}

function requireJsonRecord(value: unknown, description: string): JsonRecord {
  if (value instanceof CheckedJsonValue) {
    return requireJsonRecord(value.unwrap(), description);
  }
  if (!isJsonRecord(value)) {
    throw new TypeError(`${description} must be an object`);
  }
  return value;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string") {
    throw new TypeError(`${description} must be a string`);
  }
  return value;
}

function optionalString(value: unknown, description: string): string | null | undefined {
  return value === undefined || value === null ? value : requireString(value, description);
}

function requireNullableString(value: unknown, description: string): string | null {
  return value === null ? null : requireString(value, description);
}

function requireBoolean(value: unknown, description: string): boolean {
  if (typeof value !== "boolean") {
    throw new TypeError(`${description} must be a boolean`);
  }
  return value;
}

function optionalBoolean(value: unknown, description: string): boolean | undefined {
  if (value === undefined) {
    return;
  }
  if (typeof value !== "boolean") {
    throw new TypeError(`${description} must be a boolean`);
  }
  return value;
}

function requireJsonRecordArray(value: unknown, description: string): JsonRecord[] {
  if (!(Array.isArray(value) && value.every(isJsonRecord))) {
    throw new TypeError(`${description} must be an object array`);
  }
  return value;
}

function parseApprovedGrantResponse(value: unknown): ApprovedGrantResponse {
  const body = requireJsonRecord(value, "consent approval response");
  const grant = requireJsonRecord(body.grant, "consent approval response.grant");
  const client = requireJsonRecord(grant.client, "consent approval response.grant.client");
  const clientDisplay = requireJsonRecord(
    client.client_display,
    "consent approval response.grant.client.client_display"
  );
  const retention =
    grant.retention === null || grant.retention === undefined
      ? null
      : requireJsonRecord(grant.retention, "consent approval response.grant.retention");

  return {
    grant: {
      access_mode: requireString(grant.access_mode, "consent approval response.grant.access_mode"),
      client: {
        client_display: {
          name: requireString(clientDisplay.name, "consent approval response.grant.client.client_display.name"),
          uri: optionalString(clientDisplay.uri, "consent approval response.grant.client.client_display.uri"),
        },
        client_id: requireString(client.client_id, "consent approval response.grant.client.client_id"),
        registration_mode: requireString(
          client.registration_mode,
          "consent approval response.grant.client.registration_mode"
        ),
      },
      grant_id: requireString(grant.grant_id, "consent approval response.grant.grant_id"),
      retention:
        retention === null
          ? null
          : {
              max_duration: requireString(
                retention.max_duration,
                "consent approval response.grant.retention.max_duration"
              ),
            },
      source: requireJsonRecord(grant.source, "consent approval response.grant.source"),
      streams: requireJsonRecordArray(grant.streams, "consent approval response.grant.streams"),
    },
    grant_id: requireString(body.grant_id, "consent approval response.grant_id"),
    token: requireString(body.token, "consent approval response.token"),
  };
}

function parseDeviceAuthorizationResponse(value: unknown): { device_code: string; user_code: string } {
  const body = requireJsonRecord(value, "device authorization response");
  return {
    device_code: requireString(body.device_code, "device authorization response.device_code"),
    user_code: requireString(body.user_code, "device authorization response.user_code"),
  };
}

function parseTokenResponse(value: unknown): { access_token: string } {
  const body = requireJsonRecord(value, "token response");
  return { access_token: requireString(body.access_token, "token response.access_token") };
}

function parseParSuccessResponse(value: unknown): ParSuccessResponse {
  const body = requireJsonRecord(value, "PAR success response");
  return { request_uri: requireString(body.request_uri, "PAR success response.request_uri") };
}

function parseDynamicRegistrationResponse(value: unknown): DynamicRegistrationResponse {
  const body = requireJsonRecord(value, "dynamic registration response");
  return {
    client_id: requireString(body.client_id, "dynamic registration response.client_id"),
    client_name: requireString(body.client_name, "dynamic registration response.client_name"),
    token_endpoint_auth_method: requireString(
      body.token_endpoint_auth_method,
      "dynamic registration response.token_endpoint_auth_method"
    ),
  };
}

function parseErrorResponse(value: unknown): ErrorResponse {
  const body = requireJsonRecord(value, "error response");
  const error = requireJsonRecord(body.error, "error response.error");
  return {
    error: {
      code: requireString(error.code, "error response.error.code"),
      message: requireString(error.message, "error response.error.message"),
      request_id: optionalString(error.request_id, "error response.error.request_id"),
    },
  };
}

function parseOAuthDeviceErrorResponse(value: unknown): OAuthDeviceErrorResponse {
  const body = requireJsonRecord(value, "OAuth device error response");
  return {
    error: requireString(body.error, "OAuth device error response.error"),
    error_description: requireString(body.error_description, "OAuth device error response.error_description"),
  };
}

function parseIntrospectionResponse(value: unknown): IntrospectionResponse {
  const body = requireJsonRecord(value, "introspection response");
  const grant =
    body.grant === undefined || body.grant === null
      ? undefined
      : requireJsonRecord(body.grant, "introspection response.grant");
  return {
    active: requireBoolean(body.active, "introspection response.active"),
    inactive_reason: optionalString(body.inactive_reason, "introspection response.inactive_reason"),
    ...(grant === undefined
      ? {}
      : { grant: { source: optionalSourceDescriptor(grant.source, "introspection response.grant.source") } }),
  };
}

function parseStoredBatchPendingRequest(value: unknown): StoredBatchPendingRequest {
  const request = requireJsonRecord(value, "stored batch pending request");
  const entries = requireJsonRecordArray(request.entries, "stored batch pending request.entries");
  return {
    entries: entries.map((entry, index) => ({
      source_binding: parseSourceDescriptor(
        entry.source_binding,
        `stored batch pending request.entries[${index}].source_binding`
      ),
    })),
    request_kind: requireString(request.request_kind, "stored batch pending request.request_kind"),
  };
}

function parsePersistedPendingConsentRequest(value: unknown): PersistedPendingConsentRequest {
  const request = requireJsonRecord(value, "pending consent params_json");
  return {
    ...request,
    client: requireJsonRecord(request.client, "pending consent params_json.client"),
    selection: requireJsonRecord(request.selection, "pending consent params_json.selection"),
    source_binding: requireJsonRecord(request.source_binding, "pending consent params_json.source_binding"),
    storage_binding: requireJsonRecord(request.storage_binding, "pending consent params_json.storage_binding"),
  };
}

function parseSourceDescriptor(value: unknown, description: string): SourceDescriptor {
  const source = requireJsonRecord(value, description);
  return {
    id: requireString(source.id, `${description}.id`),
    kind: requireString(source.kind, `${description}.kind`),
  };
}

function optionalSourceDescriptor(value: unknown, description: string): SourceDescriptor | null | undefined {
  return value === undefined || value === null ? value : parseSourceDescriptor(value, description);
}

function parseTraceEventError(value: unknown, description: string): TraceEventError {
  const error = requireJsonRecord(value, description);
  return {
    code: optionalString(error.code, `${description}.code`),
    message: optionalString(error.message, `${description}.message`),
  };
}

function parseTraceEventData(value: unknown, description: string): TraceEventData {
  const data = requireJsonRecord(value, description);
  return {
    ...data,
    auth_gate: optionalBoolean(data.auth_gate, `${description}.auth_gate`),
    error: data.error === undefined ? undefined : parseTraceEventError(data.error, `${description}.error`),
    issuance_path: optionalString(data.issuance_path, `${description}.issuance_path`),
    query_shape: optionalString(data.query_shape, `${description}.query_shape`),
    source: optionalSourceDescriptor(data.source, `${description}.source`),
  };
}

function parseReferenceTraceEvent(value: unknown, description: string): ReferenceTraceEvent {
  const event = requireJsonRecord(value, description);
  return {
    ...event,
    client_id: requireNullableString(event.client_id, `${description}.client_id`),
    data: parseTraceEventData(event.data, `${description}.data`),
    event_type: requireString(event.event_type, `${description}.event_type`),
    object_id: requireString(event.object_id, `${description}.object_id`),
    object_type: requireString(event.object_type, `${description}.object_type`),
    request_id: requireNullableString(event.request_id, `${description}.request_id`),
    status: requireString(event.status, `${description}.status`),
    stream_id: requireNullableString(event.stream_id, `${description}.stream_id`),
    trace_id: requireString(event.trace_id, `${description}.trace_id`),
  };
}

function parseReferenceTraceResponse(value: unknown): ReferenceTraceResponse {
  const body = requireJsonRecord(value, "reference trace response");
  const data = requireJsonRecordArray(body.data, "reference trace response.data");
  return {
    data: data.map((event, index) => parseReferenceTraceEvent(event, `reference trace response.data[${index}]`)),
  };
}

function parseGrantTimelineResponse(value: unknown): GrantTimelineResponse {
  const body = requireJsonRecord(value, "grant timeline response");
  const trace = parseReferenceTraceResponse(body);
  return {
    ...trace,
    trace_id: requireString(body.trace_id, "grant timeline response.trace_id"),
  };
}

function parseResourceRecord(value: unknown, description: string): ResourceRecord {
  const record = requireJsonRecord(value, description);
  return {
    ...record,
    data: requireJsonRecord(record.data, `${description}.data`),
    emitted_at: requireString(record.emitted_at, `${description}.emitted_at`),
    id: requireString(record.id, `${description}.id`),
  };
}

function parseResourceRecordListResponse(value: unknown): ResourceRecordListResponse {
  const body = requireJsonRecord(value, "resource record-list response");
  const data = requireJsonRecordArray(body.data, "resource record-list response.data");
  return {
    data: data.map((record, index) => parseResourceRecord(record, `resource record-list response.data[${index}]`)),
  };
}

function parseResourceRecordPageResponse(value: unknown): ResourceRecordPageResponse {
  const body = requireJsonRecord(value, "resource record page response");
  const list = parseResourceRecordListResponse(body);
  return {
    ...list,
    has_more: requireBoolean(body.has_more, "resource record page response.has_more"),
    next_changes_since: optionalString(body.next_changes_since, "resource record page response.next_changes_since"),
    next_cursor: optionalString(body.next_cursor, "resource record page response.next_cursor"),
    object: requireString(body.object, "resource record page response.object"),
  };
}

function parseResourceRecordDetailResponse(value: unknown): ResourceRecordDetailResponse {
  return parseResourceRecord(value, "resource record-detail response");
}

function parseResourceStreamListResponse(value: unknown): ResourceStreamListResponse {
  const body = requireJsonRecord(value, "resource stream-list response");
  const data = requireJsonRecordArray(body.data, "resource stream-list response.data");
  return {
    data: data.map((stream, index) => ({
      ...stream,
      last_updated: requireNullableString(
        stream.last_updated,
        `resource stream-list response.data[${index}].last_updated`
      ),
      name: requireString(stream.name, `resource stream-list response.data[${index}].name`),
      record_count:
        typeof stream.record_count === "number"
          ? stream.record_count
          : (() => {
              throw new TypeError(`resource stream-list response.data[${index}].record_count must be a number`);
            })(),
    })),
  };
}

function parseResourceStreamMetadataResponse(value: unknown): ResourceStreamMetadataResponse {
  const body = requireJsonRecord(value, "resource stream-metadata response");
  const views = requireJsonRecordArray(body.views, "resource stream-metadata response.views");
  return {
    ...body,
    consent_time_field: requireString(body.consent_time_field, "resource stream-metadata response.consent_time_field"),
    name: requireString(body.name, "resource stream-metadata response.name"),
    object: requireString(body.object, "resource stream-metadata response.object"),
    primary_key: (() => {
      if (!Array.isArray(body.primary_key)) {
        throw new TypeError("resource stream-metadata response.primary_key must be an array");
      }
      return body.primary_key.map((field, index) =>
        requireString(field, `resource stream-metadata response.primary_key[${index}]`)
      );
    })(),
    schema: {
      properties: requireJsonRecord(
        requireJsonRecord(body.schema, "resource stream-metadata response.schema").properties,
        "resource stream-metadata response.schema.properties"
      ),
      required: (() => {
        // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
        const required = requireJsonRecord(body.schema, "resource stream-metadata response.schema").required;
        if (!Array.isArray(required)) {
          throw new TypeError("resource stream-metadata response.schema.required must be an array");
        }
        return required.map((field, index) =>
          requireString(field, `resource stream-metadata response.schema.required[${index}]`)
        );
      })(),
    },
    semantics: requireString(body.semantics, "resource stream-metadata response.semantics"),
    views: views.map((view, index) => ({
      id: requireString(view.id, `resource stream-metadata response.views[${index}].id`),
    })),
  };
}

function parseMcpInitializeResponse(value: unknown): { result: { serverInfo: { name: string } } } {
  const body = requireJsonRecord(value, "MCP initialize response");
  const result = requireJsonRecord(body.result, "MCP initialize response.result");
  const serverInfo = requireJsonRecord(result.serverInfo, "MCP initialize response.result.serverInfo");
  return {
    result: { serverInfo: { name: requireString(serverInfo.name, "MCP initialize response.result.serverInfo.name") } },
  };
}

function parseMcpToolsResponse(value: unknown): { result: { tools: Array<{ name: string }> } } {
  const body = requireJsonRecord(value, "MCP tools response");
  const result = requireJsonRecord(body.result, "MCP tools response.result");
  const tools = requireJsonRecordArray(result.tools, "MCP tools response.result.tools");
  return {
    result: {
      tools: tools.map((tool, index) => ({
        name: requireString(tool.name, `MCP tools response.result.tools[${index}].name`),
      })),
    },
  };
}

function parseIngestResponse(value: unknown): { records_accepted: number; records_rejected: number } {
  const body = requireJsonRecord(value, "ingest response");
  const accepted = body.records_accepted;
  const rejected = body.records_rejected;
  if (typeof accepted !== "number" || typeof rejected !== "number") {
    throw new TypeError("ingest response record counts must be numbers");
  }
  return { records_accepted: accepted, records_rejected: rejected };
}

function requireRetention(retention: ApprovedGrant["retention"]): { max_duration: string } {
  if (retention === null || retention === undefined) {
    throw new TypeError("grant retention must be present for this assertion");
  }
  return retention;
}

function requireFirst<T>(values: readonly T[], description: string): T {
  // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
  const first = values[0];
  if (first === undefined) {
    throw new TypeError(`${description} must not be empty`);
  }
  return first;
}

function requireAt<T>(values: readonly T[], index: number, description: string): T {
  const value = values[index];
  if (value === undefined) {
    throw new TypeError(`${description}[${index}] must be present`);
  }
  return value;
}

async function closeServer(server: Awaited<ReturnType<typeof startServer>>): Promise<void> {
  // Force-close keep-alive connections to prevent hanging.
  // Clear fallback timers when close callbacks win so the harness does not
  // retain stray timer handles after an otherwise clean shutdown.
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }

  const closeWithTimeout = (srv: typeof server.asServer): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        resolve();
      }, 2000);

      srv.close(() => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        resolve();
      });
    });

  await Promise.allSettled([closeWithTimeout(server.asServer), closeWithTimeout(server.rsServer)]);
}

async function fetchJson(url: string, opts: RequestInit = {}) {
  const resp = await fetch(url, opts);
  const body = new CheckedJsonValue(await resp.json(), `JSON response from ${url}`);
  return {
    body,
    headers: Object.fromEntries(resp.headers.entries()),
    status: resp.status,
  };
}

async function fetchReferenceTrace(asUrl: string, traceId: unknown): Promise<FetchJsonResult<ReferenceTraceResponse>> {
  const response = await fetchJson(
    `${asUrl}/_ref/traces/${encodeURIComponent(requireString(traceId, "reference trace id"))}`
  );
  return { ...response, body: parseReferenceTraceResponse(response.body) };
}

async function fetchGrantTimeline(asUrl: string, grantId: unknown): Promise<FetchJsonResult<GrantTimelineResponse>> {
  const response = await fetchJson(
    `${asUrl}/_ref/grants/${encodeURIComponent(requireString(grantId, "grant id"))}/timeline`
  );
  return { ...response, body: parseGrantTimelineResponse(response.body) };
}

async function postMcpJson(rsUrl: string, token: string, message: JsonRecord) {
  const resp = await fetch(`${rsUrl}/mcp`, {
    body: JSON.stringify(message),
    headers: {
      Accept: "application/json, text/event-stream",
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  return { body: await resp.json(), status: resp.status };
}

async function withHarness(fn: (harness: Harness) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;
  const spotifyManifest: ConnectorManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8")
  );

  try {
    await fetchJson(`${asUrl}/connectors`, {
      body: JSON.stringify(spotifyManifest),
      headers: { "Content-Type": "application/json" },
      method: "POST",
    });

    await fn({ asUrl, rsUrl, spotifyManifest });
  } finally {
    await closeServer(server);
  }
}

async function withNativeHarness(fn: (harness: NativeHarness) => Promise<void>): Promise<void> {
  const nativeManifest: NativeManifest = JSON.parse(
    readFileSync(join(REFERENCE_IMPL_DIR, "manifests/northstar-hr.json"), "utf8")
  );
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    nativeManifest,
    quiet: true,
    rsPort: 0,
  });
  const asUrl = `http://localhost:${server.asPort}`;
  const rsUrl = `http://localhost:${server.rsPort}`;

  try {
    await fn({ asUrl, nativeManifest, rsUrl });
  } finally {
    await closeServer(server);
  }
}

function createTempDbPath() {
  const dir = mkdtempSync(join(tmpdir(), "pdpp-auth-db-"));
  return {
    cleanup: () => rmSync(dir, { force: true, recursive: true }),
    dbPath: join(dir, "pdpp.sqlite"),
  };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function startGrantRequestRaw(asUrl: string, params: GrantRequestParams) {
  return fetchJson(`${asUrl}/oauth/par`, {
    body: JSON.stringify({
      authorization_details: [
        {
          access_mode: params.access_mode,
          purpose_code: params.purpose_code,
          purpose_description: params.purpose_description,
          retention: params.retention,
          source:
            params.source ||
            (params.provider_id
              ? { id: params.provider_id, kind: "provider_native" }
              : { id: params.connector_id, kind: "connector" }),
          streams: params.streams,
          type: "https://pdpp.org/data-access",
        },
      ],
      client_display: params.client_display,
      client_id: params.client_id,
    }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function startGrantRequest(
  asUrl: string,
  params: GrantRequestParams
): Promise<FetchJsonResult<ParSuccessResponse>> {
  const response = await startGrantRequestRaw(asUrl, params);
  return { ...response, body: parseParSuccessResponse(response.body) };
}

async function startGrantRequestRejection(
  asUrl: string,
  params: GrantRequestParams
): Promise<FetchJsonResult<ErrorResponse>> {
  const response = await startGrantRequestRaw(asUrl, params);
  return { ...response, body: parseErrorResponse(response.body) };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function approveGrantRequest(asUrl: string, requestUri: string, subjectId: string, extra: JsonRecord = {}) {
  return fetchJson(`${asUrl}/consent/approve`, {
    body: JSON.stringify({ request_uri: requestUri, subject_id: subjectId, ...extra }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
}

async function approveGrantSuccess(
  asUrl: string,
  requestUri: string,
  subjectId: string
): Promise<FetchJsonResult<ApprovedGrantResponse>> {
  const response = await approveGrantRequest(asUrl, requestUri, subjectId);
  return { ...response, body: parseApprovedGrantResponse(response.body) };
}

async function approveGrantRejection(
  asUrl: string,
  requestUri: string,
  subjectId: string
): Promise<FetchJsonResult<ErrorResponse>> {
  const response = await approveGrantRequest(asUrl, requestUri, subjectId);
  return { ...response, body: parseErrorResponse(response.body) };
}

async function fetchConsentRejection(asUrl: string, requestUri: string): Promise<FetchJsonResult<ErrorResponse>> {
  const response = await fetchJson(`${asUrl}/consent?request_uri=${encodeURIComponent(requestUri)}`);
  return { ...response, body: parseErrorResponse(response.body) };
}

async function startOwnerDeviceAuthorization(
  asUrl: string,
  clientId: string
): Promise<FetchJsonResult<{ device_code: string; user_code: string }>> {
  const response = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return { ...response, body: parseDeviceAuthorizationResponse(response.body) };
}

async function introspectToken(asUrl: string, token: string): Promise<FetchJsonResult<IntrospectionResponse>> {
  const response = await fetchJson(`${asUrl}/introspect`, {
    body: JSON.stringify({ token }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return { ...response, body: parseIntrospectionResponse(response.body) };
}

async function introspectFormToken(asUrl: string, token: string): Promise<FetchJsonResult<IntrospectionResponse>> {
  const response = await fetchJson(`${asUrl}/introspect`, {
    body: new URLSearchParams({ token }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  return { ...response, body: parseIntrospectionResponse(response.body) };
}

async function denyGrantRequest(asUrl: string, requestUri: string) {
  const resp = await fetch(`${asUrl}/consent/deny`, {
    body: JSON.stringify({ request_uri: requestUri }),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  return {
    body: await resp.text(),
    headers: Object.fromEntries(resp.headers.entries()),
    status: resp.status,
  };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function mutatePendingConsentRequest(
  requestUri: string,
  mutate: (request: PersistedPendingConsentRequest) => void
): Promise<void> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should decode to a pending device code");

  const row = getDb().prepare("SELECT params_json FROM pending_consents WHERE device_code = ?").get(deviceCode);
  assert.ok(row, "pending consent row exists");

  const request = parsePersistedPendingConsentRequest(
    JSON.parse(requireString(row.params_json, "pending consent params_json"))
  );
  mutate(request);

  getDb()
    .prepare("UPDATE pending_consents SET params_json = ? WHERE device_code = ?")
    .run(JSON.stringify(request), deviceCode);
}

// Build a UPDATE SET clause dynamically from an `updates` object restricted to
// an allowlist of column names. Returns `{ setText, binds }` — the caller
// concatenates `setText` into a fixed UPDATE SQL string and passes the binds
// to `.run()` along with any trailing WHERE binds.
function buildDynamicSet(updates: JsonRecord, allowedKeys: readonly string[]): { binds: unknown[]; setText: string } {
  const parts: string[] = [];
  const binds: unknown[] = [];
  for (const key of allowedKeys) {
    if (Object.hasOwn(updates, key)) {
      parts.push(`${key} = ?`);
      binds.push(updates[key]);
    }
  }
  return { binds, setText: parts.join(", ") };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function updatePendingConsentRow(requestUri: string, updates: JsonRecord): Promise<void> {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should decode to a pending device code");

  const { setText, binds } = buildDynamicSet(updates, ["params_json", "request_id", "trace_id", "scenario_id"]);
  assert.ok(binds.length, "expected pending consent row updates");

  getDb()
    .prepare(`UPDATE pending_consents SET ${setText} WHERE device_code = ?`)
    .run(...binds, deviceCode);
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function readPendingConsentTraceContext(requestUri: string) {
  const deviceCode = parsePendingConsentRequestUri(requestUri);
  assert.ok(deviceCode, "request_uri should decode to a pending device code");

  const row = getDb()
    .prepare("SELECT request_id, trace_id, scenario_id FROM pending_consents WHERE device_code = ?")
    .get(deviceCode);
  assert.ok(row, "pending consent row exists");
  return row;
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function mutateRegisteredClient(clientId: string, mutate: (metadata: JsonRecord) => void): Promise<void> {
  const row = getDb().prepare("SELECT metadata_json FROM oauth_clients WHERE client_id = ?").get(clientId);
  assert.ok(row, "expected exactly one registered client row");

  const metadata = requireJsonRecord(
    JSON.parse(requireString(row.metadata_json, "registered client metadata_json")),
    "registered client metadata_json"
  );
  mutate(metadata);

  getDb()
    .prepare("UPDATE oauth_clients SET metadata_json = ? WHERE client_id = ?")
    .run(JSON.stringify(metadata), clientId);
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function updateRegisteredClientRow(clientId: string, updates: JsonRecord): Promise<void> {
  const { setText, binds } = buildDynamicSet(updates, ["metadata_json", "token_endpoint_auth_method"]);
  assert.ok(binds.length, "expected registered client row updates");

  getDb()
    .prepare(`UPDATE oauth_clients SET ${setText} WHERE client_id = ?`)
    .run(...binds, clientId);
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function deleteRegisteredClient(clientId: string): Promise<void> {
  getDb().prepare("DELETE FROM oauth_clients WHERE client_id = ?").run(clientId);
}

async function issueOwnerToken(asUrl: string, subjectId = "owner_local"): Promise<string> {
  const clientId = "cli_longview";
  const { body: deviceBody } = await fetchJson(`${asUrl}/oauth/device_authorization`, {
    body: new URLSearchParams({ client_id: clientId }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  const device = parseDeviceAuthorizationResponse(deviceBody);
  const approveResp = await fetch(`${asUrl}/device/approve`, {
    body: new URLSearchParams({
      subject_id: subjectId,
      user_code: device.user_code,
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });
  assert.equal(approveResp.status, 200);

  const { body: tokenBody } = await fetchJson(`${asUrl}/oauth/token`, {
    body: new URLSearchParams({
      client_id: clientId,
      device_code: device.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString(),
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    method: "POST",
  });

  return parseTokenResponse(tokenBody).access_token;
}

async function registerDynamicClient(
  asUrl: string,
  metadata: JsonRecord,
  initialAccessToken: string | null = TEST_DCR_INITIAL_ACCESS_TOKEN
): Promise<FetchJsonResult<DynamicRegistrationResponse>> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (initialAccessToken) {
    headers.Authorization = `Bearer ${initialAccessToken}`;
  }
  const response = await fetchJson(`${asUrl}/oauth/register`, {
    body: JSON.stringify(metadata),
    headers,
    method: "POST",
  });
  return { ...response, body: parseDynamicRegistrationResponse(response.body) };
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function seedSpotify(rsUrl: string, manifest: ConnectorManifest, ownerToken: string) {
  const connectorPath = join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts");
  return runConnector({
    collectionMode: "full_refresh",
    connectorId: manifest.connector_id,
    connectorPath,
    manifest,
    ownerToken,
    rsUrl,
    state: null,
  });
}

async function seedNorthstar(nativeManifest: NativeManifest): Promise<void> {
  const records = [
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        gross_pay: 5400,
        issued_at: "2026-04-16T12:00:00Z",
        net_pay: 3912,
        pay_period_end: "2026-04-15",
        pay_period_start: "2026-04-01",
        statement_id: "ps_2026_04_15",
      },
      emitted_at: "2026-04-16T12:00:00Z",
      key: "ps_2026_04_15",
      stream: "pay_statements",
    },
    {
      data: {
        currency: "USD",
        employee_id: "emp_123",
        employer: "Northstar HR",
        grant_id: "eq_2026_01_01",
        grant_type: "RSU",
        granted_at: "2026-01-01T00:00:00Z",
        quantity: 1200,
        strike_price: 0,
        vesting_end_date: "2030-01-01",
        vesting_start_date: "2026-01-01",
      },
      emitted_at: "2026-01-01T00:00:00Z",
      key: "eq_2026_01_01",
      stream: "equity_grants",
    },
    {
      data: {
        coverage_level: "employee_plus_family",
        currency: "USD",
        effective_date: "2026-01-01",
        employee_cost_monthly: 280,
        employee_id: "emp_123",
        employer: "Northstar HR",
        enrollment_id: "ben_medical_2026",
        plan_name: "Northstar PPO",
      },
      emitted_at: "2026-01-01T00:00:00Z",
      key: "ben_medical_2026",
      stream: "benefits_enrollments",
    },
  ];

  for (const record of records) {
    // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
    await ingestRecord(nativeManifest.storage_binding.connector_id, record);
  }
}

async function approveGrant(
  asUrl: string,
  subjectId: string,
  params: GrantRequestParams
): Promise<ApprovedGrantResponse> {
  const { body: initiate } = await startGrantRequest(asUrl, params);

  const initiateRequest = requireJsonRecord(initiate, "PAR response");
  const { body } = await approveGrantRequest(
    asUrl,
    requireString(initiateRequest.request_uri, "PAR response.request_uri"),
    subjectId
  );
  const approved = parseApprovedGrantResponse(body);

  return approved;
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function mutateGrantSource(grantId: string, mutate: (source: JsonRecord) => JsonRecord): Promise<void> {
  const row = getDb().prepare("SELECT grant_json FROM grants WHERE grant_id = ?").get(grantId);
  assert.ok(row, "expected exactly one persisted grant row");

  const grant = requireJsonRecord(
    JSON.parse(requireString(row.grant_json, "persisted grant_json")),
    "persisted grant_json"
  );
  grant.source = mutate(requireJsonRecord(grant.source, "persisted grant_json.source"));

  getDb().prepare("UPDATE grants SET grant_json = ? WHERE grant_id = ?").run(JSON.stringify(grant), grantId);
}

// biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
async function mutateGrantStorageBinding(
  grantId: string,
  mutate: (storageBinding: JsonRecord) => JsonRecord
): Promise<void> {
  const row = getDb().prepare("SELECT storage_binding_json FROM grants WHERE grant_id = ?").get(grantId);
  assert.ok(row, "expected exactly one persisted grant row");

  const storageBinding = requireJsonRecord(
    JSON.parse(requireString(row.storage_binding_json, "persisted storage_binding_json")),
    "persisted storage_binding_json"
  );
  getDb()
    .prepare("UPDATE grants SET storage_binding_json = ? WHERE grant_id = ?")
    .run(JSON.stringify(mutate(storageBinding)), grantId);
}

test("PDPP reference implementation integration", async (t) => {
  await t.test("pending consent survives server restart when backed by durable storage", async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));

    let server = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(spotifyManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const { body: initiate } = await startGrantRequest(asUrl, {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      assert.ok(initiate.request_uri);

      await closeServer(server);
      server = await startServer({ asPort: server.asPort, dbPath, quiet: true, rsPort: server.rsPort });

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);

      const { body: approved } = await approveGrantSuccess(asUrl, initiate.request_uri, "u1");

      assert.ok(approved.grant_id);
      assert.ok(approved.token);

      const postApprovalConsentResp = await fetch(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`
      );
      assert.equal(postApprovalConsentResp.status, 404);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test("expired pending consent is rejected consistently across display and approve paths", async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
    const server = await startServer({ asPort: 0, dbPath, quiet: true, rsPort: 0 });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(spotifyManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      const { body: initiate } = await startGrantRequest(asUrl, {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const deviceCode = parsePendingConsentRequestUri(initiate.request_uri);
      getDb()
        .prepare(`
        UPDATE pending_consents
        SET expires_at = ?
        WHERE device_code = ?
      `)
        .run(new Date(Date.now() - 1000).toISOString(), deviceCode);

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 404);

      const approveResp = await fetch(`${asUrl}/consent/approve`, {
        body: JSON.stringify({ request_uri: initiate.request_uri, subject_id: "u1" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(approveResp.status, 404);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test("authorization_details envelope requests normalize into the current pending-grant flow", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              purpose_description: "Maintain a concert-recommendation profile over time",
              retention: {
                max_duration: "P30D",
                on_expiry: "delete",
              },
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_display: {
            name: "Longview",
            policy_uri: "https://longview.example/privacy",
            tos_uri: "https://longview.example/terms",
            uri: "https://longview.example",
          },
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(initiateResp.status, 201);
      const initiate = parseParSuccessResponse(await initiateResp.json());

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, REGEXP_1);
      assert.match(consentHtml, REGEXP_2);
      assert.match(consentHtml, REGEXP_3);

      const { body: approved } = await approveGrantSuccess(asUrl, initiate.request_uri, "u1");

      assert.equal(approved.grant.client.client_id, "longview");
      assert.equal(approved.grant.client.client_display.name, "Longview");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(approved.grant.source?.kind, "connector");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(approved.grant.source?.id, SPOTIFY_CONNECTOR_KEY);
      assert.equal(approved.grant.access_mode, "continuous");
      assert.equal(requireRetention(approved.grant.retention).max_duration, "P30D");
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const approvedStream = approved.grant.streams[0];
      assert.ok(approvedStream, "approval should include the requested stream");
      assert.equal(approvedStream.name, "top_artists");
      assert.equal(approvedStream.view, "basic");
      assert.ok(approved.token);

      const grantRows = getDb()
        .prepare(`
        SELECT storage_binding_json
        FROM grants
        WHERE grant_id = ?
      `)
        .all(approved.grant.grant_id);
      assert.equal(grantRows.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const grantRow = grantRows[0];
      assert.ok(grantRow, "expected persisted grant row");
      assert.deepEqual(JSON.parse(requireString(grantRow.storage_binding_json, "persisted storage binding")), {
        connector_id: SPOTIFY_CONNECTOR_KEY,
      });
    });
  });

  await t.test(
    "polyfill persisted grant bindings with unsupported fields are rejected on introspection and revocation",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        await mutateGrantSource(approved.grant.grant_id, (source) => ({
          ...source,
          debug_context: "should_not_escape",
          storage_connector_id: "leaky_storage_connector",
        }));
        await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
          ...storageBinding,
          debug_context: "should_not_escape",
        }));

        const { body: introspection } = await introspectToken(asUrl, approved.token);
        assert.equal(introspection.active, false);
        assert.equal(introspection.inactive_reason, "grant_invalid");
        assert.ok(!("grant" in introspection), "malformed polyfill persisted grants should not be surfaced publicly");

        const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeRequestId = revokeResp.headers.get("Request-Id");
        const revokeTraceId = revokeResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(revokeRequestId?.startsWith("req_"));
        assert.ok(revokeTraceId?.startsWith("trc_"));
        const revokeBody = parseErrorResponse(await revokeResp.json());
        assert.equal(revokeBody.error.code, "grant_invalid");
        assert.match(revokeBody.error.message, REGEXP_4);

        const { body: revokedTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const revokedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoked");
        assert.equal(
          revokedEvent,
          undefined,
          "malformed polyfill persisted grants should not emit degraded grant.revoked artifacts"
        );
        const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoke_rejected");
        assert.ok(rejectedEvent, "malformed polyfill persisted grants should emit grant.revoke_rejected artifacts");
        assert.equal(rejectedEvent.request_id, revokeRequestId);
        assert.equal(rejectedEvent.trace_id, revokeTraceId);
        assert.equal(rejectedEvent.data?.error?.code, "grant_invalid");
        assert.match(rejectedEvent.data?.error?.message || "", REGEXP_5);
      });
    }
  );

  await t.test("same-origin CIMD client_id resolves local metadata document and issues a scoped token", async () => {
    const publicOrigin = "https://pdpp.example.test";
    const server = await startServer({
      asPort: 0,
      asPublicUrl: publicOrigin,
      dbPath: ":memory:",
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;
    const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));

    try {
      await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(spotifyManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      await seedSpotify(rsUrl, spotifyManifest, await issueOwnerToken(asUrl, "u1"));

      const documentId = await createCimdDocument({
        clientName: "Codex",
        redirectUris: ["http://localhost:1455/callback"],
      });
      const clientId = `${publicOrigin}/oauth/client-metadata/${documentId}`;
      const { body: initiate } = await startGrantRequest(asUrl, {
        access_mode: "single_use",
        client_id: clientId,
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Read top artists through a CIMD-identified local MCP client.",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
      assert.equal(consentResp.status, 200);
      const consentHtml = await consentResp.text();
      assert.match(consentHtml, REGEXP_6);
      assert.match(consentHtml, REGEXP_7);
      assert.match(consentHtml, REGEXP_8);
      assert.match(consentHtml, REGEXP_9);
      assert.doesNotMatch(consentHtml, REGEXP_10);

      const { body: approved } = await approveGrantSuccess(asUrl, initiate.request_uri, "u1");

      assert.equal(approved.grant.client.client_id, clientId);
      assert.equal(approved.grant.client.client_display.name, "Codex");
      assert.equal(approved.grant.client.registration_mode, "client_id_metadata_document");
      assert.ok(approved.token);

      const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientRecordsResp.status, 200);
      const clientRecords = parseResourceRecordListResponse(await clientRecordsResp.json());
      assert.equal(Array.isArray(clientRecords.data), true);
      assert.equal(clientRecords.data.length, 1);

      const initialize = await postMcpJson(rsUrl, approved.token, {
        id: 1,
        jsonrpc: "2.0",
        method: "initialize",
        params: {
          capabilities: {},
          clientInfo: { name: "cimd-test", version: "0.0.0" },
          protocolVersion: "2025-06-18",
        },
      });
      assert.equal(initialize.status, 200);
      assert.equal(parseMcpInitializeResponse(initialize.body).result.serverInfo.name, "pdpp-reference-mcp");

      const tools = await postMcpJson(rsUrl, approved.token, {
        id: 2,
        jsonrpc: "2.0",
        method: "tools/list",
        params: {},
      });
      assert.equal(tools.status, 200);
      assert.deepEqual(
        // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
        parseMcpToolsResponse(tools.body)
          .result.tools.map((tool) => tool.name)
          .sort(),
        ["aggregate", "fetch", "query_records", "read_record_field", "schema", "search"]
      );

      await Reflect.apply(revokeCimdClientAccessForSecurityMetadataChange, undefined, [
        {
          clientId,
          nextSecurityHash: "sha256-new",
          previousSecurityHash: "sha256-old",
        },
      ]);
      const { body: postChangeIntrospection } = await introspectToken(asUrl, approved.token);
      assert.equal(postChangeIntrospection.active, false);

      const badClientId = `${publicOrigin}/oauth/client-metadata/cimd_missing`;
      const failed = await startGrantRequestRejection(asUrl, {
        access_mode: "single_use",
        client_id: badClientId,
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "This request must fail before consent because the CIMD document is missing.",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });
      assert.equal(failed.status, 400);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(failed.body.error?.code, "invalid_client");
      const missingClientGrantCountRow = getDb()
        .prepare("SELECT COUNT(*) AS count FROM grants WHERE client_id = ?")
        .get<{ count: number }>(badClientId);
      assert.ok(missingClientGrantCountRow, "grant count query returns a row");
      const missingClientGrantCount = missingClientGrantCountRow.count;
      assert.equal(missingClientGrantCount, 0);
    } finally {
      await closeServer(server);
    }
  });

  await t.test(
    "polyfill malformed grant revocation preserves connector source when only storage binding drifts",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
          ...storageBinding,
          debug_context: "should_not_escape",
        }));

        const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeRequestId = revokeResp.headers.get("Request-Id");
        const revokeTraceId = revokeResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(revokeRequestId?.startsWith("req_"));
        assert.ok(revokeTraceId?.startsWith("trc_"));

        const { body: revokedTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoke_rejected");
        assert.ok(rejectedEvent, "malformed polyfill persisted grants should emit grant.revoke_rejected artifacts");
        assert.equal(rejectedEvent.request_id, revokeRequestId);
        assert.equal(rejectedEvent.trace_id, revokeTraceId);
        assert.equal(rejectedEvent.data?.source?.kind, "connector");
        assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(
          !("connector_id" in (rejectedEvent.data || {})),
          "polyfill revoke rejection should use a source descriptor instead of a raw connector_id field"
        );
        assert.ok(
          !("storage_connector_id" in (rejectedEvent.data || {})),
          "polyfill revoke rejection should not expose storage connector ids"
        );
        assert.equal(rejectedEvent.data?.error?.code, "grant_invalid");
      });
    }
  );

  await t.test("provider-connect request staging rejects malformed request envelopes", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const missingDetailsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({ client_id: "longview" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(missingDetailsResp.status, 400);
      const missingDetailsBody = parseErrorResponse(await missingDetailsResp.json());
      assert.equal(missingDetailsBody.error.code, "invalid_request");
      assert.match(missingDetailsBody.error.message, REGEXP_11);

      const missingClientResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(missingClientResp.status, 400);
      const missingClientBody = parseErrorResponse(await missingClientResp.json());
      assert.equal(missingClientBody.error.code, "invalid_request");
      assert.match(missingClientBody.error.message, REGEXP_12);

      const multiDetailsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "saved_tracks" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(multiDetailsResp.status, 201);
      assert.ok(multiDetailsResp.headers.get("PDPP-Reference-Trace-Id"));
      const multiDetailsBody = parseParSuccessResponse(await multiDetailsResp.json());
      assert.match(multiDetailsBody.request_uri, REGEXP_13);
      const multiDeviceCode = parsePendingConsentRequestUri(multiDetailsBody.request_uri);
      const multiRow = getDb()
        .prepare("SELECT params_json FROM pending_consents WHERE device_code = ?")
        .get(multiDeviceCode);
      assert.ok(multiRow, "expected stored batch pending consent");
      const multiStored = parseStoredBatchPendingRequest(
        JSON.parse(requireString(multiRow.params_json, "batch pending consent params_json"))
      );
      assert.equal(multiStored.request_kind, "pdpp_selection_request_batch");
      assert.deepEqual(
        multiStored.entries.map((entry) => entry.source_binding.id),
        [SPOTIFY_CONNECTOR_KEY, SPOTIFY_CONNECTOR_KEY]
      );

      const unsupportedRequestFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
          code_challenge: "challenge",
          redirect_uri: "https://longview.example/callback",
          response_type: "code",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unsupportedRequestFieldsResp.status, 400);
      const unsupportedRequestFieldsBody = parseErrorResponse(await unsupportedRequestFieldsResp.json());
      assert.equal(unsupportedRequestFieldsBody.error.code, "invalid_request");
      assert.match(unsupportedRequestFieldsBody.error.message, REGEXP_14);

      const badTypeResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: "spotify", kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://example.com/not-pdpp",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(badTypeResp.status, 400);
      const badTypeBody = parseErrorResponse(await badTypeResp.json());
      assert.equal(badTypeBody.error.code, "invalid_request");
      assert.match(badTypeBody.error.message, REGEXP_15);

      const unsupportedAccessModeResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "time_bounded",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unsupportedAccessModeResp.status, 400);
      const unsupportedAccessModeBody = parseErrorResponse(await unsupportedAccessModeResp.json());
      assert.equal(unsupportedAccessModeBody.error.code, "invalid_request");
      assert.match(unsupportedAccessModeBody.error.message, REGEXP_16);

      const emptyStreamsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(emptyStreamsResp.status, 400);
      const emptyStreamsBody = parseErrorResponse(await emptyStreamsResp.json());
      assert.equal(emptyStreamsBody.error.code, "invalid_request");
      assert.match(emptyStreamsBody.error.message, REGEXP_17);

      const unsupportedAuthorizationDetailFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              locations: ["https://rs.pdpp.example"],
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ expand: ["albums"], name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unsupportedAuthorizationDetailFieldsResp.status, 400);
      const unsupportedAuthorizationDetailFieldsBody = parseErrorResponse(
        await unsupportedAuthorizationDetailFieldsResp.json()
      );
      assert.equal(unsupportedAuthorizationDetailFieldsBody.error.code, "invalid_request");
      assert.match(unsupportedAuthorizationDetailFieldsBody.error.message, REGEXP_18);

      const unsupportedStreamSelectionFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ expand: ["albums"], name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unsupportedStreamSelectionFieldsResp.status, 400);
      const unsupportedStreamSelectionFieldsBody = parseErrorResponse(
        await unsupportedStreamSelectionFieldsResp.json()
      );
      assert.equal(unsupportedStreamSelectionFieldsBody.error.code, "invalid_request");
      assert.match(unsupportedStreamSelectionFieldsBody.error.message, REGEXP_19);

      const unknownConnectorResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: "not_a_real_connector", kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unknownConnectorResp.status, 400);
      const unknownConnectorBody = parseErrorResponse(await unknownConnectorResp.json());
      assert.equal(unknownConnectorBody.error.code, "invalid_request");
      assert.match(unknownConnectorBody.error.message, REGEXP_20);

      const unknownStreamResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "not_a_real_stream" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unknownStreamResp.status, 400);
      const unknownStreamBody = parseErrorResponse(await unknownStreamResp.json());
      assert.equal(unknownStreamBody.error.code, "invalid_request");
      assert.match(unknownStreamBody.error.message, REGEXP_21);

      const unknownViewResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "not_a_real_view" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unknownViewResp.status, 400);
      const unknownViewBody = parseErrorResponse(await unknownViewResp.json());
      assert.equal(unknownViewBody.error.code, "invalid_request");
      assert.match(unknownViewBody.error.message, REGEXP_22);

      const contradictorySelectionResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ fields: ["id"], name: "top_artists", view: "basic" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(contradictorySelectionResp.status, 400);
      const contradictorySelectionBody = parseErrorResponse(await contradictorySelectionResp.json());
      assert.equal(contradictorySelectionBody.error.code, "invalid_request");
      assert.match(contradictorySelectionBody.error.message, REGEXP_23);

      const unknownFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ fields: ["id", "not_a_real_field"], name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(unknownFieldsResp.status, 400);
      const unknownFieldsBody = parseErrorResponse(await unknownFieldsResp.json());
      assert.equal(unknownFieldsBody.error.code, "invalid_request");
      assert.match(unknownFieldsBody.error.message, REGEXP_24);

      const malformedFieldsResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ fields: [], name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(malformedFieldsResp.status, 400);
      const malformedFieldsBody = parseErrorResponse(await malformedFieldsResp.json());
      assert.equal(malformedFieldsBody.error.code, "invalid_request");
      assert.match(malformedFieldsBody.error.message, REGEXP_25);
    });
  });

  await t.test("provider-connect request staging rejects unknown client ids", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "unknown_client",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = parseErrorResponse(await initiateResp.json());
      assert.equal(initiateBody.error.code, "invalid_client");
      assert.match(initiateBody.error.message, REGEXP_26);
    });
  });

  await t.test("provider-connect request staging rejects malformed persisted registered-client rows", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: "Transient Longview",
        token_endpoint_auth_method: "none",
      });
      await updateRegisteredClientRow(registration.body.client_id, {
        metadata_json: "{",
      });

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: registration.body.client_id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = parseErrorResponse(await initiateResp.json());
      assert.equal(initiateBody.error.code, "invalid_client");
      assert.match(initiateBody.error.message, REGEXP_27);
    });
  });

  await t.test(
    "provider-connect request staging failures preserve request and reference trace correlation through request.rejected artifacts",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const registration = await registerDynamicClient(asUrl, {
          client_name: "Transient Longview",
          token_endpoint_auth_method: "none",
        });
        await updateRegisteredClientRow(registration.body.client_id, {
          metadata_json: "{",
        });

        const initiateResp = await fetch(`${asUrl}/oauth/par`, {
          body: JSON.stringify({
            authorization_details: [
              {
                access_mode: "continuous",
                purpose_code: "https://pdpp.org/purpose/personalization",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ name: "top_artists" }],
                type: "https://pdpp.org/data-access",
              },
            ],
            client_id: registration.body.client_id,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        assert.equal(initiateResp.status, 400);
        const requestId = initiateResp.headers.get("Request-Id");
        const traceId = initiateResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.ok(traceId?.startsWith("trc_"));

        const initiateBody = parseErrorResponse(await initiateResp.json());
        assert.equal(initiateBody.error.code, "invalid_client");
        assert.equal(initiateBody.error.request_id, requestId);

        const { body: trace } = await fetchReferenceTrace(asUrl, traceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvent = (trace.data || []).find((event) => event.event_type === "request.rejected");
        assert.ok(rejectedEvent, "trace should include request.rejected");
        assert.equal(rejectedEvent.request_id, requestId);
        assert.equal(rejectedEvent.client_id, registration.body.client_id);
        assert.equal(rejectedEvent.status, "rejected");
        assert.equal(rejectedEvent.data?.error?.code, "invalid_client");
        assert.match(rejectedEvent.data?.error?.message || "", REGEXP_28);
        assert.equal(rejectedEvent.data?.source?.kind, "connector");
        assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(!("connector_id" in (rejectedEvent.data || {})));
      });
    }
  );

  await t.test(
    "provider-connect request staging success preserves request and reference trace correlation through request.submitted artifacts",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiateResp = await fetch(`${asUrl}/oauth/par`, {
          body: JSON.stringify({
            authorization_details: [
              {
                access_mode: "continuous",
                purpose_code: "https://pdpp.org/purpose/personalization",
                purpose_description: "Maintain a concert-recommendation profile over time",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ name: "top_artists", view: "basic" }],
                type: "https://pdpp.org/data-access",
              },
            ],
            client_id: "longview",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        assert.equal(initiateResp.status, 201);
        const requestId = initiateResp.headers.get("Request-Id");
        const traceId = initiateResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.ok(traceId?.startsWith("trc_"));

        const initiateBody = parseParSuccessResponse(await initiateResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(initiateBody.request_uri?.startsWith("urn:pdpp:pending-consent:"));
        assert.ok(!("trace_context" in initiateBody), "public PAR response should not expose internal trace_context");

        const { body: trace } = await fetchReferenceTrace(asUrl, traceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const submittedEvent = (trace.data || []).find((event) => event.event_type === "request.submitted");
        assert.ok(submittedEvent, "trace should include request.submitted");
        assert.equal(submittedEvent.request_id, requestId);
        assert.equal(submittedEvent.trace_id, traceId);
        assert.equal(submittedEvent.client_id, "longview");
        assert.equal(submittedEvent.status, "succeeded");
        assert.equal(submittedEvent.data?.source?.kind, "connector");
        assert.equal(submittedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(!("connector_id" in (submittedEvent.data || {})));
      });
    }
  );

  await t.test("initial-access-token dynamic client registration returns a usable public client", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const registration = await registerDynamicClient(asUrl, {
        client_name: "Dynamic Longview",
        client_uri: "https://longview.example",
        policy_uri: "https://longview.example/privacy",
        redirect_uris: ["https://longview.example/callback"],
        token_endpoint_auth_method: "none",
        tos_uri: "https://longview.example/terms",
      });

      assert.equal(registration.status, 201);
      const registrationRequestId = registration.headers["request-id"];
      const registrationTraceId = registration.headers["pdpp-reference-trace-id"];
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok(registrationRequestId?.startsWith("req_"));
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok(registrationTraceId?.startsWith("trc_"));
      assert.ok(typeof registration.body.client_id === "string" && registration.body.client_id.startsWith("cli_"));
      assert.equal(registration.body.client_name, "Dynamic Longview");
      assert.equal(registration.body.token_endpoint_auth_method, "none");
      const { body: registrationTrace } = await fetchReferenceTrace(asUrl, registrationTraceId);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const registeredEvent = (registrationTrace.data || []).find((event) => event.event_type === "client.registered");
      assert.ok(registeredEvent, "trace should include client.registered");
      assert.equal(registeredEvent.request_id, registrationRequestId);
      assert.equal(registeredEvent.trace_id, registrationTraceId);
      assert.equal(registeredEvent.object_id, registration.body.client_id);
      assert.equal(registeredEvent.client_id, registration.body.client_id);
      assert.equal(registeredEvent.data?.registration_mode, "dynamic");
      assert.equal(registeredEvent.data?.registration_access, "initial_access_token");
      assert.equal(registeredEvent.data?.client_name, "Dynamic Longview");
      assert.equal(registeredEvent.data?.token_endpoint_auth_method, "none");
      assert.equal(registeredEvent.data?.redirect_uri_count, 1);

      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              purpose_description: "Maintain a concert-recommendation profile over time",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: registration.body.client_id,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(initiateResp.status, 201);
      const initiate = parseParSuccessResponse(await initiateResp.json());
      const { body: approved } = await approveGrantSuccess(asUrl, initiate.request_uri, "u1");

      assert.equal(approved.grant.client.client_id, registration.body.client_id);
      assert.equal(approved.grant.client.client_display.name, "Dynamic Longview");
      assert.equal(approved.grant.client.client_display.uri, "https://longview.example");
    });
  });

  await t.test("public dynamic client registration works without an initial access token", async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await registerDynamicClient(
        asUrl,
        {
          client_name: "Public Dynamic Longview",
          token_endpoint_auth_method: "none",
        },
        null
      );

      assert.equal(registration.status, 201);
      const registrationTraceId = registration.headers["pdpp-reference-trace-id"];
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok(registrationTraceId?.startsWith("trc_"));
      assert.ok(typeof registration.body.client_id === "string" && registration.body.client_id.startsWith("cli_"));
      assert.equal(registration.body.client_name, "Public Dynamic Longview");
      assert.equal(registration.body.token_endpoint_auth_method, "none");

      const { body: registrationTrace } = await fetchReferenceTrace(asUrl, registrationTraceId);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const registeredEvent = (registrationTrace.data || []).find((event) => event.event_type === "client.registered");
      assert.ok(registeredEvent, "trace should include client.registered");
      assert.equal(registeredEvent.data?.registration_access, "public");
    });
  });

  await t.test(
    "registered client metadata stays authoritative over caller-supplied client_display assertions",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const registration = await registerDynamicClient(asUrl, {
          client_name: "Registered Longview",
          client_uri: "https://registered.longview.example",
          token_endpoint_auth_method: "none",
        });

        const initiateResp = await fetch(`${asUrl}/oauth/par`, {
          body: JSON.stringify({
            authorization_details: [
              {
                access_mode: "continuous",
                purpose_code: "https://pdpp.org/purpose/personalization",
                purpose_description: "Maintain a concert-recommendation profile over time",
                source: { id: spotifyManifest.connector_id, kind: "connector" },
                streams: [{ name: "top_artists", view: "basic" }],
                type: "https://pdpp.org/data-access",
              },
            ],
            client_display: {
              name: "Forged Display Name",
              uri: "https://forged.longview.example",
            },
            client_id: registration.body.client_id,
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(initiateResp.status, 201);
        const initiate = parseParSuccessResponse(await initiateResp.json());

        const consentResp = await fetch(`${asUrl}/consent?request_uri=${encodeURIComponent(initiate.request_uri)}`);
        assert.equal(consentResp.status, 200);
        const consentHtml = await consentResp.text();
        assert.match(consentHtml, REGEXP_29);
        assert.doesNotMatch(consentHtml, REGEXP_30);

        const { body: approved } = await approveGrantSuccess(asUrl, initiate.request_uri, "u1");

        assert.equal(approved.grant.client.client_display.name, "Registered Longview");
        assert.equal(approved.grant.client.client_display.uri, "https://registered.longview.example");
      });
    }
  );

  await t.test(
    "consent display and approval re-resolve registered client metadata instead of trusting the staged client snapshot",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const registration = await registerDynamicClient(asUrl, {
          client_name: "Registered Longview",
          client_uri: "https://registered.longview.example",
          token_endpoint_auth_method: "none",
        });

        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_display: {
            name: "Forged Display Name",
            uri: "https://forged.longview.example",
          },
          client_id: registration.body.client_id,
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);

        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.client.client_display = {
            name: "Persisted Forgery",
            uri: "https://persisted.forgery.example",
          };
        });
        await mutateRegisteredClient(registration.body.client_id, (metadata) => {
          metadata.client_name = "Updated Longview";
          metadata.client_uri = "https://updated.longview.example";
        });

        const consentResp = await fetch(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 200);
        const consentHtml = await consentResp.text();
        assert.match(consentHtml, REGEXP_31);
        assert.doesNotMatch(consentHtml, REGEXP_32);

        const approveResp = await approveGrantSuccess(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 200);
        assert.equal(approveResp.body.grant.client.client_display.name, "Updated Longview");
        assert.equal(approveResp.body.grant.client.client_display.uri, "https://updated.longview.example");
      });
    }
  );

  await t.test(
    "persisted pending request trace-context drift does not break staged trace correlation on approval",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;
        assert.ok(requireString(stagedRequestId, "staged request id").startsWith("req_"));
        assert.ok(requireString(stagedTraceId, "staged trace id").startsWith("trc_"));

        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.trace_context = {
            debug_context: "should_not_escape",
            request_id: "req_forged_pending",
            scenario_id: "scn_forged_pending",
            trace_id: "trc_forged_pending",
          };
        });

        const consentResp = await fetch(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 200);
        const consentHtml = await consentResp.text();
        assert.match(consentHtml, REGEXP_33);
        assert.match(
          consentHtml,
          new RegExp(`<dt>Connector</dt><dd>${SPOTIFY_CONNECTOR_KEY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</dd>`)
        );

        const approveResp = await approveGrantSuccess(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 200);
        assert.equal(approveResp.headers["request-id"], stagedRequestId);
        assert.equal(approveResp.headers["pdpp-reference-trace-id"], stagedTraceId);
        assert.equal(approveResp.body.grant.source.kind, "connector");
        assert.equal(approveResp.body.grant.source.id, SPOTIFY_CONNECTOR_KEY);

        const { body: trace } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const approvedEvent = (trace.data || []).find(
          (event) => event.event_type === "consent.approved" && event.request_id === stagedRequestId
        );
        assert.ok(approvedEvent, "trace should keep consent.approved on the original staged trace");
        assert.equal(approvedEvent.data?.source?.kind, "connector");
        assert.equal(approvedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const grantIssuedEvent = (trace.data || []).find(
          (event) => event.event_type === "grant.issued" && event.request_id === stagedRequestId
        );
        assert.ok(grantIssuedEvent, "trace should keep grant.issued on the original staged trace");
        assert.equal(grantIssuedEvent.data?.source?.kind, "connector");
        assert.equal(grantIssuedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

        const forgedTraceResp = await fetch(`${asUrl}/_ref/traces/trc_forged_pending`);
        assert.equal(forgedTraceResp.status, 404);
      });
    }
  );

  await t.test(
    "persisted pending rows missing top-level trace correlation are rejected instead of falling back to embedded request trace_context",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;

        const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
        assert.ok(deviceCode);

        const pendingRows = getDb()
          .prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `)
          .all(deviceCode);
        assert.equal(pendingRows.length, 1);
        // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
        const pendingRow = pendingRows[0];
        assert.ok(pendingRow, "expected pending consent row");
        const driftedRequest = JSON.parse(requireString(pendingRow.params_json, "pending consent params_json"));
        driftedRequest.trace_context = {
          request_id: "req_forged_pending",
          scenario_id: "scn_forged_pending",
          trace_id: "trc_forged_pending",
        };
        await updatePendingConsentRow(initiate.body.request_uri, {
          params_json: JSON.stringify(driftedRequest),
          request_id: null,
          scenario_id: null,
          trace_id: null,
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(consentResp.body.error?.code, "invalid_request");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(consentResp.body.error?.message, "Pending consent row is missing persisted trace correlation");
        assert.notEqual(consentResp.headers["request-id"], stagedRequestId);
        assert.equal(consentResp.headers["pdpp-reference-trace-id"], undefined);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 400);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(approveResp.body.error?.code, "invalid_request");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(approveResp.body.error?.message, "Pending consent row is missing persisted trace correlation");
        assert.notEqual(approveResp.headers["request-id"], stagedRequestId);
        assert.equal(approveResp.headers["pdpp-reference-trace-id"], undefined);

        const denyResp = await fetchJson(
          `${asUrl}/consent/deny?request_uri=${encodeURIComponent(initiate.body.request_uri)}`,
          {
            method: "POST",
          }
        );
        assert.equal(denyResp.status, 400);
        const denyError = parseErrorResponse(denyResp.body);
        assert.equal(denyError.error.code, "invalid_request");
        assert.equal(denyError.error.message, "Pending consent row is missing persisted trace correlation");
        assert.notEqual(denyResp.headers["request-id"], stagedRequestId);
        assert.equal(denyResp.headers["pdpp-reference-trace-id"], undefined);

        const { body: stagedTraceBody } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const stagedFollowOnEvents = (stagedTraceBody.data || []).filter((event) =>
          ["request.rejected", "consent.approved", "consent.denied", "grant.issued"].includes(event.event_type)
        );
        assert.equal(
          stagedFollowOnEvents.length,
          0,
          "malformed pending rows should not append forged follow-on artifacts to the staged trace"
        );

        const forgedTraceResp = await fetch(`${asUrl}/_ref/traces/trc_forged_pending`);
        assert.equal(forgedTraceResp.status, 404);
      });
    }
  );

  await t.test(
    "persisted pending request bindings with unsupported fields are rejected on the original staged trace",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;

        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.trace_context = {
            debug_context: "should_not_escape",
            request_id: "req_forged_pending",
            scenario_id: "scn_forged_pending",
            trace_id: "trc_forged_pending",
          };
          request.source_binding = {
            ...request.source_binding,
            debug_context: "should_not_escape",
          };
          request.storage_binding = {
            ...request.storage_binding,
            debug_context: "should_not_escape",
          };
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_34);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_35);

        const { body: trace } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvent = (trace.data || []).find(
          (event) => event.event_type === "request.rejected" && event.request_id === stagedRequestId
        );
        assert.ok(rejectedEvent, "trace should keep request.rejected on the original staged trace");
        assert.equal(rejectedEvent.data?.source?.kind, "connector");
        assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
      });
    }
  );

  await t.test(
    "persisted pending request source bindings without kind are rejected without reconstructing connector source artifacts",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);
        const stagedTrace = await readPendingConsentTraceContext(initiate.body.request_uri);
        const stagedRequestId = stagedTrace.request_id;
        const stagedTraceId = stagedTrace.trace_id;

        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.source_binding = {
            id: request.source_binding.id,
          };
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_36);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_37);

        const { body: trace } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvent = (trace.data || []).find(
          (event) => event.event_type === "request.rejected" && event.request_id === stagedRequestId
        );
        assert.ok(rejectedEvent, "trace should keep request.rejected on the original staged trace");
        assert.equal(rejectedEvent.data?.source, null);
      });
    }
  );

  await t.test(
    "consent display and approval reject staged requests whose registered client no longer exists",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const registration = await registerDynamicClient(asUrl, {
          client_name: "Transient Longview",
          token_endpoint_auth_method: "none",
        });

        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: registration.body.client_id,
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);

        await deleteRegisteredClient(registration.body.client_id);

        const consentResp = await fetch(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 400);
        const consentRequestId = consentResp.headers.get("Request-Id");
        const consentTraceId = consentResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(consentRequestId?.startsWith("req_"));
        assert.ok(consentTraceId?.startsWith("trc_"));
        const consentBody = parseErrorResponse(await consentResp.json());
        assert.equal(consentBody.error.code, "invalid_client");
        assert.match(consentBody.error.message, REGEXP_38);

        const approveResp = await fetch(`${asUrl}/consent/approve`, {
          body: JSON.stringify({ request_uri: initiate.body.request_uri, subject_id: "u1" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(approveResp.status, 400);
        const approveRequestId = approveResp.headers.get("Request-Id");
        const approveTraceId = approveResp.headers.get("PDPP-Reference-Trace-Id");
        assert.equal(approveRequestId, consentRequestId);
        assert.equal(approveTraceId, consentTraceId);
        const approveBody = parseErrorResponse(await approveResp.json());
        assert.equal(approveBody.error.code, "invalid_client");
        assert.match(approveBody.error.message, REGEXP_39);

        const { body: trace } = await fetchReferenceTrace(asUrl, consentTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvents = (trace.data || []).filter(
          (event) => event.event_type === "request.rejected" && event.request_id === consentRequestId
        );
        assert.ok(rejectedEvents.length >= 1, "trace should include request.rejected for consent-time client drift");
        const rejectedEvent = rejectedEvents.find((event) => event.data?.error?.code === "invalid_client");
        assert.ok(rejectedEvent, "trace should preserve invalid_client rejection details");
        assert.equal(rejectedEvent.object_type, "pending_consent");
        assert.equal(rejectedEvent.client_id, registration.body.client_id);
        assert.equal(rejectedEvent.data?.source?.kind, "connector");
        assert.equal(rejectedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.match(rejectedEvent.data?.error?.message || "", REGEXP_40);
      });
    }
  );

  await t.test(
    "consent denial preserves staged trace correlation and emits consent.denied on the original trace",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "single_use",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ fields: ["id", "name"], name: "saved_tracks" }],
        });
        assert.equal(initiate.status, 201);

        const stagedRequestId = initiate.headers["request-id"];
        const stagedTraceId = initiate.headers["pdpp-reference-trace-id"];
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(stagedRequestId?.startsWith("req_"));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(stagedTraceId?.startsWith("trc_"));

        const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
        assert.equal(denyResp.status, 200);
        assert.equal(denyResp.headers["request-id"], stagedRequestId);
        assert.equal(denyResp.headers["pdpp-reference-trace-id"], stagedTraceId);
        assert.match(denyResp.body, REGEXP_41);

        const { body: trace } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const deniedEvent = (trace.data || []).find(
          (event) => event.event_type === "consent.denied" && event.request_id === stagedRequestId
        );
        assert.ok(deniedEvent, "trace should include consent.denied on the original staged trace");
        assert.equal(deniedEvent.client_id, "longview");
        assert.equal(deniedEvent.object_type, "pending_consent");
        assert.equal(deniedEvent.status, "denied");
        assert.equal(deniedEvent.data?.source?.kind, "connector");
        assert.equal(deniedEvent.data?.source?.id, SPOTIFY_CONNECTOR_KEY);

        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const grantIssuedEvent = (trace.data || []).find((event) => event.event_type === "grant.issued");
        assert.equal(grantIssuedEvent, undefined, "denied consent trace should not issue a grant");
      });
    }
  );

  await t.test(
    "consent display and approval reject staged requests whose registered client row becomes malformed",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const registration = await registerDynamicClient(asUrl, {
          client_name: "Transient Longview",
          token_endpoint_auth_method: "none",
        });

        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: registration.body.client_id,
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        assert.equal(initiate.status, 201);

        await updateRegisteredClientRow(registration.body.client_id, {
          metadata_json: "{",
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_client");
        assert.match(consentResp.body.error.message, REGEXP_42);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "u1");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_client");
        assert.match(approveResp.body.error.message, REGEXP_43);
      });
    }
  );

  await t.test(
    "owner device authorization rejects unknown client ids instead of staging orphaned device codes",
    async () => {
      await withHarness(async ({ asUrl }) => {
        const deviceResp = await fetchJson(`${asUrl}/oauth/device_authorization`, {
          body: new URLSearchParams({ client_id: "not-a-real-client" }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });

        assert.equal(deviceResp.status, 400);
        const deviceError = parseOAuthDeviceErrorResponse(deviceResp.body);
        assert.equal(deviceError.error, "invalid_client");
        assert.match(deviceError.error_description, REGEXP_44);
      });
    }
  );

  await t.test(
    "owner device authorization rejects malformed registered-client rows instead of staging orphaned device codes",
    async () => {
      await withHarness(async ({ asUrl }) => {
        await updateRegisteredClientRow("cli_longview", {
          metadata_json: "{",
        });

        const deviceResp = await fetchJson(`${asUrl}/oauth/device_authorization`, {
          body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });

        assert.equal(deviceResp.status, 400);
        const deviceError = parseOAuthDeviceErrorResponse(deviceResp.body);
        assert.equal(deviceError.error, "invalid_client");
        assert.match(deviceError.error_description, REGEXP_45);
      });
    }
  );

  await t.test(
    "owner device authorization stays inspectable through request correlation and trace artifacts",
    async () => {
      await withHarness(async ({ asUrl }) => {
        const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
          body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });

        assert.equal(deviceResp.status, 200);
        const requestId = deviceResp.headers.get("Request-Id");
        const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.ok(traceId?.startsWith("trc_"));

        const deviceBody = parseDeviceAuthorizationResponse(await deviceResp.json());
        const { body: trace } = await fetchReferenceTrace(asUrl, traceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const submittedEvent = (trace.data || []).find((event) => event.event_type === "request.submitted");
        assert.ok(submittedEvent, "trace should include request.submitted");
        assert.equal(submittedEvent.request_id, requestId);
        assert.equal(submittedEvent.client_id, "cli_longview");
        assert.equal(submittedEvent.object_type, "owner_device_auth");
        // The live device_code is bearer-equivalent for owner_device_auth
        // (it redeems for an owner bearer at /oauth/token), so the public
        // _ref read surface SHALL replace object_id with a redaction
        // literal. Spec: harden-reference-auth-surfaces §7.
        assert.equal(submittedEvent.object_id, "<redacted-device-code>");
        assert.equal(submittedEvent.data?.issuance_path, "owner_device_flow");
        // user_code is part of the takeover chain; redacted on public reads.
        assert.equal(submittedEvent.data?.user_code, "<redacted-bearer>");

        const pendingResp = await fetch(`${asUrl}/oauth/token`, {
          body: new URLSearchParams({
            client_id: "cli_longview",
            device_code: deviceBody.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(pendingResp.status, 400);
        assert.equal(pendingResp.headers.get("Request-Id"), requestId);
        assert.equal(pendingResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
        const pendingBody = parseOAuthDeviceErrorResponse(await pendingResp.json());
        assert.equal(pendingBody.error, "authorization_pending");

        const approveResp = await fetch(`${asUrl}/device/approve`, {
          body: new URLSearchParams({
            subject_id: "cli_owner",
            user_code: deviceBody.user_code,
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(approveResp.status, 200);
        const exchangeResp = await fetch(`${asUrl}/oauth/token`, {
          body: new URLSearchParams({
            client_id: "cli_longview",
            device_code: deviceBody.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(exchangeResp.status, 200);
        assert.equal(exchangeResp.headers.get("Request-Id"), requestId);
        assert.equal(exchangeResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
        const exchangeBody = parseTokenResponse(await exchangeResp.json());
        assert.ok(exchangeBody.access_token);
        const { body: approvedTrace } = await fetchReferenceTrace(asUrl, traceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const ownerTokenEvent = (approvedTrace.data || []).find(
          (event) => event.event_type === "token.issued" && event.data?.issuance_path === "owner_device_flow"
        );
        assert.ok(ownerTokenEvent, "trace should include owner token issuance");
        assert.equal(ownerTokenEvent.request_id, requestId);
        assert.equal(ownerTokenEvent.client_id, "cli_longview");
        // user_code redacted on public _ref read.
        assert.equal(ownerTokenEvent.data?.user_code, "<redacted-bearer>");
      });
    }
  );

  await t.test("owner device denial stays inspectable through request correlation and trace artifacts", async () => {
    await withHarness(async ({ asUrl }) => {
      const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
        body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });

      assert.equal(deviceResp.status, 200);
      const requestId = deviceResp.headers.get("Request-Id");
      const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const deviceBody = parseDeviceAuthorizationResponse(await deviceResp.json());

      const denyResp = await fetch(`${asUrl}/device/deny`, {
        body: new URLSearchParams({
          subject_id: "cli_owner",
          user_code: deviceBody.user_code,
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(denyResp.status, 200);

      const tokenResp = await fetch(`${asUrl}/oauth/token`, {
        body: new URLSearchParams({
          client_id: "cli_longview",
          device_code: deviceBody.device_code,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        }).toString(),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        method: "POST",
      });
      assert.equal(tokenResp.status, 400);
      assert.equal(tokenResp.headers.get("Request-Id"), requestId);
      assert.equal(tokenResp.headers.get("PDPP-Reference-Trace-Id"), traceId);
      const tokenBody = parseOAuthDeviceErrorResponse(await tokenResp.json());
      assert.equal(tokenBody.error, "access_denied");

      const { body: trace } = await fetchReferenceTrace(asUrl, traceId);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const rejectedEvent = (trace.data || []).find(
        (event) => event.event_type === "request.rejected" && event.request_id === requestId
      );
      assert.ok(rejectedEvent, "trace should include request.rejected for owner-device denial");
      assert.equal(rejectedEvent.client_id, "cli_longview");
      // device_code / user_code redacted on public _ref read surfaces
      // (harden-reference-auth-surfaces §7). The internal correlation
      // by request_id and client_id remains intact.
      assert.equal(rejectedEvent.object_id, "<redacted-device-code>");
      assert.equal(rejectedEvent.data?.issuance_path, "owner_device_flow");
      assert.equal(rejectedEvent.data?.user_code, "<redacted-bearer>");
      assert.equal(rejectedEvent.data?.error?.code, "access_denied");
      assert.match(rejectedEvent.data?.error?.message || "", REGEXP_46);
    });
  });

  await t.test(
    "owner device authorization failures preserve request and reference trace correlation through request.rejected artifacts",
    async () => {
      await withHarness(async ({ asUrl }) => {
        await updateRegisteredClientRow("cli_longview", {
          metadata_json: "{",
        });

        const deviceResp = await fetch(`${asUrl}/oauth/device_authorization`, {
          body: new URLSearchParams({ client_id: "cli_longview" }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });

        assert.equal(deviceResp.status, 400);
        const requestId = deviceResp.headers.get("Request-Id");
        const traceId = deviceResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.ok(traceId?.startsWith("trc_"));

        const deviceBody = parseOAuthDeviceErrorResponse(await deviceResp.json());
        assert.equal(deviceBody.error, "invalid_client");
        assert.match(deviceBody.error_description, REGEXP_47);

        const { body: trace } = await fetchReferenceTrace(asUrl, traceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvent = (trace.data || []).find((event) => event.event_type === "request.rejected");
        assert.ok(rejectedEvent, "trace should include request.rejected");
        assert.equal(rejectedEvent.request_id, requestId);
        assert.equal(rejectedEvent.client_id, "cli_longview");
        assert.equal(rejectedEvent.status, "rejected");
        assert.equal(rejectedEvent.data?.issuance_path, "owner_device_flow");
        assert.equal(rejectedEvent.data?.error?.code, "invalid_client");
        assert.match(rejectedEvent.data?.error?.message || "", REGEXP_48);
      });
    }
  );

  await t.test(
    "owner device approval and exchange reject device codes whose client registration disappears before completion",
    async () => {
      await withHarness(async ({ asUrl }) => {
        const { body: device } = await startOwnerDeviceAuthorization(asUrl, "cli_longview");

        await deleteRegisteredClient("cli_longview");

        const devicePageResp = await fetch(`${asUrl}/device?user_code=${encodeURIComponent(device.user_code)}`);
        assert.equal(devicePageResp.status, 200);
        const devicePageHtml = await devicePageResp.text();
        assert.doesNotMatch(devicePageHtml, REGEXP_49);

        const approveResp = await fetchJson(`${asUrl}/device/approve`, {
          body: new URLSearchParams({
            subject_id: "owner_local",
            user_code: device.user_code,
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(approveResp.status, 400);
        const approveError = parseOAuthDeviceErrorResponse(approveResp.body);
        assert.equal(approveError.error, "invalid_client");
        assert.match(approveError.error_description, REGEXP_50);

        const tokenResp = await fetchJson(`${asUrl}/oauth/token`, {
          body: new URLSearchParams({
            client_id: "cli_longview",
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(tokenResp.status, 400);
        const tokenError = parseOAuthDeviceErrorResponse(tokenResp.body);
        assert.equal(tokenError.error, "invalid_client");
        assert.match(tokenError.error_description, REGEXP_51);
      });
    }
  );

  await t.test(
    "owner device display, approval, and exchange reject device codes whose client registration row becomes malformed",
    async () => {
      await withHarness(async ({ asUrl }) => {
        const { body: device } = await startOwnerDeviceAuthorization(asUrl, "cli_longview");

        await updateRegisteredClientRow("cli_longview", {
          metadata_json: "{",
        });

        const devicePageResp = await fetch(`${asUrl}/device?user_code=${encodeURIComponent(device.user_code)}`);
        assert.equal(devicePageResp.status, 200);
        const devicePageHtml = await devicePageResp.text();
        assert.doesNotMatch(devicePageHtml, REGEXP_52);

        const approveResp = await fetchJson(`${asUrl}/device/approve`, {
          body: new URLSearchParams({
            subject_id: "owner_local",
            user_code: device.user_code,
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(approveResp.status, 400);
        const approveError = parseOAuthDeviceErrorResponse(approveResp.body);
        assert.equal(approveError.error, "invalid_client");
        assert.match(approveError.error_description, REGEXP_53);

        const tokenResp = await fetchJson(`${asUrl}/oauth/token`, {
          body: new URLSearchParams({
            client_id: "cli_longview",
            device_code: device.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          }).toString(),
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          method: "POST",
        });
        assert.equal(tokenResp.status, 400);
        const tokenError = parseOAuthDeviceErrorResponse(tokenResp.body);
        assert.equal(tokenError.error, "invalid_client");
        assert.match(tokenError.error_description, REGEXP_54);
      });
    }
  );

  await t.test("dynamic client registration rejects invalid initial access tokens", async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await fetch(`${asUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Rejected Client",
          token_endpoint_auth_method: "none",
        }),
        headers: {
          Authorization: "Bearer wrong-token",
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      assert.equal(registration.status, 401);
      const registrationRequestId = registration.headers.get("Request-Id");
      const registrationTraceId = registration.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(registrationRequestId?.startsWith("req_"));
      assert.ok(registrationTraceId?.startsWith("trc_"));
      const registrationBody = parseOAuthDeviceErrorResponse(await registration.json());
      assert.equal(registrationBody.error, "invalid_client");
      assert.match(registrationBody.error_description, REGEXP_55);

      const { body: registrationTrace } = await fetchReferenceTrace(asUrl, registrationTraceId);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const rejectedEvent = (registrationTrace.data || []).find(
        (event) => event.event_type === "client.register_rejected"
      );
      assert.ok(rejectedEvent, "trace should include client.register_rejected");
      assert.equal(rejectedEvent.request_id, registrationRequestId);
      assert.equal(rejectedEvent.trace_id, registrationTraceId);
      assert.equal(rejectedEvent.object_id, registrationRequestId);
      assert.equal(rejectedEvent.data?.requested_client_name, "Rejected Client");
      assert.equal(rejectedEvent.data?.requested_token_endpoint_auth_method, "none");
      assert.equal(rejectedEvent.data?.requested_redirect_uri_count, 0);
      assert.equal(rejectedEvent.data?.error?.code, "invalid_client");
    });
  });

  await t.test(
    "dynamic client registration rejects unsupported OAuth metadata beyond the current public-client profile",
    async () => {
      await withHarness(async ({ asUrl }) => {
        const responseTypes = await fetch(`${asUrl}/oauth/register`, {
          body: JSON.stringify({
            client_name: "Too Broad",
            response_types: ["token"],
            token_endpoint_auth_method: "none",
          }),
          headers: {
            Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        assert.equal(responseTypes.status, 400);
        const responseTypesBody = parseOAuthDeviceErrorResponse(await responseTypes.json());
        assert.equal(responseTypesBody.error, "invalid_client_metadata");
        assert.match(responseTypesBody.error_description, REGEXP_56);

        const confidential = await fetch(`${asUrl}/oauth/register`, {
          body: JSON.stringify({
            client_name: "Confidential Client",
            client_secret: "not-allowed",
            token_endpoint_auth_method: "none",
          }),
          headers: {
            Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        assert.equal(confidential.status, 400);
        const confidentialBody = parseOAuthDeviceErrorResponse(await confidential.json());
        assert.equal(confidentialBody.error, "invalid_client_metadata");
        assert.match(confidentialBody.error_description, REGEXP_57);

        const applicationType = await fetch(`${asUrl}/oauth/register`, {
          body: JSON.stringify({
            application_type: "browser",
            client_name: "Native Longview",
            token_endpoint_auth_method: "none",
          }),
          headers: {
            Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });

        assert.equal(applicationType.status, 400);
        const applicationTypeBody = parseOAuthDeviceErrorResponse(await applicationType.json());
        assert.equal(applicationTypeBody.error, "invalid_client_metadata");
        assert.match(applicationTypeBody.error_description, REGEXP_58);
      });
    }
  );

  await t.test("dynamic client registration rejects unsupported client metadata extension fields", async () => {
    await withHarness(async ({ asUrl }) => {
      const registration = await fetch(`${asUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Longview",
          jwks_uri: "https://client.example/jwks.json",
          scope: "openid profile",
        }),
        headers: {
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      assert.equal(registration.status, 400);
      const registrationBody = parseOAuthDeviceErrorResponse(await registration.json());
      assert.equal(registrationBody.error, "invalid_client_metadata");
      assert.match(registrationBody.error_description, REGEXP_59);
    });
  });

  await t.test("dynamic client registration rejects malformed URI metadata fields", async () => {
    await withHarness(async ({ asUrl }) => {
      const invalidRedirectUris = await fetch(`${asUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Longview",
          redirect_uris: ["not a uri"],
        }),
        headers: {
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      assert.equal(invalidRedirectUris.status, 400);
      const invalidRedirectUrisBody = parseOAuthDeviceErrorResponse(await invalidRedirectUris.json());
      assert.equal(invalidRedirectUrisBody.error, "invalid_client_metadata");
      assert.match(invalidRedirectUrisBody.error_description, REGEXP_60);

      const invalidClientUri = await fetch(`${asUrl}/oauth/register`, {
        body: JSON.stringify({
          client_name: "Longview",
          client_uri: "still not a uri",
        }),
        headers: {
          Authorization: `Bearer ${TEST_DCR_INITIAL_ACCESS_TOKEN}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      assert.equal(invalidClientUri.status, 400);
      const invalidClientUriBody = parseOAuthDeviceErrorResponse(await invalidClientUri.json());
      assert.equal(invalidClientUriBody.error, "invalid_client_metadata");
      assert.match(invalidClientUriBody.error_description, REGEXP_61);
    });
  });

  await t.test("request staging rejects time_range on streams without consent_time_field support", async () => {
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    const manifest = {
      connector_id: "time_range_test",
      display_name: "Time Range Test",
      streams: [
        {
          name: "items",
          primary_key: "id",
          schema: {
            properties: {
              id: { type: "string" },
              value: { type: "string" },
            },
            type: "object",
          },
          semantics: "append_only",
        },
      ],
      version: "0.1.0",
    };

    try {
      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 201);

      const initiate = await startGrantRequestRejection(asUrl, {
        access_mode: "continuous",
        client_id: "longview",
        connector_id: manifest.connector_id,
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Test unsupported time_range validation",
        streams: [{ name: "items", time_range: { since: "2026-01-01T00:00:00Z" } }],
      });

      assert.equal(initiate.status, 400);
      assert.equal(initiate.body.error.code, "invalid_request");
      assert.match(initiate.body.error.message, REGEXP_62);
    } finally {
      await closeServer(server);
    }
  });

  await t.test("connector registry rejects provider-native manifests on the polyfill connector surface", async () => {
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const manifest = {
        connector_id: "https://registry.pdpp.org/connectors/not-actually-polyfill",
        provider_id: "https://native.example/providers/hr",
        streams: [
          {
            name: "items",
            primary_key: "id",
            schema: {
              properties: {
                id: { type: "string" },
              },
              type: "object",
            },
            semantics: "append_only",
          },
        ],
        version: "0.1.0",
      };

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 400);
      const registerError = parseErrorResponse(registerResp.body);
      assert.equal(registerError.error.code, "invalid_request");
      assert.match(registerError.error.message, REGEXP_63);
    } finally {
      await closeServer(server);
    }
  });

  await t.test(
    "connector registry rejects manifests whose primary keys or views reference unknown schema fields",
    async () => {
      const server = await startServer({
        asPort: 0,
        dbPath: ":memory:",
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;

      try {
        const invalidPrimaryKeyManifest = {
          connector_id: "https://registry.pdpp.org/connectors/invalid-primary-key",
          streams: [
            {
              name: "items",
              primary_key: ["missing_id"],
              schema: {
                properties: {
                  id: { type: "string" },
                  value: { type: "string" },
                },
                type: "object",
              },
              semantics: "append_only",
            },
          ],
          version: "0.1.0",
        };

        const invalidPrimaryKeyResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(invalidPrimaryKeyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(invalidPrimaryKeyResp.status, 400);
        const invalidPrimaryKeyError = parseErrorResponse(invalidPrimaryKeyResp.body);
        assert.equal(invalidPrimaryKeyError.error.code, "invalid_request");
        assert.match(invalidPrimaryKeyError.error.message, REGEXP_64);

        const invalidViewManifest = {
          connector_id: "https://registry.pdpp.org/connectors/invalid-view-fields",
          streams: [
            {
              name: "items",
              primary_key: ["id"],
              schema: {
                properties: {
                  id: { type: "string" },
                  value: { type: "string" },
                },
                type: "object",
              },
              semantics: "append_only",
              views: [
                {
                  fields: ["id", "missing_value"],
                  id: "basic",
                },
              ],
            },
          ],
          version: "0.1.0",
        };

        const invalidViewResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(invalidViewManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(invalidViewResp.status, 400);
        const invalidViewError = parseErrorResponse(invalidViewResp.body);
        assert.equal(invalidViewError.error.code, "invalid_request");
        assert.match(invalidViewError.error.message, REGEXP_65);
      } finally {
        await closeServer(server);
      }
    }
  );

  await t.test("connector registry rejects connector manifests that include native-only storage_binding", async () => {
    const server = await startServer({
      asPort: 0,
      dbPath: ":memory:",
      dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;

    try {
      const manifest = {
        connector_id: "https://registry.pdpp.org/connectors/not-actually-polyfill",
        storage_binding: {
          connector_id: "native_storage_connector",
        },
        streams: [
          {
            name: "items",
            primary_key: "id",
            schema: {
              properties: {
                id: { type: "string" },
              },
              type: "object",
            },
            semantics: "append_only",
          },
        ],
        version: "0.1.0",
      };

      const registerResp = await fetchJson(`${asUrl}/connectors`, {
        body: JSON.stringify(manifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(registerResp.status, 400);
      const registerError = parseErrorResponse(registerResp.body);
      assert.equal(registerError.error.code, "invalid_request");
      assert.match(registerError.error.message, REGEXP_66);
    } finally {
      await closeServer(server);
    }
  });

  await t.test(
    "consent display and approval reject malformed persisted requests with streams that are not present in the manifest",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ name: "not_a_real_stream" }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_67);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_68);
      });
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with views that are not present on the stream manifest",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ name: "top_artists", view: "not_a_real_view" }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_69);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_70);
      });
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with unsupported time_range",
    async () => {
      const server = await startServer({
        asPort: 0,
        dbPath: ":memory:",
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;

      const manifest = {
        connector_id: "time_range_test",
        display_name: "Time Range Test",
        streams: [
          {
            name: "items",
            primary_key: "id",
            schema: {
              properties: {
                id: { type: "string" },
                value: { type: "string" },
              },
              type: "object",
            },
            semantics: "append_only",
          },
        ],
        version: "0.1.0",
      };

      try {
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(manifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);

        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          connector_id: manifest.connector_id,
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Test unsupported time_range validation",
          streams: [{ name: "items" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ name: "items", time_range: { since: "2026-01-01T00:00:00Z" } }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_71);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_72);
      } finally {
        await closeServer(server);
      }
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with contradictory view and fields selection",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ fields: ["id"], name: "top_artists", view: "basic" }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_73);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_74);
      });
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with unknown selected fields",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ fields: ["id"], name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ fields: ["id", "not_a_real_field"], name: "top_artists" }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_75);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_76);
      });
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with unsupported normalized request fields",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.redirect_uri = "https://longview.example/callback";
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_77);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_78);
      });
    }
  );

  await t.test(
    "consent display and approval reject malformed persisted requests with unsupported pending stream selection fields",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.selection.streams = [{ expand: ["albums"], name: "top_artists" }];
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_79);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_80);
      });
    }
  );

  await t.test(
    "consent display and approval reject persisted polyfill requests whose manifest_version no longer matches the current manifest",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.manifest_version = "999.0.0";
        });

        const consentResp = await fetchConsentRejection(asUrl, initiate.body.request_uri);
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_81);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_82);
      });
    }
  );

  await t.test(
    "consent display and approval reject persisted native requests whose manifest_version no longer matches the current manifest",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        assert.equal(initiate.status, 201);
        await mutatePendingConsentRequest(initiate.body.request_uri, (request) => {
          request.manifest_version = "999.0.0";
        });

        const consentResp = await fetch(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 400);
        const consentRequestId = consentResp.headers.get("Request-Id");
        const consentTraceId = consentResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(consentRequestId?.startsWith("req_"));
        assert.ok(consentTraceId?.startsWith("trc_"));
        const consentBody = parseErrorResponse(await consentResp.json());
        assert.equal(consentBody.error.code, "invalid_request");
        assert.match(consentBody.error.message, REGEXP_83);

        const approveResp = await fetch(`${asUrl}/consent/approve`, {
          body: JSON.stringify({ request_uri: initiate.body.request_uri, subject_id: "employee_1" }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(approveResp.status, 400);
        const approveRequestId = approveResp.headers.get("Request-Id");
        const approveTraceId = approveResp.headers.get("PDPP-Reference-Trace-Id");
        assert.equal(approveRequestId, consentRequestId);
        assert.equal(approveTraceId, consentTraceId);
        const approveBody = parseErrorResponse(await approveResp.json());
        assert.equal(approveBody.error.code, "invalid_request");
        assert.match(approveBody.error.message, REGEXP_84);

        const { body: trace } = await fetchReferenceTrace(asUrl, consentTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const rejectedEvents = (trace.data || []).filter(
          (event) => event.event_type === "request.rejected" && event.request_id === consentRequestId
        );
        assert.ok(rejectedEvents.length >= 1, "trace should include request.rejected for consent-time manifest drift");
        const rejectedEvent = rejectedEvents.find((event) => event.data?.error?.code === "invalid_request");
        assert.ok(rejectedEvent, "trace should preserve invalid_request rejection details");
        assert.equal(rejectedEvent.object_type, "pending_consent");
        assert.equal(rejectedEvent.client_id, "longview");
        assert.equal(rejectedEvent.data?.source?.kind, "provider_native");
        assert.equal(rejectedEvent.data?.source?.id, nativeManifest.provider_id);
        assert.match(rejectedEvent.data?.error?.message || "", REGEXP_85);
      });
    }
  );

  await t.test(
    "native consent denial preserves staged trace correlation without connector or storage leakage",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "single_use",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });
        assert.equal(initiate.status, 201);

        const stagedRequestId = initiate.headers["request-id"];
        const stagedTraceId = initiate.headers["pdpp-reference-trace-id"];
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(stagedRequestId?.startsWith("req_"));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(stagedTraceId?.startsWith("trc_"));

        const denyResp = await denyGrantRequest(asUrl, initiate.body.request_uri);
        assert.equal(denyResp.status, 200);
        assert.equal(denyResp.headers["request-id"], stagedRequestId);
        assert.equal(denyResp.headers["pdpp-reference-trace-id"], stagedTraceId);
        assert.match(denyResp.body, REGEXP_86);

        const { body: trace } = await fetchReferenceTrace(asUrl, stagedTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const deniedEvent = (trace.data || []).find(
          (event) => event.event_type === "consent.denied" && event.request_id === stagedRequestId
        );
        assert.ok(deniedEvent, "trace should include consent.denied for native staged denial");
        assert.equal(deniedEvent.client_id, "longview");
        assert.equal(deniedEvent.object_type, "pending_consent");
        assert.equal(deniedEvent.status, "denied");
        assert.equal(deniedEvent.data?.source?.kind, "provider_native");
        assert.equal(deniedEvent.data?.source?.id, nativeManifest.provider_id);
        assert.ok(!("connector_id" in (deniedEvent.data || {})));
        assert.ok(!("storage_connector_id" in (deniedEvent.data || {})));

        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const grantIssuedEvent = (trace.data || []).find((event) => event.event_type === "grant.issued");
        assert.equal(grantIssuedEvent, undefined, "denied native consent should not issue a grant");
      });
    }
  );

  await t.test("polyfill mode rejects provider-native request envelopes", async () => {
    await withHarness(async ({ asUrl }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/financial_planning",
              source: { id: "northstar_hr", kind: "provider_native" },
              streams: [{ name: "pay_statements" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = parseErrorResponse(await initiateResp.json());
      assert.equal(initiateBody.error.code, "invalid_request");
      assert.match(initiateBody.error.message, REGEXP_87);
    });
  });

  await t.test("polyfill reference traces expose public source descriptors without storage_connector_id", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      const { body: trace } = await fetchReferenceTrace(asUrl, timeline.trace_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const events = [...(timeline.data || []), ...(trace.data || [])];

      for (const event of events) {
        if (event.data.source?.kind !== "connector") {
          continue;
        }
        assert.equal(event.data.source.id, SPOTIFY_CONNECTOR_KEY);
        assert.ok(
          !("storage_connector_id" in event.data),
          `connector event ${event.event_type} should not expose storage_connector_id`
        );
      }
    });
  });

  await t.test("removed compatibility grant-initiation and device-code consent routes stay unavailable", async () => {
    await withHarness(async ({ asUrl, spotifyManifest }) => {
      const initiateResp = await fetch(`${asUrl}/grants/initiate`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/personalization",
              purpose_description: "Maintain a concert-recommendation profile over time",
              source: { id: spotifyManifest.connector_id, kind: "connector" },
              streams: [{ name: "top_artists", view: "basic" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(initiateResp.status, 404);

      const legacyConsentResp = await fetch(`${asUrl}/consent/legacy-device-code`);
      assert.equal(legacyConsentResp.status, 404);

      const legacyApproveResp = await fetch(`${asUrl}/consent/legacy-device-code/approve`, {
        body: JSON.stringify({ subject_id: "u1" }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(legacyApproveResp.status, 404);

      const legacyDenyResp = await fetch(`${asUrl}/consent/legacy-device-code/deny`, {
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(legacyDenyResp.status, 404);
    });
  });

  await t.test("native provider hides connector registry and collection-profile routes", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "employee_1");

      const connectorsResp = await fetch(`${asUrl}/connectors`, {
        body: JSON.stringify(nativeManifest),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      assert.equal(connectorsResp.status, 404);

      const connectorLookupResp = await fetch(
        `${asUrl}/connectors/${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`
      );
      assert.equal(connectorLookupResp.status, 404);

      const ingestResp = await fetch(
        `${rsUrl}/v1/ingest/pay_statements?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          body: "",
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(ingestResp.status, 404);

      const stateResp = await fetch(
        `${rsUrl}/v1/state/${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
        }
      );
      assert.equal(stateResp.status, 404);

      const resetStreamResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(resetStreamResp.status, 404);

      const resetRecordResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records/${encodeURIComponent("ps_2026_04_15")}?connector_id=${encodeURIComponent(nativeManifest.storage_binding.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(resetRecordResp.status, 404);
    });
  });

  await t.test("native provider client grants do not require public connector_id", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_display: { name: "Longview" },
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }, { name: "equity_grants", view: "summary" }],
      });

      assert.ok(!("connector_id" in approved.grant), "native grants should not expose connector_id");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(approved.grant.source?.kind, "provider_native");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(approved.grant.source?.id, nativeManifest.provider_id);

      const grantRows = getDb()
        .prepare(`
        SELECT storage_binding_json
        FROM grants
        WHERE grant_id = ?
      `)
        .all(approved.grant.grant_id);
      assert.equal(grantRows.length, 1);
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const grantRow = grantRows[0];
      assert.ok(grantRow, "expected persisted native grant row");
      assert.deepEqual(JSON.parse(requireString(grantRow.storage_binding_json, "persisted native storage binding")), {
        connector_id: nativeManifest.storage_binding.connector_id,
      });

      const { body: introspection } = await introspectToken(asUrl, approved.token);
      assert.equal(introspection.active, true);
      assert.ok(introspection.grant, "active native grant introspection must include a grant");
      assert.equal(introspection.grant.source?.kind, "provider_native");
      assert.equal(introspection.grant.source?.id, nativeManifest.provider_id);
      assert.ok(
        !("grant_storage_connector_id" in introspection),
        "public introspection should not leak storage connector ids"
      );
      assert.ok(
        !("grant_storage_binding" in introspection),
        "public introspection should not leak structured storage bindings"
      );

      const { body: initialTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      const { body: trace } = await fetchReferenceTrace(asUrl, initialTimeline.trace_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      for (const event of trace.data || []) {
        if (!event.data) {
          continue;
        }
        assert.ok(
          !("storage_connector_id" in event.data),
          `${event.event_type} should not expose storage_connector_id in native traces`
        );
        assert.ok(
          !("connector_id" in event.data),
          `${event.event_type} should not expose connector_id in native traces`
        );
        if (event.data.source?.kind === "provider_native") {
          assert.equal(event.data.source.id, nativeManifest.provider_id);
        }
      }
      const requestEvent = trace.data.find((event) => event.event_type === "request.submitted");
      assert.ok(requestEvent, "trace should include request.submitted");
      assert.equal(requestEvent.data.source?.kind, "provider_native");
      assert.equal(requestEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(
        !("storage_connector_id" in requestEvent.data),
        "native request event should not expose storage connector ids"
      );

      const consentApprovedEvent = trace.data.find((event) => event.event_type === "consent.approved");
      assert.ok(consentApprovedEvent, "trace should include consent.approved");
      assert.equal(consentApprovedEvent.data.source?.kind, "provider_native");
      assert.equal(consentApprovedEvent.data.source?.id, nativeManifest.provider_id);

      const issuedEvent = initialTimeline.data.find((event) => event.event_type === "grant.issued");
      assert.ok(issuedEvent, "grant timeline should include grant.issued");
      assert.equal(issuedEvent.data.source?.kind, "provider_native");
      assert.equal(issuedEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in issuedEvent.data), "native grant-issued event should not expose connector_id");
      assert.ok(
        !("storage_connector_id" in issuedEvent.data),
        "native grant-issued event should not expose storage connector ids"
      );

      const tokenIssuedEvent = initialTimeline.data.find((event) => event.event_type === "token.issued");
      assert.ok(tokenIssuedEvent, "grant timeline should include token.issued");
      assert.equal(tokenIssuedEvent.data.source?.kind, "provider_native");
      assert.equal(tokenIssuedEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(tokenIssuedEvent.data.issuance_path, "grant_approval");
      assert.ok(!("connector_id" in tokenIssuedEvent.data), "native token-issued event should not expose connector_id");
      assert.ok(
        !("storage_connector_id" in tokenIssuedEvent.data),
        "native token-issued event should not expose storage connector ids"
      );

      const clientStreamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(clientStreamsResp.status, 200);
      const clientStreamsRequestId = clientStreamsResp.headers.get("Request-Id");
      const clientStreamsTraceId = clientStreamsResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(clientStreamsRequestId?.startsWith("req_"));
      assert.equal(clientStreamsTraceId, initialTimeline.trace_id);
      const clientStreamsBody = parseResourceStreamListResponse(await clientStreamsResp.json());
      assert.deepEqual(
        clientStreamsBody.data.map((stream) => stream.name),
        ["pay_statements", "equity_grants"]
      );

      const streamMetadataResp = await fetch(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamMetadataResp.status, 200);
      const streamMetadataRequestId = streamMetadataResp.headers.get("Request-Id");
      const streamMetadataTraceId = streamMetadataResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(streamMetadataRequestId?.startsWith("req_"));
      assert.equal(streamMetadataTraceId, initialTimeline.trace_id);
      const streamMetadataBody = parseResourceStreamMetadataResponse(await streamMetadataResp.json());
      assert.equal(streamMetadataBody.object, "stream_metadata");
      assert.equal(streamMetadataBody.name, "pay_statements");

      const recordsResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordsResp.status, 200);
      const recordsRequestId = recordsResp.headers.get("Request-Id");
      const recordsTraceId = recordsResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(recordsRequestId?.startsWith("req_"));
      assert.equal(recordsTraceId, initialTimeline.trace_id);
      const recordsBody = parseResourceRecordListResponse(await recordsResp.json());
      assert.equal(recordsBody.data.length, 1);
      assert.equal(requireFirst(recordsBody.data, "native client records").id, "ps_2026_04_15");

      const connectionScopedClientResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connection_id=not_a_native_concept`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );
      assert.equal(connectionScopedClientResp.status, 400);
      const connectionScopedClientBody = parseErrorResponse(await connectionScopedClientResp.json());
      assert.equal(connectionScopedClientBody.error.code, "invalid_argument");
      assert.match(connectionScopedClientBody.error.message, REGEXP_88);

      const recordResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records/ps_2026_04_15`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordResp.status, 200);
      const recordRequestId = recordResp.headers.get("Request-Id");
      const recordTraceId = recordResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(recordRequestId?.startsWith("req_"));
      assert.equal(recordTraceId, initialTimeline.trace_id);
      const recordBody = parseResourceRecordDetailResponse(await recordResp.json());
      assert.equal(recordBody.id, "ps_2026_04_15");

      const { body: postQueryTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      for (const event of postQueryTimeline.data || []) {
        if (!event.data) {
          continue;
        }
        assert.ok(
          !("storage_connector_id" in event.data),
          `${event.event_type} should not expose storage_connector_id in native grant timelines`
        );
        assert.ok(
          !("connector_id" in event.data),
          `${event.event_type} should not expose connector_id in native grant timelines`
        );
        if (event.data.source?.kind === "provider_native") {
          assert.equal(event.data.source.id, nativeManifest.provider_id);
        }
      }
      const streamListQueryEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === clientStreamsRequestId
      );
      assert.ok(streamListQueryEvent, "grant timeline should include query.received for native stream list");
      assert.equal(streamListQueryEvent.data.source?.kind, "provider_native");
      assert.equal(streamListQueryEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(streamListQueryEvent.data.query_shape, "stream_list");
      assert.ok(
        !("storage_connector_id" in streamListQueryEvent.data),
        "native stream-list query should not expose storage connector ids"
      );

      const streamListDisclosureEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === clientStreamsRequestId
      );
      assert.ok(streamListDisclosureEvent, "grant timeline should include disclosure.served for native stream list");
      assert.equal(streamListDisclosureEvent.data.source?.kind, "provider_native");
      assert.equal(streamListDisclosureEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(streamListDisclosureEvent.data.query_shape, "stream_list");
      assert.ok(
        !("storage_connector_id" in streamListDisclosureEvent.data),
        "native stream-list disclosure should not expose storage connector ids"
      );

      const streamMetadataQueryEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === streamMetadataRequestId
      );
      assert.ok(streamMetadataQueryEvent, "grant timeline should include query.received for native stream metadata");
      assert.equal(streamMetadataQueryEvent.stream_id, "pay_statements");
      assert.equal(streamMetadataQueryEvent.data.query_shape, "stream_metadata");

      const streamMetadataDisclosureEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === streamMetadataRequestId
      );
      assert.ok(
        streamMetadataDisclosureEvent,
        "grant timeline should include disclosure.served for native stream metadata"
      );
      assert.equal(streamMetadataDisclosureEvent.stream_id, "pay_statements");
      assert.equal(streamMetadataDisclosureEvent.data.query_shape, "stream_metadata");

      const recordsQueryEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === recordsRequestId
      );
      assert.ok(recordsQueryEvent, "grant timeline should include query.received for native record list disclosure");
      assert.equal(recordsQueryEvent.data.query_shape, "record_list");

      const recordQueryEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === recordRequestId
      );
      assert.ok(recordQueryEvent, "grant timeline should include query.received for native single-record disclosure");
      assert.equal(recordQueryEvent.data.requested_record_id, "ps_2026_04_15");

      const recordDisclosureEvent = postQueryTimeline.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === recordRequestId
      );
      assert.ok(
        recordDisclosureEvent,
        "grant timeline should include disclosure.served for native single-record disclosure"
      );
      assert.equal(recordDisclosureEvent.data.requested_record_id, "ps_2026_04_15");
      assert.equal(recordDisclosureEvent.data.record_count, 1);

      const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approved.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });
      assert.equal(revokeResp.status, 200);

      const { body: revokedTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      const revokedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoked");
      assert.ok(revokedEvent, "grant timeline should include grant.revoked after native revocation");
      assert.equal(revokedEvent.data.source?.kind, "provider_native");
      assert.equal(revokedEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in revokedEvent.data), "native revoked event should not expose connector_id");
      assert.ok(
        !("storage_connector_id" in revokedEvent.data),
        "native revoked event should not expose storage connector ids"
      );
    });
  });

  await t.test(
    "native persisted grant bindings with unsupported fields are rejected on introspection and revocation",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        await mutateGrantSource(approved.grant.grant_id, (source) => ({
          ...source,
          connector_id: "should_not_escape",
          debug_context: "should_not_escape",
          storage_connector_id: nativeManifest.storage_binding.connector_id,
        }));
        await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
          ...storageBinding,
          debug_context: "should_not_escape",
        }));

        const { body: introspection } = await introspectToken(asUrl, approved.token);
        assert.equal(introspection.active, false);
        assert.equal(introspection.inactive_reason, "grant_invalid");
        assert.ok(!("grant" in introspection), "malformed native persisted grants should not be surfaced publicly");

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_89);

        const { body: revokedTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const revokedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoked");
        assert.equal(
          revokedEvent,
          undefined,
          "malformed native persisted grants should not emit degraded grant.revoked artifacts"
        );
      });
    }
  );

  await t.test(
    "native malformed grant revocation preserves provider-first source when only storage binding drifts",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        await mutateGrantStorageBinding(approved.grant.grant_id, (storageBinding) => ({
          ...storageBinding,
          debug_context: "should_not_escape",
        }));

        const revokeResp = await fetch(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeRequestId = revokeResp.headers.get("Request-Id");
        const revokeTraceId = revokeResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(revokeRequestId?.startsWith("req_"));
        assert.ok(revokeTraceId?.startsWith("trc_"));

        const { body: revokedTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const rejectedEvent = revokedTimeline.data.find((event) => event.event_type === "grant.revoke_rejected");
        assert.ok(rejectedEvent, "malformed native persisted grants should emit grant.revoke_rejected artifacts");
        assert.equal(rejectedEvent.request_id, revokeRequestId);
        assert.equal(rejectedEvent.trace_id, revokeTraceId);
        assert.equal(rejectedEvent.data?.source?.kind, "provider_native");
        assert.equal(rejectedEvent.data?.source?.id, nativeManifest.provider_id);
        assert.ok(
          !("connector_id" in (rejectedEvent.data || {})),
          "native revoke rejection should not expose connector_id"
        );
        assert.ok(
          !("storage_connector_id" in (rejectedEvent.data || {})),
          "native revoke rejection should not expose storage connector ids"
        );
        assert.equal(rejectedEvent.data?.error?.code, "grant_invalid");
      });
    }
  );

  await t.test("native client reads reject malformed grant storage bindings as invalid grants", async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/northstar-hr.json"), "utf8"));
    let server = await startServer({
      asPort: 0,
      dbPath,
      nativeManifest,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }, { name: "equity_grants", view: "summary" }],
      });

      getDb()
        .prepare(`
        UPDATE grants
        SET storage_binding_json = ?
        WHERE grant_id = ?
      `)
        .run(JSON.stringify({ connector_id: "missing_native_storage_connector" }), approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
        asPort: server.asPort,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: server.rsPort,
      });

      async function assertMalformedNativeClientRead(
        path: string,
        _queryShape: string,
        _streamId: string | null = null,
        _requestedRecordId: string | null = null
      ) {
        const rejectedResp = await fetch(`${rsUrl}${path}`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "grant_invalid");
        assert.match(rejectedBody.error.message, REGEXP_90);
        assert.doesNotMatch(rejectedBody.error.message, REGEXP_162);
      }

      await assertMalformedNativeClientRead("/v1/streams", "stream_list");
      await assertMalformedNativeClientRead("/v1/streams/pay_statements", "stream_metadata", "pay_statements");
      await assertMalformedNativeClientRead("/v1/streams/pay_statements/records", "record_list", "pay_statements");
      await assertMalformedNativeClientRead(
        "/v1/streams/pay_statements/records/ps_2026_04_15",
        "record_detail",
        "pay_statements",
        "ps_2026_04_15"
      );
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test("native client reads reject grants missing structured storage bindings", async () => {
    const { dbPath, cleanup } = createTempDbPath();
    const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/northstar-hr.json"), "utf8"));
    let server = await startServer({
      asPort: 0,
      dbPath,
      nativeManifest,
      quiet: true,
      rsPort: 0,
    });
    const asUrl = `http://localhost:${server.asPort}`;
    const rsUrl = `http://localhost:${server.rsPort}`;

    try {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }, { name: "equity_grants", view: "summary" }],
      });

      getDb()
        .prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `)
        .run(approved.grant.grant_id);

      await closeServer(server);
      server = await startServer({
        asPort: server.asPort,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: server.rsPort,
      });

      const streamsResp = await fetchJson(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(streamsResp.status, 403);
      assert.ok(streamsResp.headers["request-id"]?.startsWith("req_"));
      assert.ok(streamsResp.headers["pdpp-reference-trace-id"]?.startsWith("trc_"));
      assert.equal(streamsResp.body.error.code, "grant_invalid");
      assert.match(streamsResp.body.error.message, REGEXP_91);

      const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 403);
      assert.ok(metadataResp.headers["request-id"]?.startsWith("req_"));
      assert.ok(metadataResp.headers["pdpp-reference-trace-id"]?.startsWith("trc_"));
      assert.equal(metadataResp.body.error.code, "grant_invalid");
      assert.match(metadataResp.body.error.message, REGEXP_92);

      const recordResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records/ps_2026_04_15`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(recordResp.status, 403);
      assert.ok(recordResp.headers["request-id"]?.startsWith("req_"));
      assert.ok(recordResp.headers["pdpp-reference-trace-id"]?.startsWith("trc_"));
      assert.equal(recordResp.body.error.code, "grant_invalid");
      assert.match(recordResp.body.error.message, REGEXP_93);
    } finally {
      await closeServer(server);
      cleanup();
    }
  });

  await t.test(
    "polyfill client reads fail connector-first when the persisted storage binding points to an unknown connector",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
      let server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);

        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);
        const ownerRecordListResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const visibleRecord = ownerRecordListResp.body.data?.[0];
        assert.ok(visibleRecord, "expected an owner-visible top_artists record before corrupting the grant binding");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        const missingConnectorId = "missing_spotify_connector";
        const remappedGrant = JSON.parse(JSON.stringify(approved.grant));
        remappedGrant.source = {
          id: missingConnectorId,
          kind: "connector",
        };

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?,
            storage_binding_json = ?
        WHERE grant_id = ?
      `)
          .run(
            JSON.stringify(remappedGrant),
            JSON.stringify({ connector_id: missingConnectorId }),
            approved.grant.grant_id
          );

        await closeServer(server);
        server = await startServer({
          asPort: server.asPort,
          dbPath,
          dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
          quiet: true,
          rsPort: server.rsPort,
        });

        const reRegisterResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reRegisterResp.status, 201);

        async function assertBrokenPolyfillClientRead(
          path: string,
          queryShape: string,
          streamId: string | null = null,
          requestedRecordId: string | null = null
        ) {
          const rejectedResp = await fetch(`${rsUrl}${path}`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          });
          assert.equal(rejectedResp.status, 404);
          const rejectedRequestId = rejectedResp.headers.get("Request-Id");
          const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
          assert.ok(rejectedRequestId?.startsWith("req_"));
          assert.ok(rejectedTraceId?.startsWith("trc_"));
          const rejectedBody = parseErrorResponse(await rejectedResp.json());
          assert.equal(rejectedBody.error.code, "not_found");
          assert.match(rejectedBody.error.message, REGEXP_94);

          const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
          const queryReceivedEvent = timeline.data.find(
            (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
          );
          assert.ok(
            queryReceivedEvent,
            `grant timeline should include query.received for broken polyfill ${queryShape} reads`
          );
          assert.equal(queryReceivedEvent.data.query_shape, queryShape);
          assert.equal(queryReceivedEvent.data.source?.kind, "connector");
          assert.equal(queryReceivedEvent.data.source?.id, missingConnectorId);
          if (streamId) {
            assert.equal(queryReceivedEvent.stream_id, streamId);
          }
          if (requestedRecordId) {
            assert.equal(queryReceivedEvent.data.requested_record_id, requestedRecordId);
          }

          const rejectedEvent = timeline.data.find(
            (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
          );
          assert.ok(
            rejectedEvent,
            `grant timeline should include query.rejected for broken polyfill ${queryShape} reads`
          );
          assert.equal(rejectedEvent.trace_id, rejectedTraceId);
          assert.equal(rejectedEvent.data.query_shape, queryShape);
          assert.equal(rejectedEvent.data.source?.kind, "connector");
          assert.equal(rejectedEvent.data.source?.id, missingConnectorId);
          assert.equal(rejectedEvent.data.error?.code, "not_found");
          assert.match(rejectedEvent.data.error?.message || "", REGEXP_95);
          if (streamId) {
            assert.equal(rejectedEvent.stream_id, streamId);
          }

          const servedEvent = timeline.data.find(
            (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
          );
          assert.equal(
            servedEvent,
            undefined,
            `broken polyfill ${queryShape} reads should not produce disclosure.served`
          );
        }

        await assertBrokenPolyfillClientRead("/v1/streams", "stream_list");
        await assertBrokenPolyfillClientRead("/v1/streams/top_artists", "stream_metadata", "top_artists");
        await assertBrokenPolyfillClientRead("/v1/streams/top_artists/records", "record_list", "top_artists");
        await assertBrokenPolyfillClientRead(
          `/v1/streams/top_artists/records/${encodeURIComponent(visibleRecord.id)}`,
          "record_detail",
          "top_artists",
          visibleRecord.id
        );
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "native client introspection and revocation reject grants missing structured source bindings",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const nativeManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/northstar-hr.json"), "utf8"));
      let server = await startServer({
        asPort: 0,
        dbPath,
        nativeManifest,
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;

      try {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }, { name: "equity_grants", view: "summary" }],
        });

        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.source = undefined;

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        await closeServer(server);
        server = await startServer({
          asPort: server.asPort,
          dbPath,
          nativeManifest,
          quiet: true,
          rsPort: server.rsPort,
        });

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");
        assert.ok(
          !("grant" in introspectResp.body),
          "malformed persisted grant source should not be surfaced publicly"
        );

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_96);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "malformed grants should not emit degraded grant.revoked artifacts"
        );
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "polyfill client introspection and revocation reject grants missing structured source bindings",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
      let server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;

      try {
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);

        const approved = await approveGrant(asUrl, "owner_local", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }, { name: "recently_played" }],
        });

        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.source = undefined;

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        await closeServer(server);
        server = await startServer({
          asPort: server.asPort,
          dbPath,
          dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
          quiet: true,
          rsPort: server.rsPort,
        });

        const reRegisterResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(reRegisterResp.status, 201);

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");
        assert.ok(
          !("grant" in introspectResp.body),
          "malformed persisted grant source should not be surfaced publicly"
        );

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_97);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "malformed grants should not emit degraded grant.revoked artifacts"
        );
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "polyfill client introspection and reads reject persisted grants with stream contracts that no longer resolve against the manifest",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);

        const approved = await approveGrant(asUrl, "owner_local", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });
        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.streams = [{ name: "missing_stream" }];

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");

        const streamsResp = await fetchJson(`${rsUrl}/v1/streams`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(streamsResp.status, 403);
        assert.equal(streamsResp.body.error.code, "grant_invalid");
        assert.match(streamsResp.body.error.message, REGEXP_98);

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_99);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "manifest-drifted grants should not emit degraded grant.revoked artifacts"
        );
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "polyfill client introspection and reads reject persisted grants whose manifest_version no longer matches the current manifest",
    async () => {
      const { dbPath, cleanup } = createTempDbPath();
      const spotifyManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/spotify.json"), "utf8"));
      const server = await startServer({
        asPort: 0,
        dbPath,
        dynamicClientRegistrationInitialAccessTokens: [TEST_DCR_INITIAL_ACCESS_TOKEN],
        quiet: true,
        rsPort: 0,
      });
      const asUrl = `http://localhost:${server.asPort}`;
      const rsUrl = `http://localhost:${server.rsPort}`;

      try {
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(spotifyManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);

        const approved = await approveGrant(asUrl, "owner_local", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });
        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.manifest_version = "999.0.0";

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");

        const metadataResp = await fetchJson(`${rsUrl}/v1/streams/top_artists`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(metadataResp.status, 403);
        assert.equal(metadataResp.body.error.code, "grant_invalid");
        assert.match(metadataResp.body.error.message, REGEXP_100);

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_101);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "manifest-version drifted grants should not emit degraded grant.revoked artifacts"
        );
      } finally {
        await closeServer(server);
        cleanup();
      }
    }
  );

  await t.test(
    "native client introspection and reads reject persisted grants with stream contracts that no longer resolve against the manifest",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });
        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.streams = [{ name: "missing_stream" }];

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");

        const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(metadataResp.status, 403);
        assert.equal(metadataResp.body.error.code, "grant_invalid");
        assert.match(metadataResp.body.error.message, REGEXP_102);

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_103);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "manifest-drifted native grants should not emit degraded grant.revoked artifacts"
        );
      });
    }
  );

  await t.test(
    "native client introspection and reads reject persisted grants whose manifest_version no longer matches the current manifest",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });
        const { body: timelineBeforeRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsBefore = (timelineBeforeRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.manifest_version = "999.0.0";

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        const introspectResp = await introspectFormToken(asUrl, approved.token);
        assert.equal(introspectResp.status, 200);
        assert.equal(introspectResp.body.active, false);
        assert.equal(introspectResp.body.inactive_reason, "grant_invalid");

        const metadataResp = await fetchJson(`${rsUrl}/v1/streams/pay_statements`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(metadataResp.status, 403);
        assert.equal(metadataResp.body.error.code, "grant_invalid");
        assert.match(metadataResp.body.error.message, REGEXP_104);

        const revokeResp = await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
          headers: {
            Authorization: `Bearer ${approved.token}`,
            "Content-Type": "application/json",
          },
          method: "POST",
        });
        assert.equal(revokeResp.status, 403);
        const revokeError = parseErrorResponse(revokeResp.body);
        assert.equal(revokeError.error.code, "grant_invalid");
        assert.match(revokeError.error.message, REGEXP_105);

        const { body: timelineAfterRevoke } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const revokedEventsAfter = (timelineAfterRevoke.data || []).filter(
          (event) => event.event_type === "grant.revoked"
        ).length;
        assert.equal(
          revokedEventsAfter,
          revokedEventsBefore,
          "manifest-version drifted native grants should not emit degraded grant.revoked artifacts"
        );
      });
    }
  );

  await t.test("native provider grants reject an unknown provider_id", async () => {
    await withNativeHarness(async ({ asUrl }) => {
      const initiateResp = await fetch(`${asUrl}/oauth/par`, {
        body: JSON.stringify({
          authorization_details: [
            {
              access_mode: "continuous",
              purpose_code: "https://pdpp.org/purpose/financial_planning",
              source: { id: "wrong_provider", kind: "provider_native" },
              streams: [{ name: "pay_statements" }],
              type: "https://pdpp.org/data-access",
            },
          ],
          client_id: "longview",
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });

      assert.equal(initiateResp.status, 400);
      const initiateBody = parseErrorResponse(await initiateResp.json());
      assert.equal(initiateBody.error.code, "invalid_request");
      assert.match(initiateBody.error.message, REGEXP_106);
    });
  });

  await t.test(
    "native provider grants reject requests that mix legacy source scalars with source objects",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const initiateResp = await fetch(`${asUrl}/oauth/par`, {
          body: JSON.stringify({
            authorization_details: [
              {
                access_mode: "continuous",
                connector_id: "spotify",
                purpose_code: "https://pdpp.org/purpose/financial_planning",
                source: {
                  id: nativeManifest.provider_id,
                  kind: "provider_native",
                },
                streams: [{ name: "pay_statements" }],
                type: "https://pdpp.org/data-access",
              },
            ],
            client_id: "longview",
          }),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        assert.equal(initiateResp.status, 400);
        const initiateBody = parseErrorResponse(await initiateResp.json());
        assert.equal(initiateBody.error.code, "invalid_request");
        assert.match(initiateBody.error.message, REGEXP_107);
      });
    }
  );

  await t.test("malformed persisted native pending requests are rejected instead of normalized", async () => {
    await withNativeHarness(async ({ asUrl, nativeManifest }) => {
      const initiate = await startGrantRequest(asUrl, {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });

      assert.equal(initiate.status, 201);
      const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
      assert.ok(deviceCode, "request_uri should decode to a pending device code");

      const rows = getDb()
        .prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `)
        .all(deviceCode);
      assert.equal(rows.length, 1);

      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const pendingRow = rows[0];
      assert.ok(pendingRow, "expected pending consent row");
      const malformedRequest = JSON.parse(requireString(pendingRow.params_json, "pending consent params_json"));
      malformedRequest.source_binding = undefined;

      getDb()
        .prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `)
        .run(JSON.stringify(malformedRequest), deviceCode);

      const consentResp = await fetchJson(
        `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
      );
      assert.equal(consentResp.status, 400);
      assert.equal(consentResp.body.error.code, "invalid_request");
      assert.match(consentResp.body.error.message, REGEXP_108);

      const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "employee_1");
      assert.equal(approveResp.status, 400);
      assert.equal(approveResp.body.error.code, "invalid_request");
      assert.match(approveResp.body.error.message, REGEXP_109);
    });
  });

  await t.test(
    "malformed persisted native pending request bindings with unsupported fields are rejected instead of normalized",
    async () => {
      await withNativeHarness(async ({ asUrl, nativeManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Support compensation planning and verification",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        assert.equal(initiate.status, 201);
        const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
        assert.ok(deviceCode, "request_uri should decode to a pending device code");

        const rows = getDb()
          .prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `)
          .all(deviceCode);
        assert.equal(rows.length, 1);

        // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
        const pendingRow = rows[0];
        assert.ok(pendingRow, "expected pending consent row");
        const malformedRequest = JSON.parse(requireString(pendingRow.params_json, "pending consent params_json"));
        malformedRequest.source_binding.debug_context = "should_not_escape";
        malformedRequest.storage_binding.debug_context = "should_not_escape";

        getDb()
          .prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `)
          .run(JSON.stringify(malformedRequest), deviceCode);

        const consentResp = await fetchJson(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_110);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "employee_1");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_111);
      });
    }
  );

  await t.test(
    "malformed persisted polyfill pending requests with mismatched bindings are rejected instead of normalized",
    async () => {
      await withHarness(async ({ asUrl, spotifyManifest }) => {
        const initiate = await startGrantRequest(asUrl, {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/concert_recommendation",
          purpose_description: "Recommend concerts and nearby live events",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        assert.equal(initiate.status, 201);
        const deviceCode = parsePendingConsentRequestUri(initiate.body.request_uri);
        assert.ok(deviceCode, "request_uri should decode to a pending device code");

        const rows = getDb()
          .prepare(`
        SELECT params_json
        FROM pending_consents
        WHERE device_code = ?
      `)
          .all(deviceCode);
        assert.equal(rows.length, 1);

        // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
        const pendingRow = rows[0];
        assert.ok(pendingRow, "expected pending consent row");
        const malformedRequest = JSON.parse(requireString(pendingRow.params_json, "pending consent params_json"));
        malformedRequest.source_binding.id = "other_connector";

        getDb()
          .prepare(`
        UPDATE pending_consents
        SET params_json = ?
        WHERE device_code = ?
      `)
          .run(JSON.stringify(malformedRequest), deviceCode);

        const consentResp = await fetchJson(
          `${asUrl}/consent?request_uri=${encodeURIComponent(initiate.body.request_uri)}`
        );
        assert.equal(consentResp.status, 400);
        assert.equal(consentResp.body.error.code, "invalid_request");
        assert.match(consentResp.body.error.message, REGEXP_112);

        const approveResp = await approveGrantRejection(asUrl, initiate.body.request_uri, "owner_local");
        assert.equal(approveResp.status, 400);
        assert.equal(approveResp.body.error.code, "invalid_request");
        assert.match(approveResp.body.error.message, REGEXP_113);
      });
    }
  );

  await t.test("native provider owner queries do not require public connector_id", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "employee_1");
      await seedNorthstar(nativeManifest);

      const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(streamsResp.status, 200);
      const streamsRequestId = streamsResp.headers.get("Request-Id");
      const streamsTraceId = streamsResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(streamsRequestId?.startsWith("req_"));
      assert.ok(streamsTraceId?.startsWith("trc_qry_"));
      const streamsBody = parseResourceStreamListResponse(await streamsResp.json());
      assert.deepEqual(
        streamsBody.data.map((stream) => stream.name),
        ["benefits_enrollments", "equity_grants", "pay_statements"]
      );

      const streamMetadataResp = await fetch(`${rsUrl}/v1/streams/pay_statements`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(streamMetadataResp.status, 200);
      const streamMetadataRequestId = streamMetadataResp.headers.get("Request-Id");
      const streamMetadataTraceId = streamMetadataResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(streamMetadataRequestId?.startsWith("req_"));
      assert.ok(streamMetadataTraceId?.startsWith("trc_qry_"));
      const streamMetadataBody = parseResourceStreamMetadataResponse(await streamMetadataResp.json());
      const payStatementsManifest = nativeManifest.streams.find((stream) => stream.name === "pay_statements");
      assert.ok(payStatementsManifest, "expected pay_statements native manifest entry");
      assert.equal(streamMetadataBody.name, "pay_statements");
      assert.equal(streamMetadataBody.semantics, payStatementsManifest.semantics);
      assert.equal(streamMetadataBody.consent_time_field, payStatementsManifest.consent_time_field);
      assert.deepEqual(streamMetadataBody.primary_key, [payStatementsManifest.primary_key]);

      const recordsResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(recordsResp.status, 200);
      const recordsRequestId = recordsResp.headers.get("Request-Id");
      const recordsTraceId = recordsResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(recordsRequestId?.startsWith("req_"));
      assert.ok(recordsTraceId?.startsWith("trc_qry_"));
      const recordsBody = parseResourceRecordListResponse(await recordsResp.json());
      assert.equal(recordsBody.data.length, 1);
      const firstOwnerRecord = requireFirst(recordsBody.data, "native owner records");
      assert.equal(firstOwnerRecord.id, "ps_2026_04_15");
      assert.equal(firstOwnerRecord.data.employer, "Northstar HR");

      const connectionScopedOwnerResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?connection_id=not_a_native_concept`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(connectionScopedOwnerResp.status, 400);
      const connectionScopedOwnerBody = parseErrorResponse(await connectionScopedOwnerResp.json());
      assert.equal(connectionScopedOwnerBody.error.code, "invalid_argument");
      assert.match(connectionScopedOwnerBody.error.message, REGEXP_114);

      const { body: streamsTrace } = await fetchReferenceTrace(asUrl, streamsTraceId);
      const { body: streamMetadataTrace } = await fetchReferenceTrace(asUrl, streamMetadataTraceId);
      const { body: ownerTrace } = await fetchReferenceTrace(asUrl, recordsTraceId);

      const ownerStreamListQueryEvent = streamsTrace.data.find(
        (event) => event.event_type === "query.received" && event.object_id === streamsRequestId
      );
      assert.ok(ownerStreamListQueryEvent, "owner self-export trace should include query.received for stream list");
      assert.equal(ownerStreamListQueryEvent.data.query_shape, "stream_list");
      assert.equal(ownerStreamListQueryEvent.actor_type, "subject");
      assert.equal(ownerStreamListQueryEvent.subject_id, "employee_1");
      assert.equal(ownerStreamListQueryEvent.data.source?.kind, "provider_native");
      assert.ok(
        !("connector_id" in ownerStreamListQueryEvent.data),
        "owner stream-list query event should not expose connector_id"
      );

      const ownerStreamListDisclosureEvent = streamsTrace.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === streamsRequestId
      );
      assert.ok(
        ownerStreamListDisclosureEvent,
        "owner self-export trace should include disclosure.served for stream list"
      );
      assert.equal(ownerStreamListDisclosureEvent.data.query_shape, "stream_list");
      assert.equal(ownerStreamListDisclosureEvent.actor_type, "subject");
      assert.equal(ownerStreamListDisclosureEvent.subject_id, "employee_1");
      assert.equal(ownerStreamListDisclosureEvent.data.source?.kind, "provider_native");
      assert.ok(
        !("connector_id" in ownerStreamListDisclosureEvent.data),
        "owner stream-list disclosure event should not expose connector_id"
      );

      const ownerStreamMetadataQueryEvent = streamMetadataTrace.data.find(
        (event) => event.event_type === "query.received" && event.object_id === streamMetadataRequestId
      );
      assert.ok(
        ownerStreamMetadataQueryEvent,
        "owner self-export trace should include query.received for stream metadata"
      );
      assert.equal(ownerStreamMetadataQueryEvent.stream_id, "pay_statements");
      assert.equal(ownerStreamMetadataQueryEvent.data.query_shape, "stream_metadata");
      assert.equal(ownerStreamMetadataQueryEvent.data.source?.kind, "provider_native");
      assert.ok(
        !("connector_id" in ownerStreamMetadataQueryEvent.data),
        "owner stream-metadata query event should not expose connector_id"
      );

      const ownerStreamMetadataDisclosureEvent = streamMetadataTrace.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === streamMetadataRequestId
      );
      assert.ok(
        ownerStreamMetadataDisclosureEvent,
        "owner self-export trace should include disclosure.served for stream metadata"
      );
      assert.equal(ownerStreamMetadataDisclosureEvent.stream_id, "pay_statements");
      assert.equal(ownerStreamMetadataDisclosureEvent.data.query_shape, "stream_metadata");
      assert.equal(ownerStreamMetadataDisclosureEvent.data.source?.kind, "provider_native");
      assert.ok(
        !("connector_id" in ownerStreamMetadataDisclosureEvent.data),
        "owner stream-metadata disclosure event should not expose connector_id"
      );

      const ownerQueryEvent = ownerTrace.data.find(
        (event) => event.event_type === "query.received" && event.object_id === recordsRequestId
      );
      assert.ok(ownerQueryEvent, "owner self-export trace should include query.received");
      assert.equal(ownerQueryEvent.object_id, recordsRequestId);
      assert.equal(ownerQueryEvent.actor_type, "subject");
      assert.equal(ownerQueryEvent.subject_id, "employee_1");
      assert.equal(ownerQueryEvent.data.source?.kind, "provider_native");
      assert.equal(ownerQueryEvent.data.source?.id, nativeManifest.provider_id);
      assert.ok(!("connector_id" in ownerQueryEvent.data), "owner trace query event should not expose connector_id");

      const ownerDisclosureEvent = ownerTrace.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === recordsRequestId
      );
      assert.ok(ownerDisclosureEvent, "owner self-export trace should include disclosure.served");
      assert.equal(ownerDisclosureEvent.object_id, recordsRequestId);
      assert.equal(ownerDisclosureEvent.actor_type, "subject");
      assert.equal(ownerDisclosureEvent.subject_id, "employee_1");
      assert.equal(ownerDisclosureEvent.data.source?.kind, "provider_native");
      assert.equal(ownerDisclosureEvent.data.source?.id, nativeManifest.provider_id);
      assert.equal(ownerDisclosureEvent.data.record_count, 1);
      assert.ok(
        !("connector_id" in ownerDisclosureEvent.data),
        "owner trace disclosure event should not expose connector_id"
      );
    });
  });

  await t.test("polyfill owner reads fail connector-first when the requested connector is unknown", async () => {
    await withHarness(async ({ asUrl, rsUrl }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      const missingConnectorId = "missing_spotify_connector";

      const rejectedResp = await fetch(`${rsUrl}/v1/streams?connector_id=${encodeURIComponent(missingConnectorId)}`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
      const rejectedBody = parseErrorResponse(await rejectedResp.json());
      assert.equal(rejectedBody.error.code, "not_found");
      assert.match(rejectedBody.error.message, REGEXP_115);

      const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
      const queryReceivedEvent = trace.data.find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, "owner trace should include query.received for broken polyfill owner reads");
      assert.equal(queryReceivedEvent.data.query_shape, "stream_list");
      assert.equal(queryReceivedEvent.actor_type, "subject");
      assert.equal(queryReceivedEvent.subject_id, "u1");
      assert.equal(queryReceivedEvent.data.source?.kind, "connector");
      assert.equal(queryReceivedEvent.data.source?.id, missingConnectorId);

      const rejectedEvent = trace.data.find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, "owner trace should include query.rejected for broken polyfill owner reads");
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.data.query_shape, "stream_list");
      assert.equal(rejectedEvent.data.source?.kind, "connector");
      assert.equal(rejectedEvent.data.source?.id, missingConnectorId);
      assert.equal(rejectedEvent.data.error?.code, "not_found");
      assert.match(rejectedEvent.data.error?.message || "", REGEXP_116);

      const servedEvent = trace.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
      );
      assert.equal(servedEvent, undefined, "broken polyfill owner reads should not produce disclosure.served");
    });
  });

  await t.test(
    "polyfill owner reads reject duplicate connector_id query params instead of normalizing them into owner scope",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const duplicateQuery = new URLSearchParams();
        duplicateQuery.append("connector_id", spotifyManifest.connector_id);
        duplicateQuery.append("connector_id", "unexpected_second_value");

        const rejectedResp = await fetch(`${rsUrl}/v1/streams?${duplicateQuery.toString()}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "invalid_request");
        assert.match(rejectedBody.error.message, REGEXP_117);

        const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
        const queryReceivedEvent = trace.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, "owner trace should include query.received for duplicate connector_id reads");
        assert.equal(queryReceivedEvent.data.query_shape, "stream_list");
        assert.equal(
          queryReceivedEvent.data.source,
          null,
          "duplicate connector_id should not be normalized into a connector-shaped owner source"
        );

        const rejectedEvent = trace.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "owner trace should include query.rejected for duplicate connector_id reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.data.query_shape, "stream_list");
        assert.equal(
          rejectedEvent.data.source,
          null,
          "duplicate connector_id should not be normalized into a connector-shaped rejection source"
        );
        assert.equal(rejectedEvent.data.error?.code, "invalid_request");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_118);
      });
    }
  );

  await t.test(
    "polyfill owner stream metadata rejects duplicate connector_id query params and preserves null-source trace artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const duplicateQuery = new URLSearchParams();
        duplicateQuery.append("connector_id", spotifyManifest.connector_id);
        duplicateQuery.append("connector_id", "unexpected_second_value");

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists?${duplicateQuery.toString()}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "invalid_request");
        assert.match(rejectedBody.error.message, REGEXP_119);

        const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
        const queryReceivedEvent = trace.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "owner trace should include query.received for duplicate connector_id metadata reads"
        );
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "stream_metadata");
        assert.equal(queryReceivedEvent.data.source, null);

        const rejectedEvent = trace.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "owner trace should include query.rejected for duplicate connector_id metadata reads");
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "stream_metadata");
        assert.equal(rejectedEvent.data.source, null);
        assert.equal(rejectedEvent.data.error?.code, "invalid_request");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_120);
      });
    }
  );

  await t.test(
    "polyfill owner record-list rejects duplicate connector_id query params and preserves null-source trace artifacts",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const duplicateQuery = new URLSearchParams();
        duplicateQuery.append("connector_id", spotifyManifest.connector_id);
        duplicateQuery.append("connector_id", "unexpected_second_value");
        duplicateQuery.append("limit", "2");

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?${duplicateQuery.toString()}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "invalid_request");
        assert.match(rejectedBody.error.message, REGEXP_121);

        const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
        const queryReceivedEvent = trace.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "owner trace should include query.received for duplicate connector_id record-list reads"
        );
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.limit, 2);
        assert.equal(queryReceivedEvent.data.source, null);

        const rejectedEvent = trace.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          rejectedEvent,
          "owner trace should include query.rejected for duplicate connector_id record-list reads"
        );
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_list");
        assert.equal(rejectedEvent.data.limit, 2);
        assert.equal(rejectedEvent.data.source, null);
        assert.equal(rejectedEvent.data.error?.code, "invalid_request");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_122);
      });
    }
  );

  await t.test(
    "polyfill owner reads reject malformed persisted connector manifests instead of drifting into generic failures",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const ownerRecordListResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const visibleRecord = ownerRecordListResp.body.data?.[0];
        assert.ok(visibleRecord, "expected an owner-visible top_artists record before corrupting the manifest");

        getDb()
          .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
          .run(
            '{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
            SPOTIFY_CONNECTOR_KEY
          );

        const connectorLookupResp = await fetchJson(
          `${asUrl}/connectors/${encodeURIComponent(spotifyManifest.connector_id)}`
        );
        assert.equal(connectorLookupResp.status, 400);
        assert.equal(connectorLookupResp.body.error.code, "connector_invalid");
        assert.match(
          connectorLookupResp.body.error.message,
          new RegExp(`Connector manifest for ${spotifyManifest.connector_id} is malformed or no longer valid`)
        );

        async function assertMalformedOwnerRead(path: string, queryShape: string, streamId: string | null = null) {
          const rejectedResp = await fetch(`${rsUrl}${path}`, {
            headers: { Authorization: `Bearer ${ownerToken}` },
          });
          assert.equal(rejectedResp.status, 400);
          const rejectedRequestId = rejectedResp.headers.get("Request-Id");
          const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
          assert.ok(rejectedRequestId?.startsWith("req_"));
          assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
          // Owner read routes canonicalize the connector id at the boundary, so
          // the rejection message, the query.received source descriptor, and the
          // query.rejected message all carry the canonical connector key
          // (Decision 1), not the URL-shaped manifest id.
          const rejectedBody = parseErrorResponse(await rejectedResp.json());
          assert.equal(rejectedBody.error.code, "connector_invalid");
          assert.match(
            rejectedBody.error.message,
            new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
          );

          const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
          const queryReceivedEvent = trace.data.find(
            (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
          );
          assert.ok(queryReceivedEvent, `owner trace should include query.received for malformed ${queryShape} reads`);
          assert.equal(queryReceivedEvent.data.query_shape, queryShape);
          assert.equal(queryReceivedEvent.data.source?.kind, "connector");
          assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
          if (streamId) {
            assert.equal(queryReceivedEvent.stream_id, streamId);
          }

          const rejectedEvent = trace.data.find(
            (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
          );
          assert.ok(rejectedEvent, `owner trace should include query.rejected for malformed ${queryShape} reads`);
          assert.equal(rejectedEvent.data.query_shape, queryShape);
          assert.equal(rejectedEvent.data.error?.code, "connector_invalid");
          assert.match(
            rejectedEvent.data.error?.message || "",
            new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
          );
          if (streamId) {
            assert.equal(rejectedEvent.stream_id, streamId);
          }

          const servedEvent = trace.data.find(
            (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
          );
          assert.equal(servedEvent, undefined, `malformed ${queryShape} reads should not produce disclosure.served`);
        }

        await assertMalformedOwnerRead(
          `/v1/streams?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          "stream_list"
        );
        await assertMalformedOwnerRead(
          `/v1/streams/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          "stream_metadata",
          "top_artists"
        );
        await assertMalformedOwnerRead(
          `/v1/streams/top_artists/records/${encodeURIComponent(visibleRecord.id)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          "record_detail",
          "top_artists"
        );
      });
    }
  );

  await t.test(
    "polyfill state routes reject unknown connectors and manifest-unknown streams instead of creating orphaned state",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const missingConnectorId = "missing_spotify_connector";

        const unknownGetResp = await fetchJson(`${rsUrl}/v1/state/${encodeURIComponent(missingConnectorId)}`, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(unknownGetResp.status, 404);
        assert.equal(unknownGetResp.body.error.code, "not_found");
        assert.match(unknownGetResp.body.error.message, REGEXP_123);
        const unknownGetRequestId = unknownGetResp.headers["request-id"];
        const unknownGetTraceId = unknownGetResp.headers["pdpp-reference-trace-id"];
        assert.ok(unknownGetRequestId?.startsWith("req_"));
        assert.ok(unknownGetTraceId?.startsWith("trc_state"));

        const { body: unknownGetTrace } = await fetchReferenceTrace(asUrl, unknownGetTraceId);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const unknownGetRequested = (unknownGetTrace.data || []).find(
          (event) => event.event_type === "state.requested" && event.object_id === unknownGetRequestId
        );
        assert.ok(
          unknownGetRequested,
          "owner state traces should include state.requested for rejected unknown-connector reads"
        );
        assert.equal(unknownGetRequested.data.state_scope, "owner");
        assert.equal(unknownGetRequested.data.operation, "read");
        assert.equal(unknownGetRequested.data.source?.kind, "connector");
        assert.equal(unknownGetRequested.data.source?.id, missingConnectorId);

        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const unknownGetRejected = (unknownGetTrace.data || []).find(
          (event) => event.event_type === "state.rejected" && event.object_id === unknownGetRequestId
        );
        assert.ok(
          unknownGetRejected,
          "owner state traces should include state.rejected for rejected unknown-connector reads"
        );
        assert.equal(unknownGetRejected.data.error?.code, "not_found");
        assert.match(unknownGetRejected.data.error?.message || "", REGEXP_124);

        const unknownPutResp = await fetchJson(`${rsUrl}/v1/state/${encodeURIComponent(missingConnectorId)}`, {
          body: JSON.stringify({ state: { top_artists: { cursor: "missing_connector_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        });
        assert.equal(unknownPutResp.status, 404);
        assert.equal(unknownPutResp.body.error.code, "not_found");
        assert.match(unknownPutResp.body.error.message, REGEXP_125);

        const unknownStreamPutResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify({ state: { not_a_stream: { cursor: "missing_stream_cursor" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(unknownStreamPutResp.status, 404);
        assert.equal(unknownStreamPutResp.body.error.code, "not_found");
        assert.match(
          unknownStreamPutResp.body.error.message,
          new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`)
        );

        const stateRows = getDb()
          .prepare(`
        SELECT connector_id, stream, state_json
        FROM connector_state
        WHERE connector_id IN (?, ?)
      `)
          .all(missingConnectorId, SPOTIFY_CONNECTOR_KEY);
        assert.equal(stateRows.length, 0, "rejected state writes should not create connector_state rows");
      });
    }
  );

  await t.test(
    "polyfill state routes reject malformed persisted connector manifests instead of drifting into generic failures",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");

        getDb()
          .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
          .run(
            '{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
            SPOTIFY_CONNECTOR_KEY
          );

        const malformedGetResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(malformedGetResp.status, 400);
        assert.equal(malformedGetResp.body.error.code, "connector_invalid");
        assert.match(
          malformedGetResp.body.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
        );

        const malformedPutResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify({ state: { top_artists: { cursor: "malformed_manifest_cursor" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(malformedPutResp.status, 400);
        assert.equal(malformedPutResp.body.error.code, "connector_invalid");
        assert.match(
          malformedPutResp.body.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
        );

        const stateRows = getDb()
          .prepare(`
        SELECT connector_id, stream, state_json
        FROM connector_state
        WHERE connector_id = ?
      `)
          .all(SPOTIFY_CONNECTOR_KEY);
        assert.equal(stateRows.length, 0, "malformed-manifest state writes should not create connector_state rows");
      });
    }
  );

  await t.test(
    "grant-scoped polyfill state rejects unknown grants and connector-mismatched grants instead of creating orphaned grant state",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const githubManifest = JSON.parse(readFileSync(join(REFERENCE_IMPL_DIR, "manifests/github.json"), "utf8"));
        const githubConnectorKey = canonicalConnectorKey(githubManifest.connector_id) ?? githubManifest.connector_id;
        const ownerToken = await issueOwnerToken(asUrl, "u1");

        await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(githubManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        const unknownGrantId = "grant_missing_for_state";

        const unknownGrantGetResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(unknownGrantId)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(unknownGrantGetResp.status, 404);
        assert.equal(unknownGrantGetResp.body.error.code, "not_found");
        assert.match(unknownGrantGetResp.body.error.message, REGEXP_126);

        const unknownGrantPutResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(unknownGrantId)}`,
          {
            body: JSON.stringify({ state: { top_artists: { cursor: "missing_grant_cursor" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(unknownGrantPutResp.status, 404);
        assert.equal(unknownGrantPutResp.body.error.code, "not_found");
        assert.match(unknownGrantPutResp.body.error.message, REGEXP_127);

        const mismatchedGrantGetResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(githubManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(mismatchedGrantGetResp.status, 400);
        assert.equal(mismatchedGrantGetResp.body.error.code, "invalid_request");
        assert.match(
          mismatchedGrantGetResp.body.error.message,
          new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to connector ${githubConnectorKey}`)
        );

        const mismatchedGrantPutResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(githubManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          {
            body: JSON.stringify({ state: { pull_requests: { cursor: "mismatched_grant_cursor" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(mismatchedGrantPutResp.status, 400);
        assert.equal(mismatchedGrantPutResp.body.error.code, "invalid_request");
        assert.match(
          mismatchedGrantPutResp.body.error.message,
          new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to connector ${githubConnectorKey}`)
        );

        const grantStateRows = getDb()
          .prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id IN (?, ?)
      `)
          .all(unknownGrantId, approved.grant.grant_id);
        assert.equal(
          grantStateRows.length,
          0,
          "rejected grant-scoped state writes should not create grant_connector_state rows"
        );
      });
    }
  );

  await t.test("grant-scoped polyfill state rejects malformed persisted grant bindings as invalid grants", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
      });

      getDb()
        .prepare("UPDATE grants SET storage_binding_json = ? WHERE grant_id = ?")
        .run('{"connector_id":', approved.grant.grant_id);

      const malformedGrantGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(malformedGrantGetResp.status, 403);
      assert.equal(malformedGrantGetResp.body.error.code, "grant_invalid");
      assert.match(malformedGrantGetResp.body.error.message, REGEXP_128);
      const malformedGrantGetRequestId = malformedGrantGetResp.headers["request-id"];
      const malformedGrantGetTraceId = malformedGrantGetResp.headers["pdpp-reference-trace-id"];
      assert.ok(malformedGrantGetRequestId?.startsWith("req_"));
      assert.ok(malformedGrantGetTraceId?.startsWith("trc_"));

      const { body: malformedGrantTimeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const malformedGrantRequested = (malformedGrantTimeline.data || []).find(
        (event) => event.event_type === "state.requested" && event.object_id === malformedGrantGetRequestId
      );
      assert.ok(
        malformedGrantRequested,
        "grant timeline should include state.requested for malformed grant-scoped state reads"
      );
      assert.equal(malformedGrantRequested.trace_id, malformedGrantGetTraceId);
      assert.equal(malformedGrantRequested.data.state_scope, "grant");
      assert.equal(malformedGrantRequested.data.operation, "read");
      assert.equal(malformedGrantRequested.data.source?.kind, "connector");
      assert.equal(malformedGrantRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const malformedGrantRejected = (malformedGrantTimeline.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === malformedGrantGetRequestId
      );
      assert.ok(
        malformedGrantRejected,
        "grant timeline should include state.rejected for malformed grant-scoped state reads"
      );
      assert.equal(malformedGrantRejected.trace_id, malformedGrantGetTraceId);
      assert.equal(malformedGrantRejected.data.error?.code, "grant_invalid");
      assert.match(malformedGrantRejected.data.error?.message || "", REGEXP_129);

      const malformedGrantPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "malformed_grant_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(malformedGrantPutResp.status, 403);
      assert.equal(malformedGrantPutResp.body.error.code, "grant_invalid");
      assert.match(malformedGrantPutResp.body.error.message, REGEXP_130);

      const grantStateRows = getDb()
        .prepare("SELECT grant_id, connector_id, stream, state_json FROM grant_connector_state WHERE grant_id = ?")
        .all(approved.grant.grant_id);
      assert.equal(
        grantStateRows.length,
        0,
        "malformed grant-scoped state writes should not create grant_connector_state rows"
      );
    });
  });

  await t.test("grant-scoped polyfill state stays limited to the grant stream set", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
      });

      // The grant-scoped state read canonicalizes the connector id at the
      // boundary, so it derives the default account connector_instance_id and
      // looks up grant_connector_state rows under the canonical key. Seed both
      // the connector_id column and the instance-id derivation with the
      // canonical key (Decision 1) so the read correlates.
      const grantConnectorInstanceId = makeDefaultAccountConnectorInstanceId("u1", SPOTIFY_CONNECTOR_KEY);
      const insertGrantState = getDb().prepare(`
        INSERT INTO grant_connector_state(grant_id, connector_id, connector_instance_id, stream, state_json, updated_at)
        VALUES(?, ?, ?, ?, ?, ?)
      `);
      insertGrantState.run(
        approved.grant.grant_id,
        SPOTIFY_CONNECTOR_KEY,
        grantConnectorInstanceId,
        "top_artists",
        JSON.stringify({ cursor: "granted_cursor" }),
        "2026-04-18T10:00:00.000Z"
      );
      insertGrantState.run(
        approved.grant.grant_id,
        SPOTIFY_CONNECTOR_KEY,
        grantConnectorInstanceId,
        "recently_played",
        JSON.stringify({ cursor: "hidden_cursor" }),
        "2026-04-18T11:00:00.000Z"
      );

      const getResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(getResp.status, 200);
      const getRequestId = getResp.headers["request-id"];
      const getTraceId = getResp.headers["pdpp-reference-trace-id"];
      assert.ok(getRequestId?.startsWith("req_"));
      assert.ok(getTraceId?.startsWith("trc_"));
      assert.deepEqual(getResp.body.state, { top_artists: { cursor: "granted_cursor" } });
      assert.equal(getResp.body.updated_at, "2026-04-18T10:00:00.000Z");
      assert.ok(
        !("recently_played" in getResp.body.state),
        "grant-scoped state reads should hide rows for streams outside the grant"
      );

      const { body: grantTimelineAfterGet } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const getRequested = (grantTimelineAfterGet.data || []).find(
        (event) => event.event_type === "state.requested" && event.object_id === getRequestId
      );
      assert.ok(getRequested, "grant timeline should include state.requested for grant-scoped state reads");
      assert.equal(getRequested.trace_id, getTraceId);
      assert.equal(getRequested.data.operation, "read");
      assert.equal(getRequested.data.state_scope, "grant");
      assert.equal(getRequested.data.source?.kind, "connector");
      assert.equal(getRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const servedEvent = (grantTimelineAfterGet.data || []).find(
        (event) => event.event_type === "state.served" && event.object_id === getRequestId
      );
      assert.ok(servedEvent, "grant timeline should include state.served for grant-scoped state reads");
      assert.equal(servedEvent.trace_id, getTraceId);
      assert.deepEqual(servedEvent.data.visible_streams, ["top_artists"]);
      assert.equal(servedEvent.data.updated_at, "2026-04-18T10:00:00.000Z");

      const validPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "updated_granted_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(validPutResp.status, 200);
      const validPutRequestId = validPutResp.headers["request-id"];
      const validPutTraceId = validPutResp.headers["pdpp-reference-trace-id"];
      assert.ok(validPutRequestId?.startsWith("req_"));
      assert.ok(validPutTraceId?.startsWith("trc_"));
      assert.deepEqual(validPutResp.body.state, { top_artists: { cursor: "updated_granted_cursor" } });

      const { body: grantTimelineAfterValidPut } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const updatedEvent = (grantTimelineAfterValidPut.data || []).find(
        (event) => event.event_type === "state.updated" && event.object_id === validPutRequestId
      );
      assert.ok(updatedEvent, "grant timeline should include state.updated for successful grant-scoped state writes");
      assert.equal(updatedEvent.trace_id, validPutTraceId);
      assert.deepEqual(updatedEvent.data.requested_streams, ["top_artists"]);
      assert.deepEqual(updatedEvent.data.persisted_streams, ["top_artists"]);

      const putResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { recently_played: { cursor: "outside_grant_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(putResp.status, 400);
      const rejectedPutRequestId = putResp.headers["request-id"];
      const rejectedPutTraceId = putResp.headers["pdpp-reference-trace-id"];
      assert.ok(rejectedPutRequestId?.startsWith("req_"));
      assert.ok(rejectedPutTraceId?.startsWith("trc_"));
      assert.equal(putResp.body.error.code, "invalid_request");
      assert.match(
        putResp.body.error.message,
        new RegExp(`Grant '${approved.grant.grant_id}' is not scoped to stream recently_played`)
      );

      const { body: grantTimelineAfterRejectedPut } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const rejectedEvent = (grantTimelineAfterRejectedPut.data || []).find(
        (event) => event.event_type === "state.rejected" && event.object_id === rejectedPutRequestId
      );
      assert.ok(rejectedEvent, "grant timeline should include state.rejected for rejected grant-scoped state writes");
      assert.equal(rejectedEvent.trace_id, rejectedPutTraceId);
      assert.deepEqual(rejectedEvent.data.requested_streams, ["recently_played"]);
      assert.equal(rejectedEvent.data.error?.code, "invalid_request");
      assert.match(rejectedEvent.data.error?.message || "", REGEXP_131);

      const grantStateRows = getDb()
        .prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `)
        .all(approved.grant.grant_id);
      assert.equal(grantStateRows.length, 2, "rejected writes should not create new grant-scoped state rows");
      const typedGrantStateRows: Array<{ state_json: string; stream: string }> = [];
      for (const storedRow of grantStateRows) {
        const unknownStoredRow: unknown = storedRow;
        const stateRow = requireJsonRecord(unknownStoredRow, "grant connector state row");
        typedGrantStateRows.push({
          state_json: requireString(stateRow.state_json, "grant connector state row.state_json"),
          stream: requireString(stateRow.stream, "grant connector state row.stream"),
        });
      }
      assert.equal(
        requireJsonRecord(
          JSON.parse(
            requireFirst(
              typedGrantStateRows.filter((row) => row.stream === "top_artists"),
              "top_artists state row"
            ).state_json
          ),
          "persisted top_artists state"
        ).cursor,
        "updated_granted_cursor",
        "successful in-grant state writes should persist the updated granted stream cursor"
      );
      assert.equal(
        typedGrantStateRows.filter((row) => row.stream === "recently_played").length,
        1,
        "rejected writes should not mutate existing out-of-grant rows"
      );
    });
  });

  await t.test(
    "grant-scoped polyfill state admits a URL-shaped connector path against a canonically-keyed grant binding",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        // Approval canonicalizes the grant storage binding to the connector key
        // (`spotify`), but the manifest connector_id — and therefore the path a
        // client constructs from it — is URL-shaped
        // (`https://registry.pdpp.org/connectors/spotify`). Before the
        // canonicalize-connector-keys fix (Decision 1), grant-scoped state
        // admission compared the raw URL-shaped path id against the canonical
        // storage binding and rejected the request with 400 "not scoped to
        // connector". This regression pins that both sides are canonicalized so
        // the URL-shaped path resolves against the canonical binding.
        assert.equal(spotifyManifest.connector_id, "https://registry.pdpp.org/connectors/spotify");
        const urlShapedPath = `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`;
        const canonicalPath = `${rsUrl}/v1/state/${encodeURIComponent(SPOTIFY_CONNECTOR_KEY)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`;

        const putResp = await fetchJson(urlShapedPath, {
          body: JSON.stringify({ state: { top_artists: { cursor: "url_shaped_path_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        });
        assert.equal(putResp.status, 200, "PUT against the URL-shaped path must be admitted, not rejected with 400");
        assert.notEqual(putResp.status, 400);
        assert.deepEqual(putResp.body.state, { top_artists: { cursor: "url_shaped_path_cursor" } });

        const getResp = await fetchJson(urlShapedPath, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(getResp.status, 200, "GET against the URL-shaped path must round-trip the state written via PUT");
        assert.deepEqual(getResp.body.state, { top_artists: { cursor: "url_shaped_path_cursor" } });

        // The canonical path resolves to the same grant-scoped state, proving
        // both the URL-shaped and canonical connector ids canonicalize to the
        // same key the binding is stored under.
        const canonicalGetResp = await fetchJson(canonicalPath, {
          headers: { Authorization: `Bearer ${ownerToken}` },
        });
        assert.equal(canonicalGetResp.status, 200);
        assert.deepEqual(canonicalGetResp.body.state, { top_artists: { cursor: "url_shaped_path_cursor" } });

        const grantStateRows = getDb()
          .prepare(`
        SELECT connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `)
          .all(approved.grant.grant_id);
        assert.equal(grantStateRows.length, 1, "the URL-shaped PUT should persist exactly one grant-scoped state row");
        // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
        const grantStateRow = grantStateRows[0];
        assert.ok(grantStateRow, "expected grant-scoped state row");
        assert.equal(
          grantStateRow.connector_id,
          SPOTIFY_CONNECTOR_KEY,
          "grant-scoped state should persist under the canonical connector key"
        );
        assert.equal(grantStateRow.stream, "top_artists");
      });
    }
  );

  await t.test("grant-scoped polyfill state rejects grants missing a valid stream list as invalid grants", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists" }],
      });

      const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
      malformedGrant.streams = undefined;

      getDb()
        .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
        .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

      const malformedGetResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(malformedGetResp.status, 403);
      assert.equal(malformedGetResp.body.error.code, "grant_invalid");
      assert.match(malformedGetResp.body.error.message, REGEXP_132);

      const malformedPutResp = await fetchJson(
        `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
        {
          body: JSON.stringify({ state: { top_artists: { cursor: "malformed_grant_streams_cursor" } } }),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/json",
          },
          method: "PUT",
        }
      );
      assert.equal(malformedPutResp.status, 403);
      assert.equal(malformedPutResp.body.error.code, "grant_invalid");
      assert.match(malformedPutResp.body.error.message, REGEXP_133);
    });
  });

  await t.test(
    "grant-scoped polyfill state rejects persisted grants whose stream contract no longer resolves against the manifest",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        const malformedGrant = JSON.parse(JSON.stringify(approved.grant));
        malformedGrant.streams = [{ name: "not_in_manifest" }];

        getDb()
          .prepare(`
        UPDATE grants
        SET grant_json = ?
        WHERE grant_id = ?
      `)
          .run(JSON.stringify(malformedGrant), approved.grant.grant_id);

        const malformedGetResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(malformedGetResp.status, 403);
        assert.equal(malformedGetResp.body.error.code, "grant_invalid");
        assert.match(malformedGetResp.body.error.message, REGEXP_134);

        const malformedPutResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          {
            body: JSON.stringify({ state: { top_artists: { cursor: "should_not_persist" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(malformedPutResp.status, 403);
        assert.equal(malformedPutResp.body.error.code, "grant_invalid");
        assert.match(malformedPutResp.body.error.message, REGEXP_135);
      });
    }
  );

  await t.test(
    "grant-scoped polyfill state rejects single_use grants because the runtime keeps state null for them",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Generate a one-time concert recommendation snapshot",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists" }],
        });

        const getResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(getResp.status, 400);
        assert.equal(getResp.body.error.code, "invalid_request");
        assert.match(
          getResp.body.error.message,
          new RegExp(
            `Grant '${approved.grant.grant_id}' does not support grant-scoped state because access_mode is single_use`
          )
        );

        const putResp = await fetchJson(
          `${rsUrl}/v1/state/${encodeURIComponent(spotifyManifest.connector_id)}?grant_id=${encodeURIComponent(approved.grant.grant_id)}`,
          {
            body: JSON.stringify({ state: { top_artists: { cursor: "single_use_grant_cursor" } } }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/json",
            },
            method: "PUT",
          }
        );
        assert.equal(putResp.status, 400);
        assert.equal(putResp.body.error.code, "invalid_request");
        assert.match(
          putResp.body.error.message,
          new RegExp(
            `Grant '${approved.grant.grant_id}' does not support grant-scoped state because access_mode is single_use`
          )
        );

        const grantStateRows = getDb()
          .prepare(`
        SELECT grant_id, connector_id, stream, state_json
        FROM grant_connector_state
        WHERE grant_id = ?
      `)
          .all(approved.grant.grant_id);
        assert.equal(grantStateRows.length, 0, "single_use grants should not create grant-scoped state rows");
      });
    }
  );

  await t.test(
    "polyfill owner delete routes reject unknown connectors and manifest-unknown streams instead of silently succeeding",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const missingConnectorId = "missing_spotify_connector";
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const beforeRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(beforeRecordsResp.status, 200);
        const beforeRecordsBody = parseResourceRecordListResponse(await beforeRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const beforeRecords = beforeRecordsBody.data || [];
        assert.ok(beforeRecords.length > 0, "expected seeded top_artists records before exercising delete routes");
        const protectedRecordId = requireFirst(beforeRecords, "seeded top_artists records").id;

        const missingDeleteAllResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(missingConnectorId)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(missingDeleteAllResp.status, 404);
        assert.equal(missingDeleteAllResp.body.error.code, "not_found");
        assert.match(missingDeleteAllResp.body.error.message, REGEXP_136);
        const missingDeleteAllRequestId = missingDeleteAllResp.headers["request-id"];
        const missingDeleteAllTraceId = missingDeleteAllResp.headers["pdpp-reference-trace-id"];
        assert.ok(missingDeleteAllRequestId?.startsWith("req_"));
        assert.ok(missingDeleteAllTraceId?.startsWith("trc_mut_"));

        const { body: missingDeleteAllTrace } = await fetchReferenceTrace(asUrl, missingDeleteAllTraceId);
        const missingDeleteAllRequested = missingDeleteAllTrace.data.find(
          (event) => event.event_type === "mutation.requested" && event.object_id === missingDeleteAllRequestId
        );
        assert.ok(
          missingDeleteAllRequested,
          "owner trace should include mutation.requested for rejected unknown-connector delete-all requests"
        );
        assert.equal(missingDeleteAllRequested.stream_id, "top_artists");
        assert.equal(missingDeleteAllRequested.data.operation, "delete_stream_records");

        const missingDeleteAllRejected = missingDeleteAllTrace.data.find(
          (event) => event.event_type === "mutation.rejected" && event.object_id === missingDeleteAllRequestId
        );
        assert.ok(
          missingDeleteAllRejected,
          "owner trace should include mutation.rejected for rejected unknown-connector delete-all requests"
        );
        assert.equal(missingDeleteAllRejected.stream_id, "top_artists");
        assert.equal(missingDeleteAllRejected.data.operation, "delete_stream_records");
        assert.equal(missingDeleteAllRejected.data.error?.code, "not_found");
        assert.match(missingDeleteAllRejected.data.error?.message || "", REGEXP_137);

        const missingDeleteOneResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(missingConnectorId)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(missingDeleteOneResp.status, 404);
        assert.equal(missingDeleteOneResp.body.error.code, "not_found");
        assert.match(missingDeleteOneResp.body.error.message, REGEXP_138);

        const unknownStreamDeleteAllResp = await fetchJson(
          `${rsUrl}/v1/streams/not_a_stream/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(unknownStreamDeleteAllResp.status, 404);
        assert.equal(unknownStreamDeleteAllResp.body.error.code, "not_found");
        assert.match(
          unknownStreamDeleteAllResp.body.error.message,
          new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`)
        );

        const unknownStreamDeleteOneResp = await fetchJson(
          `${rsUrl}/v1/streams/not_a_stream/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(unknownStreamDeleteOneResp.status, 404);
        assert.equal(unknownStreamDeleteOneResp.body.error.code, "not_found");
        assert.match(
          unknownStreamDeleteOneResp.body.error.message,
          new RegExp(`Stream 'not_a_stream' not found for connector ${SPOTIFY_CONNECTOR_KEY}`)
        );

        const afterRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(afterRecordsResp.status, 200);
        const afterRecordsBody = parseResourceRecordListResponse(await afterRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const afterRecords = afterRecordsBody.data || [];
        assert.equal(
          afterRecords.length,
          beforeRecords.length,
          "rejected delete routes should not remove valid records"
        );
        assert.ok(
          afterRecords.some((record) => record.id === protectedRecordId),
          "rejected delete routes should leave the protected record intact"
        );
      });
    }
  );

  await t.test("polyfill owner ingest and delete routes emit correlated mutation artifacts on success", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ingestResp = await fetch(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          body: `${JSON.stringify({
            data: { genres: ["ambient"], id: "artist_trace_success", name: "Trace Success" },
            emitted_at: new Date().toISOString(),
            key: "artist_trace_success",
          })}\n${JSON.stringify({
            data: { id: "artist_trace_bad_json", name: "Bad Json" },
            emitted_at: new Date().toISOString(),
            key: "artist_trace_bad_json",
          }).slice(0, -1)}`,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );
      assert.equal(ingestResp.status, 200);
      const ingestRequestId = ingestResp.headers.get("Request-Id");
      const ingestTraceId = ingestResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(ingestRequestId?.startsWith("req_"));
      assert.ok(ingestTraceId?.startsWith("trc_mut_"));
      const ingestBody = parseIngestResponse(await ingestResp.json());
      assert.equal(ingestBody.records_accepted, 1);
      assert.equal(ingestBody.records_rejected, 1);

      const { body: ingestTrace } = await fetchReferenceTrace(asUrl, ingestTraceId);
      const ingestRequested = ingestTrace.data.find(
        (event) => event.event_type === "mutation.requested" && event.object_id === ingestRequestId
      );
      assert.ok(ingestRequested, "owner trace should include mutation.requested for successful ingest requests");
      assert.equal(ingestRequested.stream_id, "top_artists");
      assert.equal(ingestRequested.data.operation, "ingest_records");
      assert.equal(ingestRequested.data.submitted_record_count, 2);
      assert.equal(ingestRequested.data.source?.kind, "connector");
      assert.equal(ingestRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const ingestCompleted = ingestTrace.data.find(
        (event) => event.event_type === "mutation.completed" && event.object_id === ingestRequestId
      );
      assert.ok(ingestCompleted, "owner trace should include mutation.completed for successful ingest requests");
      assert.equal(ingestCompleted.stream_id, "top_artists");
      assert.equal(ingestCompleted.data.operation, "ingest_records");
      assert.equal(ingestCompleted.data.records_accepted, 1);
      assert.equal(ingestCompleted.data.records_rejected, 1);
      assert.equal(ingestCompleted.data.error_count, 1);
      assert.equal(ingestCompleted.data.source?.kind, "connector");
      assert.equal(ingestCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const deleteResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent("artist_trace_success")}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );
      assert.equal(deleteResp.status, 204);
      const deleteRequestId = deleteResp.headers.get("Request-Id");
      const deleteTraceId = deleteResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(deleteRequestId?.startsWith("req_"));
      assert.ok(deleteTraceId?.startsWith("trc_mut_"));

      const { body: deleteTrace } = await fetchReferenceTrace(asUrl, deleteTraceId);
      const deleteRequested = deleteTrace.data.find(
        (event) => event.event_type === "mutation.requested" && event.object_id === deleteRequestId
      );
      assert.ok(deleteRequested, "owner trace should include mutation.requested for successful delete requests");
      assert.equal(deleteRequested.stream_id, "top_artists");
      assert.equal(deleteRequested.data.operation, "delete_record");
      assert.equal(deleteRequested.data.requested_record_id, "artist_trace_success");
      assert.equal(deleteRequested.data.source?.kind, "connector");
      assert.equal(deleteRequested.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const deleteCompleted = deleteTrace.data.find(
        (event) => event.event_type === "mutation.completed" && event.object_id === deleteRequestId
      );
      assert.ok(deleteCompleted, "owner trace should include mutation.completed for successful delete requests");
      assert.equal(deleteCompleted.stream_id, "top_artists");
      assert.equal(deleteCompleted.data.operation, "delete_record");
      assert.equal(deleteCompleted.data.requested_record_id, "artist_trace_success");
      assert.equal(deleteCompleted.data.deleted_record_count, 1);
      assert.equal(deleteCompleted.data.source?.kind, "connector");
      assert.equal(deleteCompleted.data.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test(
    "polyfill owner ingest rejects duplicate connector_id query params instead of normalizing them into mutation scope",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const duplicateQuery = new URLSearchParams();
        duplicateQuery.append("connector_id", spotifyManifest.connector_id);
        duplicateQuery.append("connector_id", "unexpected_second_value");

        const rejectedResp = await fetch(`${rsUrl}/v1/ingest/top_artists?${duplicateQuery.toString()}`, {
          body: `${JSON.stringify({
            data: { id: "artist_should_not_ingest", name: "Should Not Ingest" },
            emitted_at: new Date().toISOString(),
            key: "artist_should_not_ingest",
          })}\n`,
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        });
        assert.equal(rejectedResp.status, 400);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_mut_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "invalid_request");
        assert.match(rejectedBody.error.message, REGEXP_139);

        const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
        const requestedEvent = trace.data.find(
          (event) => event.event_type === "mutation.requested" && event.object_id === rejectedRequestId
        );
        assert.ok(requestedEvent, "owner trace should include mutation.requested for duplicate connector_id ingest");
        assert.equal(requestedEvent.stream_id, "top_artists");
        assert.equal(requestedEvent.data.operation, "ingest_records");
        assert.equal(
          requestedEvent.data.source,
          null,
          "duplicate connector_id should not be normalized into a connector-shaped mutation source"
        );

        const rejectedEvent = trace.data.find(
          (event) => event.event_type === "mutation.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "owner trace should include mutation.rejected for duplicate connector_id ingest");
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.operation, "ingest_records");
        assert.equal(
          rejectedEvent.data.source,
          null,
          "duplicate connector_id should not be normalized into a connector-shaped mutation rejection source"
        );
        assert.equal(rejectedEvent.data.error?.code, "invalid_request");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_140);
      });
    }
  );

  await t.test(
    "polyfill owner ingest rejects malformed persisted connector manifests instead of drifting into generic failures",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        getDb()
          .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
          .run(
            '{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
            SPOTIFY_CONNECTOR_KEY
          );

        const rejectedResp = await fetchJson(
          `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify({
              data: { id: "artist_malformed_manifest_ingest", name: "Should Not Ingest" },
              emitted_at: new Date().toISOString(),
              key: "artist_malformed_manifest_ingest",
            }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );
        assert.equal(rejectedResp.status, 400);
        assert.equal(rejectedResp.body.error.code, "connector_invalid");
        assert.match(
          rejectedResp.body.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
        );
        const rejectedRequestId = rejectedResp.headers["request-id"];
        const rejectedTraceId = rejectedResp.headers["pdpp-reference-trace-id"];
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_mut_"));

        const { body: rejectedTrace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
        const mutationRequested = rejectedTrace.data.find(
          (event) => event.event_type === "mutation.requested" && event.object_id === rejectedRequestId
        );
        assert.ok(
          mutationRequested,
          "owner trace should include mutation.requested for malformed-manifest ingest requests"
        );
        assert.equal(mutationRequested.stream_id, "top_artists");
        assert.equal(mutationRequested.data.operation, "ingest_records");
        assert.equal(mutationRequested.data.submitted_record_count, 1);

        const mutationRejected = rejectedTrace.data.find(
          (event) => event.event_type === "mutation.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          mutationRejected,
          "owner trace should include mutation.rejected for malformed-manifest ingest requests"
        );
        assert.equal(mutationRejected.stream_id, "top_artists");
        assert.equal(mutationRejected.data.operation, "ingest_records");
        assert.equal(mutationRejected.data.error?.code, "connector_invalid");
        assert.match(mutationRejected.data.error?.message || "", REGEXP_141);

        const ownerRecordsResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=100`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(ownerRecordsResp.status, 400);
        assert.equal(ownerRecordsResp.body.error.code, "connector_invalid");
      });
    }
  );

  await t.test(
    "polyfill owner delete routes reject malformed persisted connector manifests instead of drifting into generic failures",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const beforeRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(beforeRecordsResp.status, 200);
        const beforeRecordsBody = parseResourceRecordListResponse(await beforeRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const beforeRecords = beforeRecordsBody.data || [];
        assert.ok(
          beforeRecords.length > 0,
          "expected seeded top_artists records before exercising malformed-manifest delete routes"
        );
        const protectedRecordId = requireFirst(beforeRecords, "seeded top_artists records").id;

        getDb()
          .prepare(`
        UPDATE connectors
        SET manifest = ?
        WHERE connector_id = ?
      `)
          .run(
            '{"connector_id":"https://registry.pdpp.org/connectors/spotify","streams":[{"name":"top_artists","primary_key":["missing_id"]}]}',
            SPOTIFY_CONNECTOR_KEY
          );

        const deleteAllResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(deleteAllResp.status, 400);
        assert.equal(deleteAllResp.body.error.code, "connector_invalid");
        assert.match(
          deleteAllResp.body.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
        );
        const deleteAllRequestId = deleteAllResp.headers["request-id"];
        const deleteAllTraceId = deleteAllResp.headers["pdpp-reference-trace-id"];
        assert.ok(deleteAllRequestId?.startsWith("req_"));
        assert.ok(deleteAllTraceId?.startsWith("trc_mut_"));

        const { body: deleteAllTrace } = await fetchReferenceTrace(asUrl, deleteAllTraceId);
        const deleteAllRequested = deleteAllTrace.data.find(
          (event) => event.event_type === "mutation.requested" && event.object_id === deleteAllRequestId
        );
        assert.ok(
          deleteAllRequested,
          "owner trace should include mutation.requested for malformed-manifest delete-all requests"
        );
        assert.equal(deleteAllRequested.data.operation, "delete_stream_records");

        const deleteAllRejected = deleteAllTrace.data.find(
          (event) => event.event_type === "mutation.rejected" && event.object_id === deleteAllRequestId
        );
        assert.ok(
          deleteAllRejected,
          "owner trace should include mutation.rejected for malformed-manifest delete-all requests"
        );
        assert.equal(deleteAllRejected.data.operation, "delete_stream_records");
        assert.equal(deleteAllRejected.data.error?.code, "connector_invalid");

        const deleteOneResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(protectedRecordId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            headers: { Authorization: `Bearer ${ownerToken}` },
            method: "DELETE",
          }
        );
        assert.equal(deleteOneResp.status, 400);
        assert.equal(deleteOneResp.body.error.code, "connector_invalid");
        assert.match(
          deleteOneResp.body.error.message,
          new RegExp(`Connector manifest for ${SPOTIFY_CONNECTOR_KEY} is malformed or no longer valid`)
        );

        const afterRecordsResp = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(afterRecordsResp.status, 400);
        assert.equal(afterRecordsResp.body.error.code, "connector_invalid");
      });
    }
  );

  await t.test(
    "client stream lists respect grant resource restrictions when reporting counts and last_updated",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts based on a chosen artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              name: "top_artists",
              resources: ["spotify:artist:0C0XlULifJtAgn6ZNCW2eu", "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ"],
            },
          ],
        });

        const ownerRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(ownerRecordsResp.status, 200);
        const ownerRecordsBody = parseResourceRecordListResponse(await ownerRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const ownerRecords = ownerRecordsBody.data || [];

        const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(streamsResp.status, 200);
        const streamsBody = parseResourceStreamListResponse(await streamsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const topArtistsSummary = (streamsBody.data || []).find((stream) => stream.name === "top_artists");
        assert.ok(topArtistsSummary, "expected top_artists in the granted stream list");

        const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(clientRecordsResp.status, 200);
        const clientRecordsBody = parseResourceRecordListResponse(await clientRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const clientRecords = clientRecordsBody.data || [];

        assert.equal(clientRecords.length, 2);
        assert.ok(
          ownerRecords.length > clientRecords.length,
          "resource-restricted grant should expose fewer records than owner access"
        );
        assert.equal(topArtistsSummary.record_count, clientRecords.length);
        assert.deepEqual(
          // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
          clientRecords.map((record) => record.id).sort(),
          ["spotify:artist:0C0XlULifJtAgn6ZNCW2eu", "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ"].sort()
        );

        const expectedLastUpdated =
          // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
          clientRecords
            .map((record) => record.emitted_at)
            .sort()
            .at(-1) || null;
        assert.equal(topArtistsSummary.last_updated, expectedLastUpdated);
      });
    }
  );

  await t.test(
    "client stream lists respect grant time_range restrictions when reporting counts and last_updated",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const since = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts from recent listening only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              name: "top_artists",
              time_range: { since },
            },
          ],
        });

        const ownerRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(ownerRecordsResp.status, 200);
        const ownerRecordsBody = parseResourceRecordListResponse(await ownerRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const ownerRecords = ownerRecordsBody.data || [];

        const streamsResp = await fetch(`${rsUrl}/v1/streams`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(streamsResp.status, 200);
        const streamsBody = parseResourceStreamListResponse(await streamsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const topArtistsSummary = (streamsBody.data || []).find((stream) => stream.name === "top_artists");
        assert.ok(topArtistsSummary, "expected top_artists in the granted stream list");

        const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(clientRecordsResp.status, 200);
        const clientRecordsBody = parseResourceRecordListResponse(await clientRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const clientRecords = clientRecordsBody.data || [];

        assert.ok(clientRecords.length > 0, "time-range-restricted grant should still expose recent records");
        assert.ok(
          ownerRecords.length > clientRecords.length,
          "time-range-restricted grant should expose fewer records than owner access"
        );
        assert.equal(topArtistsSummary.record_count, clientRecords.length);

        const expectedLastUpdated =
          // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
          clientRecords
            .map((record) => record.emitted_at)
            .sort()
            .at(-1) || null;
        assert.equal(topArtistsSummary.last_updated, expectedLastUpdated);
      });
    }
  );

  await t.test(
    "client stream metadata rejects streams outside the grant and preserves the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using top artists only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/recently_played`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId, "rejected client metadata reads should carry a reference trace id");
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "grant_stream_not_allowed");
        assert.match(rejectedBody.error.message, REGEXP_142);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for rejected stream metadata reads"
        );
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "recently_played");
        assert.equal(queryReceivedEvent.data.query_shape, "stream_metadata");
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected stream metadata reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "recently_played");
        assert.equal(rejectedEvent.data.query_shape, "stream_metadata");
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "grant_stream_not_allowed");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_143);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, "rejected stream metadata reads should not produce disclosure.served");
      });
    }
  );

  await t.test(
    "client record-list rejects streams outside the grant and preserves the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using top artists only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/recently_played/records?limit=1`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId, "rejected client record-list reads should carry a reference trace id");
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "grant_stream_not_allowed");
        assert.match(rejectedBody.error.message, REGEXP_144);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, "grant timeline should include query.received for rejected record-list reads");
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "recently_played");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected record-list reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "recently_played");
        assert.equal(rejectedEvent.data.query_shape, "record_list");
        assert.equal(rejectedEvent.data.error?.code, "grant_stream_not_allowed");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_145);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, "rejected record-list reads should not produce disclosure.served");
      });
    }
  );

  await t.test(
    "client record-detail rejects streams outside the grant and preserves the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const ownerListResp = await fetchJson(
          `${rsUrl}/v1/streams/saved_tracks/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=1`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        const hiddenRecord = ownerListResp.body.data?.[0];
        assert.ok(hiddenRecord, "expected an owner-visible saved_tracks record outside the client grant");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using top artists only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const rejectedResp = await fetch(
          `${rsUrl}/v1/streams/saved_tracks/records/${encodeURIComponent(hiddenRecord.id)}`,
          {
            headers: { Authorization: `Bearer ${approved.token}` },
          }
        );
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId, "rejected client record-detail reads should carry a reference trace id");
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "grant_stream_not_allowed");
        assert.match(rejectedBody.error.message, REGEXP_146);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, "grant timeline should include query.received for rejected record-detail reads");
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "saved_tracks");
        assert.equal(queryReceivedEvent.data.query_shape, "record_detail");
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected record-detail reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "saved_tracks");
        assert.equal(rejectedEvent.data.query_shape, "record_detail");
        assert.equal(rejectedEvent.data.error?.code, "grant_stream_not_allowed");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_147);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, "rejected record-detail reads should not produce disclosure.served");
      });
    }
  );

  await t.test(
    "client record detail hides records outside grant resources and preserves the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using a chosen artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              name: "top_artists",
              resources: ["spotify:artist:0C0XlULifJtAgn6ZNCW2eu", "spotify:artist:1Xyo4u8uXC1ZmMpatF05PJ"],
            },
          ],
        });

        const rejectedId = "spotify:artist:6eUKZXaKkcviH0Ku9w2n3V";
        const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(rejectedId)}`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 404);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId, "rejected client record-detail reads should carry a reference trace id");
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "not_found");
        assert.match(rejectedBody.error.message, REGEXP_148);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(queryReceivedEvent, "grant timeline should include query.received for rejected record-detail reads");
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_detail");
        assert.equal(queryReceivedEvent.data.requested_record_id, rejectedId);
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected record-detail reads");
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_detail");
        assert.equal(rejectedEvent.data.requested_record_id, rejectedId);
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "not_found");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_149);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(servedEvent, undefined, "rejected record-detail reads should not produce disclosure.served");
      });
    }
  );

  await t.test(
    "client record detail hides records outside grant time_range and preserves the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const since = new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString();
        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts from recent listening only",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              name: "top_artists",
              time_range: { since },
            },
          ],
        });

        const ownerRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(ownerRecordsResp.status, 200);
        const ownerRecordsBody = parseResourceRecordListResponse(await ownerRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const ownerRecords = ownerRecordsBody.data || [];

        const clientRecordsResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=20`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(clientRecordsResp.status, 200);
        const clientRecordsBody = parseResourceRecordListResponse(await clientRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const clientRecords = clientRecordsBody.data || [];

        const visibleIds = new Set(clientRecords.map((record) => record.id));
        const hiddenRecord = ownerRecords.find((record) => !visibleIds.has(record.id));
        assert.ok(hiddenRecord, "expected at least one owner-visible record outside the grant time_range");

        const rejectedResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(hiddenRecord.id)}`,
          {
            headers: { Authorization: `Bearer ${approved.token}` },
          }
        );
        assert.equal(rejectedResp.status, 404);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId, "rejected client time-range record-detail reads should carry a reference trace id");
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "not_found");
        assert.match(rejectedBody.error.message, REGEXP_150);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for rejected time-range record-detail reads"
        );
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_detail");
        assert.equal(queryReceivedEvent.data.requested_record_id, hiddenRecord.id);
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          rejectedEvent,
          "grant timeline should include query.rejected for rejected time-range record-detail reads"
        );
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_detail");
        assert.equal(rejectedEvent.data.requested_record_id, hiddenRecord.id);
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "not_found");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_151);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(
          servedEvent,
          undefined,
          "rejected time-range record-detail reads should not produce disclosure.served"
        );
      });
    }
  );

  await t.test("resource-limited client pagination reports has_more only for additional visible records", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const ownerRecordsResp = await fetch(
        `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );
      assert.equal(ownerRecordsResp.status, 200);
      const ownerRecordsBody = parseResourceRecordListResponse(await ownerRecordsResp.json());
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const ownerRecords = ownerRecordsBody.data || [];
      // biome-ignore lint/style/useDestructuring: Indexed access expresses the protocol field position under test.
      const mostRecentVisible = ownerRecords[0];
      assert.ok(mostRecentVisible, "expected at least one owner-visible record to scope the grant");

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Recommend concerts using only the latest permitted artist",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            name: "top_artists",
            resources: [mostRecentVisible.id],
          },
        ],
      });

      const resp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(resp.status, 200);
      const requestId = resp.headers.get("Request-Id");
      const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(requestId?.startsWith("req_"));
      assert.ok(traceId?.startsWith("trc_"));

      const body = parseResourceRecordPageResponse(await resp.json());
      assert.equal(body.object, "list");
      assert.equal(body.has_more, false, "hidden records should not make has_more appear true");
      assert.ok(!body.next_cursor, "no pagination cursor should be exposed when no additional visible records exist");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(body.data?.length, 1);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.equal(body.data?.[0]?.id, mostRecentVisible.id);

      const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      const queryReceivedEvent = timeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === requestId
      );
      assert.ok(queryReceivedEvent, "grant timeline should include query.received for the restricted paginated read");
      assert.equal(queryReceivedEvent.trace_id, traceId);
      assert.equal(queryReceivedEvent.stream_id, "top_artists");
      assert.equal(queryReceivedEvent.data.query_shape, "record_list");
      assert.equal(queryReceivedEvent.data.source?.kind, "connector");
      assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

      const servedEvent = timeline.data.find(
        (event) => event.event_type === "disclosure.served" && event.object_id === requestId
      );
      assert.ok(servedEvent, "grant timeline should include disclosure.served for the restricted paginated read");
      assert.equal(servedEvent.trace_id, traceId);
      assert.equal(servedEvent.stream_id, "top_artists");
      assert.equal(servedEvent.data.query_shape, "record_list");
      assert.equal(servedEvent.data.record_count, 1);
      assert.equal(servedEvent.data.has_more, false);
      assert.equal(servedEvent.data.source?.kind, "connector");
      assert.equal(servedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
    });
  });

  await t.test("client stream metadata remains source-level even when the grant narrows fields", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Recommend concerts using the basic top-artist subset",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [
          {
            fields: ["id", "name", "genres"],
            name: "top_artists",
          },
        ],
      });

      const metadataResp = await fetch(`${rsUrl}/v1/streams/top_artists`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(metadataResp.status, 200);
      const metadataBody = parseResourceStreamMetadataResponse(await metadataResp.json());
      assert.equal(metadataBody.object, "stream_metadata");
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      const metadataFields = Object.keys(metadataBody.schema.properties || {}).sort();
      assert.ok(metadataFields.includes("id"));
      assert.ok(metadataFields.includes("name"));
      assert.ok(metadataFields.includes("genres"));
      assert.ok(metadataFields.includes("popularity"));
      assert.ok(metadataFields.includes("followers"));
      assert.ok(metadataFields.includes("image_url"));
      assert.ok(metadataFields.includes("source_updated_at"));
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
      assert.deepEqual((metadataBody.schema.required || []).sort(), ["id", "name"]);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      // biome-ignore lint/suspicious/useArraySortCompare: Fixture values use the runtime default sort semantics under test.
      assert.deepEqual((metadataBody.views || []).map((view) => view.id).sort(), ["basic", "full"]);
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok("popularity" in (metadataBody.schema.properties || {}));
      // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
      assert.ok((metadataBody.views || []).some((view) => view.id === "full"));
    });
  });

  await t.test(
    "field-limited client grants project record-list and record-detail disclosures to the granted field subset",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using the basic top-artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              fields: ["id", "name", "genres"],
              name: "top_artists",
            },
          ],
        });

        const listResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(listResp.status, 200);
        const listBody = parseResourceRecordListResponse(await listResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const firstRecord = listBody.data?.[0];
        assert.ok(firstRecord, "expected at least one granted record");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ["genres", "id", "name"]);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("popularity" in (firstRecord.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("followers" in (firstRecord.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("image_url" in (firstRecord.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("source_updated_at" in (firstRecord.data || {})));

        const detailResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstRecord.id)}`,
          {
            headers: { Authorization: `Bearer ${approved.token}` },
          }
        );
        assert.equal(detailResp.status, 200);
        const detailBody = parseResourceRecordDetailResponse(await detailResp.json());
        assert.equal(detailBody.object, "record");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.deepEqual(Object.keys(detailBody.data || {}).sort(), ["genres", "id", "name"]);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("popularity" in (detailBody.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("followers" in (detailBody.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("image_url" in (detailBody.data || {})));
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.ok(!("source_updated_at" in (detailBody.data || {})));
      });
    }
  );

  await t.test(
    "field-limited client grants reject filter fields outside the grant and preserve the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using the basic top-artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              fields: ["id", "name", "genres"],
              name: "top_artists",
            },
          ],
        });

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?filter[popularity]=96`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "field_not_granted");
        assert.match(rejectedBody.error.message, REGEXP_152);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for rejected filter-based record-list reads"
        );
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          rejectedEvent,
          "grant timeline should include query.rejected for rejected filter-based record-list reads"
        );
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_list");
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "field_not_granted");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_153);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(
          servedEvent,
          undefined,
          "rejected filter-based record-list reads should not produce disclosure.served"
        );
      });
    }
  );

  await t.test(
    "field-limited client grants reject manifest views that expand beyond granted fields and preserve the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using the basic top-artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              fields: ["id", "name", "genres"],
              name: "top_artists",
            },
          ],
        });

        const rejectedResp = await fetch(`${rsUrl}/v1/streams/top_artists/records?view=full`, {
          headers: { Authorization: `Bearer ${approved.token}` },
        });
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "field_not_granted");
        assert.match(rejectedBody.error.message, REGEXP_154);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for rejected view-based record-list reads"
        );
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.requested_view, "full");
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          rejectedEvent,
          "grant timeline should include query.rejected for rejected view-based record-list reads"
        );
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_list");
        assert.equal(rejectedEvent.data.requested_view, "full");
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "field_not_granted");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_155);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(
          servedEvent,
          undefined,
          "rejected view-based record-list reads should not produce disclosure.served"
        );
      });
    }
  );

  await t.test(
    "field-limited client grants project changes_since disclosures to the granted field subset",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time using the basic top-artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              fields: ["id", "name", "genres"],
              name: "top_artists",
            },
          ],
        });

        const baseline = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64"))}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(baseline.status, 200);
        const firstRecord = baseline.body.data?.[0];
        assert.ok(firstRecord, "expected at least one granted record in the baseline changes_since response");
        assert.deepEqual(Object.keys(firstRecord.data || {}).sort(), ["genres", "id", "name"]);
        assert.ok(!("popularity" in (firstRecord.data || {})));
        assert.ok(!("followers" in (firstRecord.data || {})));
        assert.ok(!("image_url" in (firstRecord.data || {})));
        assert.ok(!("source_updated_at" in (firstRecord.data || {})));

        const ownerRecord = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstRecord.id)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );

        const hiddenFieldUpdate = {
          data: {
            ...ownerRecord.body.data,
            popularity: 101,
            source_updated_at: new Date().toISOString(),
          },
          emitted_at: new Date().toISOString(),
          key: firstRecord.id,
        };

        await fetchJson(
          `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify(hiddenFieldUpdate),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );

        const hiddenDelta = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(hiddenDelta.status, 200);
        assert.equal(
          hiddenDelta.body.data.length,
          0,
          "changes_since should hide deltas that only touch ungranted fields"
        );

        const visibleFieldUpdate = {
          data: {
            ...hiddenFieldUpdate.data,
            genres: [...ownerRecord.body.data.genres, "touring"],
            source_updated_at: new Date().toISOString(),
          },
          emitted_at: new Date().toISOString(),
          key: firstRecord.id,
        };

        await fetchJson(
          `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify(visibleFieldUpdate),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );

        const visibleDelta = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(hiddenDelta.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(visibleDelta.status, 200);
        assert.equal(visibleDelta.body.data.length, 1);
        const visibleRecordDelta = requireFirst(visibleDelta.body.data, "visible field delta");
        assert.equal(visibleRecordDelta.id, firstRecord.id);
        assert.deepEqual(Object.keys(visibleRecordDelta.data || {}).sort(), ["genres", "id", "name"]);
        assert.ok(!("popularity" in (visibleRecordDelta.data || {})));
        assert.ok(!("followers" in (visibleRecordDelta.data || {})));
        assert.ok(!("image_url" in (visibleRecordDelta.data || {})));
        assert.ok(!("source_updated_at" in (visibleRecordDelta.data || {})));
        assert.deepEqual(visibleRecordDelta.data.genres.at(-1), "touring");
      });
    }
  );

  await t.test(
    "field-limited client grants reject changes_since filter fields outside the grant and preserve the rejection in the timeline",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time using the basic top-artist subset",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              fields: ["id", "name", "genres"],
              name: "top_artists",
            },
          ],
        });

        const rejectedResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64"))}&filter[popularity]=96`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(rejectedResp.status, 403);
        const rejectedRequestId = rejectedResp.headers.get("Request-Id");
        const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(rejectedRequestId?.startsWith("req_"));
        assert.ok(rejectedTraceId?.startsWith("trc_"));
        const rejectedBody = parseErrorResponse(await rejectedResp.json());
        assert.equal(rejectedBody.error.code, "field_not_granted");
        assert.match(rejectedBody.error.message, REGEXP_156);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for rejected changes_since filter reads"
        );
        assert.equal(queryReceivedEvent.trace_id, rejectedTraceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.has_changes_since, true);
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const rejectedEvent = timeline.data.find(
          (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
        );
        assert.ok(
          rejectedEvent,
          "grant timeline should include query.rejected for rejected changes_since filter reads"
        );
        assert.equal(rejectedEvent.trace_id, rejectedTraceId);
        assert.equal(rejectedEvent.stream_id, "top_artists");
        assert.equal(rejectedEvent.data.query_shape, "record_list");
        assert.equal(rejectedEvent.data.has_changes_since, true);
        assert.equal(rejectedEvent.data.source?.kind, "connector");
        assert.equal(rejectedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
        assert.equal(rejectedEvent.data.error?.code, "field_not_granted");
        assert.match(rejectedEvent.data.error?.message || "", REGEXP_157);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === rejectedRequestId
        );
        assert.equal(
          servedEvent,
          undefined,
          "rejected changes_since filter reads should not produce disclosure.served"
        );
      });
    }
  );

  await t.test("native client query rejections stay correlated on the grant timeline", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rejectedResp.status, 400);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_"));
      const rejectedBody = parseErrorResponse(await rejectedResp.json());
      assert.equal(rejectedBody.error.code, "invalid_request");

      const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
      const queryReceivedEvent = timeline.data.find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, "grant timeline should include query.received for rejected native client reads");
      assert.equal(queryReceivedEvent.data.query_shape, "record_list");
      assert.equal(queryReceivedEvent.data.source?.kind, "provider_native");

      const rejectedEvent = timeline.data.find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, "grant timeline should include query.rejected for rejected native client reads");
      assert.equal(rejectedEvent.trace_id, rejectedTraceId);
      assert.equal(rejectedEvent.data.query_shape, "record_list");
      assert.equal(rejectedEvent.data.source?.kind, "provider_native");
      assert.equal(rejectedEvent.data.error?.code, "invalid_request");
      assert.match(rejectedEvent.data.error?.message || "", REGEXP_158);
    });
  });

  // Regression for owner-review-1 (mount-rs-record-read-operations): the
  // Fastify transport uses `qs.parse`, so repeated `?fields=a&fields=b`
  // produces an array. The previous native route rejected `view + fields`
  // via a truthiness test (`if (req.query.view && req.query.fields)`), so
  // arrays still triggered the mutex. The operation must preserve that
  // behavior; otherwise a client could pass `view=compact` plus repeated
  // `fields=` params and silently drop the view.
  await t.test("record-list rejects view plus repeated fields query params (qs array shape)", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Support compensation planning and verification",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });

      // Repeated `fields=` produces `fields: ['id', 'employer']` after qs
      // parsing, which is the exact shape the P1 fix guards against.
      const rejectedResp = await fetch(
        `${rsUrl}/v1/streams/pay_statements/records?view=summary&fields=id&fields=employer`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );
      assert.equal(rejectedResp.status, 400);
      const rejectedBody = parseErrorResponse(await rejectedResp.json());
      assert.equal(rejectedBody.error.code, "invalid_request");
      assert.match(rejectedBody.error.message, REGEXP_159);
    });
  });

  await t.test("native owner query rejections stay correlated on owner traces", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "employee_1");
      await seedNorthstar(nativeManifest);

      const rejectedResp = await fetch(`${rsUrl}/v1/streams/not_a_stream`, {
        headers: { Authorization: `Bearer ${ownerToken}` },
      });
      assert.equal(rejectedResp.status, 404);
      const rejectedRequestId = rejectedResp.headers.get("Request-Id");
      const rejectedTraceId = rejectedResp.headers.get("PDPP-Reference-Trace-Id");
      assert.ok(rejectedRequestId?.startsWith("req_"));
      assert.ok(rejectedTraceId?.startsWith("trc_qry_"));
      const rejectedBody = parseErrorResponse(await rejectedResp.json());
      assert.equal(rejectedBody.error.code, "not_found");

      const { body: trace } = await fetchReferenceTrace(asUrl, rejectedTraceId);
      const queryReceivedEvent = trace.data.find(
        (event) => event.event_type === "query.received" && event.object_id === rejectedRequestId
      );
      assert.ok(queryReceivedEvent, "owner trace should include query.received for rejected native owner reads");
      assert.equal(queryReceivedEvent.stream_id, "not_a_stream");
      assert.equal(queryReceivedEvent.data.query_shape, "stream_metadata");
      assert.equal(queryReceivedEvent.data.source?.kind, "provider_native");

      const rejectedEvent = trace.data.find(
        (event) => event.event_type === "query.rejected" && event.object_id === rejectedRequestId
      );
      assert.ok(rejectedEvent, "owner trace should include query.rejected for rejected native owner reads");
      assert.equal(rejectedEvent.stream_id, "not_a_stream");
      assert.equal(rejectedEvent.data.query_shape, "stream_metadata");
      assert.equal(rejectedEvent.data.source?.kind, "provider_native");
      assert.equal(rejectedEvent.data.error?.code, "not_found");
      assert.match(rejectedEvent.data.error?.message || "", REGEXP_160);
    });
  });

  await t.test("changes_since hides unauthorized-only changes and returns tombstones", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Maintain a concert-recommendation profile over time",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const baseline = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64"))}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(baseline.status, 200);
      assert.equal(baseline.body.data.length, 8);

      const firstId = requireAt(baseline.body.data, 0, "baseline record").id;
      const ownerRecord = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(firstId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        { headers: { Authorization: `Bearer ${ownerToken}` } }
      );

      const hiddenFieldUpdate = {
        data: {
          ...ownerRecord.body.data,
          popularity: 101,
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
        key: firstId,
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          body: JSON.stringify(hiddenFieldUpdate),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );

      const hiddenDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(hiddenDelta.status, 200);
      assert.equal(hiddenDelta.body.data.length, 0);

      const visibleFieldUpdate = {
        data: {
          ...hiddenFieldUpdate.data,
          genres: [...ownerRecord.body.data.genres, "touring"],
          source_updated_at: new Date().toISOString(),
        },
        emitted_at: new Date().toISOString(),
        key: firstId,
      };

      await fetchJson(
        `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          body: JSON.stringify(visibleFieldUpdate),
          headers: {
            Authorization: `Bearer ${ownerToken}`,
            "Content-Type": "application/x-ndjson",
          },
          method: "POST",
        }
      );

      const visibleDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(hiddenDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(visibleDelta.status, 200);
      assert.equal(visibleDelta.body.data.length, 1);
      const visibleDeltaRecord = requireFirst(visibleDelta.body.data, "visible changes delta");
      assert.equal(visibleDeltaRecord.id, firstId);
      assert.deepEqual(visibleDeltaRecord.data.genres.at(-1), "touring");

      const deletedId = requireAt(baseline.body.data, 1, "deleted baseline record").id;
      const deleted = await fetch(
        `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(deletedId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
        {
          headers: { Authorization: `Bearer ${ownerToken}` },
          method: "DELETE",
        }
      );

      assert.equal(deleted.status, 204);

      const tombstoneDelta = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(visibleDelta.body.next_changes_since)}`,
        { headers: { Authorization: `Bearer ${approved.token}` } }
      );

      assert.equal(tombstoneDelta.status, 200);
      assert.equal(tombstoneDelta.body.data.length, 1);
      const tombstone = requireFirst(tombstoneDelta.body.data, "tombstone delta");
      assert.equal(tombstone.deleted, true);
      assert.equal(tombstone.id, deletedId);
    });
  });

  await t.test(
    "resource-limited changes_since pagination reports has_more only for additional visible changes",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const ownerRecordsResp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}&limit=20`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );
        assert.equal(ownerRecordsResp.status, 200);
        const ownerRecordsBody = parseResourceRecordListResponse(await ownerRecordsResp.json());
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        const ownerRecords = ownerRecordsBody.data || [];
        const visibleRecord = ownerRecords.at(-1);
        assert.ok(visibleRecord, "expected at least one owner-visible record to scope the changes_since grant");

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "single_use",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Recommend concerts using only one permitted artist change stream",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [
            {
              name: "top_artists",
              resources: [visibleRecord.id],
            },
          ],
        });

        const cursor = Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64");
        const resp = await fetch(
          `${rsUrl}/v1/streams/top_artists/records?limit=1&changes_since=${encodeURIComponent(cursor)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(resp.status, 200);
        const requestId = resp.headers.get("Request-Id");
        const traceId = resp.headers.get("PDPP-Reference-Trace-Id");
        assert.ok(requestId?.startsWith("req_"));
        assert.ok(traceId?.startsWith("trc_"));

        const body = parseResourceRecordPageResponse(await resp.json());
        assert.equal(body.object, "list");
        assert.equal(body.has_more, false, "hidden change groups should not make has_more appear true");
        assert.ok(!body.next_cursor, "no pagination cursor should be exposed when no additional visible changes exist");
        assert.ok(body.next_changes_since, "changes_since responses should still advance the bookmark");
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(body.data?.length, 1);
        // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
        assert.equal(body.data?.[0]?.id, visibleRecord.id);

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
        const queryReceivedEvent = timeline.data.find(
          (event) => event.event_type === "query.received" && event.object_id === requestId
        );
        assert.ok(
          queryReceivedEvent,
          "grant timeline should include query.received for the restricted changes_since read"
        );
        assert.equal(queryReceivedEvent.trace_id, traceId);
        assert.equal(queryReceivedEvent.stream_id, "top_artists");
        assert.equal(queryReceivedEvent.data.query_shape, "record_list");
        assert.equal(queryReceivedEvent.data.has_changes_since, true);
        assert.equal(queryReceivedEvent.data.source?.kind, "connector");
        assert.equal(queryReceivedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);

        const servedEvent = timeline.data.find(
          (event) => event.event_type === "disclosure.served" && event.object_id === requestId
        );
        assert.ok(servedEvent, "grant timeline should include disclosure.served for the restricted changes_since read");
        assert.equal(servedEvent.trace_id, traceId);
        assert.equal(servedEvent.stream_id, "top_artists");
        assert.equal(servedEvent.data.query_shape, "record_list");
        assert.equal(servedEvent.data.record_count, 1);
        assert.equal(servedEvent.data.has_more, false);
        assert.equal(servedEvent.data.has_next_changes_since, true);
        assert.equal(servedEvent.data.source?.kind, "connector");
        assert.equal(servedEvent.data.source?.id, SPOTIFY_CONNECTOR_KEY);
      });
    }
  );

  await t.test(
    "changes_since still returns a record when an authorized change is followed by an unauthorized change before sync",
    async () => {
      await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        await seedSpotify(rsUrl, spotifyManifest, ownerToken);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Maintain a concert-recommendation profile over time",
          source: { id: spotifyManifest.connector_id, kind: "connector" },
          streams: [{ name: "top_artists", view: "basic" }],
        });

        const baseline = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64"))}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );

        assert.equal(baseline.status, 200);
        assert.ok(baseline.body.data.length >= 3);

        const targetId = requireAt(baseline.body.data, 2, "target baseline record").id;
        const ownerRecord = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records/${encodeURIComponent(targetId)}?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          { headers: { Authorization: `Bearer ${ownerToken}` } }
        );

        const authorizedUpdate = {
          data: {
            ...ownerRecord.body.data,
            genres: [...ownerRecord.body.data.genres, "journal-proof"],
            source_updated_at: new Date().toISOString(),
          },
          emitted_at: new Date().toISOString(),
          key: targetId,
        };

        await fetchJson(
          `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify(authorizedUpdate),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );

        const unauthorizedUpdate = {
          data: {
            ...authorizedUpdate.data,
            popularity: 777,
            source_updated_at: new Date().toISOString(),
          },
          emitted_at: new Date().toISOString(),
          key: targetId,
        };

        await fetchJson(
          `${rsUrl}/v1/ingest/top_artists?connector_id=${encodeURIComponent(spotifyManifest.connector_id)}`,
          {
            body: JSON.stringify(unauthorizedUpdate),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );

        const delta = await fetchJson(
          `${rsUrl}/v1/streams/top_artists/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );

        assert.equal(delta.status, 200);
        assert.equal(delta.body.data.length, 1);
        const deltaRecord = requireFirst(delta.body.data, "resource mutation delta");
        assert.equal(deltaRecord.id, targetId);
        assert.equal(deltaRecord.data.genres.at(-1), "journal-proof");
        assert.equal("popularity" in deltaRecord.data, false);
      });
    }
  );

  await t.test("single_use grants issue one token but allow reuse of that token until expiry", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "One-time recommendation bootstrap",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      const first = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(first.status, 200);
      assert.equal(first.body.data.length, 1);
      assert.ok(first.body.next_cursor);

      const second = await fetchJson(
        `${rsUrl}/v1/streams/top_artists/records?limit=1&cursor=${encodeURIComponent(first.body.next_cursor)}`,
        {
          headers: { Authorization: `Bearer ${approved.token}` },
        }
      );
      assert.equal(second.status, 200);
      assert.equal(second.body.data.length, 1);
      assert.notEqual(requireFirst(second.body.data, "second page").id, requireFirst(first.body.data, "first page").id);
    });
  });

  await t.test("single_use grant: second token issuance is rejected with grant_consumed", async () => {
    // B1 HTTP proof: single_use consumption enforcement.
    // The grant is marked consumed atomically on first token issuance.
    // Any subsequent call to issueToken with the same grant_id MUST throw
    // with code 'grant_consumed' — the grant cannot be re-exchanged.
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      // Step 1: issue the single_use grant — first token issuance happens
      // inside approveGrant (POST /consent/approve) and marks it consumed.
      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "single_use",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "One-time recommendation bootstrap",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });
      assert.ok(approved.token, "first token was issued");
      assert.equal(approved.grant.access_mode, "single_use");

      // Step 2: the issued token is still valid for RS queries (pagination allowed).
      const rsFirst = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });
      assert.equal(rsFirst.status, 200, "first RS query with the issued token succeeds");

      // Step 3: verify the grant is marked consumed in the DB.
      const grantRow = getDb()
        .prepare("SELECT consumed, access_mode FROM grants WHERE grant_id = ?")
        .get(approved.grant.grant_id);
      assert.ok(grantRow, "grant row exists");
      assert.equal(grantRow.access_mode, "single_use");
      assert.equal(grantRow.consumed, 1, "grant is marked consumed after first token issuance");

      // Step 4: attempt a second token issuance on the same grant — MUST fail.
      // This is the enforcement proof: grant_consumed, not a generic error.
      await assert.rejects(
        () =>
          issueToken(approved.grant.grant_id, "u1", "concert_recommendation_app", null, {
            source: "test_second_issuance",
          }),
        (err: unknown) => {
          const error = requireJsonRecord(err, "single-use token error");
          assert.equal(error.code, "grant_consumed", "error code is grant_consumed");
          assert.match(requireString(error.message, "single-use token error.message"), REGEXP_161);
          return true;
        },
        "second token issuance on a consumed single_use grant must throw grant_consumed"
      );
    });
  });

  await t.test("continuous grant: repeated token issuances succeed (not consumed after first use)", async () => {
    // B1 control: a continuous grant must NOT be consumed after first token
    // issuance — repeated issuances must succeed until the grant is explicitly revoked.
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Ongoing concert recommendation assistant",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });
      assert.equal(approved.grant.access_mode, "continuous");

      // Verify the grant is NOT marked consumed after the initial issuance.
      const grantRow = getDb()
        .prepare("SELECT consumed, access_mode FROM grants WHERE grant_id = ?")
        .get(approved.grant.grant_id);
      assert.ok(grantRow, "expected continuous grant row");
      assert.equal(grantRow.consumed, 0, "continuous grant is not consumed after first token issuance");

      // A second token issuance must succeed for a continuous grant.
      const secondToken = await issueToken(approved.grant.grant_id, "u1", "concert_recommendation_app", null, {
        source: "test_second_issuance",
      });
      assert.ok(secondToken, "second token issuance on a continuous grant succeeds");

      // The second token must work for RS queries.
      const rsQuery = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${secondToken}` },
      });
      assert.equal(rsQuery.status, 200, "RS query with second-issued continuous token succeeds");
    });
  });

  await t.test("changes_since cursors expire with HTTP 410 when history is pruned", async () => {
    try {
      await withHarness(async ({ asUrl, rsUrl }) => {
        const cursorManifest = {
          connector_id: "cursor-expiry-fixture",
          display_name: "Cursor expiry fixture",
          protocol_version: "0.1.0",
          runtime_requirements: { bindings: { network: { required: false } } },
          streams: [
            {
              name: "events",
              primary_key: ["id"],
              schema: {
                properties: {
                  id: { type: "string" },
                  value: { type: "string" },
                },
                required: ["id", "value"],
                type: "object",
              },
              semantics: "mutable_state",
            },
          ],
          version: "1.0.0",
        };
        const registerResp = await fetchJson(`${asUrl}/connectors`, {
          body: JSON.stringify(cursorManifest),
          headers: { "Content-Type": "application/json" },
          method: "POST",
        });
        assert.equal(registerResp.status, 201);
        const ownerToken = await issueOwnerToken(asUrl, "u1");
        const initial = await fetch(
          `${rsUrl}/v1/ingest/events?connector_id=${encodeURIComponent(cursorManifest.connector_id)}`,
          {
            body: JSON.stringify({
              data: { id: "evt_1", value: "initial" },
              emitted_at: "2026-04-24T00:00:00.000Z",
              key: "evt_1",
            }),
            headers: {
              Authorization: `Bearer ${ownerToken}`,
              "Content-Type": "application/x-ndjson",
            },
            method: "POST",
          }
        );
        assert.equal(initial.status, 200);

        const approved = await approveGrant(asUrl, "u1", {
          access_mode: "continuous",
          client_id: "concert_recommendation_app",
          purpose_code: "https://pdpp.org/purpose/personalization",
          purpose_description: "Incremental sync with cursor expiry",
          source: { id: cursorManifest.connector_id, kind: "connector" },
          streams: [{ name: "events" }],
        });

        const baseline = await fetchJson(
          `${rsUrl}/v1/streams/events/records?changes_since=${encodeURIComponent(Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64"))}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(baseline.status, 200);

        process.env.PDPP_CHANGE_HISTORY_LIMIT = "2";

        for (let i = 0; i < 4; i += 1) {
          const update = {
            data: {
              id: "evt_1",
              value: `delta-${i}`,
            },
            emitted_at: `2026-04-24T00:00:0${i + 1}.000Z`,
            key: "evt_1",
          };

          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const ingest = await fetch(
            `${rsUrl}/v1/ingest/events?connector_id=${encodeURIComponent(cursorManifest.connector_id)}`,
            {
              body: JSON.stringify(update),
              headers: {
                Authorization: `Bearer ${ownerToken}`,
                "Content-Type": "application/x-ndjson",
              },
              method: "POST",
            }
          );
          assert.equal(ingest.status, 200);
        }

        const expired = await fetchJson(
          `${rsUrl}/v1/streams/events/records?changes_since=${encodeURIComponent(baseline.body.next_changes_since)}`,
          { headers: { Authorization: `Bearer ${approved.token}` } }
        );
        assert.equal(expired.status, 410);
        assert.equal(expired.body.error.code, "cursor_expired");
      });
    } finally {
      delete process.env.PDPP_CHANGE_HISTORY_LIMIT;
    }
  });

  await t.test("revoked grants fail with grant_revoked", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");
      await seedSpotify(rsUrl, spotifyManifest, ownerToken);

      const approved = await approveGrant(asUrl, "u1", {
        access_mode: "continuous",
        client_id: "concert_recommendation_app",
        purpose_code: "https://pdpp.org/purpose/personalization",
        purpose_description: "Revocation test",
        source: { id: spotifyManifest.connector_id, kind: "connector" },
        streams: [{ name: "top_artists", view: "basic" }],
      });

      await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
        headers: {
          Authorization: `Bearer ${approved.token}`,
          "Content-Type": "application/json",
        },
        method: "POST",
      });

      const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);

      const revoked = await fetchJson(`${rsUrl}/v1/streams/top_artists/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });

      assert.equal(revoked.status, 403);
      assert.equal(revoked.body.error.code, "grant_revoked");
      assert.ok(revoked.headers["request-id"]?.startsWith("req_"));
      assert.equal(revoked.headers["pdpp-reference-trace-id"], timeline.trace_id);
    });
  });

  await t.test("expired grants fail with grant_expired and preserve correlation headers", async () => {
    await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
      await seedNorthstar(nativeManifest);

      const approved = await approveGrant(asUrl, "employee_1", {
        access_mode: "continuous",
        client_id: "longview",
        purpose_code: "https://pdpp.org/purpose/financial_planning",
        purpose_description: "Expiry correlation test",
        source: { id: nativeManifest.provider_id, kind: "provider_native" },
        streams: [{ name: "pay_statements" }],
      });

      const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);

      getDb()
        .prepare(`
        UPDATE tokens
        SET expires_at = ?
        WHERE token_id = ?
      `)
        .run(new Date(Date.now() - 60_000).toISOString(), approved.token);

      const expired = await fetchJson(`${rsUrl}/v1/streams/pay_statements/records?limit=1`, {
        headers: { Authorization: `Bearer ${approved.token}` },
      });

      assert.equal(expired.status, 403);
      assert.equal(expired.body.error.code, "grant_expired");
      assert.ok(expired.headers["request-id"]?.startsWith("req_"));
      assert.equal(expired.headers["pdpp-reference-trace-id"], timeline.trace_id);
    });
  });

  await t.test(
    "auth-gate client read failures emit correlated query.rejected artifacts on the grant timeline",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        for (const scenario of [
          {
            inactiveReason: "grant_invalid",
            // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
            mutate: async (approved: ApprovedGrantResponse) => {
              getDb()
                .prepare(`
              UPDATE grants
              SET storage_binding_json = NULL
              WHERE grant_id = ?
            `)
                .run(approved.grant.grant_id);
            },
          },
          {
            inactiveReason: "grant_revoked",
            mutate: async (approved: ApprovedGrantResponse) => {
              await fetchJson(`${asUrl}/grants/${approved.grant.grant_id}/revoke`, {
                headers: {
                  Authorization: `Bearer ${approved.token}`,
                  "Content-Type": "application/json",
                },
                method: "POST",
              });
            },
          },
          {
            inactiveReason: "grant_expired",
            // biome-ignore lint/suspicious/useAwait: Async callback preserves the dependency contract and rejection timing.
            mutate: async (approved: ApprovedGrantResponse) => {
              getDb()
                .prepare(`
              UPDATE tokens
              SET expires_at = ?
              WHERE token_id = ?
            `)
                .run(new Date(Date.now() - 60_000).toISOString(), approved.token);
            },
          },
        ]) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const approved = await approveGrant(asUrl, "employee_1", {
            access_mode: "continuous",
            client_id: "longview",
            purpose_code: "https://pdpp.org/purpose/financial_planning",
            purpose_description: `Auth-gate ${scenario.inactiveReason} correlation test`,
            source: { id: nativeManifest.provider_id, kind: "provider_native" },
            streams: [{ name: "pay_statements" }],
          });

          await scenario.mutate(approved);

          const rejected = await fetchJson(`${rsUrl}/v1/streams`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          });

          assert.equal(rejected.status, 403);
          assert.equal(rejected.body.error.code, scenario.inactiveReason);
          assert.ok(rejected.headers["request-id"]?.startsWith("req_"));
          assert.ok(rejected.headers["pdpp-reference-trace-id"]?.startsWith("trc_"));

          const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
          const rejectedEvent = (timeline.data || []).find(
            (event) =>
              event.event_type === "query.rejected" &&
              event.object_id === rejected.headers["request-id"] &&
              event.data?.query_shape === "stream_list" &&
              event.data?.auth_gate === true
          );

          assert.ok(
            rejectedEvent,
            `grant timeline should include auth-gate query.rejected for ${scenario.inactiveReason}`
          );
          assert.equal(rejectedEvent.trace_id, rejected.headers["pdpp-reference-trace-id"]);
          assert.equal(rejectedEvent.data?.error?.code, scenario.inactiveReason);
        }
      });
    }
  );

  await t.test(
    "auth-gate query.rejected artifacts preserve query_shape and stream_id across client read routes",
    async () => {
      await withNativeHarness(async ({ asUrl, rsUrl, nativeManifest }) => {
        await seedNorthstar(nativeManifest);

        const approved = await approveGrant(asUrl, "employee_1", {
          access_mode: "continuous",
          client_id: "longview",
          purpose_code: "https://pdpp.org/purpose/financial_planning",
          purpose_description: "Auth-gate route-shape correlation test",
          source: { id: nativeManifest.provider_id, kind: "provider_native" },
          streams: [{ name: "pay_statements" }],
        });

        getDb()
          .prepare(`
        UPDATE grants
        SET storage_binding_json = NULL
        WHERE grant_id = ?
      `)
          .run(approved.grant.grant_id);

        const changesSince = Buffer.from(JSON.stringify({ kind: "changes_since", version: 0 })).toString("base64");

        const routeExpectations = [
          {
            path: "/v1/streams",
            queryShape: "stream_list",
            streamId: null,
          },
          {
            path: "/v1/streams/pay_statements",
            queryShape: "stream_metadata",
            streamId: "pay_statements",
          },
          {
            hasChangesSince: true,
            limit: 1,
            path: `/v1/streams/pay_statements/records?limit=1&changes_since=${encodeURIComponent(changesSince)}`,
            queryShape: "record_list",
            streamId: "pay_statements",
          },
          {
            path: "/v1/streams/pay_statements/records/ps_2026_04_15",
            queryShape: "record_detail",
            requestedRecordId: "ps_2026_04_15",
            streamId: "pay_statements",
          },
        ];

        // biome-ignore lint/suspicious/noEvolvingTypes: Accumulator evolves through deliberately heterogeneous fixture data.
        const observed = [];
        for (const route of routeExpectations) {
          // biome-ignore lint/performance/noAwaitInLoops: Sequential test setup and assertion order is intentional.
          const rejected = await fetchJson(`${rsUrl}${route.path}`, {
            headers: { Authorization: `Bearer ${approved.token}` },
          });

          assert.equal(rejected.status, 403);
          assert.equal(rejected.body.error.code, "grant_invalid");
          assert.ok(rejected.headers["request-id"]?.startsWith("req_"));
          assert.ok(rejected.headers["pdpp-reference-trace-id"]?.startsWith("trc_"));
          observed.push({
            ...route,
            requestId: rejected.headers["request-id"],
            traceId: rejected.headers["pdpp-reference-trace-id"],
          });
        }

        const { body: timeline } = await fetchGrantTimeline(asUrl, approved.grant.grant_id);

        for (const route of observed) {
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
          const queryReceivedEvent = (timeline.data || []).find(
            (event) =>
              event.event_type === "query.received" &&
              event.object_id === route.requestId &&
              event.data?.query_shape === route.queryShape &&
              event.data?.auth_gate === true
          );
          // biome-ignore lint/suspicious/noUnnecessaryConditions: Runtime guard protects an untyped external/test boundary.
          const rejectedEvent = (timeline.data || []).find(
            (event) =>
              event.event_type === "query.rejected" &&
              event.object_id === route.requestId &&
              event.data?.query_shape === route.queryShape &&
              event.data?.auth_gate === true
          );

          assert.ok(
            queryReceivedEvent,
            `grant timeline should include auth-gate query.received for ${route.queryShape}`
          );
          assert.equal(queryReceivedEvent.trace_id, route.traceId);
          assert.equal(queryReceivedEvent.stream_id ?? null, route.streamId);
          assert.equal(queryReceivedEvent.data?.has_changes_since ?? null, route.hasChangesSince ?? null);
          assert.equal(queryReceivedEvent.data?.limit ?? null, route.limit ?? null);
          assert.equal(queryReceivedEvent.data?.requested_record_id ?? null, route.requestedRecordId ?? null);
          assert.ok(rejectedEvent, `grant timeline should include auth-gate query.rejected for ${route.queryShape}`);
          assert.equal(rejectedEvent.trace_id, route.traceId);
          assert.equal(rejectedEvent.stream_id ?? null, route.streamId);
          assert.equal(rejectedEvent.data?.has_changes_since ?? null, route.hasChangesSince ?? null);
          assert.equal(rejectedEvent.data?.limit ?? null, route.limit ?? null);
          assert.equal(rejectedEvent.data?.requested_record_id ?? null, route.requestedRecordId ?? null);
          assert.equal(rejectedEvent.data?.error?.code, "grant_invalid");
        }
      });
    }
  );

  await t.test("runtime stages STATE and only commits it when requested", async () => {
    await withHarness(async ({ asUrl, rsUrl, spotifyManifest }) => {
      const ownerToken = await issueOwnerToken(asUrl, "u1");

      const uncommittedRun = await runConnector({
        collectionMode: "full_refresh",
        connectorId: spotifyManifest.connector_id,
        connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
        manifest: spotifyManifest,
        ownerToken,
        persistState: false,
        rsUrl,
        state: null,
      });

      assert.deepEqual(uncommittedRun.checkpoint_summary, {
        buffered_records_dropped: 0,
        commit_status: "disabled",
        mode: "checkpointed_streaming",
        records_flushed: 21,
        state_streams_committed: 0,
        state_streams_staged: 2,
      });

      const noState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.deepEqual(noState, {});

      const committedRun = await runConnector({
        collectionMode: "full_refresh",
        connectorId: spotifyManifest.connector_id,
        connectorPath: join(REFERENCE_IMPL_DIR, "connectors/seed/index.ts"),
        manifest: spotifyManifest,
        ownerToken,
        persistState: true,
        rsUrl,
        state: null,
      });

      assert.deepEqual(committedRun.checkpoint_summary, {
        buffered_records_dropped: 0,
        commit_status: "committed",
        mode: "checkpointed_streaming",
        records_flushed: 21,
        state_streams_committed: 2,
        state_streams_staged: 2,
      });

      const persistedState = await loadSyncState(spotifyManifest.connector_id, ownerToken, { rsUrl });
      assert.ok(persistedState, "sync state should be persisted");
      assert.ok(persistedState.top_artists);
      assert.ok(persistedState.saved_tracks);
    });
  });
});
