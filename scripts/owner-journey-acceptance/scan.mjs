// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Pure scanner core for the owner-journey acceptance harness.
//
// Every function here is pure over its inputs (source text + manifest) so the
// node:test suite can drive them with synthetic fixtures and the CLI can drive
// them with real files. File I/O lives only in the CLI entry and the test
// harness, never here.

/**
 * Strip line and block comments from JS/TS/TSX source so forbidden-string rules
 * match rendered content, not developer comments. This is a pragmatic stripper:
 * it removes `// ...` and block comments but preserves string/template content,
 * which is where rendered owner copy lives. It is intentionally conservative —
 * it will not strip a `//` that sits inside a string (e.g. a URL), so rendered
 * URLs survive for the command/link scanners.
 *
 * @param {string} src
 * @returns {string}
 */
export function stripComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  let mode = "code"; // code | line-comment | block-comment | sq | dq | template
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line-comment";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block-comment";
        i += 2;
        continue;
      }
      if (c === "'") {
        mode = "sq";
        out += c;
        i += 1;
        continue;
      }
      if (c === '"') {
        mode = "dq";
        out += c;
        i += 1;
        continue;
      }
      if (c === "`") {
        mode = "template";
        out += c;
        i += 1;
        continue;
      }
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line-comment") {
      if (c === "\n") {
        mode = "code";
        out += c;
      }
      i += 1;
      continue;
    }
    if (mode === "block-comment") {
      if (c === "*" && next === "/") {
        mode = "code";
        i += 2;
        continue;
      }
      i += 1;
      continue;
    }
    // string / template modes: copy verbatim, honor escapes, exit on matching
    // quote. Template literals can nest `${...}` but we do not need to parse
    // expressions for the rules we run; copying verbatim is sufficient and keeps
    // rendered text intact.
    out += c;
    if (c === "\\") {
      // copy the escaped char too
      if (i + 1 < n) {
        out += src[i + 1];
        i += 2;
        continue;
      }
    }
    if (mode === "sq" && c === "'") {
      mode = "code";
    } else if (mode === "dq" && c === '"') {
      mode = "code";
    } else if (mode === "template" && c === "`") {
      mode = "code";
    }
    i += 1;
  }
  return out;
}

/**
 * Run forbidden-string rules over one file's source.
 *
 * @param {object} args
 * @param {string} args.path        repo-relative path (for reporting)
 * @param {string} args.src         raw file source
 * @param {"normal"|"advanced"} args.tier
 * @param {ReadonlyArray<object>} args.rules  FORBIDDEN_STRING_RULES
 * @returns {Array<{ruleId:string, class:string, path:string, line:number, excerpt:string, rationale:string}>}
 */
export function scanForbiddenStrings({ path, src, tier, rules }) {
  // Strip comments, then blank out module-specifier lines (import ... from "x",
  // export ... from "x", and dynamic import("x")). A module path is never owner
  // copy, so `from "../../packages/cli/..."` must not count as a rendered
  // `packages/...` leak. We blank the whole statement line to keep offsets sane.
  const cleaned = blankModuleSpecifiers(stripComments(src));
  const findings = [];
  for (const rule of rules) {
    if (!rule.tiers.includes(tier)) {
      continue;
    }
    const match = cleaned.match(rule.pattern);
    if (!match) {
      continue;
    }
    findings.push({
      ruleId: rule.id,
      class: rule.class,
      path,
      line: lineOf(cleaned, match.index ?? 0),
      excerpt: excerptAround(cleaned, match.index ?? 0),
      rationale: rule.rationale,
    });
  }
  return findings;
}

/**
 * Replace the body of `import ... from "..."`, `export ... from "..."`, and
 * `import("...")` statements with spaces of equal length, so module specifiers
 * never match owner-copy rules while character offsets (and therefore line
 * numbers) are preserved.
 *
 * @param {string} src comment-stripped source
 * @returns {string}
 */
export function blankModuleSpecifiers(src) {
  const blankRange = (text, re) =>
    text.replace(re, (full) => full.replace(/[^\n]/g, " "));
  let out = src;
  // import ... from "x"  /  export ... from "x"  (single or double quoted)
  out = blankRange(out, /\b(?:import|export)\b[^\n;]*?\bfrom\s*["'][^"'\n]*["']/g);
  // bare side-effect import "x"
  out = blankRange(out, /\bimport\s*["'][^"'\n]*["']/g);
  // dynamic import("x")
  out = blankRange(out, /\bimport\s*\(\s*["'][^"'\n]*["']\s*\)/g);
  return out;
}

/**
 * Scan a rendered page for imports/calls of helper symbols known to emit
 * developer-only monorepo commands (the indirect-leak guard). A page that
 * references such a symbol could render its monorepo command to the owner.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.src
 * @param {ReadonlyArray<object>} args.forbiddenHelpers FORBIDDEN_RENDERED_HELPERS
 * @returns {Array} findings
 */
export function scanRenderedHelperReachability({ path, src, forbiddenHelpers }) {
  const cleaned = stripComments(src);
  const findings = [];
  for (const helper of forbiddenHelpers) {
    for (const symbol of helper.symbols) {
      const re = new RegExp(`\\b${symbol}\\b`);
      const match = cleaned.match(re);
      if (match) {
        findings.push({
          ruleId: helper.id,
          class: helper.class,
          path,
          line: lineOf(cleaned, match.index ?? 0),
          excerpt: `rendered page references ${symbol}()`,
          rationale: helper.rationale,
        });
      }
    }
  }
  return findings;
}

/**
 * Extract shell commands rendered in owner UI source. We look at string and
 * template literals (after comment stripping) that begin with a known command
 * head: `npx`, the pdpp bin, the local-collector bin, or an external host bin
 * (`claude`/`codex`). Template `${...}` holes are normalized to a placeholder
 * token so the head/subcommand parse is stable.
 *
 * @param {string} src raw file source
 * @returns {Array<{raw:string, head:string, subcommand:string|null, packageSpecifier:string|null, line:number}>}
 */
export function extractRenderedCommands(src, options = {}) {
  // Map of known package-specifier *variable names* to their literal value, so a
  // command built as `["npx","-y",localCollectorPackageSpecifier,"enroll"]` or
  // ``npx -y ${localCollectorPackageSpecifier} run`` resolves to a real
  // package. Without this, command-builder helpers (the actual owner command
  // surface) would slip past freshness because the specifier is a variable.
  const specifierVars = options.specifierVars ?? deriveSpecifierVars(src);
  const cleaned = stripComments(src);
  const commands = [];

  // (1) Quoted/templated literal commands: `npx -y @pdpp/cli connect ...`,
  //     ``npx -y ${specifierVar} run`` (specifier var resolved), `claude mcp ...`.
  const literalRe = /(['"`])((?:\\.|(?!\1)[\s\S])*?)\1/g;
  let m;
  while ((m = literalRe.exec(cleaned)) !== null) {
    const rawBody = m[2];
    // Resolve a `${specifierVar}` hole to its literal specifier; blank other holes.
    const resolved = rawBody.replace(/\$\{\s*([\w.]+)\s*\}/g, (_full, ident) => {
      const key = ident.split(".").pop();
      return specifierVars[ident] ?? specifierVars[key] ?? "<v>";
    });
    const normalized = resolved.trim();
    const parsed = parseCommand(normalized);
    if (parsed) {
      commands.push({ ...parsed, raw: normalized, line: lineOf(cleaned, m.index) });
    }
  }

  // (2) Array-of-tokens command builders:
  //     ["npx", "-y", localCollectorPackageSpecifier, "enroll", "--base-url", ...]
  //     The first token must be "npx"; tokens are string literals or known
  //     specifier vars. This is the dominant shape in pdpp-cli-command.ts.
  const arrayRe = /\[\s*"npx"[\s\S]*?\]/g;
  let am;
  while ((am = arrayRe.exec(cleaned)) !== null) {
    const tokens = parseArrayTokens(am[0], specifierVars);
    if (tokens.length > 0 && tokens[0] === "npx") {
      const parsed = parseCommand(tokens.join(" "));
      if (parsed) {
        commands.push({ ...parsed, raw: tokens.join(" "), line: lineOf(cleaned, am.index) });
      }
    }
  }

  return commands;
}

/**
 * Parse the token list out of a `["npx", ...]` array literal. String literals
 * become their value; bare identifiers resolve through specifierVars (unknown
 * identifiers and `.push(...)` dynamic parts are dropped, which is fine — we
 * only need head + specifier + subcommand).
 */
function parseArrayTokens(arraySrc, specifierVars) {
  const inner = arraySrc.replace(/^\[/, "").replace(/\]$/, "");
  const tokens = [];
  for (const rawPart of inner.split(",")) {
    const part = rawPart.trim();
    if (!part) {
      continue;
    }
    const strMatch = part.match(/^(['"`])((?:\\.|(?!\1)[\s\S])*?)\1$/);
    if (strMatch) {
      tokens.push(strMatch[2]);
      continue;
    }
    const ident = part.match(/^[\w.]+$/);
    if (ident) {
      const key = part.split(".").pop();
      if (specifierVars[part]) {
        tokens.push(specifierVars[part]);
      } else if (specifierVars[key]) {
        tokens.push(specifierVars[key]);
      }
      // unknown identifier: skip (not head/specifier/subcommand we can resolve)
      continue;
    }
    // Anything else (nested expr) terminates the simple token list.
    break;
  }
  return tokens;
}

/**
 * Derive `{ varName -> "@scope/pkg@tag" }` from `const X = "@.../..."` and
 * `const X = \`${Y}@latest\`` declarations in the source. Two passes so a
 * specifier built from a package-name var (the common shape) resolves.
 *
 * @param {string} src
 * @returns {Record<string,string>}
 */
export function deriveSpecifierVars(src) {
  const cleaned = stripComments(src);
  const vars = {};
  // Pass 1: direct string assignments to a "@scope/pkg" or "@scope/pkg@tag".
  for (const mm of cleaned.matchAll(/\b(?:const|let|var)\s+([\w]+)\s*=\s*"(@[\w/-]+(?:@[\w.-]+)?)"/g)) {
    vars[mm[1]] = mm[2];
  }
  // Pass 2: template specifiers like `${packageNameVar}@latest`.
  for (const mm of cleaned.matchAll(/\b(?:const|let|var)\s+([\w]+)\s*=\s*`\$\{\s*([\w]+)\s*\}@([\w.-]+)`/g)) {
    const base = vars[mm[2]];
    if (base) {
      vars[mm[1]] = `${base.split("@").slice(0, base.startsWith("@") ? 2 : 1).join("@")}@${mm[3]}`;
    }
  }
  return vars;
}

const COMMAND_HEADS = new Set(["npx", "pdpp", "pdpp-local-collector", "claude", "codex", "node", "pnpm"]);
const VERSION_LABEL_RE = /^\d+\.\d+\.\d+(?:[-+][a-z0-9.-]+)?$/i;

/**
 * Parse a normalized command string into its head, package specifier (for npx),
 * and the meaningful subcommand. Returns null when the literal is not a command.
 *
 * @param {string} normalized
 */
export function parseCommand(normalized) {
  const tokens = normalized.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }
  const head = tokens[0];
  if (head === "pdpp" && tokens.length === 2 && VERSION_LABEL_RE.test(tokens[1])) {
    return null;
  }
  if (!COMMAND_HEADS.has(head)) {
    return null;
  }
  if (head === "npx") {
    // npx [-y] <specifier> <subcommand?> ...
    let idx = 1;
    while (idx < tokens.length && (tokens[idx] === "-y" || tokens[idx] === "--yes")) {
      idx += 1;
    }
    const specifier = tokens[idx] ?? null;
    if (!specifier || !specifier.startsWith("@")) {
      return null;
    }
    const packageName = specifier.split("@").slice(0, -1).join("@") || specifier;
    const subcommand = tokens[idx + 1] ?? null;
    return { head, packageSpecifier: specifier, packageName, subcommand: cleanSub(subcommand) };
  }
  if (head === "pdpp" || head === "pdpp-local-collector") {
    const packageName = head === "pdpp" ? "@pdpp/cli" : "@pdpp/local-collector";
    return { head, packageSpecifier: null, packageName, subcommand: cleanSub(tokens[1] ?? null) };
  }
  // External host CLIs and bare node/pnpm: capture head + subcommand for the
  // report; freshness for these is out of PDPP package scope (node/pnpm caught
  // by forbidden-string rules instead).
  return { head, packageSpecifier: null, packageName: null, subcommand: cleanSub(tokens[1] ?? null) };
}

function cleanSub(sub) {
  if (!sub) {
    return null;
  }
  // A `<v>` placeholder or a flag is not a subcommand.
  if (sub === "<v>" || sub.startsWith("-")) {
    return null;
  }
  return sub;
}

/**
 * Derive the published-command surface for a package from its source dispatch
 * file. Grounding freshness in the actual source means the harness fails the
 * instant the UI advertises a subcommand the package does not ship.
 *
 * Two dispatch shapes are recognized:
 *   - @pdpp/cli: `if (command === 'connect')` lines in index.js
 *   - @pdpp/local-collector: the `usage: pdpp-local-collector <a|b|c|...>` line
 *     plus `command === "..."` / `command !== "..."` guards in the bin.
 *
 * @param {string} dispatchSource raw source of the dispatch file
 * @returns {Set<string>} subcommand names the package ships
 */
export function deriveSubcommandSurface(dispatchSource) {
  const subs = new Set();
  // Shape 1: command === 'x' / command === "x"
  for (const mm of dispatchSource.matchAll(/command\s*(?:===|!==)\s*['"]([a-z][a-z0-9-]*)['"]/gi)) {
    subs.add(mm[1]);
  }
  // Shape 2: a usage line listing subcommands as a pipe alternation,
  // `usage: bin <enroll|run|status|...>`. Require a pipe so a single
  // placeholder arg like `<provider-url>` or `<url>` is not mistaken for a
  // subcommand. Scan every `<...|...>` group on usage lines and keep the
  // alternations.
  for (const mm of dispatchSource.matchAll(/<([a-z0-9_-]+(?:\|[a-z0-9_-]+)+)>/gi)) {
    for (const part of mm[1].split("|")) {
      const p = part.trim();
      if (p) {
        subs.add(p);
      }
    }
  }
  return subs;
}

/**
 * Check freshness of rendered commands against the derived published surface.
 *
 * @param {object} args
 * @param {Array} args.commands              from extractRenderedCommands (with path)
 * @param {Record<string,Set<string>>} args.surfaceByPackage  packageName -> subcommand Set
 * @param {Record<string,object>} args.publishedPackages       PUBLISHED_PACKAGES
 * @returns {{rendered:Array, findings:Array}}
 */
export function checkCommandFreshness({ commands, surfaceByPackage, publishedPackages }) {
  const findings = [];
  const rendered = [];
  for (const cmd of commands) {
    const pkgName = cmd.packageName;
    // External host CLIs (claude/codex) and non-package heads: record, do not gate.
    if (!pkgName || !publishedPackages[pkgName]) {
      rendered.push({ ...cmd, verified: cmd.head === "claude" || cmd.head === "codex" ? "external-host" : "n/a" });
      continue;
    }
    const meta = publishedPackages[pkgName];
    const surface = surfaceByPackage[pkgName];
    let verified = "package-known";
    if (cmd.subcommand && surface && !surface.has(cmd.subcommand)) {
      findings.push({
        ruleId: "command-freshness",
        class: "unpublished-command",
        path: cmd.path,
        line: cmd.line,
        excerpt: cmd.raw,
        rationale: `Rendered command '${cmd.head} ${cmd.subcommand}' is not a published subcommand of ${pkgName}. Published subcommands: ${[...(surface ?? [])].sort().join(", ") || "(none derived)"}.`,
      });
      verified = "MISSING";
    } else if (cmd.subcommand) {
      verified = "published-subcommand";
    }
    rendered.push({ ...cmd, verificationMode: meta.verificationMode, verified });
  }
  return { rendered, findings };
}

/**
 * Check that external help links in a static-secret surface open in a new tab.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.src
 * @returns {Array} findings
 */
export function checkHelpLinkTargets({ path, src }) {
  const findings = [];
  const cleaned = stripComments(src);
  // Find anchor tags carrying an external help href (help_url or http(s)).
  const anchorRe = /<a\b[^>]*?>/g;
  let m;
  while ((m = anchorRe.exec(cleaned)) !== null) {
    const tag = m[0];
    const referencesExternalHelp = /help_url|href=\{?["'`]?https?:/.test(tag) || /field\.help_url/.test(tag);
    if (!referencesExternalHelp) {
      continue;
    }
    const opensNewTab = /target=\{?["'`]?_blank/.test(tag);
    const safeRel = /rel=\{?["'`]?(?:[^"'`]*\b)?(?:noreferrer|noopener)/.test(tag);
    if (!opensNewTab || !safeRel) {
      findings.push({
        ruleId: "static-secret-help-link-new-tab",
        class: "help-link-same-tab",
        path,
        line: lineOf(cleaned, m.index),
        excerpt: tag.slice(0, 120),
        rationale: `External help link must set target="_blank" and rel="noreferrer"/"noopener" (opensNewTab=${opensNewTab}, safeRel=${safeRel}).`,
      });
    }
  }
  return findings;
}

/**
 * Check that the post-submit static-secret surface references durable artifacts
 * (connection id + run/sync link) rather than relying only on a transient
 * notice. Detectable from source: the rule requires every declared signal.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.src
 * @param {object} args.rule POST_SUBMIT_RULE
 * @returns {Array} findings
 */
export function checkPostSubmitDurability({ path, src, rule }) {
  const cleaned = stripComments(src);
  const missing = rule.requiredSignals.filter((sig) => !sig.pattern.test(cleaned));
  if (missing.length === 0) {
    return [];
  }
  return [
    {
      ruleId: rule.id,
      class: rule.class,
      path,
      line: 0,
      excerpt: `missing durable signal(s): ${missing.map((s) => s.id).join(", ")}`,
      rationale: rule.rationale,
    },
  ];
}

/**
 * Check the shared dashboard shell's primary navigation contract. This is a
 * source-level regression guard for the old failure where navigation looked
 * like vague top chrome instead of a durable route map.
 *
 * @param {object} args
 * @param {string} args.path
 * @param {string} args.src
 * @param {ReadonlyArray<{label:string,href:string}>} args.requiredItems
 * @returns {Array} findings
 */
export function checkSharedShellNavContract({ path, src, requiredItems }) {
  const cleaned = stripComments(src);
  const findings = [];

  for (const item of requiredItems) {
    const itemRe = new RegExp(
      `\\{\\s*label:\\s*${quotedLiteralPattern(item.label)},\\s*href:\\s*${quotedLiteralPattern(item.href)}\\s*\\}`
    );
    if (!itemRe.test(cleaned)) {
      findings.push({
        ruleId: "shared-shell-missing-nav-item",
        class: "shell-navigation-contract",
        path,
        line: 0,
        excerpt: `${item.label} -> ${item.href}`,
        rationale:
          "The owner console shell must expose the primary route map as durable navigation links. Missing or remapped route labels can recreate the confusing top-nav/button state from the owner walkthrough.",
      });
    }
  }

  const linkUsesRouteHref = /<Link\b[\s\S]*?href=\{item\.href\}/.test(cleaned);
  if (!linkUsesRouteHref) {
    findings.push({
      ruleId: "shared-shell-nav-not-links",
      class: "shell-navigation-contract",
      path,
      line: 0,
      excerpt: "NavList must render Link href={item.href}",
      rationale:
        "Primary navigation must be real route links. It must not regress into vague buttons that obscure route changes.",
    });
  }

  if (!/aria-current=\{active \? "page" : undefined\}/.test(cleaned)) {
    findings.push({
      ruleId: "shared-shell-missing-active-page",
      class: "shell-navigation-contract",
      path,
      line: 0,
      excerpt: "aria-current active page marker",
      rationale:
        "The shared shell must mark the current route with aria-current so the owner can tell where they are.",
    });
  }

  const jumpButton = cleaned.match(/<button\b[^>]*className="rr-chrome-btn"[\s\S]*?<\/button>/)?.[0] ?? "";
  if (!/\bJump\b/.test(jumpButton) || /\bExplore\b/.test(jumpButton)) {
    findings.push({
      ruleId: "shared-shell-jump-not-explore-button",
      class: "shell-navigation-contract",
      path,
      line: jumpButton ? lineOf(cleaned, cleaned.indexOf(jumpButton)) : 0,
      excerpt: excerptAround(jumpButton, 0, 80) || "missing Jump button",
      rationale:
        "Header chrome may open the command palette, but it must not present Explore as an ambiguous button. Explore belongs in route navigation.",
    });
  }

  return findings;
}

/**
 * Check dashboard route files for shared-shell consistency. Redirect-only
 * aliases and full-screen browser-stream surfaces are explicit exceptions; all
 * normal owner route pages and loading states should use the same Recordroom
 * shell.
 *
 * @param {object} args
 * @param {ReadonlyArray<{path:string,src:string}>} args.files
 * @param {ReadonlyArray<string>} args.fullScreenExceptions
 * @returns {Array} findings
 */
export function checkDashboardRouteShellContract({ files, fullScreenExceptions = [] }) {
  const findings = [];
  const exceptionSet = new Set(fullScreenExceptions);

  for (const file of files) {
    const cleaned = stripComments(file.src);
    const isRouteFile = /\/(?:page|loading)\.tsx$/.test(file.path);
    if (!isRouteFile) {
      continue;
    }

    if (/\bDashboardShell\b/.test(cleaned)) {
      findings.push({
        ruleId: "legacy-dashboard-shell-route",
        class: "shell-navigation-contract",
        path: file.path,
        line: lineOf(cleaned, cleaned.search(/\bDashboardShell\b/)),
        excerpt: "DashboardShell",
        rationale:
          "Normal console routes must not reintroduce the legacy dashboard shell/top-nav path. Use RecordroomShellWithPalette for shared navigation.",
      });
    }

    if (exceptionSet.has(file.path) || isRedirectOnlyRoute(cleaned)) {
      continue;
    }

    if (!/\bRecordroomShellWithPalette\b/.test(cleaned)) {
      findings.push({
        ruleId: "dashboard-route-missing-recordroom-shell",
        class: "shell-navigation-contract",
        path: file.path,
        line: 0,
        excerpt: "RecordroomShellWithPalette missing",
        rationale:
          "Normal dashboard pages and loading states must render inside the shared Recordroom shell so navigation and chrome stay consistent across the owner journey.",
      });
    }
  }

  return findings;
}

function quotedLiteralPattern(value) {
  return `["']${escapeRegExp(value)}["']`;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isRedirectOnlyRoute(src) {
  return (
    /\b(?:redirect|permanentRedirect)\s*\(/.test(src) &&
    !/<RecordroomShellWithPalette\b/.test(src) &&
    !/<main\b/.test(src) &&
    !/<section\b/.test(src) &&
    !/<div\b/.test(src)
  );
}

// ── small text helpers ─────────────────────────────────────────────────────

/** 1-based line number of a character offset. */
export function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** A short single-line excerpt around an offset, for report readability. */
export function excerptAround(text, index, radius = 50) {
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + radius);
  return text
    .slice(start, end)
    .replace(/\s+/g, " ")
    .trim();
}
