// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
//
// The client-under-test seam. Unlike TargetAdapter, this contract puts the
// suite on the server side of a small fixture and observes the requests the
// client sends to it. The fixture is deliberately part of the contract: a
// client case must say which server response made its next request meaningful.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

const RECORDS_PATH = /^\/v1\/streams\/[^/]+\/records$/;

export type ClientSelection = Readonly<Record<string, unknown>>;

export interface ClientRequest {
  readonly body?: unknown;
  readonly headers: Readonly<Record<string, string>>;
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
}

export interface ClientActionResult {
  readonly errorCode?: unknown;
  readonly errorType?: unknown;
  readonly ok: boolean;
  readonly sourceKindRead?: string;
  readonly status: number;
}

export type ClientFixtureResponse =
  | {
      readonly kind: "page";
      readonly nextChangesSince?: string;
      readonly nextCursor?: string;
    }
  | {
      readonly code: unknown;
      readonly kind: "error";
      readonly status: number;
      readonly type?: unknown;
    }
  | {
      readonly cursor: string;
      readonly expiredCursor: string;
      readonly kind: "expired-cursor";
    };

export interface ClientFixture {
  close: () => Promise<void>;
  readonly configure: (response: ClientFixtureResponse) => void;
  readonly requestLog: () => readonly ClientRequest[];
  readonly url: string;
}

/**
 * The smallest client surface the conformance cases need.
 *
 * `requestLog` is the primary observation. The action results carry only the
 * HTTP outcome and grant provenance needed by cases; they do not expose
 * client internals.
 */
export interface ClientUnderTest {
  authorize: (selection: ClientSelection) => Promise<ClientActionResult>;
  readonly fixture: ClientFixture;
  readPage: (stream: string, cursor?: string) => Promise<ClientActionResult>;
  syncAgain: (stream: string) => Promise<ClientActionResult>;
  syncOnce: (stream: string) => Promise<ClientActionResult>;
}

type ClientDefect =
  | "add-selection-display"
  | "assume-source-kind"
  | "construct-cursor"
  | "override-status-with-error-code"
  | "parse-unknown-identifier"
  | "reuse-next-cursor-as-changes-since"
  | "retry-expired-cursor"
  | "retry-revoked-grant"
  | "throw-on-unknown-error";

interface RsSuccessResponse<Body = unknown> {
  readonly body: Body;
  readonly ok: true;
  readonly status: number;
}

interface RsErrorResponse {
  readonly error: Readonly<Record<string, unknown>>;
  readonly ok: false;
  readonly status: number;
}

type RsResponse<Body = unknown> = RsSuccessResponse<Body> | RsErrorResponse;

/**
 * This is the response shape used by the vendored `@pdpp/mcp-server` client.
 * It is kept private so the conformance contract stays independent of that
 * package's release surface.
 */
class VendoredRsClient {
  private readonly accessToken = "client-fixture-access-token";
  private readonly providerUrl: string;

  constructor(providerUrl: string) {
    this.providerUrl = providerUrl;
  }

  getJson<Body = unknown>(path: string, query: Readonly<Record<string, string>> = {}): Promise<RsResponse<Body>> {
    return this.request("GET", path, undefined, query);
  }

  postJson<Body = unknown>(path: string, body: unknown): Promise<RsResponse<Body>> {
    return this.request("POST", path, body);
  }

  private async request<Body>(
    method: string,
    path: string,
    body?: unknown,
    query: Readonly<Record<string, string>> = {}
  ): Promise<RsResponse<Body>> {
    const url = new URL(path, `${this.providerUrl}/`);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }
    const response = await fetch(url, {
      method,
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${this.accessToken}`,
        "User-Agent": "@pdpp/mcp-server",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const contentType = response.headers.get("content-type") ?? "";
    const parsed = contentType.includes("application/json") ? await response.json() : await response.text();
    if (response.ok) {
      return { body: parsed as Body, ok: true, status: response.status };
    }
    const envelope = parsed && typeof parsed === "object" && "error" in parsed ? parsed.error : parsed;
    return {
      error: (envelope && typeof envelope === "object" ? envelope : {}) as Readonly<Record<string, unknown>>,
      ok: false,
      status: response.status,
    };
  }
}

function actionResult<Body>(response: RsResponse<Body>, sourceKindRead?: string): ClientActionResult {
  if (response.ok) {
    return { ok: true, ...(sourceKindRead === undefined ? {} : { sourceKindRead }), status: response.status };
  }
  return {
    errorCode: response.error.code,
    errorType: response.error.type,
    ok: false,
    ...(sourceKindRead === undefined ? {} : { sourceKindRead }),
    status: response.status,
  };
}

function isUnknownIdentifier(value: unknown): boolean {
  return typeof value !== "string";
}

function shouldRetryUnknownError(response: RsResponse): boolean {
  return !response.ok && response.status >= 400 && typeof response.error.code === "string";
}

function responseBodyField(body: unknown, field: string): string | undefined {
  if (!body || typeof body !== "object") {
    return undefined;
  }
  const value = (body as Record<string, unknown>)[field];
  return typeof value === "string" ? value : undefined;
}

async function readBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  if (chunks.length === 0) {
    return undefined;
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json");
  response.end(JSON.stringify(body));
}

function requestHeaders(request: IncomingMessage): Readonly<Record<string, string>> {
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") {
      headers[key] = value;
    } else if (value) {
      headers[key] = value.join(",");
    }
  }
  return headers;
}

function queryValues(url: URL): Readonly<Record<string, string>> {
  return Object.fromEntries(url.searchParams.entries());
}

async function startFixture(): Promise<ClientFixture> {
  const requests: ClientRequest[] = [];
  let configuredResponse: ClientFixtureResponse = {
    kind: "page",
    nextChangesSince: "changes-since-fixture-token",
    nextCursor: "page-fixture-token",
  };

  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: one fixture handler must expose each protocol response mode so the request log remains the single independent observation.
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    const body = await readBody(request);
    requests.push({
      ...(body === undefined ? {} : { body }),
      headers: requestHeaders(request),
      method: request.method ?? "GET",
      path: url.pathname,
      query: queryValues(url),
    });

    if (request.method === "POST" && url.pathname === "/authorize") {
      writeJson(response, 200, {
        access_token: "client-fixture-access-token",
        grant: { source: { id: "https://fixture.invalid/source", kind: "connector" } },
      });
      return;
    }

    if (request.method !== "GET" || !RECORDS_PATH.test(url.pathname)) {
      writeJson(response, 404, { error: { code: "not_found", type: "not_found_error" } });
      return;
    }

    if (configuredResponse.kind === "error") {
      writeJson(response, configuredResponse.status, {
        error: {
          code: configuredResponse.code,
          ...(configuredResponse.type === undefined ? {} : { type: configuredResponse.type }),
        },
      });
      return;
    }

    if (
      configuredResponse.kind === "expired-cursor" &&
      url.searchParams.get("changes_since") === configuredResponse.expiredCursor
    ) {
      writeJson(response, 410, { error: { code: "cursor_expired", type: "gone_error" } });
      return;
    }

    let nextChangesSince: string | undefined;
    if (configuredResponse.kind === "page") {
      ({ nextChangesSince } = configuredResponse);
    } else if (url.searchParams.has("changes_since")) {
      nextChangesSince = "changes-since-after-full-resync";
    } else {
      nextChangesSince = configuredResponse.expiredCursor;
    }

    writeJson(response, 200, {
      data: [],
      has_more: false,
      next_changes_since: nextChangesSince,
      next_cursor: configuredResponse.kind === "page" ? configuredResponse.nextCursor : configuredResponse.cursor,
      object: "list",
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Client fixture did not receive a TCP address.");
  }

  return {
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
    configure: (response) => {
      configuredResponse = response;
    },
    requestLog: () => requests.slice(),
    url: `http://127.0.0.1:${address.port}`,
  };
}

export async function createPdppClientUnderTest(defects: readonly ClientDefect[] = []): Promise<ClientUnderTest> {
  const fixture = await startFixture();
  const defectSet = new Set(defects);
  const client = new VendoredRsClient(fixture.url);
  let nextChangesSince: string | undefined;
  let nextCursor: string | undefined;
  let grantSourceKind: string | undefined;

  function getPage(stream: string, query: Readonly<Record<string, string>>): Promise<RsResponse> {
    return client.getJson(`/v1/streams/${encodeURIComponent(stream)}/records`, query);
  }

  async function syncOnce(stream: string): Promise<ClientActionResult> {
    const response = await getPage(stream, {});
    if (response.ok) {
      nextChangesSince = responseBodyField(response.body, "next_changes_since");
      nextCursor = responseBodyField(response.body, "next_cursor");
    }
    return actionResult(response);
  }

  return {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this adapter deliberately keeps the client defect switches beside the action they mutate so each receipt names one behavior change.
    authorize: async (selection) => {
      const requestSelection = {
        ...selection,
        ...(defectSet.has("add-selection-display") ? { display: "client supplied" } : {}),
        ...(defectSet.has("assume-source-kind") ? { source: { kind: "provider_native" } } : {}),
      };
      const response = await client.postJson("/authorize", { authorization_details: [requestSelection] });
      if (response.ok) {
        const grant =
          response.body && typeof response.body === "object"
            ? (response.body as Record<string, unknown>).grant
            : undefined;
        const source = grant && typeof grant === "object" ? (grant as Record<string, unknown>).source : undefined;
        grantSourceKind =
          source && typeof source === "object" && typeof (source as Record<string, unknown>).kind === "string"
            ? ((source as Record<string, unknown>).kind as string)
            : undefined;
      }
      if (!response.ok && defectSet.has("throw-on-unknown-error")) {
        throw new Error("authorization request failed");
      }
      return actionResult(response, grantSourceKind);
    },
    fixture,
    readPage: async (stream, cursor) => {
      const sentCursor =
        cursor === undefined || !defectSet.has("construct-cursor") ? cursor : `${cursor}-constructed-by-client`;
      const response = await getPage(stream, sentCursor === undefined ? {} : { cursor: sentCursor });
      if (
        !response.ok &&
        defectSet.has("retry-revoked-grant") &&
        response.status === 403 &&
        response.error.code === "grant_revoked"
      ) {
        return actionResult(await getPage(stream, sentCursor === undefined ? {} : { cursor: sentCursor }));
      }
      if (!response.ok && defectSet.has("throw-on-unknown-error") && shouldRetryUnknownError(response)) {
        throw new Error("unknown error code parser failed");
      }
      if (!response.ok && defectSet.has("parse-unknown-identifier") && isUnknownIdentifier(response.error.code)) {
        throw new Error("unknown error identifier parser failed");
      }
      if (
        !response.ok &&
        defectSet.has("override-status-with-error-code") &&
        response.error.code === "cursor_expired"
      ) {
        return { errorCode: response.error.code, errorType: response.error.type, ok: false, status: 410 };
      }
      return actionResult(response, grantSourceKind);
    },
    syncAgain: async (stream) => {
      const changesSince = defectSet.has("reuse-next-cursor-as-changes-since") ? nextCursor : nextChangesSince;
      const response = await getPage(stream, changesSince === undefined ? {} : { changes_since: changesSince });
      if (!response.ok && response.status === 410 && response.error.code === "cursor_expired") {
        if (defectSet.has("retry-expired-cursor")) {
          return actionResult(await getPage(stream, changesSince === undefined ? {} : { changes_since: changesSince }));
        }
        return syncOnce(stream);
      }
      if (!response.ok && defectSet.has("throw-on-unknown-error") && shouldRetryUnknownError(response)) {
        throw new Error("unknown error code parser failed");
      }
      return actionResult(response);
    },
    syncOnce,
  };
}

export type { ClientDefect };
