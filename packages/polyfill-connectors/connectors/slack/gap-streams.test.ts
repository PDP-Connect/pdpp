// Direct-call tests for the four gap streams (stars/user_groups/reminders/
// dm_read_states) that collect via slack-api.ts rather than the slackdump
// archive. Calls the exported stream runners in-process (not via the
// subprocess harness) so `globalThis.fetch` mocking works, mirroring
// connectors/github/index.test.ts's pattern for the same reason.
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { afterEach, before, test } from "node:test";
import {
  runDmReadStatesStream,
  runRemindersStream,
  runStarsStream,
  runUserGroupsStream,
  type StreamDeps,
} from "./index.ts";
import { resetSlackApiGovernor } from "./slack-api.ts";

const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_SET_TIMEOUT = globalThis.setTimeout;

before(() => {
  globalThis.setTimeout = new Proxy(ORIGINAL_SET_TIMEOUT, {
    apply: (_target, _thisArg, callArgs: unknown[]) => {
      const [handler, , ...args] = callArgs as [TimerHandler, number?, ...unknown[]];
      if (typeof handler === "function") {
        queueMicrotask(() => (handler as (...a: unknown[]) => void)(...args));
      }
      const handle = ORIGINAL_SET_TIMEOUT(() => undefined, 0);
      clearTimeout(handle);
      return handle;
    },
  });
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  resetSlackApiGovernor();
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

interface Captured {
  considered: Array<{ considered: number; stream: string }>;
  records: Array<{ data: unknown; stream: string }>;
}

function fakeDeps(db: DatabaseSync, captured: Captured, requested: readonly string[]): StreamDeps {
  return {
    db,
    emit: (msg) => {
      if (msg.type === "DETAIL_COVERAGE") {
        captured.considered.push({ stream: msg.stream, considered: msg.considered ?? 0 });
      }
      return Promise.resolve();
    },
    emitRecord: (stream, data) => {
      captured.records.push({ stream, data });
      return Promise.resolve();
    },
    emittedAt: "2026-07-10T00:00:00.000Z",
    fingerprintCursors: new Map(),
    progress: () => Promise.resolve(),
    requested: new Map(requested.map((name) => [name, { name }])),
  };
}

test("runStarsStream: emits one RECORD per starred item and declares considered", async () => {
  globalThis.fetch = () =>
    Promise.resolve(
      jsonResponse({
        ok: true,
        items: [{ type: "message", channel: "C01", message: { ts: "1.1", user: "U01" } }],
      })
    );
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runStarsStream(fakeDeps(db, captured, ["stars"]), "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "stars");
  assert.equal(captured.considered[0]?.considered, 1);
});

test("runStarsStream: zero stars still completes and declares considered=0", async () => {
  globalThis.fetch = () => Promise.resolve(jsonResponse({ ok: true, items: [] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runStarsStream(fakeDeps(db, captured, ["stars"]), "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 0);
  assert.equal(captured.considered[0]?.considered, 0);
});

test("runUserGroupsStream: emits one RECORD per user group", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({ ok: true, usergroups: [{ id: "S01", handle: "eng", users: ["U01"] }] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runUserGroupsStream(fakeDeps(db, captured, ["user_groups"]), "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "user_groups");
});

test("runRemindersStream: emits one RECORD per reminder", async () => {
  globalThis.fetch = () =>
    Promise.resolve(jsonResponse({ ok: true, reminders: [{ id: "Rm01", text: "ping bob", time: 1_714_032_900 }] }));
  const db = new DatabaseSync(":memory:");
  const captured: Captured = { considered: [], records: [] };
  await runRemindersStream(fakeDeps(db, captured, ["reminders"]), "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 1);
  assert.equal(captured.records[0]?.stream, "reminders");
});

function seedChannel(db: DatabaseSync, id: string, data: Record<string, unknown>): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS CHANNEL (
      ID TEXT NOT NULL,
      NAME TEXT,
      DATA TEXT,
      CHUNK_ID INTEGER NOT NULL
    );
  `);
  db.prepare("INSERT INTO CHANNEL (ID, NAME, DATA, CHUNK_ID) VALUES (?, ?, ?, ?)").run(
    id,
    null,
    JSON.stringify(data),
    1
  );
}

test("runDmReadStatesStream: only calls conversations.info for is_im/is_mpim channels", async () => {
  const db = new DatabaseSync(":memory:");
  seedChannel(db, "D01", { is_im: true });
  seedChannel(db, "G01", { is_mpim: true });
  seedChannel(db, "C01", { is_channel: true });

  const seenChannels: string[] = [];
  globalThis.fetch = (url) => {
    const parsed = new URL(String(url));
    const channel = parsed.searchParams.get("channel") ?? "";
    seenChannels.push(channel);
    return Promise.resolve(
      jsonResponse({ ok: true, channel: { id: channel, last_read: "1.1", unread_count: 0, unread_count_display: 0 } })
    );
  };
  const captured: Captured = { considered: [], records: [] };
  await runDmReadStatesStream(fakeDeps(db, captured, ["dm_read_states"]), "xoxc-fake", "d-fake");

  assert.deepEqual([...seenChannels].sort(), ["D01", "G01"]);
  assert.equal(captured.records.length, 2);
  assert.ok(captured.records.every((r) => r.stream === "dm_read_states"));
});

test("runDmReadStatesStream: zero DM/MPIM channels makes zero API calls and completes cleanly", async () => {
  const db = new DatabaseSync(":memory:");
  seedChannel(db, "C01", { is_channel: true });
  globalThis.fetch = () => Promise.reject(new Error("should not be called"));
  const captured: Captured = { considered: [], records: [] };
  await runDmReadStatesStream(fakeDeps(db, captured, ["dm_read_states"]), "xoxc-fake", "d-fake");
  assert.equal(captured.records.length, 0);
  assert.equal(captured.considered[0]?.considered, 0);
});
