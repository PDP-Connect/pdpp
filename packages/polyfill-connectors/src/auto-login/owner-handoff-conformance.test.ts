// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * The gate that keeps the owner-handoff paved road paved.
 *
 * ## What this exists to prevent
 *
 * Venmo shipped on the blocking Continue path while ChatGPT's detect-and-resume
 * already existed. That was not carelessness — it was structural. There was no
 * shared handoff layer: `requestManualLoginForChallenge` was defined TWICE,
 * PRIVATELY (venmo.ts and amazon.ts), each connector rolled its own, and the
 * underlying `manualAction` / `manualBrowserLogin` helpers offered the blocking
 * shape with no default and no enforcement. A new connector picked the footgun
 * by writing the obvious thing, and an owner ended up clicking Continue on a
 * sign-in that had already succeeded.
 *
 * Making detect-and-resume the DEFAULT (see `observed-login.ts`) fixes today's
 * connectors. This gate is what stops tomorrow's from regressing: a file that
 * calls the raw blocking helpers must either route through the paved road or
 * carry an explicit, declared justification. Silence fails.
 *
 * ## Why a source scan rather than a runtime assertion
 *
 * The failure mode is a connector that never runs in CI with a real challenge
 * page. A behavioral test cannot reach a branch that only fires behind a live
 * CAPTCHA; a static scan reaches every branch by construction, including ones
 * no fixture exercises. That is the same reason the repo already gates
 * credential-env reads statically (`check-no-direct-credential-env.ts`).
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const AUTO_LOGIN_DIR = HERE;
const PACKAGE_ROOT = join(HERE, "..", "..");
const CONNECTORS_DIR = join(PACKAGE_ROOT, "connectors");

/** The raw blocking helpers. Calling one is what puts a file under this gate. */
const BLOCKING_HELPER_CALL = /\b(?:manualAction|manualBrowserLogin)\s*\(/;

/**
 * Evidence a file is on the paved road. Tolerates an explicit type argument
 * (`requestOwnerBrowserAction<boolean>({...})`), which both migrated connectors
 * use — a marker that missed it would report a compliant file as a violation.
 */
const PAVED_ROAD_MARKER = /\brequestOwnerBrowserAction\s*(?:<[^>]*>\s*)?\(/;

/**
 * Evidence a file declared why it cannot use the paved road, in the typed form
 * `observed-login.ts` requires. The `reason` field must name a member of the
 * closed `UnobservableReason` union — a free-text excuse cannot satisfy this.
 */
const DECLARED_JUSTIFICATION =
  /reason:\s*"(?:no_success_marker_exists|owner_supplies_a_secret|success_is_not_session_liveness)"/;

/**
 * Files that pre-date the paved road and are explicitly, temporarily exempt.
 *
 * This list may only SHRINK. It is not a place to add a new connector — a new
 * connector has no reason to be here, and adding one is the exact regression
 * this gate exists to make visible in review. Each entry is a connector whose
 * migration is separate work, not a blessing of the blocking path.
 */
const PRE_PAVED_ROAD_EXEMPTIONS = new Set([
  "auto-login/chase.ts",
  "auto-login/chatgpt.ts",
  "auto-login/heb.ts",
  "auto-login/reddit.ts",
  "auto-login/usaa.ts",
  "connectors/heb/index.ts",
  "connectors/whoop/index.ts",
]);

interface SourceFile {
  readonly id: string;
  readonly text: string;
}

function collectSourceFiles(): SourceFile[] {
  const files: SourceFile[] = [];

  for (const entry of readdirSync(AUTO_LOGIN_DIR)) {
    if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
      files.push({
        id: `auto-login/${entry}`,
        text: readFileSync(join(AUTO_LOGIN_DIR, entry), "utf8"),
      });
    }
  }

  for (const connector of readdirSync(CONNECTORS_DIR, { withFileTypes: true })) {
    if (!connector.isDirectory()) {
      continue;
    }
    const indexPath = join(CONNECTORS_DIR, connector.name, "index.ts");
    try {
      files.push({
        id: `connectors/${connector.name}/index.ts`,
        text: readFileSync(indexPath, "utf8"),
      });
    } catch {
      // Not every connector has an index.ts; nothing to gate.
    }
  }

  return files;
}

/**
 * Classify one file against the gate. Exported so the negative-control test can
 * run a synthetic non-compliant connector through the SAME logic the real scan
 * uses — a control that re-implemented the rule would only prove the mirror.
 */
export function violatesOwnerHandoffGate(file: SourceFile): boolean {
  if (!BLOCKING_HELPER_CALL.test(file.text)) {
    return false;
  }
  if (PRE_PAVED_ROAD_EXEMPTIONS.has(file.id)) {
    return false;
  }
  return !(PAVED_ROAD_MARKER.test(file.text) || DECLARED_JUSTIFICATION.test(file.text));
}

test("every connector using the blocking owner handoff is on the paved road or declares why it cannot", () => {
  const violations = collectSourceFiles()
    .filter((file) => violatesOwnerHandoffGate(file))
    .map((file) => file.id);

  assert.deepEqual(
    violations,
    [],
    "These files call manualAction/manualBrowserLogin without routing through " +
      "requestOwnerBrowserAction and without a declared UnobservableJustification. " +
      "Detect-and-resume is the default: emit non-blocking assistance and poll your " +
      "success marker (see src/auto-login/observed-login.ts). If success genuinely " +
      "cannot be observed, declare it — an owner must never click Continue for a " +
      `sign-in the system could have seen succeed. Offending files: ${violations.join(", ")}`
  );
});

test("NEGATIVE CONTROL: a new connector taking the blocking path silently FAILS the gate", () => {
  // The gate is only worth having if it actually catches the regression. This
  // is the exact file a new connector author would write today: reaches for the
  // blocking helper, no paved road, no justification.
  const silentFootgun: SourceFile = {
    id: "connectors/newthing/index.ts",
    text: [
      'import { manualAction } from "../../src/browser-handoff.ts";',
      "async function ensureSession({ page, sendInteraction }) {",
      '  await manualAction({ page, message: "Sign in, then press Continue." }, sendInteraction);',
      "}",
    ].join("\n"),
  };

  assert.equal(
    violatesOwnerHandoffGate(silentFootgun),
    true,
    "a new connector must NOT be able to adopt the blocking Continue path silently"
  );
});

test("NEGATIVE CONTROL: the same connector PASSES once it declares a justification", () => {
  const declared: SourceFile = {
    id: "connectors/newthing/index.ts",
    text: [
      'import { manualAction } from "../../src/browser-handoff.ts";',
      "const justification = {",
      '  evidence: "The owner types a code that exists only on their phone; no page state can reveal it.",',
      '  reason: "owner_supplies_a_secret",',
      '  site: "newthing:otp",',
      "};",
      "async function ensureSession({ page, sendInteraction }) {",
      '  await manualAction({ page, message: "Enter the code." }, sendInteraction);',
      "}",
    ].join("\n"),
  };

  assert.equal(violatesOwnerHandoffGate(declared), false, "a declared, typed justification satisfies the gate");
});

test("NEGATIVE CONTROL: an invented reason does not satisfy the gate", () => {
  // The reason must name a member of the closed `UnobservableReason` union.
  // A connector cannot talk its way past the gate with free text.
  const inventedExcuse: SourceFile = {
    id: "connectors/newthing/index.ts",
    text: [
      'import { manualAction } from "../../src/browser-handoff.ts";',
      'const justification = { reason: "it_is_tricky", site: "newthing:x" };',
      "async function ensureSession({ page, sendInteraction }) {",
      '  await manualAction({ page, message: "Continue." }, sendInteraction);',
      "}",
    ].join("\n"),
  };

  assert.equal(violatesOwnerHandoffGate(inventedExcuse), true, "only the closed reason union counts as a declaration");
});

test("a connector that never blocks is not subject to the gate at all", () => {
  const noHandoff: SourceFile = {
    id: "connectors/newthing/index.ts",
    text: "export async function collect() { /* API-only connector */ }",
  };

  assert.equal(violatesOwnerHandoffGate(noHandoff), false);
});

test("the exemption list only covers files that pre-date the paved road", () => {
  // Venmo and Amazon are the migrated consumers. If either reappears here, the
  // migration has been reverted and the gate must say so.
  assert.equal(PRE_PAVED_ROAD_EXEMPTIONS.has("auto-login/venmo.ts"), false, "venmo is migrated, not exempt");
  assert.equal(PRE_PAVED_ROAD_EXEMPTIONS.has("auto-login/amazon.ts"), false, "amazon is migrated, not exempt");
});
