// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export type BoundedReadPattern = "readFile" | "readFileSync" | "all";

export interface BoundedReadException {
  readonly connector: string;
  readonly file: string;
  readonly lineIncludes: string;
  readonly pattern: BoundedReadPattern;
  readonly reason: string;
}

export interface BoundedReadFinding {
  readonly connector: string;
  readonly file: string;
  readonly line: number;
  readonly pattern: BoundedReadPattern;
  readonly text: string;
}

export const BOUNDED_READ_EXCEPTIONS: readonly BoundedReadException[] = [
  {
    connector: "google_maps",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: 'import { readdir, readFile } from "node:fs/promises";',
    reason: "Imports readFile for the reviewed single-artifact Timeline JSON read below.",
  },
  {
    connector: "google_maps",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: 'JSON.parse(await readFile(path, "utf8"))',
    reason: "Reads one Timeline JSON artifact. Keep reviewed until a streaming JSON parser tranche lands.",
  },
  {
    connector: "google_takeout",
    file: "parsers.ts",
    pattern: "readFile",
    lineIncludes: 'import { readFile } from "node:fs/promises";',
    reason: "Imports readFile for reviewed Takeout JSON sidecar reads below.",
  },
  {
    connector: "google_takeout",
    file: "parsers.ts",
    pattern: "readFile",
    lineIncludes: 'JSON.parse(await readFile(path, "utf8"))',
    reason: "Reads one Takeout JSON sidecar per call; streaming migration is deferred until large fixtures justify it.",
  },
  {
    connector: "ical",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: 'import { readdir, readFile } from "node:fs/promises";',
    reason: "Imports readFile for reviewed per-calendar ICS reads below.",
  },
  {
    connector: "ical",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: 'await readFile(join(dir, f), "utf8")',
    reason:
      "Reads each ICS calendar file as a per-artifact input. Keep reviewed until a large-calendar fixture proves risk.",
  },
  {
    connector: "slack",
    file: "index.ts",
    pattern: "all",
    lineIncludes: "return db.prepare(sql).all() as T[];",
    reason:
      "Reviewed safeAll helper for bounded lookup tables such as workspace, users, channels, files, and canvases. The unbounded MESSAGE table now uses iterateMessageRows.",
  },
  {
    connector: "whatsapp",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: 'import { readdir, readFile } from "node:fs/promises";',
    reason: "Imports readFile for reviewed per-export chat text reads below.",
  },
  {
    connector: "whatsapp",
    file: "index.ts",
    pattern: "readFile",
    lineIncludes: "const content = await readFile(fileName).catch((): Buffer => Buffer.alloc(0));",
    reason: "Reads one WhatsApp chat export file. Keep reviewed until large-export line streaming is implemented.",
  },
];

interface PatternMatcher {
  readonly pattern: BoundedReadPattern;
  readonly test: (line: string) => boolean;
}

const READ_FILE_CALL = /\bawait\s+readFile\s*\(/;
const READ_FILE_IMPORT = /import\s+\{[^}]*\breadFile\b[^}]*\}\s+from\s+["']node:fs\/promises["']/;
const READ_FILE_SYNC = /\breadFileSync\s*\(/;
const DOT_ALL = /\.all\s*\(/;
const MANIFEST_JSON_SUFFIX = /\.json$/;

const MATCHERS: readonly PatternMatcher[] = [
  { pattern: "readFile", test: (line) => READ_FILE_CALL.test(line) || READ_FILE_IMPORT.test(line) },
  { pattern: "readFileSync", test: (line) => READ_FILE_SYNC.test(line) },
  { pattern: "all", test: (line) => DOT_ALL.test(line) },
];

export const EXPLICIT_LOCAL_CLASS_CONNECTORS: readonly string[] = [];

function packageRoot(): string {
  return fileURLToPath(new URL("..", import.meta.url));
}

export function discoverLocalSourceConnectors(root: string = packageRoot()): string[] {
  const manifestsDir = new URL("manifests/", new URL(`${root}/`, "file:"));
  const discovered = new Set<string>(EXPLICIT_LOCAL_CLASS_CONNECTORS);
  for (const entry of readdirSync(manifestsDir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    const manifest = JSON.parse(readFileSync(new URL(entry, manifestsDir), "utf8")) as unknown;
    if (declaresFilesystemBinding(manifest)) {
      discovered.add(entry.replace(MANIFEST_JSON_SUFFIX, ""));
    }
  }
  return [...discovered].sort();
}

function declaresFilesystemBinding(manifest: unknown): boolean {
  if (typeof manifest !== "object" || manifest === null) {
    return false;
  }
  const runtimeRequirements = (manifest as { runtime_requirements?: unknown }).runtime_requirements;
  if (typeof runtimeRequirements !== "object" || runtimeRequirements === null) {
    return false;
  }
  const bindings = (runtimeRequirements as { bindings?: unknown }).bindings;
  if (typeof bindings !== "object" || bindings === null) {
    return false;
  }
  const filesystem = (bindings as { filesystem?: unknown }).filesystem;
  return (
    typeof filesystem === "object" && filesystem !== null && (filesystem as { required?: unknown }).required === true
  );
}

function connectorSourceFiles(connectorDir: URL): string[] {
  return readdirSync(connectorDir).filter(
    (file) => file.endsWith(".ts") && !file.includes(".test.") && !file.includes(".fixture.")
  );
}

function stripComments(lines: readonly string[]): string[] {
  let inBlock = false;
  return lines.map((line) => {
    let out = "";
    for (let i = 0; i < line.length; i++) {
      const pair = line.slice(i, i + 2);
      if (inBlock) {
        if (pair === "*/") {
          inBlock = false;
          i++;
        }
        continue;
      }
      if (pair === "/*") {
        inBlock = true;
        i++;
        continue;
      }
      if (pair === "//") {
        break;
      }
      out += line[i];
    }
    return out;
  });
}

function isAllowed(
  exceptions: readonly BoundedReadException[],
  connector: string,
  file: string,
  pattern: BoundedReadPattern,
  rawLine: string
): boolean {
  return exceptions.some(
    (exception) =>
      exception.connector === connector &&
      exception.file === file &&
      exception.pattern === pattern &&
      rawLine.includes(exception.lineIncludes)
  );
}

export interface FindUnapprovedBoundedReadsOptions {
  readonly exceptions?: readonly BoundedReadException[];
  readonly root?: string;
}

export function findUnapprovedBoundedReads(options: FindUnapprovedBoundedReadsOptions = {}): BoundedReadFinding[] {
  const root = options.root ?? packageRoot();
  const connectorsRoot = new URL("connectors/", new URL(`${root}/`, "file:"));
  const exceptions = options.exceptions ?? BOUNDED_READ_EXCEPTIONS;
  const findings: BoundedReadFinding[] = [];

  for (const connector of discoverLocalSourceConnectors(root)) {
    const connectorDir = new URL(`${connector}/`, connectorsRoot);
    for (const file of connectorSourceFiles(connectorDir)) {
      const rawLines = readFileSync(new URL(file, connectorDir), "utf8").split("\n");
      const codeLines = stripComments(rawLines);
      codeLines.forEach((line, index) => {
        for (const matcher of MATCHERS) {
          if (matcher.test(line) && !isAllowed(exceptions, connector, file, matcher.pattern, rawLines[index] ?? "")) {
            findings.push({
              connector,
              file,
              line: index + 1,
              pattern: matcher.pattern,
              text: (rawLines[index] ?? "").trim(),
            });
          }
        }
      });
    }
  }

  return findings;
}
