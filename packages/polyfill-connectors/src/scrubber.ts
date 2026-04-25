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

interface ConnectorScrubRuleModule {
  default?: unknown;
  scrubRules?: unknown;
}

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
      const replacement = rule.replacement;
      out = out.replace(rule.pattern, (substring: string, ...args: string[]) => replacement(substring, ...args));
    }
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
