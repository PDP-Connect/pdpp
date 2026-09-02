// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only connector fixture for `bin/scenario-fidelity.test.ts`.
 *
 * Makes a SEQUENCE of real `fetch` calls against `PDPP_SCENARIO_FIDELITY_BASE_URL`
 * (an env var the test points at its own in-test loopback HTTP provider),
 * covering every recorder-fidelity behavior FIX 1 adds:
 *   1. POST with a JSON body (body_sha256 must be recorded).
 *   2. GET with a `session_token` query param whose value equals a string
 *      leaf of request 1's response body (bindings must be produced; the
 *      raw value must never be persisted).
 *   3. GET with a genuine (never-provider-issued) `api_key` query param
 *      (must still be redacted+normalized, unchanged from prior behavior).
 *   4. GET of a response the provider marks oversized (truncation path).
 *
 * NOT registered in `src/orchestrator.ts` — fixture-only, never a
 * production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (_stream: string, data: RecordData) => ({ ok: true, data });

runConnector({
  name: "scenario-fidelity-http-connector",
  validateRecord,
  async collect({ emit, emitRecord }) {
    const baseUrl = process.env.PDPP_SCENARIO_FIDELITY_BASE_URL;
    if (!baseUrl) {
      throw new Error("scenario-fidelity-http-connector: PDPP_SCENARIO_FIDELITY_BASE_URL is not set");
    }

    await emit({ type: "PROGRESS", stream: "items", message: "creating session" });

    // 1. POST with a JSON body — body_sha256 must be recorded.
    const createRes = await fetch(new URL("/session", baseUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ client: "scenario-fidelity-http-connector" }),
    });
    const created = (await createRes.json()) as { cursor: string };
    await emitRecord("items", { id: "session", cursor: created.cursor });

    // 2. GET with a provider-issued cursor in a credential-shaped param —
    // must produce a binding, must NOT persist the raw cursor value.
    const pageUrl = new URL("/page", baseUrl);
    pageUrl.searchParams.set("session_token", created.cursor);
    const pageRes = await fetch(pageUrl);
    const page = (await pageRes.json()) as { items: Array<{ id: string }> };
    for (const item of page.items) {
      await emitRecord("items", { id: item.id });
    }

    // 3. GET with a genuine client secret — no provenance, must stay redacted.
    const secretUrl = new URL("/secret-page", baseUrl);
    secretUrl.searchParams.set("api_key", "genuinely-never-issued-by-provider");
    await fetch(secretUrl);

    // 4. GET of an oversized response — truncation path.
    await fetch(new URL("/huge", baseUrl));

    await emit({ type: "STATE", stream: "items", cursor: { since: created.cursor } });
  },
});
