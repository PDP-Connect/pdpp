#!/usr/bin/env node
// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * `conformance <connector>` — the one command a connector author runs to
 * find out whether their connector is done.
 *
 * Before this existed the answer was "read the roster comments in
 * connector-conformance-roster.ts and hope". The individual checks all
 * existed; nothing composed them, so nobody ran them together and the
 * result was 8 of 42 connectors at evidence level `proven`.
 *
 * This composes what is already here. It adds no new assertions of its own —
 * every verdict below comes from a check that already shipped:
 *
 *   1. manifest present + parseable, declares its own streams
 *   2. a test file exists, and its own suite passes
 *   3. pilot-real-shape fixture present (locks emitted-record shape
 *      against schema drift — src/pilot-fixture-test-helper.ts)
 *   4. mock-mutation verdict (scripts/mock-mutation-check.ts) — ADVISORY
 *   5. reachability coverage (scripts/connector-reachability.mjs) — ADVISORY
 *
 * HONESTY CONTRACT, inherited from the checks it wraps:
 *   - A check that cannot run reports UNKNOWN. It never becomes a PASS.
 *   - Steps 4 and 5 are ADVISORY: most connectors have no path-matching mock
 *     and no fixed public API base, and neither absence is actionable in a
 *     single PR. They print, they do not fail.
 *   - Passing every step means "nothing mechanical is wrong". It does NOT
 *     mean the connector works against a real account — only a real run
 *     against a real account shows that, which is the whole argument of
 *     docs/inbox/design-note-connector-conformance.md.
 *
 * Usage:
 *   node --import tsx scripts/conformance.ts <connector>
 *   node --import tsx scripts/conformance.ts <connector> --json
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isMainModule } from "../src/is-main-module.ts";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");
const MANIFESTS_DIR = join(PACKAGE_ROOT, "manifests");
const FIXTURES_DIR = join(PACKAGE_ROOT, "fixtures");

type Verdict = "PASS" | "FAIL" | "UNKNOWN" | "ADVISORY" | "WEAK";

interface Step {
  readonly advisory?: boolean;
  readonly detail: string;
  readonly name: string;
  /** The specific command or edit that moves this step off its current verdict. Absent only for PASS. */
  readonly nextAction?: string;
  readonly verdict: Verdict;
}

function manifestPath(connector: string): string {
  return join(MANIFESTS_DIR, `${connector}.json`);
}

function checkManifest(connector: string): Step {
  const file = manifestPath(connector);
  if (!existsSync(file)) {
    return {
      detail: `no manifest at manifests/${connector}.json`,
      name: "manifest",
      nextAction: `create manifests/${connector}.json — copy the shape of an existing manifest (e.g. manifests/ynab.json) and declare this connector's streams`,
      verdict: "FAIL",
    };
  }
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8")) as {
      streams?: unknown;
      public_listing?: { status?: string };
    };
    const streams = Array.isArray(manifest.streams) ? manifest.streams.length : 0;
    if (streams === 0) {
      return {
        detail: "manifest declares no streams",
        name: "manifest",
        nextAction: `add at least one entry to the "streams" array in manifests/${connector}.json`,
        verdict: "FAIL",
      };
    }
    const status = manifest.public_listing?.status ?? "unset";
    return { detail: `${streams} stream(s), evidence level "${status}"`, name: "manifest", verdict: "PASS" };
  } catch (err) {
    return {
      detail: `manifest is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      name: "manifest",
      nextAction: `fix the JSON syntax error in manifests/${connector}.json`,
      verdict: "FAIL",
    };
  }
}

function checkTests(connector: string): Step {
  const dir = join(CONNECTORS_DIR, connector);
  if (!existsSync(dir)) {
    return {
      detail: `no connector directory at connectors/${connector}`,
      name: "tests",
      nextAction: `create connectors/${connector}/ — copy the layout of an existing connector (index.ts, schemas.ts, *.test.ts)`,
      verdict: "FAIL",
    };
  }
  const testFiles = readdirSync(dir).filter((f) => f.endsWith(".test.ts") && !f.startsWith("__mutation_scratch_"));
  if (testFiles.length === 0) {
    return {
      detail: "no test file — cannot be checked, which is not the same as passing",
      name: "tests",
      nextAction: `add a connectors/${connector}/integration.test.ts that exercises real collection logic — see docs/reference/connector-authoring-guide.md`,
      verdict: "UNKNOWN",
    };
  }
  try {
    execFileSync(process.execPath, ["--test", "--import", "tsx", ...testFiles.map((f) => join(dir, f))], {
      cwd: PACKAGE_ROOT,
      encoding: "utf8",
      stdio: "pipe",
      timeout: 300_000,
    });
    return { detail: `${testFiles.length} test file(s) pass`, name: "tests", verdict: "PASS" };
  } catch {
    return {
      detail: `suite FAILS — run: npx tsx --test connectors/${connector}/*.test.ts`,
      name: "tests",
      nextAction: `run \`npx tsx --test connectors/${connector}/*.test.ts\` locally and fix the failing assertion(s) before anything else here matters`,
      verdict: "FAIL",
    };
  }
}

function checkPilotFixture(connector: string): Step {
  const dir = join(FIXTURES_DIR, connector, "scrubbed", "pilot-real-shape");
  if (!existsSync(dir)) {
    return {
      detail: "no pilot-real-shape fixture — emitted-record shape is not locked against schema drift",
      name: "pilot fixture",
      nextAction: `capture one: run this connector with PDPP_CAPTURE_FIXTURES=1 against a real account, then run the scrub-connector-fixtures pipeline to produce fixtures/${connector}/scrubbed/pilot-real-shape/`,
      verdict: "UNKNOWN",
    };
  }
  const records = join(dir, "records");
  const streams = existsSync(records) ? readdirSync(records).filter((f) => f.endsWith(".jsonl")).length : 0;
  return {
    detail: `${streams} stream fixture(s) present`,
    name: "pilot fixture",
    nextAction:
      streams > 0
        ? undefined
        : `fixtures/${connector}/scrubbed/pilot-real-shape/records/ exists but has no .jsonl files — re-run the fixture capture, the directory was created without records`,
    verdict: streams > 0 ? "PASS" : "UNKNOWN",
  };
}

function checkMockMutation(connector: string): Step {
  try {
    const out = execFileSync(
      process.execPath,
      ["--import", "tsx", join(PACKAGE_ROOT, "scripts", "mock-mutation-check.ts"), `--connector=${connector}`, "--json"],
      { cwd: PACKAGE_ROOT, encoding: "utf8", stdio: "pipe", timeout: 600_000 }
    );
    const parsed = JSON.parse(out) as Array<{ detail: string; verdict: string }>;
    const first = parsed[0];
    if (!first) {
      return { advisory: true, detail: "no result", name: "mock mutation", verdict: "UNKNOWN" };
    }
    const verdict = first.verdict as Verdict;
    const nextAction =
      verdict === "UNKNOWN"
        ? `this connector's test(s) have no request-path-matching literal (identifier === "/foo", .startsWith("/foo"), .includes("/foo")) — if it makes real HTTP requests, add a fake-server/route assertion that checks the actual path, not just query params or headers`
        : verdict === "WEAK"
          ? "one or more path literals are decorative (the suite still passes when corrupted) — see the literal(s) named in the detail above and add an assertion that fails when that exact path is wrong"
          : undefined;
    return { advisory: true, detail: first.detail, name: "mock mutation", nextAction, verdict };
  } catch (err) {
    return {
      advisory: true,
      detail: `could not run: ${err instanceof Error ? err.message.slice(0, 120) : String(err)}`,
      name: "mock mutation",
      nextAction: `run \`node --import tsx scripts/mock-mutation-check.ts --connector=${connector}\` directly to see the underlying error`,
      verdict: "UNKNOWN",
    };
  }
}

function checkReachability(connector: string): Step {
  const script = join(PACKAGE_ROOT, "..", "..", "scripts", "connector-reachability.mjs");
  if (!existsSync(script)) {
    return {
      advisory: true,
      detail: "probe script not found",
      name: "reachability",
      nextAction: "scripts/connector-reachability.mjs is missing from the repo root — this is a repo-wide problem, not specific to this connector",
      verdict: "UNKNOWN",
    };
  }
  const source = readFileSync(script, "utf8");
  if (!source.includes(`connector: "${connector}"`)) {
    return {
      advisory: true,
      detail: "no probe target defined — add one to scripts/connector-reachability.mjs to cover this connector",
      name: "reachability",
      nextAction: `if this connector calls a fixed public API base directly (not browser-automation, not local-file-only), add a TARGETS entry to scripts/connector-reachability.mjs using the exact path from this connector's own source — see the file's header comment for the shape. If it's browser-automation-only or file-import-only, this stays UNKNOWN permanently and that's correct.`,
      verdict: "UNKNOWN",
    };
  }
  return {
    advisory: true,
    detail: "probe target defined; run `node scripts/connector-reachability.mjs` (needs network)",
    name: "reachability",
    verdict: "ADVISORY",
  };
}

export function runConformance(connector: string): Step[] {
  const manifest = checkManifest(connector);
  if (manifest.verdict === "FAIL") {
    return [manifest];
  }
  return [manifest, checkTests(connector), checkPilotFixture(connector), checkMockMutation(connector), checkReachability(connector)];
}

const GLYPH: Record<Verdict, string> = { ADVISORY: "·", FAIL: "✖", PASS: "✔", UNKNOWN: "?", WEAK: "⚠" };

function main(): void {
  const args = process.argv.slice(2);
  const jsonOut = args.includes("--json");
  const connector = args.find((a) => !a.startsWith("--"));
  if (!connector) {
    console.error("usage: conformance <connector> [--json]");
    process.exit(2);
  }

  const steps = runConformance(connector);

  if (jsonOut) {
    console.log(JSON.stringify({ connector, steps }, null, 2));
  } else {
    console.log(`\nconformance: ${connector}\n`);
    for (const s of steps) {
      console.log(`${GLYPH[s.verdict]} ${s.name.padEnd(16)} ${s.detail}`);
      if (s.nextAction) {
        console.log(`  → ${s.nextAction}`);
      }
    }
    const blocking = steps.filter((s) => !s.advisory && s.verdict === "FAIL");
    const unknown = steps.filter((s) => !s.advisory && s.verdict === "UNKNOWN");
    // An advisory WEAK/UNKNOWN still qualifies the all-clear: a decorative mock
    // means the suite that just passed would not have caught a wrong path, which
    // is precisely how jellyfin shipped green and broken.
    const softGaps = steps.filter((s) => s.advisory && (s.verdict === "WEAK" || s.verdict === "UNKNOWN"));
    console.log(
      blocking.length > 0
        ? `\nNOT READY — ${blocking.length} blocking failure(s).`
        : unknown.length + softGaps.length > 0
          ? `\nNo blocking failures, but ${unknown.length + softGaps.length} check(s) could not run or found soft spots. That is a gap, not a pass.`
          : softGaps.length > 0
            ? `\nNo blocking failures, but ${softGaps.length} advisory gap(s) above mean the suite has soft spots. This does NOT mean it works against a real account.`
            : `\nNothing mechanical is wrong. This does NOT mean it works against a real account — only a real run shows that.`
    );
  }

  process.exit(steps.some((s) => !s.advisory && s.verdict === "FAIL") ? 1 : 0);
}

if (isMainModule(import.meta.url)) {
  main();
}
