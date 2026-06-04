import assert from "node:assert/strict";
import test from "node:test";
import { readOptions } from "./connector-options.ts";

const SPEC = {
  envPrefix: "TESTC_",
  fields: {
    LOOKBACK_DAYS: { parse: "int" as const, default: 7 },
    SKIP_FILES: { parse: "bool" as const, default: false },
    CHANNEL_ALLOWLIST: { parse: "csv" as const, default: [] as string[] },
    REGION: { parse: "string" as const, default: "us" },
  },
};

function withEnv(env: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(env)) {
    saved[k] = process.env[k];
    if (env[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = env[k];
    }
  }
  try {
    fn();
  } finally {
    for (const k of Object.keys(env)) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
  }
}

test("readOptions: returns declared defaults when nothing provided", () => {
  withEnv(
    {
      TESTC_LOOKBACK_DAYS: undefined,
      TESTC_SKIP_FILES: undefined,
      TESTC_CHANNEL_ALLOWLIST: undefined,
      TESTC_REGION: undefined,
    },
    () => {
      const out = readOptions(null, SPEC);
      assert.deepEqual(out, { LOOKBACK_DAYS: 7, SKIP_FILES: false, CHANNEL_ALLOWLIST: [], REGION: "us" });
    }
  );
});

test("readOptions: env vars override defaults with coercion", () => {
  withEnv(
    {
      TESTC_LOOKBACK_DAYS: "30",
      TESTC_SKIP_FILES: "yes",
      TESTC_CHANNEL_ALLOWLIST: "a, b ,c",
      TESTC_REGION: "eu",
    },
    () => {
      const out = readOptions(null, SPEC);
      assert.equal(out.LOOKBACK_DAYS, 30);
      assert.equal(out.SKIP_FILES, true);
      assert.deepEqual(out.CHANNEL_ALLOWLIST, ["a", "b", "c"]);
      assert.equal(out.REGION, "eu");
    }
  );
});

test("readOptions: START.connector_options takes precedence over env", () => {
  withEnv({ TESTC_LOOKBACK_DAYS: "30", TESTC_REGION: "eu" }, () => {
    const out = readOptions({ connector_options: { LOOKBACK_DAYS: 90, REGION: "ap" } }, SPEC);
    // START wins over env
    assert.equal(out.LOOKBACK_DAYS, 90);
    assert.equal(out.REGION, "ap");
  });
});

test("readOptions: START options accept native types without string coercion", () => {
  const out = readOptions({ connector_options: { SKIP_FILES: true, CHANNEL_ALLOWLIST: ["x", "y"] } }, SPEC);
  assert.equal(out.SKIP_FILES, true);
  assert.deepEqual(out.CHANNEL_ALLOWLIST, ["x", "y"]);
});

test("readOptions: malformed int falls back to default", () => {
  const out = readOptions({ connector_options: { LOOKBACK_DAYS: "not-a-number" } }, SPEC);
  assert.equal(out.LOOKBACK_DAYS, 7);
});

test("readOptions: START present for one field, env for another, default for third", () => {
  withEnv({ TESTC_REGION: "eu", TESTC_LOOKBACK_DAYS: undefined }, () => {
    const out = readOptions({ connector_options: { SKIP_FILES: true } }, SPEC);
    assert.equal(out.SKIP_FILES, true); // from START
    assert.equal(out.REGION, "eu"); // from env
    assert.equal(out.LOOKBACK_DAYS, 7); // default
  });
});
