// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

/**
 * Source-level oracle: no connector may compute a DURABLE artifact path from
 * the home directory.
 *
 * A `homedir()`-derived write target is invisible in unit tests (every
 * developer's `$HOME` is durable) and only fails in production, on the
 * documented deployment, at container-replacement time — which is exactly how
 * the Slack archive loss went unnoticed across nine real runs. So the gate is
 * a source scan rather than a behavioural test: it fires when the pattern is
 * written, not when a user loses data months later.
 *
 * The rule is about DURABLE state. Reads from a foreign tool's home
 * (`~/.codex`, `~/.claude`, `~/Library/Messages`) and human-owned import
 * drop-boxes are legitimately home-rooted — the user put those files there
 * and PDPP never writes them. Those connectors are listed below with the
 * reason each is exempt, so adding a new exemption is a deliberate, reviewed
 * act rather than a silent regression.
 */

import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONNECTORS_DIR = resolve(__dirname, "..", "connectors");

/**
 * Connectors allowed to reference `homedir()`, each with the reason. Every
 * entry is a READ of a location someone else owns — never a durable artifact
 * PDPP itself accumulates.
 */
const HOME_ROOTED_READ_EXEMPTIONS: Readonly<Record<string, string>> = {
  // Foreign tool homes — PDPP reads another program's files, never writes.
  codex: "reads ~/.codex (CODEX_HOME), a foreign tool's own directory",
  claude_code: "reads ~/.claude (CLAUDE_CODE_HOME), a foreign tool's own directory",
  imessage: "reads ~/Library/Messages, a macOS system location",
  // Human-owned drop-boxes — the user places an export here; PDPP reads it
  // once and never writes. Each already honours its own *_DIR override.
  whatsapp: "reads the user's WhatsApp export drop-box (WHATSAPP_EXPORT_DIR)",
  ical: "reads the user's iCal export drop-box (ICAL_IMPORT_DIR)",
  netflix_export: "reads the user's Netflix export drop-box (NETFLIX_EXPORT_DIR)",
  google_takeout: "reads the user's Takeout drop-box (GOOGLE_TAKEOUT_DIR)",
  google_maps: "reads the user's Maps timeline drop-box (GOOGLE_MAPS_TIMELINE_DIR)",
  twitter_archive: "reads the user's Twitter archive drop-box (TWITTER_ARCHIVE_DIR)",
  apple_health: "reads the user's Apple Health export drop-box (APPLE_HEALTH_EXPORT_DIR)",
  apple_photos: "reads the user's Apple Photos export drop-box (APPLE_PHOTOS_EXPORT_DIR)",
};

/** Every `<connectors>/<name>/*.ts` file that is not a test. */
function connectorSourceFiles(connector: string): string[] {
  const dir = join(CONNECTORS_DIR, connector);
  return readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts") && !entry.name.includes(".test."))
    .map((entry) => join(dir, entry.name));
}

function connectorNames(): string[] {
  return readdirSync(CONNECTORS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

test("no connector derives a durable artifact path from the home directory", () => {
  const offenders: string[] = [];
  for (const connector of connectorNames()) {
    if (connector in HOME_ROOTED_READ_EXEMPTIONS) {
      continue;
    }
    for (const file of connectorSourceFiles(connector)) {
      const source = readFileSync(file, "utf8");
      // Match the call, not the word: prose in a comment explaining why we no
      // longer use homedir() must not trip the gate.
      if (/\bhomedir\s*\(\s*\)/.test(source.replace(/^\s*(?:\/\/|\*).*$/gm, ""))) {
        offenders.push(`${connector}: ${file}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "These connectors compute a path from homedir(). Durable artifacts must use " +
      "resolveConnectorArtifactDir() from src/connector-artifact-root.ts so they land on the " +
      `deployment's persistent volume. If the path is a READ of a user- or foreign-tool-owned ` +
      `location, add it to HOME_ROOTED_READ_EXEMPTIONS with a reason.\n${offenders.join("\n")}`
  );
});

test("the connectors that write durable bulk artifacts route through the shared root", () => {
  // The three artifacts the owner's production instance actually accumulated:
  // the Slack archive, and the Chase/USAA statement PDFs that emitted records
  // reference by path. Each must name the shared resolver.
  const durableWriters: Readonly<Record<string, string>> = {
    slack: "index.ts",
    chase: "index.ts",
    usaa: "statement-pdfs.ts",
  };
  for (const [connector, file] of Object.entries(durableWriters)) {
    const source = readFileSync(join(CONNECTORS_DIR, connector, file), "utf8");
    assert.match(
      source,
      /resolveConnectorArtifactDir\(/,
      `${connector}/${file} writes a durable artifact but does not use resolveConnectorArtifactDir()`
    );
  }
});

test("every exemption names a connector that still exists", () => {
  // A stale exemption would silently excuse a connector that was renamed or
  // rewritten to write durable state.
  const present = new Set(connectorNames());
  for (const connector of Object.keys(HOME_ROOTED_READ_EXEMPTIONS)) {
    assert.ok(present.has(connector), `exemption names a missing connector: ${connector}`);
  }
});
