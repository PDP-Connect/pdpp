// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Pins the literal route strings the console calls against the literal
 * strings the reference server registers them under, so a rename on either
 * side fails a test instead of surfacing as a live 404.
 *
 * `rs-client.ts` and `operator-runs.ts` import `server-only` transitively, so
 * their functions cannot execute in a plain `node:test` process (same
 * constraint documented in `ref-client-pagination.test.ts`). These tests pin
 * the source-level contract instead: read both the caller and the route
 * registration as text and assert the same literal path appears in each.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const CONNECTOR_TEMPLATES_PATH = "/v1/owner/connector-templates";
const RUN_INTERACTION_STREAM_MINT_PATH = "/_ref/runs/:runId/run-interaction-stream";

test("listOwnerConnectorTemplates calls the path owner-connector-templates.ts registers", async () => {
  const clientSource = await readFile(new URL("./rs-client.ts", import.meta.url), "utf8");
  assert.match(
    clientSource,
    /authedFetch\("\/v1\/owner\/connector-templates"\)/,
    "rs-client.ts must call the literal /v1/owner/connector-templates path"
  );

  const routeSource = await readFile(
    new URL(
      "../../../../../../reference-implementation/server/routes/owner-connector-templates.ts",
      import.meta.url
    ),
    "utf8"
  );
  assert.match(
    routeSource,
    /app\.get\(\s*"\/v1\/owner\/connector-templates"/,
    "owner-connector-templates.ts must register the literal /v1/owner/connector-templates path"
  );

  assert.ok(clientSource.includes(CONNECTOR_TEMPLATES_PATH) && routeSource.includes(CONNECTOR_TEMPLATES_PATH));
});

test("mintRunInteractionStream calls the path streaming/routes.ts registers", async () => {
  const clientSource = await readFile(new URL("./operator-runs.ts", import.meta.url), "utf8");
  assert.match(
    clientSource,
    /fetchAs\(`\/_ref\/runs\/\$\{encodeURIComponent\(runId\)\}\/run-interaction-stream`, \{\s*\n\s*body: asJson\(payload\)/,
    "operator-runs.ts must POST to the literal /_ref/runs/:runId/run-interaction-stream template"
  );

  const routeSource = await readFile(
    new URL("../../../../../../reference-implementation/server/streaming/routes.ts", import.meta.url),
    "utf8"
  );
  assert.match(
    routeSource,
    /app\.post\("\/_ref\/runs\/:runId\/run-interaction-stream",/,
    "streaming/routes.ts must register POST /_ref/runs/:runId/run-interaction-stream"
  );

  assert.ok(routeSource.includes(RUN_INTERACTION_STREAM_MINT_PATH));
});
