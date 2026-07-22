// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { existsSync } from "node:fs";
import { extname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Which captured file type a rule applies to. */
export type ScrubScope = "all" | "html" | "json";

/** A single scrub rule. `replacement` may be a string or a replacer function. */
export interface ScrubRule {
  pattern: RegExp;
  replacement: string | ((substring: string, ...args: string[]) => string);
  scope: ScrubScope;
}

export interface StructuredRedaction {
  reason: string;
  replacement: string;
  text: string;
}

export interface StructuredRedactionPlan {
  redactions: StructuredRedaction[];
  version: 1;
}

interface ConnectorScrubRuleModule {
  default?: unknown;
  scrubRules?: unknown;
}

const REDACTION_REPLACEMENT_RE = /^\[REDACTED_[A-Z0-9_]+\]$/;

export function fileScopeOf(path: string): ScrubScope {
  const ext = extname(path).toLowerCase();
  if (ext === ".html" || ext === ".htm") {
    return "html";
  }
  if (ext === ".json" || ext === ".jsonl") {
    return "json";
  }
  return "all";
}

export function applyScrubRules(content: string, rules: readonly ScrubRule[], fileScope: ScrubScope): string {
  let out = content;
  for (const rule of rules) {
    if (!scopeMatches(fileScope, rule.scope)) {
      continue;
    }
    if (typeof rule.replacement === "string") {
      out = out.replace(rule.pattern, rule.replacement);
    } else {
      const { replacement } = rule;
      out = out.replace(rule.pattern, (substring: string, ...args: string[]) => replacement(substring, ...args));
    }
  }
  return out;
}

export function parseStructuredRedactionPlan(value: unknown): StructuredRedactionPlan {
  if (!value || typeof value !== "object") {
    throw new Error("redaction plan must be an object");
  }
  const candidate = value as { version?: unknown; redactions?: unknown };
  if (candidate.version !== 1) {
    throw new Error("redaction plan version must be 1");
  }
  if (!Array.isArray(candidate.redactions)) {
    throw new Error("redaction plan redactions must be an array");
  }
  return {
    version: 1,
    redactions: candidate.redactions.map(parseStructuredRedaction),
  };
}

export function applyStructuredRedactionPlan(content: string, plan: StructuredRedactionPlan): string {
  let out = content;
  for (const redaction of plan.redactions) {
    if (!out.includes(redaction.text)) {
      throw new Error(`redaction target not found: ${redaction.reason}`);
    }
    out = out.split(redaction.text).join(redaction.replacement);
  }
  return out;
}

export async function loadConnectorScrubRules(packageRoot: string, connector: string): Promise<ScrubRule[]> {
  const rulesFile = findConnectorRulesFile(packageRoot, connector);
  if (!rulesFile) {
    return [];
  }

  const mod = (await import(pathToFileURL(rulesFile).href)) as ConnectorScrubRuleModule;
  const rules = mod.scrubRules ?? mod.default ?? [];
  if (!Array.isArray(rules)) {
    console.warn(`${rulesFile}: expected scrubRules array; got ${typeof rules}`);
    return [];
  }
  return rules.filter(isScrubRule);
}

function findConnectorRulesFile(packageRoot: string, connector: string): string | null {
  const connectorRoot = join(packageRoot, "connectors", connector);
  const candidates = [join(connectorRoot, "scrub-rules.ts"), join(connectorRoot, "scrub-rules.js")];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function scopeMatches(fileScope: ScrubScope, ruleScope: ScrubScope): boolean {
  return ruleScope === "all" || ruleScope === fileScope;
}

function isScrubRule(value: unknown): value is ScrubRule {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as Partial<ScrubRule>;
  return (
    candidate.pattern instanceof RegExp &&
    (typeof candidate.replacement === "string" || typeof candidate.replacement === "function") &&
    (candidate.scope === "all" || candidate.scope === "html" || candidate.scope === "json")
  );
}

function parseStructuredRedaction(value: unknown, index: number): StructuredRedaction {
  if (!value || typeof value !== "object") {
    throw new Error(`redaction ${index} must be an object`);
  }
  const candidate = value as { text?: unknown; replacement?: unknown; reason?: unknown };
  if (typeof candidate.text !== "string" || candidate.text.length === 0) {
    throw new Error(`redaction ${index} text must be a non-empty string`);
  }
  if (typeof candidate.replacement !== "string" || !REDACTION_REPLACEMENT_RE.test(candidate.replacement)) {
    throw new Error(`redaction ${index} replacement must be a [REDACTED_*] placeholder`);
  }
  if (typeof candidate.reason !== "string" || candidate.reason.length === 0) {
    throw new Error(`redaction ${index} reason must be a non-empty string`);
  }
  return {
    text: candidate.text,
    replacement: candidate.replacement,
    reason: candidate.reason,
  };
}
