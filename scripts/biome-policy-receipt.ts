// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "..");
const LEDGER_PATH = "docs/biome-exception-ledger.jsonl";
const REVIEW_BY = "2027-01-31";
const PROCESSED_FILES_PATTERN = /Files processed:\s*\n([\s\S]*?)(?=\n[^\n]*Files fixed:|\nScanned project)/;
const PROCESSED_FILE_LINE_PATTERN = /^\s*-\s+(.+)$/gm;
const LINE_SUPPRESSION_PATTERN =
  /\/\/[^\S\r\n]*biome-ignore(?<scope>-all|-start|-end)?\s+(?<rule>[^:\r\n]+):(?<reason>[^\r\n]*(?:\r?\n[ \t]*\/\/(?![ \t]*biome-ignore)[^\r\n]*)*)/g;
const BLOCK_SUPPRESSION_PATTERN =
  /\/\*+[\s*]*biome-ignore(?<scope>-all|-start|-end)?\s+(?<rule>[^:\r\n]+):(?<reason>[\s\S]*?)\*\//g;
const HTML_SUPPRESSION_PATTERN =
  /<!--\s*biome-ignore(?<scope>-all|-start|-end)?\s+(?<rule>[^:\r\n]+):(?<reason>[\s\S]*?)-->/g;
const SUPPRESSION_TOKEN_PATTERN = /\bbiome-ignore/;
const CONFIG_OFF_PATTERN = /"(?<rule>[^"]+)":\s*"off"/g;
const CONFIG_DISABLED_TOOL_PATTERN = /"(?<tool>formatter|linter)"\s*:\s*\{\s*"enabled"\s*:\s*false/g;
const EXCLUSION_PATTERN = /"(?<pattern>!![^"]+)"/g;
const COMMENT_PREFIX_PATTERN = /^\/\/\s?/;
const SEE_COMMENT_ABOVE_PATTERN = /^see (?:cause )?(?:comment|note) above(?: the if-chain)?\.?$/i;
const LINE_BREAK_PATTERN = /\r?\n/;
const BLOCK_COMMENT_LINE_PREFIX_PATTERN = /^\*\s?/;
const LINE_COMMENT_PREFIX_PATTERN = /^\/\/\s?/;

interface Diagnostic {
  category: string;
  location: {
    end: { column: number; line: number };
    path: string;
    start: { column: number; line: number };
  };
  message: string;
  severity: string;
}

interface BiomeResult {
  diagnostics: Diagnostic[];
  summary: Record<string, number>;
}

interface LedgerEntry {
  classification: string;
  id: string;
  invariant: string;
  kind: "config-rule" | "exclusion" | "inline-suppression";
  line: number;
  owner: string;
  path: string;
  probe: string;
  review: {
    expires_on: string;
    trigger: string;
  };
  rule_or_pattern: string;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function command(commandName: string, args: string[]): string {
  return execFileSync(commandName, args, { cwd: ROOT, encoding: "utf8" }).trim();
}

function trackedFiles(): string[] {
  return command("git", ["ls-files", "-z"]).split("\0").filter(Boolean);
}

function ownerFor(path: string): string {
  if (path.startsWith("reference-implementation/")) {
    return "PDPP reference implementation maintainers";
  }
  if (path.startsWith("apps/")) {
    return "PDPP app maintainers";
  }
  if (path.startsWith("packages/")) {
    return "PDPP package maintainers";
  }
  if (path.startsWith("docs/design-system/")) {
    return "PDPP design-system maintainers";
  }
  return "PDPP repository maintainers";
}

function probeFor(path: string): string {
  if (path.startsWith("reference-implementation/")) {
    return "pnpm --dir reference-implementation run typecheck && pnpm test-accounting:check";
  }
  if (path.startsWith("docs/design-system/")) {
    return "pnpm generated-artifacts:check && pnpm exec biome check docs/design-system/ink-carbon/project";
  }
  if (path.startsWith("apps/") || path.startsWith("packages/")) {
    return "pnpm -r --if-present run typecheck && pnpm test-accounting:check";
  }
  return "pnpm exec ultracite check --error-on-warnings && pnpm test-accounting:check";
}

function classificationFor(rule: string): string {
  if (rule.includes("noUnresolvedImports") || rule.includes("noUnnecessaryConditions")) {
    return "tool-model-mismatch";
  }
  if (rule.includes("/a11y/") || rule.includes("noJsxPropsBind")) {
    return "bounded-interface-exception";
  }
  if (rule === "format" || rule.startsWith("assist/")) {
    return "generator-or-ordering-contract";
  }
  return "behavior-preservation-exception";
}

function ledgerId(value: Omit<LedgerEntry, "id">): string {
  return `biome-${sha256(JSON.stringify(value)).slice(0, 20)}`;
}

function entry(input: Omit<LedgerEntry, "id" | "owner" | "probe" | "review">): LedgerEntry {
  const withoutId: Omit<LedgerEntry, "id"> = {
    ...input,
    owner: ownerFor(input.path),
    probe: probeFor(input.path),
    review: {
      expires_on: REVIEW_BY,
      trigger: "Re-adjudicate when this exact path, rule/pattern, or stated invariant changes.",
    },
  };
  return { ...withoutId, id: ledgerId(withoutId) };
}

function nearestRationale(lines: string[], index: number): string {
  const rationale: string[] = [];
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 12; cursor -= 1) {
    const trimmed = (lines[cursor] ?? "").trim();
    if (trimmed.startsWith("//")) {
      if (trimmed.includes("biome-ignore")) {
        continue;
      }
      rationale.unshift(trimmed.replace(COMMENT_PREFIX_PATTERN, ""));
      continue;
    }
    if (trimmed === "") {
      if (rationale.length > 0) {
        break;
      }
      continue;
    }
    break;
  }
  return rationale.join(" ").trim();
}

function referencedRationale(lines: string[], index: number): string {
  for (let cursor = index - 1; cursor >= 0 && cursor >= index - 24; cursor -= 1) {
    const trimmed = (lines[cursor] ?? "").trim();
    if (!(trimmed.startsWith("//") && !trimmed.includes("biome-ignore"))) {
      continue;
    }
    const rationale: string[] = [];
    for (let commentCursor = cursor; commentCursor >= 0; commentCursor -= 1) {
      const comment = (lines[commentCursor] ?? "").trim();
      if (!(comment.startsWith("//") && !comment.includes("biome-ignore"))) {
        break;
      }
      rationale.unshift(comment.replace(COMMENT_PREFIX_PATTERN, ""));
    }
    return rationale.join(" ").trim();
  }
  return "";
}

function selfContainedRationale(
  lines: string[],
  index: number,
  rule: string,
  sourceReason: string,
  priorRationaleByRule: ReadonlyMap<string, string>
): string {
  if (!SEE_COMMENT_ABOVE_PATTERN.test(sourceReason)) {
    return sourceReason;
  }
  return referencedRationale(lines, index) || priorRationaleByRule.get(rule) || sourceReason;
}

interface RawSuppression {
  offset: number;
  reason: string;
  rule: string;
  scope: string | undefined;
}

function normalizeSuppressionReason(value: string): string {
  return value
    .split(LINE_BREAK_PATTERN)
    .map((line) => line.trim().replace(BLOCK_COMMENT_LINE_PREFIX_PATTERN, "").replace(LINE_COMMENT_PREFIX_PATTERN, ""))
    .filter(Boolean)
    .join(" ")
    .trim();
}

function collectSuppressions(text: string, pattern: RegExp): RawSuppression[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => {
    const directiveOffset = match[0].search(SUPPRESSION_TOKEN_PATTERN);
    return {
      offset: match.index + Math.max(0, directiveOffset),
      reason: normalizeSuppressionReason(match.groups?.reason ?? ""),
      rule: (match.groups?.rule ?? "").trim(),
      scope: match.groups?.scope?.slice(1),
    };
  });
}

function scanInline(path: string, text: string): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  const lines = text.split("\n");
  const priorRationaleByRule = new Map<string, string>();
  const suppressions = [
    ...collectSuppressions(text, LINE_SUPPRESSION_PATTERN),
    ...collectSuppressions(text, BLOCK_SUPPRESSION_PATTERN),
    ...collectSuppressions(text, HTML_SUPPRESSION_PATTERN),
  ].sort((left, right) => left.offset - right.offset);
  let line = 1;
  let priorOffset = 0;
  for (const suppression of suppressions) {
    for (let offset = priorOffset; offset < suppression.offset; offset += 1) {
      if (text[offset] === "\n") {
        line += 1;
      }
    }
    priorOffset = suppression.offset;
    const sourceIndex = line - 1;
    const reason = selfContainedRationale(
      lines,
      sourceIndex,
      suppression.rule,
      suppression.reason,
      priorRationaleByRule
    );
    if (!(suppression.rule && reason)) {
      throw new Error(`${path}:${line}: every Biome suppression requires a rule and invariant rationale`);
    }
    if (SEE_COMMENT_ABOVE_PATTERN.test(reason)) {
      throw new Error(`${path}:${line}: Biome suppression rationale must be self-contained`);
    }
    priorRationaleByRule.set(suppression.rule, reason);
    entries.push(
      entry({
        classification: classificationFor(suppression.rule),
        invariant: reason,
        kind: "inline-suppression",
        line,
        path,
        rule_or_pattern: suppression.scope ? `${suppression.scope}:${suppression.rule}` : suppression.rule,
      })
    );
  }
  return entries;
}

function scanConfig(path: string, lines: string[]): LedgerEntry[] {
  const entries: LedgerEntry[] = [];
  for (const [index, line] of lines.entries()) {
    for (const match of line.matchAll(CONFIG_OFF_PATTERN)) {
      const rule = match.groups?.rule;
      if (!rule) {
        throw new Error(`${path}:${index + 1}: could not parse disabled Biome rule`);
      }
      entries.push(
        entry({
          classification: classificationFor(rule),
          invariant:
            nearestRationale(lines, index) ||
            "Rule exception is bounded by this exact config location and its enclosing scoped override; typecheck and policy receipts probe the documented boundary.",
          kind: "config-rule",
          line: index + 1,
          path,
          rule_or_pattern: rule,
        })
      );
    }
    for (const match of line.matchAll(CONFIG_DISABLED_TOOL_PATTERN)) {
      const tool = match.groups?.tool;
      if (!tool) {
        throw new Error(`${path}:${index + 1}: could not parse disabled Biome tool`);
      }
      entries.push(
        entry({
          classification: "generated-data-or-tool-boundary",
          invariant:
            nearestRationale(lines, index) ||
            `${tool} is disabled only for this exact generated, captured-data, or host-tooling override.`,
          kind: "config-rule",
          line: index + 1,
          path,
          rule_or_pattern: `${tool}.enabled=false`,
        })
      );
    }
    for (const match of line.matchAll(EXCLUSION_PATTERN)) {
      const exclusion = match.groups?.pattern;
      if (!exclusion) {
        throw new Error(`${path}:${index + 1}: could not parse Biome force-exclusion`);
      }
      entries.push(
        entry({
          classification: "generated-data-or-tool-boundary",
          invariant:
            nearestRationale(lines, index) ||
            "Force-excluded dependency, generated output, or captured-data boundary; the selection mutation gate verifies authored coverage.",
          kind: "exclusion",
          line: index + 1,
          path,
          rule_or_pattern: exclusion,
        })
      );
    }
  }
  return entries;
}

function assertParserFixtures(): void {
  const directive = ["biome", "ignore"].join("-");
  const inline = scanInline(
    "fixture.tsx",
    [
      `// ${directive} lint/style/useForOf: ordered mutation contract`,
      `/** ${directive}-all lint/performance/useTopLevelRegex: invariant`,
      " * source probe */",
      `value; // ${directive}-start lint/suspicious/noExplicitAny: generated boundary`,
      `// ${directive}-end lint/suspicious/noExplicitAny: generated boundary`,
      `{/** ${directive} lint/performance/noJsxPropsBind: row-local handler */}`,
      `<!-- ${directive} lint/a11y/noSvgWithoutTitle: branded standalone asset -->`,
    ].join("\n")
  );
  const inlineRules = inline.map((value) => value.rule_or_pattern);
  const expectedInlineRules = [
    "lint/style/useForOf",
    "all:lint/performance/useTopLevelRegex",
    "start:lint/suspicious/noExplicitAny",
    "end:lint/suspicious/noExplicitAny",
    "lint/performance/noJsxPropsBind",
    "lint/a11y/noSvgWithoutTitle",
  ];
  if (JSON.stringify(inlineRules) !== JSON.stringify(expectedInlineRules)) {
    throw new Error(`Biome suppression parser fixture failed: ${JSON.stringify(inlineRules)}`);
  }
  if (inline[1]?.invariant !== "invariant source probe") {
    throw new Error(`Biome multiline rationale parser fixture failed: ${JSON.stringify(inline[1]?.invariant)}`);
  }
  const config = scanConfig("biome.jsonc", [
    '"assist": { "actions": { "source": { "organizeImports": "off" } } },',
    '"formatter": { "enabled": false },',
    '"!!generated", "!!captured"',
  ]);
  if (
    JSON.stringify(config.map((value) => value.rule_or_pattern)) !==
    JSON.stringify(["organizeImports", "formatter.enabled=false", "!!generated", "!!captured"])
  ) {
    throw new Error("Biome config-exception parser fixture failed");
  }
}

function buildLedger(): string {
  const entries: LedgerEntry[] = [];
  for (const path of trackedFiles()) {
    const absolutePath = resolve(ROOT, path);
    let text: string;
    try {
      text = readFileSync(absolutePath, "utf8");
    } catch {
      continue;
    }
    const lines = text.split("\n");
    if (!path.endsWith(".md")) {
      entries.push(...scanInline(path, text));
    }
    if (path.endsWith("biome.jsonc")) {
      entries.push(...scanConfig(path, lines));
    }
  }
  entries.sort((left, right) => left.path.localeCompare(right.path) || left.line - right.line);
  const fingerprint = sha256(entries.map(({ id: _id, ...value }) => JSON.stringify(value)).join("\n"));
  const header = {
    entry_count: entries.length,
    fingerprint_sha256: fingerprint,
    policy:
      "Every active inline suppression, disabled rule, and force-excluded path is exact, owned, probed, and review-bounded. Any tuple change regenerates this ledger and requires review.",
    schema_version: 1,
  };
  return `${[JSON.stringify(header), ...entries.map((value) => JSON.stringify(value))].join("\n")}\n`;
}

function parseJsonResult(commandName: string): BiomeResult {
  const result = spawnSync(
    "pnpm",
    ["exec", commandName, "check", "--reporter=json", "--max-diagnostics=none", "--diagnostic-level=info", "."],
    { cwd: ROOT, encoding: "utf8", maxBuffer: 100 * 1024 * 1024 }
  );
  let parsed: BiomeResult;
  try {
    parsed = JSON.parse(result.stdout) as BiomeResult;
  } catch (error) {
    throw new Error(`${commandName} did not emit a JSON diagnostic result: ${result.stderr}`, { cause: error });
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${commandName} diagnostics exited ${result.status}: ${result.stderr}`);
  }
  return parsed;
}

function processedFiles(commandName: "biome" | "ultracite"): string[] {
  const result = spawnSync("pnpm", ["exec", commandName, "check", "--verbose", "--max-diagnostics=1", "."], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const output = `${result.stdout}\n${result.stderr}`;
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${commandName} inventory exited ${result.status}: ${output}`);
  }
  const match = output.match(PROCESSED_FILES_PATTERN);
  if (!match) {
    throw new Error(`Could not read ${commandName}'s processed-file inventory`);
  }
  return [...(match[1] ?? "").matchAll(PROCESSED_FILE_LINE_PATTERN)]
    .map((item) => (item[1] ?? "").trim())
    .sort((left, right) => left.localeCompare(right));
}

function diagnosticTuple(diagnostic: Diagnostic): Record<string, unknown> {
  return {
    category: diagnostic.category,
    location: diagnostic.location,
    message: diagnostic.message,
    path: diagnostic.location.path,
    rule: diagnostic.category,
    severity: diagnostic.severity,
    workspace: ".",
  };
}

function assertCleanDiagnostics(name: string, result: BiomeResult): void {
  if (result.diagnostics.length > 0) {
    throw new Error(
      `${name} emitted ${result.diagnostics.length} diagnostic(s): ${JSON.stringify(result.diagnostics)}`
    );
  }
}

interface DiagnosticEvidence {
  biome: BiomeResult;
  biomeFiles: string[];
  ultracite: BiomeResult;
  ultraciteFiles: string[];
}

function collectDiagnosticEvidence(): DiagnosticEvidence {
  const biome = parseJsonResult("biome");
  const ultracite = parseJsonResult("ultracite");
  assertCleanDiagnostics("Biome", biome);
  assertCleanDiagnostics("Ultracite", ultracite);
  const biomeFiles = processedFiles("biome");
  const ultraciteFiles = processedFiles("ultracite");
  if (JSON.stringify(biomeFiles) !== JSON.stringify(ultraciteFiles)) {
    throw new Error("Biome and Ultracite selected different files");
  }
  return { biome, biomeFiles, ultracite, ultraciteFiles };
}

function writeReceipt(path: string, ledger: string, evidence: DiagnosticEvidence): void {
  const status = command("git", ["status", "--porcelain=v1"]);
  if (status) {
    throw new Error("Biome policy receipts require a clean working tree");
  }
  const { biome, biomeFiles, ultracite } = evidence;
  const diagnostics = [...biome.diagnostics, ...ultracite.diagnostics].map(diagnosticTuple);
  const receipt = {
    base_sha: command("git", ["merge-base", "HEAD", "e455e2f87ec1cd90018e3b6fbe9eb556754428a5"]),
    config_hashes: Object.fromEntries(
      trackedFiles()
        .filter((file) => file.endsWith("biome.jsonc"))
        .map((file) => [file, sha256(readFileSync(resolve(ROOT, file)))])
    ),
    diagnostic_fingerprint_sha256: sha256(JSON.stringify(diagnostics)),
    diagnostics,
    exception_ledger: {
      entry_count: ledger.trimEnd().split("\n").length - 1,
      path: LEDGER_PATH,
      sha256: sha256(ledger),
    },
    head_sha: command("git", ["rev-parse", "HEAD"]),
    runtime: {
      biome: command("pnpm", ["exec", "biome", "--version"]),
      node: process.version,
      pnpm: command("pnpm", ["--version"]),
      ultracite: command("pnpm", ["exec", "ultracite", "--version"]),
    },
    schema_version: 1,
    selected_paths: biomeFiles,
    selected_paths_fingerprint_sha256: sha256(biomeFiles.join("\n")),
    severity_totals: {
      error: diagnostics.filter((value) => value.severity === "error").length,
      info: diagnostics.filter((value) => value.severity === "info").length,
      warning: diagnostics.filter((value) => value.severity === "warning").length,
    },
    workspace: relative(ROOT, ROOT) || ".",
  };
  writeFileSync(resolve(ROOT, path), `${JSON.stringify(receipt, null, 2)}\n`);
}

assertParserFixtures();
const generatedLedger = buildLedger();
if (process.argv.includes("--write-ledger")) {
  writeFileSync(resolve(ROOT, LEDGER_PATH), generatedLedger);
} else {
  const trackedLedger = readFileSync(resolve(ROOT, LEDGER_PATH), "utf8");
  if (trackedLedger !== generatedLedger) {
    throw new Error("Biome exception ledger drift: run pnpm biome:policy:write");
  }
}

const diagnosticEvidence = collectDiagnosticEvidence();
const receiptIndex = process.argv.indexOf("--receipt");
if (receiptIndex >= 0) {
  const receiptPath = process.argv[receiptIndex + 1];
  if (!receiptPath) {
    throw new Error("--receipt requires a path");
  }
  writeReceipt(receiptPath, generatedLedger, diagnosticEvidence);
}

console.log(
  `biome-policy: ${generatedLedger.trimEnd().split("\n").length - 1} exact exceptions; ledger and diagnostics policy valid`
);
