// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { resolveSourceIntrospectionContext } from "../../server/source-introspection-context.ts";
import { writePr89CaseOutput } from "./pr89-case-output.ts";
import { bearer, startPr89OAuthHarness } from "./pr89-oauth-harness.ts";

async function jsonBody(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

test("captured introspection context enforces the response-only request matrix with AS disabled", async () => {
  const harness = await startPr89OAuthHarness();
  const records = JSON.parse(readFileSync(new URL("./fixtures/pr89/records.json", import.meta.url), "utf8")) as Record<
    string,
    Parameters<typeof harness.ingest>[0]
  >;
  assert.ok(records.allowed && records.outside_resource && records.outside_time);
  await harness.ingest(records.allowed);
  await harness.ingest(records.outside_resource);
  let captured: Record<string, unknown> | null = null;
  harness.setIntrospectionInterceptor(async (input, init) => {
    const response = await fetch(input, init);
    const body = await jsonBody(response);
    captured = structuredClone(body);
    return new Response(JSON.stringify(body), {
      headers: { "Content-Type": "application/json" },
      status: response.status,
    });
  });

  try {
    const captureRequest = await fetch(`${harness.rsUrl}/v1/streams`, { headers: bearer(harness.token) });
    assert.equal(captureRequest.status, 200);
    assert.ok(captured);
    const resolved = resolveSourceIntrospectionContext(captured);
    const grant = resolved.grant as { streams: Record<string, unknown>[] };
    const stream = grant.streams.find((candidate) => candidate.name === "top_artists");
    assert.deepEqual(stream?.instance_ids, [harness.instanceId]);
    assert.deepEqual(stream?.time_constraint, {
      field: "observed_at",
      since: "2026-01-01T00:00:00Z",
      until: "2026-04-01T00:00:00Z",
    });

    let responseOnlyReads = 0;
    harness.setIntrospectionInterceptor(() => {
      responseOnlyReads += 1;
      return Promise.resolve(
        new Response(JSON.stringify(captured), {
          headers: { "Content-Type": "application/json" },
          status: 200,
        })
      );
    });
    await harness.disableAuthorizationServer();

    const recordsUrl = `${harness.rsUrl}/v1/streams/top_artists/records?connection_id=${encodeURIComponent(harness.instanceId)}`;
    const allowed = await fetch(recordsUrl, { headers: bearer(harness.token) });
    assert.equal(allowed.status, 200);
    const allowedBody = await jsonBody(allowed);
    const allowedData = allowedBody.data as Record<string, unknown>[];
    assert.deepEqual(
      allowedData.map((record) => record.id),
      ["artist:42"]
    );

    const deniedRequests = [
      {
        code: "context.stream_not_allowed",
        name: "stream",
        status: 401,
        url: `${harness.rsUrl}/v1/streams/recently_played/records`,
      },
      {
        code: "context.instance_mismatch",
        name: "instance",
        status: 401,
        url: `${harness.rsUrl}/v1/streams/top_artists/records?connection_id=account-b`,
      },
      {
        code: "unknown_field",
        name: "field",
        status: 400,
        url: `${harness.rsUrl}/v1/streams/top_artists/records?fields=private_note`,
      },
    ] as const;
    const deniedEnvelopes = await Promise.all(
      deniedRequests.map(async (denied) => {
        const response = await fetch(denied.url, { headers: bearer(harness.token) });
        const body = await jsonBody(response);
        const error = body.error as Record<string, unknown> | undefined;
        assert.equal(response.status, denied.status, `${denied.name}: ${JSON.stringify(body)}`);
        assert.equal(error?.code, denied.code, denied.name);
        return { error: error?.code, matrix: denied.name, status: response.status };
      })
    );
    const envelopes: Record<string, unknown>[] = [{ matrix: "allowed", status: allowed.status }, ...deniedEnvelopes];

    await harness.ingest(records.outside_time);
    const outsideTime = await fetch(recordsUrl, { headers: bearer(harness.token) });
    assert.equal(outsideTime.status, 200);
    const outsideTimeBody = await jsonBody(outsideTime);
    assert.deepEqual(outsideTimeBody.data, []);
    envelopes.push(
      { matrix: "resource_omitted", status: allowed.status },
      { matrix: "time_omitted", status: outsideTime.status }
    );
    assert.equal(responseOnlyReads, 5);

    writePr89CaseOutput({
      case_id: "case-4",
      observations: ["allowed_matrix_passed", "as_disabled", "denied_matrix_passed", "response_only_enforcement"],
      oracle_code: "response_only",
      response_envelopes: envelopes,
      schema: "pdpp.pr89.case-output.v1",
    });
  } finally {
    await harness.close();
  }
});
