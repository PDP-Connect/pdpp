// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveSourceIntrospectionContext } from "../../server/source-introspection-context.ts";
import { writePr89CaseOutput } from "./pr89-case-output.ts";
import { bearer, startPr89OAuthHarness } from "./pr89-oauth-harness.ts";

interface MutationFixture {
  delete?: boolean;
  expected: string;
  kind: "credentials" | "request" | "response";
  path?: string;
  query?: string;
  status?: number;
  value?: unknown;
}

const MUTATION_NAMES = [
  "wrong-credentials",
  "wrong-issuer",
  "wrong-audience",
  "expired",
  "stale-cache",
  "inactive",
  "wrong-context-kind",
  "client-mismatch",
  "subject-mismatch",
  "source-mismatch",
  "grant-mismatch",
  "rights-missing",
  "instance-mismatch",
  "field-mismatch",
] as const;

function mutationFixture(name: string): MutationFixture {
  return JSON.parse(
    readFileSync(new URL(`./fixtures/pr89/introspection/mutations/${name}.json`, import.meta.url), "utf8")
  ) as MutationFixture;
}

function mutatePath(target: Record<string, unknown>, fixture: MutationFixture): void {
  assert.ok(fixture.path);
  const parts = fixture.path.split(".");
  const leaf = parts.pop();
  assert.ok(leaf);
  let owner = target;
  for (const part of parts) {
    const next = owner[part];
    assert.ok(next && typeof next === "object" && !Array.isArray(next));
    owner = next as Record<string, unknown>;
  }
  if (fixture.delete) {
    delete owner[leaf];
  } else {
    owner[leaf] = fixture.value;
  }
}

async function parseJson(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

test("authenticated HTTP introspection resolves context and rejects the fixed mutation matrix", async () => {
  const harness = await startPr89OAuthHarness();
  const validFixture = JSON.parse(
    readFileSync(new URL("./fixtures/pr89/introspection/valid.json", import.meta.url), "utf8")
  ) as MutationFixture;
  assert.deepEqual(validFixture, { expected: "active", kind: "response" });
  let current: MutationFixture | null = null;
  let introspectionCalls = 0;
  let capturedResponse: Record<string, unknown> | null = null;
  const envelopes: Record<string, unknown>[] = [];
  harness.setIntrospectionInterceptor(async (input, init) => {
    introspectionCalls += 1;
    if (current?.kind === "credentials") {
      const headers = new Headers(init?.headers);
      headers.set("Authorization", "Basic invalid");
      return fetch(input, { ...init, headers });
    }
    const response = await fetch(input, init);
    if (!response.ok) {
      return response;
    }
    const body = await parseJson(response);
    capturedResponse = structuredClone(body);
    if (current?.kind === "response") {
      mutatePath(body, current);
    }
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: response.status,
    });
  });

  try {
    current = null;
    const valid = await fetch(`${harness.rsUrl}/v1/streams`, { headers: bearer(harness.token) });
    assert.equal(valid.status, 200, JSON.stringify(await parseJson(valid.clone())));
    assert.equal(introspectionCalls, 1);
    assert.ok(capturedResponse);
    const resolved = resolveSourceIntrospectionContext(capturedResponse);
    const grant = resolved.grant as { streams: Record<string, unknown>[] };
    const approvedStream = grant.streams.find((stream) => stream.name === "top_artists");
    assert.deepEqual(approvedStream?.instance_ids, [harness.instanceId]);
    assert.deepEqual(approvedStream?.fields, ["id", "name", "observed_at"]);
    assert.deepEqual(approvedStream?.time_constraint, {
      field: "observed_at",
      since: "2026-01-01T00:00:00Z",
      until: "2026-04-01T00:00:00Z",
    });
    assert.deepEqual(approvedStream?.resources, ["artist:42"]);
    envelopes.push({ fixture: "valid", status: valid.status });

    for (const name of MUTATION_NAMES) {
      current = mutationFixture(name);
      const before: number = introspectionCalls;
      const query = current.kind === "request" ? `?${current.query}` : "";
      // biome-ignore lint/performance/noAwaitInLoops: The mutable interceptor must apply one named mutation at a time.
      const response = await fetch(`${harness.rsUrl}/v1/streams/top_artists/records${query}`, {
        headers: bearer(harness.token),
      });
      const body = await parseJson(response);
      const error = body.error as Record<string, unknown> | undefined;
      assert.equal(response.status, current.status ?? 401, `${name}: ${JSON.stringify(body)}`);
      assert.equal(error?.code, current.expected, name);
      assert.equal(introspectionCalls, before + 1, name);
      envelopes.push({ error: error?.code, fixture: name, status: response.status });
    }

    writePr89CaseOutput({
      case_id: "case-3",
      observations: [
        "authenticated_http_introspection",
        "complete_context_resolved",
        "mutation_matrix_rejected",
        "one_http_introspection_no_fallback",
      ],
      oracle_code: "context_resolved",
      response_envelopes: envelopes,
      schema: "pdpp.pr89.case-output.v1",
    });
  } finally {
    await harness.close();
  }
});
