// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Test-only stub connector for `bin/scenario-cli.test.ts`.
 *
 * Unlike `src/test-fixtures/connector-dev-cli-fixture.ts` (which emits
 * hardcoded records with no HTTP calls), this fixture makes REAL `fetch`
 * calls against `PDPP_SCENARIO_STUB_BASE_URL` (an env var the test points at
 * its own in-test synthetic HTTP provider on loopback) — it needs actual
 * network traffic to record/replay, because bin/scenario-record.ts and
 * bin/scenario-verify.ts exist to capture and replay HTTP interactions, not
 * hardcoded records.
 *
 * Two-page cursor pagination on a single `items` stream, closely mirroring
 * connectors/oura/index.ts's shape (a `next_token`-style cursor query param,
 * a day-based incremental `since` cursor from committed state) so the CLI
 * proof exercises the same pagination + incremental-narrowing pattern the
 * real oura spike proved, without depending on it. NOT registered in
 * src/orchestrator.ts — fixture-only, never a production connector.
 */

import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

interface StubItem {
  id: string;
  value: string;
}

interface StubPage {
  items: StubItem[];
  next_cursor: string | null;
}

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "items" && typeof data.id === "string" && typeof data.value === "string") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected string id and value" }] };
};

runConnector({
  name: "scenario-cli-stub-connector",
  validateRecord,
  async collect({ emit, emitRecord, state }) {
    const baseUrl = process.env.PDPP_SCENARIO_STUB_BASE_URL;
    if (!baseUrl) {
      throw new Error("scenario-cli-stub-connector: PDPP_SCENARIO_STUB_BASE_URL is not set");
    }
    const itemsState = state.items;
    const since =
      itemsState !== null &&
      typeof itemsState === "object" &&
      typeof (itemsState as { since?: unknown }).since === "string"
        ? (itemsState as { since: string }).since
        : undefined;

    await emit({ type: "PROGRESS", stream: "items", message: "collecting stub items" });

    let cursor: string | undefined;
    let lastId: string | undefined;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("/items", baseUrl);
      if (since) {
        url.searchParams.set("since", since);
      }
      if (cursor) {
        url.searchParams.set("cursor", cursor);
      }
      // credential-shaped param so the CLI's normalizer path is exercised
      // for real, the same way oura's next_token collides with the
      // credential regex.
      url.searchParams.set("api_token", "stub-token-never-persisted");

      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`scenario-cli-stub-connector: fetch failed with status ${String(res.status)}`);
      }
      const body = (await res.json()) as StubPage;
      for (const item of body.items) {
        await emitRecord("items", { id: item.id, value: item.value });
        lastId = item.id;
      }
      if (!body.next_cursor) {
        break;
      }
      cursor = body.next_cursor;
    }

    if (lastId) {
      await emit({ type: "STATE", stream: "items", cursor: { since: lastId } });
    }
  },
});
