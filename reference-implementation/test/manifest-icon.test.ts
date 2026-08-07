// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Validation coverage for connector manifest `icon`.
 *
 * `icon` is an OPTIONAL, manifest-declared brand glyph the console renders in
 * place of the deterministic monogram fallback. v1 supports exactly one
 * kind, `inline_svg`: the manifest carries the SVG markup itself, so no
 * runtime fetch and no connector-id -> icon map exists anywhere in the
 * console or reference implementation.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { validateManifestIcon } from "../server/connector-manifest-validation.ts";
import { startServer } from "../server/index.ts";

type StartedServer = Awaited<ReturnType<typeof startServer>>;

function hasCloseAllConnections(server: object): server is { closeAllConnections: () => void } {
  return "closeAllConnections" in server && typeof server.closeAllConnections === "function";
}

async function closeServer(server: StartedServer): Promise<void> {
  if (hasCloseAllConnections(server.asServer)) {
    server.asServer.closeAllConnections();
  }
  if (hasCloseAllConnections(server.rsServer)) {
    server.rsServer.closeAllConnections();
  }
  await Promise.allSettled([
    new Promise((r) => server.asServer.close(r)),
    new Promise((r) => server.rsServer.close(r)),
  ]);
}

async function withHarness(fn: (harness: { asUrl: string }) => Promise<void>): Promise<void> {
  const server = await startServer({
    asPort: 0,
    dbPath: ":memory:",
    quiet: true,
    rsPort: 0,
  });
  try {
    await fn({ asUrl: `http://localhost:${server.asPort}` });
  } finally {
    await closeServer(server);
  }
}

interface ErrorBody {
  error: { code: string; message: string };
}

interface RegisterResult {
  body: ErrorBody | string | null;
  status: number;
}

function hasErrorBody(body: RegisterResult["body"]): body is ErrorBody {
  return typeof body === "object" && body !== null && "error" in body;
}

async function registerConnectorManifest(asUrl: string, manifest: unknown): Promise<RegisterResult> {
  const resp = await fetch(`${asUrl}/connectors`, {
    body: JSON.stringify(manifest),
    headers: { "Content-Type": "application/json" },
    method: "POST",
  });
  const text = await resp.text();
  let body: RegisterResult["body"] = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { body, status: resp.status };
}

const SIMPLE_SVG = '<svg role="img" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 0z"/></svg>';

function makeManifest(extra: Record<string, unknown> = {}) {
  return {
    connector_id: "https://registry.pdpp.test/connectors/icon-fixture",
    display_name: "Icon fixture",
    protocol_version: "0.1.0",
    streams: [
      {
        cursor_field: "received_at",
        name: "notes",
        primary_key: ["id"],
        schema: {
          properties: {
            id: { type: "string" },
            received_at: { format: "date-time", type: "string" },
          },
          required: ["id", "received_at"],
          type: "object",
        },
        selection: { fields: true, resources: true },
        semantics: "mutable_state",
      },
    ],
    version: "0.1.0",
    ...extra,
  };
}

test("manifest declaring a valid inline_svg icon is accepted", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "#1ED760", kind: "inline_svg", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest omitting icon is accepted (no icon is the default state)", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(asUrl, makeManifest());
    assert.equal(status, 201, `expected 201, got ${status}: ${JSON.stringify(body)}`);
  });
});

test("manifest icon with an unsupported kind is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "remote_url", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    assert.equal(body.error.code, "invalid_request");
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.kind must be "inline_svg"/u);
  });
});

test("manifest icon.svg containing a script tag is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        icon: { kind: "inline_svg", svg: "<svg><script>alert(1)</script></svg>" },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /must not contain scripts/u);
  });
});

test("manifest icon.svg with an event-handler attribute is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({
        icon: { kind: "inline_svg", svg: '<svg onload="alert(1)"><path d="M0 0z"/></svg>' },
      })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /must not contain scripts/u);
  });
});

test("manifest icon.svg not wrapped in a bare <svg> element is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "inline_svg", svg: "<div>not an svg</div>" } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /bare <svg>/u);
  });
});

test("manifest icon.color with a non-hex value is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { color: "spotify green", kind: "inline_svg", svg: SIMPLE_SVG } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon\.color must be a hex color/u);
  });
});

test("manifest icon with unsupported keys is rejected", async () => {
  await withHarness(async ({ asUrl }) => {
    const { status, body } = await registerConnectorManifest(
      asUrl,
      makeManifest({ icon: { kind: "inline_svg", svg: SIMPLE_SVG, url: "https://example.com/icon.svg" } })
    );
    assert.equal(status, 400);
    assert.ok(hasErrorBody(body));
    // biome-ignore lint/performance/useTopLevelRegex: localized test assertion preserves its explicit contract.
    assert.match(body.error.message, /icon has unsupported keys/u);
  });
});

test("validateManifestIcon: pure-function shape checks", () => {
  assert.doesNotThrow(() => validateManifestIcon({}, "invalid_request"));
  assert.doesNotThrow(() => validateManifestIcon({ icon: undefined }, "invalid_request"));
  assert.doesNotThrow(() => validateManifestIcon({ icon: { kind: "inline_svg", svg: SIMPLE_SVG } }, "invalid_request"));
  assert.throws(() => validateManifestIcon({ icon: "not-an-object" }, "invalid_request"));
  assert.throws(() => validateManifestIcon({ icon: { kind: "inline_svg" } }, "invalid_request"));
});
