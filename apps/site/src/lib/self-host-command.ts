// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import { repoBlobUrl } from "@/components/pdpp-concept/site-facts.ts";

/**
 * The self-host command model.
 *
 * WHY THIS IS DATA AND NOT JSX. The previous builder encoded its commands as
 * JSX inside the page, so the only way to test them was to regex the source of
 * `page.tsx`. That test could confirm a string appeared; it could not confirm
 * the command a reader actually copies for a given set of choices. Every
 * command is now produced by `buildCommand()`, so the capability test asserts
 * against the same function the page renders from.
 *
 * WHAT A READER CHOOSES vs WHAT WE SET. The choices are OUTCOMES: who can
 * reach it, and whether search understands meaning. Which image tag, which env
 * var, which port, and which browser backend deliver those outcomes are
 * implementation details and never appear in the UI.
 *
 * BROWSER SUPPORT IS NOT A CHOICE. Every command selects the browser-capable
 * image. 14 of 33 connectors (Amazon, Anthropic, Chase, ChatGPT, DoorDash,
 * HEB, LinkedIn, Loom, Meta, Reddit, Shopify, Uber, USAA, Whole Foods) cannot
 * sign in without one, and a reader will not supply their own browser
 * container. It costs one image tag, so the default carries it and no row is
 * spent asking. Sign-ins that need a human are streamed to the dashboard so
 * the owner can watch and take over — that is the default path, not an
 * upgrade.
 *
 * EVERY COMMAND HERE WAS RUN, 2026-08-05. Full transcripts in BUILDER2.md:
 *   - the compose URL returns 200; `docker compose config` validates
 *   - the stack booted: postgres healthy, reference healthy, web serving,
 *     `/` 307 -> /owner/login, /.well-known/oauth-authorization-server 200,
 *     and /opt/patchright-browsers/chromium-1217 present INSIDE the running
 *     reference container
 *   - the public-origin variant advertises issuer https://pdpp.example.com
 *   - the keyword-only variant boots healthy with the download disabled
 *
 * AND WHAT FAILED, which is why there is no single-container tab:
 *   - reference-browser:main has Chromium but NO console — it listens only on
 *     7662/7663 and never serves port 3000. It also refuses to boot without
 *     PDPP_OWNER_PASSWORD and PDPP_LOCAL_TRANSFORMER_SUPERVISOR_RESTART_CONTRACT=1.
 *   - railway-core:main has the console and first-boot password generation but
 *     no /opt/patchright-browsers at all.
 *   - core:main and core-browser:main DO NOT EXIST (manifest inspect 404s).
 *   No published single image is both console-bearing and browser-capable, so
 *   a one-container command would have to lie about one of them.
 */

/** Segments of a rendered command. `emphasis` marks the token the eye lands on. */
export interface CommandSegment {
  readonly emphasis?: boolean;
  readonly text: string;
}

export interface SelfHostChoices {
  /**
   * `local` stays on this machine. `public` advertises an HTTPS origin so
   * hosted MCP clients (Claude.ai, ChatGPT) can reach it — they call from
   * their own infrastructure, so loopback is not reachable to them.
   */
  readonly access: "local" | "public";
  /** The origin a `public` deployment advertises. Ignored when access is `local`. */
  readonly publicUrl: string;
  /** Semantic search is on by default; off skips the embedding-model download. */
  readonly semanticSearch: boolean;
}

export const defaultChoices: SelfHostChoices = {
  access: "local",
  publicUrl: "",
  semanticSearch: true,
};

export type MethodId = "compose" | "fly" | "railway";

/**
 * The browser-capable image. `core-browser` is the intended public artifact
 * name but is NOT published — `docker manifest inspect` 404s for both `core`
 * and `core-browser` — so commands name the artifact that exists today.
 */
const BROWSER_IMAGE = "ghcr.io/pdp-connect/pdpp/reference-browser:main";

/**
 * Raw URL rather than a release asset. `releases/latest/download/...` 404s:
 * every release from v1.0.0 to v1.0.4 shipped zero assets. This URL was
 * fetched by the command under test and returns 200.
 */
const COMPOSE_URL = "https://raw.githubusercontent.com/PDP-Connect/pdpp/main/deploy/docker/docker-compose.yml";

export const RAILWAY_TEMPLATE_URL = "https://railway.com/new/template/pdpp-core-template-source";

/** Shown as a placeholder, never as a value, so the command is never broken. */
export const PUBLIC_URL_PLACEHOLDER = "https://pdpp.example.com";

function originFor(choices: SelfHostChoices): string {
  const trimmed = choices.publicUrl.trim();
  return trimmed.length > 0 ? trimmed : PUBLIC_URL_PLACEHOLDER;
}

/**
 * THE FIX FOR THE DEFECT THAT MADE THIS REBUILD NECESSARY. The old command was
 * `docker compose -f deploy/docker/docker-compose.yml up -d`, a repo-relative
 * path the reader does not have in their clipboard or their cwd; pasted into a
 * fresh terminal it errors immediately. This command FETCHES the compose file
 * first, so it works from an empty directory with nothing cloned.
 *
 * The secret-generation line is not decoration: the compose file guards both
 * values with `:?`, so the stack refuses to start without them.
 */
function composeCommand(choices: SelfHostChoices): CommandSegment[] {
  const segments: CommandSegment[] = [
    { text: "mkdir pdpp && cd pdpp\ncurl -fsSLO " },
    { emphasis: true, text: COMPOSE_URL },
    {
      text:
        "\nprintf 'PDPP_OWNER_PASSWORD=%s\\nPDPP_CREDENTIAL_ENCRYPTION_KEY=%s\\n' \\\n" +
        '  "$(openssl rand -base64 24)" "$(openssl rand -hex 32)" > .env\n' +
        `echo PDPP_REFERENCE_IMAGE=${BROWSER_IMAGE} >> .env\n`,
    },
  ];
  if (choices.access === "public") {
    segments.push(
      { text: "echo PDPP_REFERENCE_ORIGIN=" },
      { emphasis: true, text: originFor(choices) },
      { text: " >> .env\n" }
    );
  }
  if (!choices.semanticSearch) {
    segments.push({ text: "echo PDPP_EMBEDDING_DOWNLOAD_ALLOWED=0 >> .env\n" });
  }
  segments.push({ text: "docker compose up -d" });
  return segments;
}

export interface BuiltCommand {
  /** Rendered command segments, or null when this method has no shell command. */
  readonly segments: readonly CommandSegment[] | null;
  /** Shown in place of a command when `segments` is null. Never both. */
  readonly unavailable?: string;
  /** Where "Open the template ->" (or equivalent) points when `unavailable` is set. */
  readonly unavailableHref?: string;
  /** The link's own label, since "Open the template" is wrong for a runbook. */
  readonly unavailableLinkLabel?: string;
}

/**
 * Railway deploys from a template, and a template link CANNOT carry variable
 * values: Railway's documented deploy-URL parameters are attribution only
 * (referralCode, utm_*), and values are either baked in by the template author
 * or typed by the deployer into Railway's own form. So this tab cannot honour
 * the choices above, and it says so rather than pretending a click is a shell
 * line or silently discarding what the reader picked.
 */
function railwayCommand(): BuiltCommand {
  return {
    segments: null,
    unavailable: "Railway asks for these settings on its own deploy form, and gives the node a public address.",
    unavailableHref: RAILWAY_TEMPLATE_URL,
    unavailableLinkLabel: "Open the template",
  };
}

/**
 * Fly CAN run one real `fly launch` command (unlike Railway's template-only
 * flow), but not one that keeps the same guarantee every other tab on this
 * page keeps: every published image it could name fails the browser-capable
 * requirement, or is not a public product name.
 *
 * Verified 2026-08-05: `docker manifest inspect` resolves only two tags for
 * this repository's Fly-runnable image, `railway-core:main` and
 * `railway-core:sha-2fbdb4a`. Neither is browser-capable — `docker run
 * --entrypoint sh ... -c "ls /opt/patchright-browsers"` returns "No such file
 * or directory" on both, and on a from-source build of the Dockerfile's
 * `platform-core` target too, because `platform-core` is `FROM railway-core`
 * with no browser-install layer added (see the Dockerfile). No neutrally
 * named published repo exists as an alternative: `platform-core`,
 * `core-platform`, and `pdpp-core` all 404 on ghcr.io. `platform-core` is a
 * build-target alias, not a published tag.
 *
 * So a Fly command today would have to either name `railway-core` (a
 * deployment-provider-specific internal target name, banned from reader-
 * facing copy on this page for exactly this reason: see
 * self-host-browser-capability.test.ts, "no command or copy exposes a
 * platform-specific artifact name") or silently drop browser support that
 * this page's own "Browser sources included" feature promises. Both are
 * worse than telling the reader the shape and pointing them at the runbook
 * that carries the same caveat: deploy/flyio/README.md states this scope
 * line explicitly ("Out of scope: browser-backed connector collection inside
 * the deployed app").
 */
function flyCommand(): BuiltCommand {
  return {
    segments: null,
    unavailable:
      "Fly.io needs a few more flags than fit in one line here, and its published image does not yet carry browser-based sign-in.",
    unavailableHref: repoBlobUrl("deploy/flyio/README.md"),
    unavailableLinkLabel: "Read the runbook",
  };
}

export function buildCommand(method: MethodId, choices: SelfHostChoices): BuiltCommand {
  if (method === "railway") {
    return railwayCommand();
  }
  if (method === "fly") {
    return flyCommand();
  }
  return { segments: composeCommand(choices) };
}

/** Flatten a built command to the exact text the clipboard receives. */
export function commandText(segments: readonly CommandSegment[]): string {
  return segments.map((segment) => segment.text).join("");
}

export interface MethodDefinition {
  readonly id: MethodId;
  readonly label: string;
}

/**
 * Compose first: it is the only path that carries every choice above into the
 * command shown. Fly and Railway both go after it, in that order, because
 * both skip the Access/Search row (see the "HIDDEN ON RAILWAY AND FLY"
 * comment in command-tabs.tsx) — Fly ahead of Railway because it is one real
 * shell command a reader runs directly, where Railway is a link to a form.
 */
export const METHODS: readonly MethodDefinition[] = [
  { id: "compose", label: "Docker Compose" },
  { id: "fly", label: "Fly.io" },
  { id: "railway", label: "Railway" },
];
