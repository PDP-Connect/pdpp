// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Report rendering for the friend self-host acceptance harness. Pure: given
// the release-artifact check, the journey result, and a teardown result,
// return the markdown report body. No secrets are ever included — the
// journey steps' own detail strings are asserted leak-free before reaching
// this renderer (see journey.ts's assertNoLeak).

import type { JourneyResult } from "./journey.ts";
import type { ReleaseArtifactCheckResult } from "./release-artifacts.ts";

export interface TeardownResult {
  detail: string;
  ok: boolean;
}

function stepResultCell(step: JourneyResult["steps"][number]): string {
  if (!step.ok) {
    return "FAIL";
  }
  if (step.skippedReason) {
    return `skipped (${escapeCell(step.skippedReason)})`;
  }
  return "pass";
}

function renderJourneySteps(lines: string[], journey: JourneyResult | null): void {
  lines.push("## Journey steps");
  lines.push("");
  if (!journey) {
    lines.push("Not run — release-artifact check failed closed before any live step was attempted.");
    lines.push("");
    return;
  }
  lines.push("| Step | Mode | Result | Detail |");
  lines.push("| --- | --- | --- | --- |");
  for (const step of journey.steps) {
    lines.push(`| \`${step.id}\` | ${step.mode} | ${stepResultCell(step)} | ${escapeCell(step.detail)} |`);
  }
  lines.push("");
}

export function renderReport({
  releaseArtifacts,
  journey,
  teardown,
  timestamp,
  origin,
}: {
  journey: JourneyResult | null;
  origin: string | null;
  releaseArtifacts: ReleaseArtifactCheckResult;
  teardown: TeardownResult | null;
  timestamp: string;
}): string {
  const lines: string[] = [];
  const overallOk = releaseArtifacts.ok && (journey ? journey.ok : true) && (teardown ? teardown.ok : true);

  lines.push("# Friend Self-Host Acceptance Run");
  lines.push("");
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Result: ${overallOk ? "PASS" : "FAIL"}`);
  lines.push(`Origin: ${origin ?? "(release-artifact check only; no live run attempted)"}`);
  lines.push("");
  lines.push(
    "This report is produced by `scripts/check-friend-journey-acceptance.ts`. It drives the " +
      "documented friend self-host path — clean startup, owner login, first source add, a " +
      "Gmail-style static-secret connector, the ChatGPT browser-backed connector, a second " +
      "static-secret connector, credential issue/revoke, and an MCP client connect+query — " +
      "against one running deployment, then tears it down. Every step is labeled `structural` " +
      "(proven with no real provider credentials) or `live` (requires a real browser surface; " +
      "skipped with a named reason when unavailable, never silently passed)."
  );
  lines.push("");

  lines.push("## Release artifacts");
  lines.push("");
  lines.push(
    "Fail-closed check: refuses to attempt a live run when the release artifacts " +
      "(Compose file, Dockerfile build targets) it depends on are missing."
  );
  lines.push("");
  lines.push("| Check | Result | Detail |");
  lines.push("| --- | --- | --- |");
  for (const f of releaseArtifacts.findings) {
    lines.push(`| \`${f.id}\` | ${f.ok ? "ok" : "MISSING"} | ${escapeCell(f.detail)} |`);
  }
  lines.push("");

  renderJourneySteps(lines, journey);

  if (teardown) {
    lines.push("## Teardown");
    lines.push("");
    lines.push(`Result: ${teardown.ok ? "clean" : "FAIL"}`);
    lines.push("");
    lines.push(escapeCell(teardown.detail));
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function escapeCell(text: string | null | undefined): string {
  return String(text ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
}
