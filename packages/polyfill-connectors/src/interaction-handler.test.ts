import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, test } from "node:test";
import { __testing } from "./interaction-handler.ts";

const { buildClickUrl } = __testing;

const ENV_KEYS = ["PDPP_WEB_BASE_URL", "PDPP_REFERENCE_ORIGIN"] as const;

function clearWebBaseEnv(): Record<(typeof ENV_KEYS)[number], string | undefined> {
  const saved = {} as Record<(typeof ENV_KEYS)[number], string | undefined>;
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  return saved;
}

function restoreWebBaseEnv(saved: Record<(typeof ENV_KEYS)[number], string | undefined>): void {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = saved[key];
    }
  }
}

describe("buildClickUrl", () => {
  let saved: Record<(typeof ENV_KEYS)[number], string | undefined>;

  beforeEach(() => {
    saved = clearWebBaseEnv();
  });

  afterEach(() => {
    restoreWebBaseEnv(saved);
  });

  test("returns undefined when runId is not provided", () => {
    assert.equal(buildClickUrl(undefined, "manual_action", "i-1"), undefined);
  });

  test("manual_action produces stream viewer URL with interaction_id", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-42");
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1/stream?interaction_id=i-42");
  });

  test("non-manual_action kinds produce the run page URL", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "credentials", "i-42");
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1");
  });

  test("PDPP_WEB_BASE_URL takes priority over PDPP_REFERENCE_ORIGIN", () => {
    process.env.PDPP_WEB_BASE_URL = "https://web.example.com";
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://web.example.com/"));
  });

  test("falls back to PDPP_REFERENCE_ORIGIN when web URL is unset", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("falls back to localhost when neither env var is set", () => {
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("http://localhost:3000/"));
  });

  test("trims whitespace in env values", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "  https://reference.example.com  ";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("treats empty string as unset and falls through to next source", () => {
    process.env.PDPP_WEB_BASE_URL = "";
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", "i-1");
    assert.ok(url?.startsWith("https://reference.example.com/"));
  });

  test("missing interactionId still produces a URL with empty query value", () => {
    process.env.PDPP_REFERENCE_ORIGIN = "https://reference.example.com";
    const url = buildClickUrl("run-1", "manual_action", undefined);
    assert.equal(url, "https://reference.example.com/dashboard/runs/run-1/stream?interaction_id=");
  });
});
