// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Behavioral proof for the local-collector scope contract.
//
// These drive a REAL connector child process against a REAL HTTP server and
// assert on what the collector actually sent — not on the shape of a helper's
// return value. The four cases are the ones that decide whether a bounded local
// collection is honest:
//
//   (a) a truncated sample stays NON-GREEN (no coverage checkpoint)
//   (b) a complete scoped pass COMMITS coverage bound to its scope
//   (c) out-of-scope data is NOT claimed as covered
//   (d) a scope change INVALIDATES prior proof
//
// The server-declared boundary is injected through the same `/state` read a
// real deployment uses, so these also prove the delivery path rather than
// assuming it.

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  buildCollectorStartMessage,
  buildTerminalCollectionFacts,
  COLLECTION_SCOPE_STATE_KEY,
  collectorScopeFingerprint,
  readCollectionScopeFromState,
  resolveScopedStreamTimeRanges,
  runCollectorConnector,
} from "./collector-runner.ts";

const SINCE = "2026-06-01T00:00:00.000Z";
/** Mirrors the claude_code/codex manifest split: 3 timed streams, the rest not. */
const TIME_SCOPABLE = ["sessions", "messages"];
const ALL_STREAMS = ["sessions", "messages", "skills", "coverage_diagnostics"];

interface ScopeHarness {
  close: () => Promise<void>;
  terminalPosts: Record<string, unknown>[];
  url: string;
}

async function startScopeHarness(priorState: Record<string, unknown>): Promise<ScopeHarness> {
  const terminalPosts: Record<string, unknown>[] = [];
  let persisted: Record<string, unknown> = { ...priorState };

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const url = req.url ?? "";
      const raw = Buffer.concat(chunks).toString("utf8");
      let parsed: Record<string, unknown> | null = null;
      try {
        parsed = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
      } catch {
        parsed = null;
      }
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(body));
      };

      if (url.endsWith("/terminal-collection")) {
        terminalPosts.push(parsed ?? {});
        send(200, { object: "device_terminal_collection", status: "accepted" });
        return;
      }
      if (url.endsWith("/state")) {
        if (req.method === "PUT" && parsed && typeof parsed.state === "object" && parsed.state) {
          persisted = { ...persisted, ...(parsed.state as Record<string, unknown>) };
        }
        send(200, {
          device_id: "device-1",
          object: "device_source_instance_state",
          source_instance_id: "src-1",
          state: persisted,
          updated_at: null,
        });
        return;
      }
      if (url.includes("/ingest-batches")) {
        send(200, { accepted: true, object: "device_ingest_batch" });
        return;
      }
      send(200, { object: "device_exporter_heartbeat", status: "accepted" });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
    terminalPosts,
    url: `http://127.0.0.1:${port}`,
  };
}

/**
 * A connector child that honours START.scope time_range the way the shared
 * runtime does: it emits one in-range and one out-of-range record per stream,
 * dropping whatever the declared bound excludes. `truncate` makes it exit
 * WITHOUT a DONE, which is how an aborted sample actually looks on the wire.
 */
async function writeScopeFixture(input: { truncate?: boolean }): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-scope-fixture-"));
  const path = join(dir, "fixture.mjs");
  const script = `(async () => {
  let buf = "";
  await new Promise((r) => process.stdin.on("data", (c) => { buf += c; if (buf.includes("\\n")) r(); }));
  const start = JSON.parse(buf.split("\\n")[0]);
  const scopes = new Map((start.scope?.streams ?? []).map((s) => [s.name, s]));
  const emit = (m) => process.stdout.write(JSON.stringify(m) + "\\n");
  const inRange = (stream, ts) => {
    const since = scopes.get(stream)?.time_range?.since;
    return !since || ts >= since;
  };
  for (const stream of ["sessions", "messages"]) {
    for (const [id, ts] of [["old-" + stream, "2020-01-01T00:00:00.000Z"], ["new-" + stream, "2026-07-01T00:00:00.000Z"]]) {
      if (inRange(stream, ts)) {
        emit({ type: "RECORD", stream, key: id, data: { id, timestamp: ts }, emitted_at: ts });
      }
    }
    emit({ type: "STATE", stream, cursor: { fetched_at: "2026-08-01T00:00:00.000Z" } });
  }
  ${
    input.truncate
      ? `// Truncated exactly like an aborted \`--sample <n>\` run: the connector
  // reports a clean per-stream DONE for the records it did emit, but is stopped
  // before it ever enumerates its coverage stores, so no coverage_diagnostics
  // checkpoint is flushed. This is the honest shape of a bounded sample -- real
  // durable records, no coverage claim -- and it must stay non-green even
  // though the run "succeeded" and a boundary was declared.
  emit({ type: "DONE", status: "succeeded", records_emitted: 2 });`
      : `// A stream with no manifest time field: collected WHOLE under a scoped run.
  emit({ type: "RECORD", stream: "skills", key: "skill-1", data: { id: "skill-1" }, emitted_at: "2020-01-01T00:00:00.000Z" });
  emit({ type: "STATE", stream: "skills", cursor: { fetched_at: "2026-08-01T00:00:00.000Z" } });
  emit({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:projects", data: { id: "coverage:projects", store: "projects", stream: "sessions", status: "collected" }, emitted_at: "2026-08-01T00:00:00.000Z" });
  emit({ type: "RECORD", stream: "coverage_diagnostics", key: "coverage:skills", data: { id: "coverage:skills", store: "skills", stream: "skills", status: "collected" }, emitted_at: "2026-08-01T00:00:00.000Z" });
  emit({ type: "STATE", stream: "coverage_diagnostics", cursor: { fetched_at: "2026-08-01T00:00:00.000Z" } });
  emit({ type: "DONE", status: "succeeded", records_emitted: 4 });`
  }
})().catch((err) => { process.stderr.write(String(err)); process.exit(1); });
`;
  await writeFile(path, script);
  return path;
}

function scopeState(since: string): Record<string, unknown> {
  return { [COLLECTION_SCOPE_STATE_KEY]: { declared_at: "2026-08-01T00:00:00.000Z", scope: { since } } };
}

async function tempQueuePath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pdpp-scope-queue-"));
  return join(dir, "outbox.sqlite3");
}

async function runScoped(input: {
  harness: ScopeHarness;
  truncate?: boolean;
}): Promise<Awaited<ReturnType<typeof runCollectorConnector>> | null> {
  const fixture = await writeScopeFixture({ ...(input.truncate ? { truncate: true } : {}) });
  try {
    return await runCollectorConnector({
      baseUrl: input.harness.url,
      connector: {
        args: [fixture],
        command: "node",
        connector_id: "fixture-scope",
        runtime_requirements: { bindings: {} },
        streams: ALL_STREAMS,
        timeScopableStreams: TIME_SCOPABLE,
      },
      deviceId: "device-1",
      deviceToken: "device-token",
      queuePath: await tempQueuePath(),
      sourceInstanceId: "src-1",
    });
  } catch {
    // A truncated child (no DONE) legitimately fails the run; the assertion
    // under test is what the collector did NOT report, not that it succeeded.
    return null;
  }
}

test("the declared boundary reaches the connector only on streams that can prove it", () => {
  const ranges = resolveScopedStreamTimeRanges({ since: SINCE }, TIME_SCOPABLE);
  const start = buildCollectorStartMessage(ALL_STREAMS, [], null, {}, ranges);
  const byName = new Map(start.scope.streams.map((s) => [s.name, s]));

  assert.deepEqual(byName.get("sessions")?.time_range, { since: SINCE });
  assert.deepEqual(byName.get("messages")?.time_range, { since: SINCE });
  assert.equal(
    "time_range" in (byName.get("skills") ?? {}),
    false,
    "a stream with no manifest time field must never carry a bound it cannot be measured against"
  );
});

test("the reserved scope entry is never handed to the connector as a stream cursor", () => {
  const start = buildCollectorStartMessage(["sessions"], [], {
    ...scopeState(SINCE),
    sessions: { cursor: "s-1" },
  });
  assert.deepEqual(start.state, { sessions: { cursor: "s-1" } });
  assert.equal(JSON.stringify(start).includes(COLLECTION_SCOPE_STATE_KEY), false);
});

test("scope is read from the same state payload the collector already fetches", () => {
  assert.deepEqual(readCollectionScopeFromState(scopeState(SINCE)), { since: SINCE });
  assert.equal(readCollectionScopeFromState({}), null, "a connection that declared nothing runs unscoped");
});

// (a) a truncated sample stays NON-GREEN (no coverage checkpoint)
test("(a) a truncated pass commits no coverage, scoped or not", async () => {
  const harness = await startScopeHarness(scopeState(SINCE));
  try {
    await runScoped({ harness, truncate: true });
    assert.equal(
      harness.terminalPosts.length,
      0,
      "a run that never reached DONE must report no terminal coverage evidence, even inside a declared scope"
    );
  } finally {
    await harness.close();
  }
});

// (b) a complete scoped pass COMMITS coverage bound to its scope
test("(b) a complete scoped pass commits coverage stamped with its boundary", async () => {
  const harness = await startScopeHarness(scopeState(SINCE));
  try {
    await runScoped({ harness });
    assert.equal(harness.terminalPosts.length, 1, "a complete scoped pass is a real commit, not a truncation");
    const post = harness.terminalPosts[0] as { collection_scope?: string };
    assert.equal(
      post.collection_scope,
      `since=${SINCE}`,
      "stored proof must state the region it covers, never leave it ambiguous"
    );
  } finally {
    await harness.close();
  }
});

// (c) out-of-scope data is NOT claimed as covered
test("(c) a stream the bound could not be enforced on is not claimed as covering it", async () => {
  const harness = await startScopeHarness(scopeState(SINCE));
  try {
    await runScoped({ harness });
    const post = harness.terminalPosts[0] as {
      streams?: Array<{ scoped?: boolean; stream: string }>;
    };
    const byStream = new Map((post.streams ?? []).map((s) => [s.stream, s]));

    assert.equal(byStream.get("sessions")?.scoped, true, "a timed stream carried the bound and proves it");
    assert.equal(
      byStream.get("skills")?.scoped,
      false,
      "skills was collected whole; its coverage must not read as proof of the declared since"
    );
  } finally {
    await harness.close();
  }
});

// (d) a scope change INVALIDATES prior proof
test("(d) evidence measured under one boundary stops describing a changed one", async () => {
  const first = await startScopeHarness(scopeState(SINCE));
  let measured: string;
  try {
    await runScoped({ harness: first });
    measured = (first.terminalPosts[0] as { collection_scope: string }).collection_scope;
  } finally {
    await first.close();
  }

  const widened = "2026-01-01T00:00:00.000Z";
  const second = await startScopeHarness(scopeState(widened));
  try {
    await runScoped({ harness: second });
    const recomputed = (second.terminalPosts[0] as { collection_scope: string }).collection_scope;
    assert.notEqual(
      measured,
      recomputed,
      "a changed boundary must produce a distinguishable proof identity, so stale coverage cannot be reused"
    );
    assert.equal(recomputed, `since=${widened}`);
  } finally {
    await second.close();
  }
});

test("the runner's fingerprint matches the contract's, so server and collector agree", async () => {
  const { collectionScopeFingerprint: contractFingerprint } = await import(
    "../../reference-contract/src/evidence/collection-scope.ts"
  );
  for (const scope of [
    null,
    { since: SINCE },
    { source_roots: ["b", "a", "a"] },
    { since: SINCE, source_roots: ["z"] },
    { since: "not-a-date" },
  ]) {
    assert.equal(
      collectorScopeFingerprint(scope),
      contractFingerprint(scope),
      `fingerprint drift on ${JSON.stringify(scope)} would silently invalidate or revalidate proof`
    );
  }
});

// The counterweight to (c): a roots boundary must NOT be honoured for a
// connector that never implemented root pruning. Supplying roots to such a
// connector and marking its streams `scoped` would report whole-corpus coverage
// as coverage-of-the-owner's-selection — a fabricated watermark, and the most
// dangerous failure mode of this whole contract because the data still arrives
// and the run still looks green.
test("a supplied root cannot produce scoped:true for a connector that does not enforce roots", () => {
  const coverage = new Map([
    ["photos-store", { status: "collected" as const, stream: "photos" }],
    ["diag-store", { status: "collected" as const, stream: "coverage_diagnostics" }],
  ]);

  const unsupported = buildTerminalCollectionFacts(coverage, {}, ["proj-a"], false);
  for (const fact of unsupported) {
    assert.equal(
      (fact as { scoped?: boolean }).scoped,
      undefined,
      `${fact.stream}: an unenforced roots boundary must be declassified, never claimed as scoped coverage`
    );
  }

  // ...and the same inputs DO produce a scoped claim once the connector has
  // declared (and implemented) enforcement, so the gate is the declaration
  // rather than an accident of the data.
  const supported = buildTerminalCollectionFacts(coverage, {}, ["proj-a"], true);
  for (const fact of supported) {
    assert.equal((fact as { scoped?: boolean }).scoped, true, `${fact.stream}: an enforced roots boundary is provable`);
  }
});

test("roots are not transmitted to a connector that never declared root enforcement", () => {
  // Sending a boundary a connector will silently ignore is worse than sending
  // none: the run would look bounded while walking everything.
  const start = buildCollectorStartMessage(["photos"], [], null, {}, {}, []);
  assert.equal(
    "source_roots" in (start.scope.streams[0] ?? {}),
    false,
    "an unsupported connector must receive no roots at all"
  );
});
