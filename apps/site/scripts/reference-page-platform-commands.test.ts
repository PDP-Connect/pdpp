// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Copy-paste correctness of the setup commands, per platform.
 *
 * The friend-facing commands are POSIX shell. On Windows PowerShell the same
 * text is not merely awkward, it is a syntax error or silently wrong:
 *   - `\` at end of line is not a continuation (PowerShell uses a backtick),
 *     so a multi-line block runs as separate broken commands.
 *   - `$(...)` is command substitution in POSIX but a subexpression whose
 *     output PowerShell does not interpolate into a single-quoted string.
 *   - `openssl` is not present on a default Windows install.
 *   - `>` redirection writes UTF-16LE by default, which `docker compose`
 *     cannot parse as a `.env` file.
 * Two layers: static probes assert that any POSIX-only construct shipped to
 * friends is accompanied by a PowerShell equivalent and that the equivalent is
 * not itself POSIX-shaped; then, when a `pwsh` interpreter is available, the
 * documented Windows block is EXECUTED and its output checked, so the Windows
 * claim rests on a real run rather than on inspection.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REFERENCE_PAGE = new URL("../src/app/reference/page.tsx", import.meta.url);
const DOCKER_RUNBOOK = new URL("../../../deploy/docker/README.md", import.meta.url);
const QUICKSTART = new URL("../../../docs/operator/selfhost-quickstart.md", import.meta.url);

// Constructs that do not survive a copy-paste into PowerShell.
const POSIX_ONLY_CONSTRUCTS: readonly (readonly [string, RegExp])[] = [
  ["backslash line continuation", /\\\n/],
  ["POSIX command substitution", /\$\(/],
  ["openssl invocation", /\bopenssl\s+rand\b/],
];

// A doc that ships POSIX-only setup commands must name PowerShell somewhere,
// so a Windows reader is not left running a command that cannot work.
const POWERSHELL_MARKER = /PowerShell/i;
const POWERSHELL_BLOCK_RE = /```powershell\n([\s\S]*?)```/g;
const BACKSLASH_LINE_RE = /\\\n/;
const OPENSSL_RE = /\bopenssl\s+rand\b/;
const POSIX_SUBSHELL_RE = /\$\(/;
const ENV_FILE_RE = /\.env\b/;
const POWERSHELL_ENCODING_RE = /-Encoding\s+(ascii|utf8NoBOM|utf8)/i;
const NEWLINE_RE = /\r?\n/;
const HEX_KEY_RE = /^[0-9a-f]{64}$/;

const PLATFORM_DOCS = [
  ["Docker runbook", DOCKER_RUNBOOK],
  ["self-host quickstart", QUICKSTART],
] as const;

function read(url: URL): Promise<string> {
  return readFile(fileURLToPath(url), "utf8");
}

test("docs shipping POSIX-only setup commands also address PowerShell", async () => {
  const sources = await Promise.all(
    [...PLATFORM_DOCS, ["public reference page", REFERENCE_PAGE] as const].map(
      async ([label, url]) => [label, await read(url)] as const
    )
  );
  for (const [label, source] of sources) {
    const posixOnly = POSIX_ONLY_CONSTRUCTS.filter(([, re]) => re.test(source)).map(([name]) => name);
    if (!posixOnly.length) {
      continue;
    }
    assert.match(
      source,
      POWERSHELL_MARKER,
      `${label} ships POSIX-only constructs (${posixOnly.join(", ")}) but never mentions PowerShell, so a Windows reader gets a broken copy-paste`
    );
  }
});

// The PowerShell variant must not itself contain the POSIX constructs it
// exists to replace — a "Windows" block that still uses `\` and `$(openssl)`
// is worse than none, because it looks authoritative.
test("a PowerShell block does not carry POSIX-only syntax", async () => {
  const sources = await Promise.all(PLATFORM_DOCS.map(async ([label, url]) => [label, await read(url)] as const));
  for (const [label, source] of sources) {
    for (const block of source.matchAll(POWERSHELL_BLOCK_RE)) {
      const body = block[1] ?? "";
      assert.doesNotMatch(body, BACKSLASH_LINE_RE, `${label} PowerShell block uses a backslash line continuation`);
      assert.doesNotMatch(body, OPENSSL_RE, `${label} PowerShell block calls openssl`);
      assert.doesNotMatch(body, POSIX_SUBSHELL_RE, `${label} PowerShell block uses POSIX command substitution`);
    }
  }
});

// PowerShell's `>` and `Out-File` default to UTF-16LE, which docker compose
// cannot read as a .env file. Any PowerShell block writing .env must pin the
// encoding explicitly.
test("PowerShell blocks writing .env pin a docker-readable encoding", async () => {
  const sources = await Promise.all(PLATFORM_DOCS.map(async ([label, url]) => [label, await read(url)] as const));
  for (const [label, source] of sources) {
    for (const block of source.matchAll(POWERSHELL_BLOCK_RE)) {
      const body = block[1] ?? "";
      if (!ENV_FILE_RE.test(body)) {
        continue;
      }
      assert.match(
        body,
        POWERSHELL_ENCODING_RE,
        `${label} PowerShell block writes .env without pinning an encoding; PowerShell defaults to UTF-16LE which docker compose cannot parse`
      );
    }
  }
});

// Executable probe. When a PowerShell interpreter is present we do not merely
// lint the documented Windows block — we RUN the exact secret-generation and
// .env-writing code from the runbook and assert it produces a docker-readable
// file with the same secret shapes the POSIX `openssl` commands produce.
// Skipped (not silently passed) when pwsh is unavailable.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function powershellAvailable(): boolean {
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", "$PSVersionTable.PSVersion.Major"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

// Extract the documented block so the test cannot drift from the runbook.
async function documentedPowershellSecretBlock(): Promise<string> {
  const source = await read(DOCKER_RUNBOOK);
  const block = [...source.matchAll(POWERSHELL_BLOCK_RE)]
    .map((match) => match[1] ?? "")
    .find((body) => body.includes("PDPP_CREDENTIAL_ENCRYPTION_KEY"));
  assert.ok(block, "Docker runbook must document a PowerShell block that writes the credential secrets");
  // Drop the two lines that reach the network / change directory; we are
  // proving the secret + encoding semantics, not re-downloading compose.
  return block
    .split("\n")
    .filter((line) => !(line.startsWith("mkdir ") || line.startsWith("curl.exe ") || line.startsWith("docker ")))
    .join("\n");
}

// Step 1's fetch commands use `curl`/`curl.exe`, `mkdir`, and `cd` — none of
// which are POSIX-only constructs the generic oracle above flags — so
// nothing else in this file forces a PowerShell mate to exist there. Pin it
// explicitly: a Windows reader following step 1 of the quickstart must not
// be left with only the sh block and a prose pointer.
const RELEASED_BUNDLE_URL = "https://github.com/PDP-Connect/pdpp/releases/latest/download/docker-compose.yml";
const STEP1_SH_FETCH_RE = new RegExp(
  `\`\`\`sh\\nmkdir pdpp && cd pdpp\\ncurl -fsSLO ${RELEASED_BUNDLE_URL.replace(/[/.]/g, "\\$&")}\\n\`\`\``
);
const STEP1_POWERSHELL_FETCH_RE = new RegExp(
  `\`\`\`powershell\\nmkdir pdpp; cd pdpp\\ncurl\\.exe -fsSLO ${RELEASED_BUNDLE_URL.replace(/[/.]/g, "\\$&")}\\n\`\`\``
);

test("quickstart step 1 ships an executable PowerShell fetch block with the same stable release URL as the sh block", async () => {
  const source = await read(QUICKSTART);
  assert.match(
    source,
    STEP1_SH_FETCH_RE,
    "quickstart step 1 must keep its sh fetch block in the exact pinned shape this test expects"
  );
  assert.match(
    source,
    STEP1_POWERSHELL_FETCH_RE,
    "quickstart step 1 must ship a directly-executable PowerShell fetch block (mkdir; cd; curl.exe -fsSLO <same pinned URL>), not prose telling the reader to substitute curl.exe themselves"
  );
});

test("documented PowerShell block really writes a docker-readable .env", { skip: !powershellAvailable() }, async () => {
  const script = await documentedPowershellSecretBlock();
  const dir = mkdtempSync(join(tmpdir(), "pdpp-ps-"));
  try {
    execFileSync("pwsh", ["-NoProfile", "-Command", script], { cwd: dir, stdio: "pipe" });
    const raw = readFileSync(join(dir, ".env"));
    // UTF-16LE would put a NUL between every ASCII character; docker compose
    // cannot parse that. This is the actual Windows failure mode.
    assert.equal(raw.includes(0x00), false, ".env must not be UTF-16LE encoded");
    const env = new Map(
      raw
        .toString("utf8")
        .split(NEWLINE_RE)
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("=");
          return [line.slice(0, at), line.slice(at + 1)] as const;
        })
    );
    // `openssl rand -base64 24` -> 32 base64 chars; `-hex 32` -> 64 hex chars.
    assert.equal(env.get("PDPP_OWNER_PASSWORD")?.length, 32, "owner password must match `openssl rand -base64 24`");
    assert.match(
      env.get("PDPP_CREDENTIAL_ENCRYPTION_KEY") ?? "",
      HEX_KEY_RE,
      "encryption key must match `openssl rand -hex 32`"
    );
    assert.ok(env.get("PDPP_REFERENCE_ORIGIN"), "origin must be written");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
