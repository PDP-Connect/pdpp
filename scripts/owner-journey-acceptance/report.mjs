// Report rendering for the owner-journey acceptance harness.
//
// Pure: given the local (and optional live) results plus a timestamp, return the
// markdown report body. The CLI writes it to
// `tmp/workstreams/owner-journey-acceptance-<ts>.md`. No secrets are ever
// included — only the auth *mode* (cookie / bearer / none), never a value.

/**
 * @param {object} args
 * @param {object} args.local  result of runLocalAcceptance
 * @param {object|null} args.live result of runLiveAcceptance (or null if not run)
 * @param {object|null} [args.cleanShell] result of checkCleanShellFreshness (or null)
 * @param {string} args.timestamp ISO-8601 string (supplied by caller)
 * @returns {string} markdown
 */
export function renderReport({ local, live, cleanShell = null, timestamp }) {
  const lines = [];
  const overallOk = local.ok && (live ? live.ok : true);

  lines.push("# Owner Journey Acceptance Run");
  lines.push("");
  lines.push(`Generated: ${timestamp}`);
  lines.push(`Result: ${overallOk ? "PASS" : "FAIL"}`);
  lines.push(`Mode: local-source${live ? ` + live (${live.origin})` : ""}`);
  lines.push("");
  lines.push(
    "This report is produced by `scripts/check-owner-journey-acceptance.mjs`. It " +
      "scans the normal owner setup surfaces for the failure classes that broke the " +
      "owner setup walkthrough: developer-only paths, unpublished CLI commands, raw " +
      "setup-planner labels, same-tab credential help links, and transient-only " +
      "post-submit flows."
  );
  lines.push("");

  // ── Findings ──────────────────────────────────────────────────────────────
  lines.push("## Findings");
  lines.push("");
  const allFindings = [...local.findings, ...(live ? live.findings : [])];
  if (allFindings.length === 0) {
    lines.push("No violations. Every scanned owner surface is clean.");
  } else {
    lines.push("| Class | Rule | Location | Rationale |");
    lines.push("| --- | --- | --- | --- |");
    for (const f of allFindings) {
      const loc = `\`${f.path}:${f.line ?? 0}\``;
      lines.push(`| ${f.class} | ${f.ruleId} | ${loc} | ${escapeCell(f.rationale)} |`);
    }
  }
  lines.push("");

  // ── Local source scan ────────────────────────────────────────────────────
  lines.push("## Local source scan");
  lines.push("");
  lines.push("Scanned files:");
  lines.push("");
  for (const f of local.scannedFiles.normal) {
    lines.push(`- normal: \`${f}\``);
  }
  for (const f of local.scannedFiles.advanced) {
    lines.push(`- advanced: \`${f}\``);
  }
  for (const f of local.scannedFiles.commandSource) {
    lines.push(`- command-source: \`${f}\``);
  }
  lines.push("");

  // ── Command freshness ─────────────────────────────────────────────────────
  lines.push("## Command freshness");
  lines.push("");
  lines.push("Published subcommand surface (derived from package source):");
  lines.push("");
  for (const [pkg, subs] of Object.entries(local.publishedSurface)) {
    lines.push(`- \`${pkg}\`: ${subs.map((s) => `\`${s}\``).join(", ")}`);
  }
  lines.push("");
  lines.push("Commands rendered in owner UI:");
  lines.push("");
  lines.push("| Package / host | Subcommand | Verified | Verification mode |");
  lines.push("| --- | --- | --- | --- |");
  for (const c of dedupeCommands(local.renderedCommands)) {
    const pkg = c.packageName ?? c.head;
    const sub = c.subcommand ?? "(base)";
    const mode = c.verificationMode ?? (c.verified === "external-host" ? "owner-installed agent CLI" : "n/a");
    lines.push(`| \`${pkg}\` | \`${sub}\` | ${c.verified} | ${escapeCell(mode)} |`);
  }
  lines.push("");

  // ── Clean-shell freshness ─────────────────────────────────────────────────
  if (cleanShell) {
    lines.push("## Clean-shell command freshness");
    lines.push("");
    lines.push("Each published package was resolved from a throwaway directory via `npx -y <pkg>@<tag> --help`.");
    lines.push("");
    lines.push("| Package | Specifier | Resolved | Error |");
    lines.push("| --- | --- | --- | --- |");
    for (const p of cleanShell.probes) {
      lines.push(`| \`${p.package}\` | \`${p.specifier}\` | ${p.ok ? "yes" : "no"} | ${escapeCell(p.error ?? "")} |`);
    }
    lines.push("");
  }

  // ── Live probe ────────────────────────────────────────────────────────────
  if (live) {
    lines.push("## Live origin probe");
    lines.push("");
    lines.push(`Origin: \`${live.origin}\``);
    lines.push(`Owner auth mode: ${live.authMode} (value never printed)`);
    lines.push("");
    lines.push("| Surface | Status | Reached owner surface | Findings |");
    lines.push("| --- | --- | --- | --- |");
    for (const s of live.surfaces) {
      const status = s.status ?? `error: ${s.error ?? "unknown"}`;
      lines.push(`| \`${s.path}\` | ${status} | ${s.reachedOwnerSurface ? "yes" : "no"} | ${s.findingCount ?? 0} |`);
    }
    lines.push("");
    if (live.authMode === "none") {
      lines.push(
        "> Live auth was not supplied, so owner-only surfaces likely redirected to login " +
          "and are treated as acceptance failures. Set `PDPP_OWNER_SESSION_COOKIE` or " +
          "`PDPP_OWNER_PASSWORD` to scan authenticated renders."
      );
      lines.push("");
    } else if (live.findings.some((f) => f.class === "live-probe-inconclusive")) {
      lines.push(
        "> At least one live owner surface was not reached. This is a failed live gate until " +
          "the authenticated rendered page is observed."
      );
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

/** Collapse duplicate (package, subcommand) command rows for a compact table. */
function dedupeCommands(commands) {
  const seen = new Set();
  const out = [];
  for (const c of commands) {
    const key = `${c.packageName ?? c.head}::${c.subcommand ?? ""}::${c.verified}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push(c);
  }
  return out;
}

function escapeCell(text) {
  return String(text ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
}
