// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, extname, join, relative } from "node:path";
import { promisify } from "node:util";
// biome-ignore lint/correctness/noUnresolvedImports: Biome does not follow this package's export map.
import { parse } from "@babel/parser";

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".next",
  ".turbo",
  ".tmp",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);
const PACKAGE_NAME = "package.json";
const WORKFLOW_DIRECTORY = ".github/workflows";
const OWNER_COMMAND = "test-scratch/run-command.ts";
const ROOT_OWNER_COMMAND = "test:scratch";
const RAW_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const ROOT_REVIEWED_NON_TEST_SCRIPTS = new Set(["test-accounting:inventory", "friend-journey:acceptance"]);
const TMP_PATH = /\/tmp/;
const WHITESPACE = /\s/;
const ROOT_HOST_ALIAS = /(?:^|:)(?:smoke|acceptance)(?::|$)/;
const SHELL_COMMENT = /(^|\s)#.*$/;
const SHELL_REDIRECTION = /(?:^|\s)>>?\s*["']?[^\s"']*\/tmp/;
const WORKFLOW_RUN = /^(\s*)(?:-\s+)?run:\s*(.*)$/;
const LEADING_WHITESPACE = /^\s*/;
const QUOTED_SCALAR = /^("|')(.*)\1$/;
const SHELL_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const execFileAsync = promisify(execFile);
const WRITER_NAMES = new Set([
  "appendFile",
  "appendFileSync",
  "copyFile",
  "copyFileSync",
  "createWriteStream",
  "mkdir",
  "mkdirSync",
  "mkdtemp",
  "mkdtempSync",
  "open",
  "rename",
  "renameSync",
  "rm",
  "rmSync",
  "writeFile",
  "writeFileSync",
]);
const SOURCE_EXTENSIONS = new Set([".cjs", ".cts", ".js", ".jsx", ".mjs", ".mts", ".sh", ".ts", ".tsx"]);

export interface RatchetFinding {
  path: string;
  reason: string;
}

interface ReviewedWriterException {
  path: string;
  reason: string;
  source: RegExp;
}

const REVIEWED_WRITER_EXCEPTIONS: readonly ReviewedWriterException[] = [
  {
    path: "scripts/docker-neko-dynamic-allocator-smoke-config.mjs",
    reason: "direct invocation fallback; canonical runs provide the owner root",
    source: /env\.PDPP_TEST_SCRATCH_ROOT \?\? env\.TMPDIR \?\? "\/tmp"/,
  },
  {
    path: "scripts/docker-neko-network-durability-smoke.sh",
    reason: "direct invocation fallback; canonical runs provide the owner root",
    source: /PDPP_TEST_SCRATCH_ROOT:-\$\{TMPDIR:-\/tmp\}/,
  },
  {
    path: "scripts/docker-neko-network-migration-smoke.sh",
    reason: "direct invocation fallback; canonical runs provide the owner root",
    source: /PDPP_TEST_SCRATCH_ROOT:-\$\{TMPDIR:-\/tmp\}/,
  },
  {
    path: "scripts/docker-neko-dynamic-allocator-smoke.sh",
    reason: "stable cross-run flock coordination state",
    source: /PDPP_NEKO_DYNAMIC_SMOKE_PORT_LOCK_FILE:-\/tmp\/pdpp-neko-dynamic-smoke-ports\.lock/,
  },
  {
    path: "scripts/docker-smoke.sh",
    reason: "container-internal database path",
    source: /PDPP_DB_PATH:-\/tmp\/pdpp-smoke\.sqlite/,
  },
  {
    path: "scripts/core-headed-patchright-runtime-oracle.ts",
    reason: "container X11 socket path",
    source: /`\/tmp\/\.X11-unix\/X\$\{display\.slice\(1\)\}`/,
  },
  {
    path: "docker/neko/install-patchright-chromium.sh",
    reason: "container build scratch path",
    source: /mktemp \/tmp\/patchright-chromium-/,
  },
  {
    path: "packages/polyfill-connectors/src/connector-runtime.ts",
    reason: "production trace fallback outside canonical test ownership",
    source: /`\/tmp\/\$\{traceName\}\.zip`/,
  },
  {
    path: "packages/polyfill-connectors/bin/amazon-request-export.ts",
    reason: "production CLI output default outside canonical test ownership",
    source: /const outDir = "\/tmp"/,
  },
  {
    path: "docs/explorer/uat/harness/capture.ts",
    reason: "standalone UAT capture output outside canonical entrypoints",
    source: /"\/tmp\/explorer-uat-out"/,
  },
];

async function filesBelow(root: string, directory = ""): Promise<string[]> {
  const absoluteDirectory = join(root, directory);
  const entries = await readdir(absoluteDirectory, { withFileTypes: true }).catch(() => []);
  const nested = await Promise.all(
    entries.map((entry): Promise<string[]> => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        return IGNORED_DIRECTORIES.has(entry.name) ? [] : filesBelow(root, path);
      }
      return entry.isFile() ? [path] : [];
    })
  );
  return nested.flat();
}

async function repositoryFiles(root: string): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" });
    return stdout
      .split("\0")
      .filter((path) => path.length > 0)
      .filter((path) => !path.split("/").some((part) => IGNORED_DIRECTORIES.has(part)));
  } catch {
    // Mutation fixtures are intentionally not Git repositories; scan their complete small tree.
    return filesBelow(root);
  }
}

function shellTokenSegments(command: string): string[][] {
  const segments: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = () => {
    if (token) {
      tokens.push(token);
      token = "";
    }
  };
  const endSegment = () => {
    push();
    if (tokens.length > 0) {
      segments.push(tokens);
      tokens = [];
    }
  };
  for (const character of command) {
    if (escaped) {
      token += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        token += character;
      }
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (WHITESPACE.test(character)) {
      push();
    } else if (";|&".includes(character)) {
      endSegment();
    } else {
      token += character;
    }
  }
  endSegment();
  return segments;
}

function shellTokens(command: string): string[] {
  return shellTokenSegments(command).flat();
}

function commandBasename(token: string): string {
  return token.replaceAll("\\", "/").split("/").at(-1) ?? token;
}

const SHELL_WRAPPER_ARGUMENTS: Readonly<Record<string, ReadonlySet<string>>> = {
  env: new Set(["-u", "--unset"]),
  command: new Set(),
  sudo: new Set(["-a", "-C", "-D", "-g", "-h", "-p", "-R", "-r", "-t", "-U", "-u"]),
};

function isShellAssignment(token: string): boolean {
  return SHELL_ASSIGNMENT.test(token);
}

function skipShellAssignments(tokens: readonly string[], start: number): number {
  let index = start;
  while (index < tokens.length && isShellAssignment(tokens[index] ?? "")) {
    index += 1;
  }
  return index;
}

function shellWrapperCommandIndex(
  tokens: readonly string[],
  start: number,
  wrapper: string,
  optionArguments: ReadonlySet<string>
): number {
  let index = start;
  while (index < tokens.length) {
    const token = tokens[index] ?? "";
    if (token === "--") {
      return index + 1;
    }
    if (isShellAssignment(token) && (wrapper === "env" || wrapper === "sudo")) {
      index += 1;
      continue;
    }
    if (!token.startsWith("-") || token === "-") {
      return index;
    }
    const option = token.includes("=") ? token.slice(0, token.indexOf("=")) : token;
    index += optionArguments.has(option) && !token.includes("=") ? 2 : 1;
  }
  return index;
}

function shellCommandToken(tokens: readonly string[]): string | undefined {
  let index = 0;
  while (index < tokens.length) {
    index = skipShellAssignments(tokens, index);
    const wrapper = commandBasename(tokens[index] ?? "");
    const optionArguments = SHELL_WRAPPER_ARGUMENTS[wrapper];
    if (!optionArguments) {
      return tokens[index];
    }
    index = shellWrapperCommandIndex(tokens, index + 1, wrapper, optionArguments);
  }
}

function isRawTestCommand(command: string): boolean {
  const tokens = shellTokens(command);
  const hasNodeTest = tokens.some((token) => commandBasename(token) === "node") && tokens.includes("--test");
  const hasTsxTest =
    tokens.some((token) => commandBasename(token) === "tsx") && tokens.some((token) => RAW_TEST_FILE.test(token));
  const hasShellTest =
    tokens.some((token) => ["bash", "sh"].includes(commandBasename(token))) &&
    tokens.some((token) => token.endsWith(".test.sh")) &&
    !tokens.includes("-n");
  return hasNodeTest || hasTsxTest || hasShellTest;
}

function hasOwnerInvocation(command: string): boolean {
  return shellTokens(command).some(
    (token) => token === ROOT_OWNER_COMMAND || token === OWNER_COMMAND || token.endsWith(`/${OWNER_COMMAND}`)
  );
}

function referencesTestScript(command: string): boolean {
  return shellTokens(command).some((token) => token === "test" || token.startsWith("test:"));
}

function isPackageFrontDoor(name: string, command: string): boolean {
  if (name === "test" || name.startsWith("test:") || isRawTestCommand(command)) {
    return true;
  }
  return (
    (name === "verify" || name.startsWith("verify:")) && (referencesTestScript(command) || isRawTestCommand(command))
  );
}

function isRootFrontDoor(name: string, command: string): boolean {
  if (name === "test:scratch" || ROOT_REVIEWED_NON_TEST_SCRIPTS.has(name)) {
    return name === "test:scratch";
  }
  if (
    name === "reference-implementation:test" ||
    name.endsWith(":test") ||
    (name.startsWith("test-accounting:") && name !== "test-accounting:inventory") ||
    isRawTestCommand(command)
  ) {
    return true;
  }
  const isSupportedHostWriterAlias =
    ROOT_HOST_ALIAS.test(name) || name.endsWith(":verify") || name.endsWith(":no-human-verify");
  return isSupportedHostWriterAlias;
}

function isOwnerRouted(command: string): boolean {
  return hasOwnerInvocation(command);
}

function isReviewedRootDelegate(path: string, name: string, command: string): boolean {
  return (
    path === PACKAGE_NAME &&
    name === "reference-implementation:test" &&
    command === "pnpm --dir reference-implementation run test"
  );
}

async function packageFindings(root: string, files: readonly string[]): Promise<RatchetFinding[]> {
  return (
    await Promise.all(
      files
        .filter((file) => basename(file) === PACKAGE_NAME)
        .map(async (path) => {
          const packageJson = JSON.parse(await readFile(join(root, path), "utf8")) as {
            scripts?: Record<string, string>;
          };
          const isRoot = path === PACKAGE_NAME;
          return Object.entries(packageJson.scripts ?? {}).flatMap(([name, command]) => {
            const frontDoor = isRoot ? isRootFrontDoor(name, command) : isPackageFrontDoor(name, command);
            const verifyDelegatesToTest =
              !isRoot && (name === "verify" || name.startsWith("verify:")) && referencesTestScript(command);
            const allowed =
              isOwnerRouted(command) || isReviewedRootDelegate(path, name, command) || verifyDelegatesToTest;
            return frontDoor && !allowed ? [{ path, reason: `package script ${name} bypasses the scratch owner` }] : [];
          });
        })
    )
  ).flat();
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: the bounded YAML block-scalar state machine keeps workflow parsing mechanical.
function workflowRuns(source: string, path: string): string[] {
  const lines = source.split("\n");
  const runs: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = WORKFLOW_RUN.exec(lines[index] ?? "");
    if (!match) {
      continue;
    }
    const indent = match[1]?.length ?? 0;
    const inline = match[2] ?? "";
    if (inline === "|" || inline === ">" || inline === "|-" || inline === ">-") {
      const block: string[] = [];
      for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next] ?? "";
        const lineIndent = line.match(LEADING_WHITESPACE)?.[0]?.length ?? 0;
        if (line.trim() !== "" && lineIndent <= indent) {
          break;
        }
        block.push(line.slice(Math.min(line.length, indent + 2)));
        index = next;
      }
      runs.push(block.join("\n"));
    } else if (inline) {
      runs.push(inline.replace(QUOTED_SCALAR, "$2"));
    } else {
      throw new Error(`workflow run has no command: ${path}:${index + 1}`);
    }
  }
  return runs;
}

async function workflowFindings(root: string, files: readonly string[]): Promise<RatchetFinding[]> {
  const workflowFiles = files.filter((file) => {
    const extension = extname(file);
    return dirnameOf(file) === WORKFLOW_DIRECTORY && (extension === ".yaml" || extension === ".yml");
  });
  return (
    await Promise.all(
      workflowFiles.map(async (path) => {
        const source = await readFile(join(root, path), "utf8");
        return workflowRuns(source, path).flatMap((run) =>
          isRawTestCommand(run) && !isOwnerRouted(run)
            ? [{ path, reason: `workflow run bypasses the scratch owner: ${singleLine(run)}` }]
            : []
        );
      })
    )
  ).flat();
}

function dirnameOf(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function singleLine(value: string): string {
  return value.replaceAll(/\s+/g, " ").trim();
}

function calleeName(expression: { type?: string; name?: string; property?: { name?: string } }): string | undefined {
  if (expression.type === "Identifier") {
    return expression.name;
  }
  if (expression.type === "MemberExpression" || expression.type === "OptionalMemberExpression") {
    return expression.property?.name;
  }
}

function literalValue(node?: {
  type?: string;
  value?: unknown;
  expressions?: unknown[];
  quasis?: Array<{ value?: { cooked?: string | null } }>;
}): string | undefined {
  if (!node) {
    return;
  }
  if (node.type === "StringLiteral" && typeof node.value === "string") {
    return node.value;
  }
  if (node.type === "TemplateLiteral") {
    return node.quasis?.map((quasi) => quasi.value?.cooked ?? "").join("") ?? undefined;
  }
}

function pathArgumentIndexes(name: string): readonly number[] {
  return name === "copyFile" || name === "copyFileSync" || name === "rename" || name === "renameSync" ? [0, 1] : [0];
}

function sourceWriterLiterals(source: string, path: string): string[] {
  const plugins = path.endsWith("x") ? ["jsx", "typescript"] : ["typescript"];
  const file = parse(source, { plugins, sourceType: "unambiguous" });
  const values: string[] = [];
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: a parser AST has a heterogeneous recursive shape.
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") {
      return;
    }
    const typed = node as { type?: string; callee?: unknown; arguments?: unknown[] };
    if (typed.type === "CallExpression" || typed.type === "OptionalCallExpression") {
      const name = calleeName(typed.callee as Parameters<typeof calleeName>[0]);
      if (name && WRITER_NAMES.has(name)) {
        for (const index of pathArgumentIndexes(name)) {
          const argument = typed.arguments?.[index];
          const value = literalValue(argument as Parameters<typeof literalValue>[0]);
          if (value?.includes("/tmp")) {
            values.push(value);
          }
        }
      }
    }
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) {
        for (const item of value) {
          visit(item);
        }
      } else {
        visit(value);
      }
    }
  };
  visit(file.program);
  return values;
}

function shellWriterLiterals(source: string): string[] {
  return source.split("\n").flatMap((line) => {
    const code = line.replace(SHELL_COMMENT, "");
    if (!TMP_PATH.test(code)) {
      return [];
    }
    const commandWriter = new Set(["cp", "install", "mkdir", "mktemp", "mv", "rm", "tee", "touch"]);
    const hasCommandWriter = shellTokenSegments(code).some((tokens) => {
      const command = commandBasename(shellCommandToken(tokens) ?? "");
      return commandWriter.has(command) && tokens.some((token) => token.includes("/tmp"));
    });
    const hasRedirection = SHELL_REDIRECTION.test(code);
    return hasCommandWriter || hasRedirection ? [code.trim()] : [];
  });
}

function maskReviewedWriterExceptions(path: string, source: string): string {
  return REVIEWED_WRITER_EXCEPTIONS.filter((exception) => exception.path === path).reduce(
    (masked, exception) => masked.replace(exception.source, '"reviewed-writer-exception"'),
    source
  );
}

async function hostWriterFindings(root: string, files: readonly string[]): Promise<RatchetFinding[]> {
  return (
    await Promise.all(
      files
        .filter((file) => SOURCE_EXTENSIONS.has(extname(file)) && !file.endsWith(".d.ts"))
        .map(async (path) => {
          const source = await readFile(join(root, path), "utf8");
          const unreviewedSource = maskReviewedWriterExceptions(path, source);
          const values =
            extname(path) === ".sh"
              ? shellWriterLiterals(unreviewedSource)
              : sourceWriterLiterals(unreviewedSource, path);
          return values.length > 0
            ? [{ path, reason: `literal /tmp host writer: ${singleLine(values[0] ?? "")}` }]
            : [];
        })
    )
  ).flat();
}

/** Scan repository-derived package, workflow, and executable-writer inventories. */
export async function findCanonicalEntrypointBypasses(root: string): Promise<RatchetFinding[]> {
  const files = await repositoryFiles(root);
  const findings = await Promise.all([
    packageFindings(root, files),
    workflowFindings(root, files),
    hostWriterFindings(root, files),
  ]);
  return findings
    .flat()
    .sort((left, right) => `${left.path}:${left.reason}`.localeCompare(`${right.path}:${right.reason}`));
}

export function formatRatchetFindings(findings: readonly RatchetFinding[], root: string): string {
  return findings.map((finding) => `${relative(root, join(root, finding.path))}: ${finding.reason}`).join("\n");
}
