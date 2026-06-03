import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildHpiQueryArgs, queryHpiStream, windowFromScope } from "./hpi-adapter.ts";

test("buildHpiQueryArgs: minimal mapping", () => {
  const args = buildHpiQueryArgs({ stream: "saved", hpiFunction: "my.reddit.all.saved" });
  assert.deepEqual(args, ["query", "my.reddit.all.saved", "-o", "json", "--stream"]);
});

test("buildHpiQueryArgs: order key + type", () => {
  const args = buildHpiQueryArgs({
    stream: "saved",
    hpiFunction: "my.reddit.all.saved",
    orderKey: "created",
    orderType: "datetime",
  });
  assert.deepEqual(args, [
    "query",
    "my.reddit.all.saved",
    "-o",
    "json",
    "--stream",
    "--order-key",
    "created",
    "--order-type",
    "datetime",
  ]);
});

test("buildHpiQueryArgs: time window + limit map to --after/--before/--limit", () => {
  const args = buildHpiQueryArgs(
    { stream: "saved", hpiFunction: "my.reddit.all.saved", orderKey: "created", orderType: "datetime" },
    { since: "2026-01-01T00:00:00Z", until: "2026-06-01T00:00:00Z", limit: 100 }
  );
  assert.ok(args.includes("--after"));
  assert.equal(args[args.indexOf("--after") + 1], "2026-01-01T00:00:00Z");
  assert.ok(args.includes("--before"));
  assert.equal(args[args.indexOf("--before") + 1], "2026-06-01T00:00:00Z");
  assert.ok(args.includes("--limit"));
  assert.equal(args[args.indexOf("--limit") + 1], "100");
});

test("buildHpiQueryArgs: omits limit when zero/absent", () => {
  const args = buildHpiQueryArgs({ stream: "s", hpiFunction: "my.x.y" }, { limit: 0 });
  assert.ok(!args.includes("--limit"));
});

test("windowFromScope maps PDPP scope -> HPI window", () => {
  assert.deepEqual(windowFromScope({ time_range: { since: "2026-01-01", until: "2026-02-01" }, limit: 50 }), {
    since: "2026-01-01",
    until: "2026-02-01",
    limit: 50,
  });
  assert.deepEqual(windowFromScope({}), {});
});

test("queryHpiStream: end-to-end against a fake hpi that emits JSONL", async () => {
  // A real executable stand-in for `hpi`: it echoes the args it received (so we
  // can assert the CLI contract) and emits two JSONL records like
  // `hpi query my.reddit.all.saved -o json --stream` would.
  const dir = mkdtempSync(join(tmpdir(), "fake-hpi-"));
  const fakeHpi = join(dir, "hpi");
  writeFileSync(
    fakeHpi,
    [
      "#!/usr/bin/env node",
      // Assert we were called with the expected hpi subcommand + flags.
      "const args = process.argv.slice(2);",
      'if (args[0] !== "query" || !args.includes("--stream") || !args.includes("-o")) {',
      '  process.stderr.write("unexpected args: " + JSON.stringify(args));',
      "  process.exit(2);",
      "}",
      // Emit JSONL (one object per line), as `--stream -o json` does.
      'process.stdout.write(JSON.stringify({ id: "t1_aaa", subreddit: "rust", created: "2026-05-01T00:00:00Z" }) + "\\n");',
      'process.stdout.write(JSON.stringify({ id: "t1_bbb", subreddit: "golang", created: "2026-05-02T00:00:00Z" }) + "\\n");',
    ].join("\n"),
    "utf8"
  );
  chmodSync(fakeHpi, 0o755);

  const prevBin = process.env.HPI_BIN;
  const prevTimeout = process.env.HPI_TIMEOUT_MS;
  process.env.HPI_BIN = fakeHpi;
  process.env.HPI_TIMEOUT_MS = "5000";
  try {
    const records = await queryHpiStream(
      { stream: "saved", hpiFunction: "my.reddit.all.saved", orderKey: "created", orderType: "datetime" },
      { since: "2026-01-01T00:00:00Z", limit: 100 }
    );
    assert.equal(records.length, 2);
    assert.deepEqual(
      records.map((r) => r.id),
      ["t1_aaa", "t1_bbb"]
    );
    assert.equal(records[0]?.subreddit, "rust");
  } finally {
    if (prevBin === undefined) {
      delete process.env.HPI_BIN;
    } else {
      process.env.HPI_BIN = prevBin;
    }
    if (prevTimeout === undefined) {
      delete process.env.HPI_TIMEOUT_MS;
    } else {
      process.env.HPI_TIMEOUT_MS = prevTimeout;
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
