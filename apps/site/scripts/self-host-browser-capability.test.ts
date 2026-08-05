// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildCommand,
  commandText,
  defaultChoices,
  METHODS,
  type MethodId,
  PUBLIC_URL_PLACEHOLDER,
  type SelfHostChoices,
} from "../src/lib/self-host-command.ts";

// THE THING THAT STOPS US SHIPPING A COMMAND THAT LIES.
//
// A reader who comes to connect ChatGPT, Amazon or USAA needs a command that
// can launch a real browser. The default `reference` image ships none, so a
// command built on it starts cleanly and then fails at sign-in with
// "Executable doesn't exist at /opt/patchright-browsers/...".
//
// This asserts against `buildCommand()` — the same function the page renders
// from — rather than regexing page.tsx. The old version could only confirm a
// string appeared somewhere in the JSX; it could not confirm what a reader
// actually copies for a given set of choices, which is the thing that has to
// be true.
//
// VERIFIED BY EXECUTION 2026-08-05, and this is what the assertions encode:
//   reference-browser:main -> /opt/patchright-browsers/chromium-1217 present,
//     and present again inside the RUNNING container of a stack booted from
//     the emitted command
//   reference:main         -> no /opt/patchright-browsers directory at all
//   core:main, core-browser:main -> do not exist; manifest inspect 404s
//   railway-core:main      -> console + first-boot password, but no browser
//   raw.githubusercontent.com/.../deploy/docker/docker-compose.yml -> 200
//   github.com/.../releases/latest/download/docker-compose.yml     -> 404

const BROWSER_IMAGE = "reference-browser";
// Hoisted: these are compiled once rather than per assertion.
const IMAGE_OVERRIDE_RE = /PDPP_REFERENCE_IMAGE=\S*?pdpp\/(reference|reference-browser)(:|\s|$)/;
const REPO_RELATIVE_COMPOSE_RE = /-f\s+deploy\/docker/;
const UNPUBLISHED_ARTIFACT_RE = /pdpp\/core(-browser)?:/;
const PAGE = readFileSync(join(import.meta.dirname, "../src/app/self-host/page.tsx"), "utf8");

/** Every combination of choices the builder can produce. */
function allChoices(): SelfHostChoices[] {
  const combos: SelfHostChoices[] = [];
  for (const access of ["local", "public"] as const) {
    for (const semanticSearch of [true, false]) {
      combos.push({ ...defaultChoices, access, semanticSearch });
    }
  }
  return combos;
}

function shellCommands(): { method: MethodId; text: string }[] {
  const out: { method: MethodId; text: string }[] = [];
  for (const method of METHODS) {
    for (const choices of allChoices()) {
      const built = buildCommand(method.id, choices);
      if (built.segments) {
        out.push({ method: method.id, text: commandText(built.segments) });
      }
    }
  }
  return out;
}

test("every generated command selects the browser-capable image", () => {
  const commands = shellCommands();
  assert.ok(commands.length > 0, "no shell commands were generated at all");
  for (const { method, text } of commands) {
    assert.ok(
      text.includes(BROWSER_IMAGE),
      `"${method}" emits a command that never names ${BROWSER_IMAGE}, so browser-backed sources would fail at sign-in`
    );
  }
});

test("no generated command selects the browser-free image", () => {
  for (const { method, text } of shellCommands()) {
    const override = IMAGE_OVERRIDE_RE.exec(text);
    if (override) {
      assert.equal(
        override[1],
        BROWSER_IMAGE,
        `"${method}" sets the image to the browser-free build; browser connectors would fail at Patchright launch`
      );
    }
  }
});

test("a method with no shell command explains itself instead of emitting one", () => {
  for (const method of METHODS) {
    for (const choices of allChoices()) {
      const built = buildCommand(method.id, choices);
      const explains = typeof built.unavailable === "string" && built.unavailable.length > 0;
      assert.ok(
        Boolean(built.segments) !== explains,
        `"${method.id}" must produce exactly one of a command or an explanation, so a combination is never silently dropped`
      );
    }
  }
});

// THE DEFECT THIS REBUILD EXISTS TO FIX. The old Compose command was
// `docker compose -f deploy/docker/docker-compose.yml up -d` — a repo-relative
// path the reader does not have. Pasted into a fresh terminal it errors.
test("a compose command never depends on a file the reader does not have", () => {
  for (const { method, text } of shellCommands()) {
    if (!text.includes("docker compose")) {
      continue;
    }
    assert.ok(
      text.includes("curl -fsSLO ") || text.includes("git clone "),
      `"${method}" runs docker compose without first fetching or cloning the compose file, so it fails as copied`
    );
    assert.ok(
      !REPO_RELATIVE_COMPOSE_RE.test(text),
      `"${method}" passes a repo-relative compose path the reader has no copy of`
    );
  }
});

// Every release from v1.0.0 to v1.0.4 shipped ZERO assets, so this URL has
// never resolved. It is an easy and invisible mistake to reintroduce.
test("no command fetches a release asset, because no release has ever had one", () => {
  for (const { method, text } of shellCommands()) {
    assert.ok(
      !text.includes("releases/latest/download"),
      `"${method}" fetches a release asset; that URL 404s because no PDPP release has ever attached one`
    );
  }
});

test("no command names an artifact that does not exist", () => {
  for (const { method, text } of shellCommands()) {
    assert.ok(
      !UNPUBLISHED_ARTIFACT_RE.test(text),
      `"${method}" names pdpp/core or pdpp/core-browser, neither of which is published`
    );
  }
});

test("the public-access choice puts the reader's address into the command", () => {
  for (const method of METHODS) {
    const local = buildCommand(method.id, { ...defaultChoices, access: "local" });
    const publicDefault = buildCommand(method.id, { ...defaultChoices, access: "public" });
    if (!(local.segments && publicDefault.segments)) {
      continue;
    }
    assert.ok(
      !commandText(local.segments).includes("PDPP_REFERENCE_ORIGIN"),
      `"${method.id}" advertises a public origin even when the reader chose local-only`
    );
    assert.ok(
      commandText(publicDefault.segments).includes(PUBLIC_URL_PLACEHOLDER),
      `"${method.id}" does not carry a public address when the reader asked to be reachable`
    );

    const typed = buildCommand(method.id, {
      ...defaultChoices,
      access: "public",
      publicUrl: "https://example.test",
    });
    assert.ok(
      typed.segments && commandText(typed.segments).includes("https://example.test"),
      `"${method.id}" ignores the address the reader typed`
    );
  }
});

test("semantic search is on by default and only opted out of explicitly", () => {
  for (const method of METHODS) {
    const on = buildCommand(method.id, { ...defaultChoices, semanticSearch: true });
    const off = buildCommand(method.id, { ...defaultChoices, semanticSearch: false });
    if (!(on.segments && off.segments)) {
      continue;
    }
    assert.ok(
      !commandText(on.segments).includes("PDPP_EMBEDDING_DOWNLOAD_ALLOWED"),
      `"${method.id}" disables embeddings on the default path; semantic search is meant to be on`
    );
    assert.ok(
      commandText(off.segments).includes("PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0"),
      `"${method.id}" claims keyword-only but never turns the embedding download off`
    );
  }
  assert.equal(defaultChoices.semanticSearch, true, "semantic search must default to on");
  assert.equal(defaultChoices.access, "local", "access must default to this-machine-only");
});

// Persistence is never a choice: a data server that forgets on restart is not
// one. The compose stack carries it in named volumes.
test("every command persists data", () => {
  for (const { method, text } of shellCommands()) {
    assert.ok(text.includes("-v ") || text.includes("docker compose"), `"${method}" runs without persistent storage`);
  }
});

test("no command or copy exposes a platform-specific artifact name", () => {
  // Public artifact names are platform-neutral. `railway-core` is an internal
  // Docker target, and a reader who sees it learns a deployment provider's name
  // as if it were the product's. Comments are exempt; they explain why it exists.
  for (const { method, text } of shellCommands()) {
    assert.ok(!text.includes("railway-core"), `"${method}" emits the internal railway-core target name`);
  }
  const visible = PAGE.split("\n")
    .filter((line) => !line.trim().startsWith("//"))
    .join("\n");
  assert.ok(
    !visible.includes("railway-core"),
    "railway-core is an internal target name and must not appear in a command or in copy a reader sees"
  );
});

// The standing instruction is that outcomes are exposed and mechanism is not.
// These names leaking into the UI is the failure mode that instruction guards.
test("the builder never exposes implementation detail as a reader-facing choice", () => {
  const builder = readFileSync(join(import.meta.dirname, "../src/components/pdpp-concept/command-tabs.tsx"), "utf8");
  const visible = builder
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*"));
    })
    .join("\n");
  for (const banned of ["PDPP_NEKO", "PDPP_BROWSER_SURFACE", "COMPOSE_PROFILES", "neko", "patchright"]) {
    assert.ok(
      !visible.includes(banned),
      `the builder UI names "${banned}", which is an implementation detail a reader must never be asked about`
    );
  }
});
