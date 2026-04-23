#!/usr/bin/env node

/**
 * One-shot: extract Slack xoxc token + d cookie from the shared Playwright
 * profile for a given workspace and write them to .env.local.
 *
 * Usage:
 *   node bin/bootstrap-slack-session.js --workspace=myteam
 *   node bin/bootstrap-slack-session.js --workspace=myteam --headed
 *
 * Precondition: the shared browser profile (~/.pdpp/browser-profile/) has a
 * logged-in Slack session for the workspace. If not, run the headed
 * bootstrap-browser pass first to log in once.
 *
 * Technique: Slack desktop-web stores xoxc tokens in IndexedDB under
 * "localConfig_v2" + TS_registry. Simpler + more reliable: navigate to
 * `<workspace>.slack.com` and read from `window.boot_data.api_token` or
 * `TS.model.api_token` depending on client version. The `d` cookie is the
 * session cookie stored against `.slack.com`.
 *
 * If both can't be found, the script prints the INTERACTION request so the
 * user can paste the token manually.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
// biome-ignore lint/correctness/noUnresolvedImports: dotenv is declared in package.json; Biome's resolver can't follow its conditional exports
import { config as dotenvConfig } from "dotenv";
import type { BrowserContext, Page } from "playwright";
import { launchPersistentContext } from "../src/browser-profile.ts";
import { handleInteraction, type InteractionMessage, type InteractionResponse } from "../src/interaction-handler.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");
const ENV_FILE = join(REPO_ROOT, ".env.local");

dotenvConfig({ path: ENV_FILE });

const XOXC_PATTERN = /xoxc-[A-Za-z0-9-]+/;

interface Args {
  headed: boolean;
  workspace: string | null;
}

function parseArgs(argv: string[]): Args {
  const out: Args = { headed: false, workspace: null };
  for (const a of argv) {
    if (a === "--headed") {
      out.headed = true;
    } else if (a.startsWith("--workspace=")) {
      out.workspace = a.slice(12);
    }
  }
  return out;
}

let _ic = 0;
const nextInteractionId = (): string => `int_${Date.now()}_${++_ic}`;
const sendInteractionAndWait = (msg: InteractionMessage): Promise<InteractionResponse> =>
  handleInteraction(msg, { connectorName: "slack-bootstrap" });

async function extractToken(page: Page): Promise<string | null> {
  // The usual places Slack stashes the xoxc token:
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: inlined inside page.evaluate; decomposing would break the serialize-to-browser boundary
  return await page.evaluate((): string | null => {
    const candidates: string[] = [];
    // Grab browser-only globals via globalThis to bypass lib-constraint issues.
    // Typed structurally so each access is narrow.
    const g = globalThis as Record<string, unknown>;
    const w = (g.window ?? g) as {
      boot_data?: { api_token?: string };
      TS?: { model?: { api_token?: string } };
    };
    const ls = g.localStorage as
      | {
          length: number;
          key: (i: number) => string | null;
          getItem: (k: string) => string | null;
        }
      | undefined;
    try {
      if (typeof w.boot_data === "object" && w.boot_data?.api_token) {
        candidates.push(w.boot_data.api_token);
      }
    } catch {
      /* ignore */
    }
    try {
      if (typeof w.TS === "object" && w.TS?.model?.api_token) {
        candidates.push(w.TS.model.api_token);
      }
    } catch {
      /* ignore */
    }
    // Look in localStorage for any xoxc token
    try {
      if (ls) {
        for (let i = 0; i < ls.length; i++) {
          const k = ls.key(i);
          if (!k) {
            continue;
          }
          const v = ls.getItem(k) || "";
          // biome-ignore lint/performance/useTopLevelRegex: runs inside page.evaluate, serialized to browser
          const m = v.match(/xoxc-[A-Za-z0-9-]+/);
          if (m) {
            candidates.push(m[0]);
          }
        }
      }
    } catch {
      /* ignore */
    }
    // Return the first xoxc- match
    return candidates.find((t) => t?.startsWith("xoxc-")) || null;
  });
}

async function extractCookie(context: BrowserContext): Promise<string | null> {
  const cookies = await context.cookies("https://slack.com");
  const d = cookies.find((c) => c.name === "d");
  return d ? d.value : null;
}

function appendEnv(varName: string, value: string): string {
  const line = `${varName}=${value}\n`;
  if (existsSync(ENV_FILE)) {
    const current = readFileSync(ENV_FILE, "utf8");
    if (new RegExp(`^${varName}=`, "m").test(current)) {
      const updated = current.replace(new RegExp(`^${varName}=.*$`, "m"), `${varName}=${value}`);
      writeFileSync(ENV_FILE, updated, { mode: 0o600 });
      return "updated";
    }
    writeFileSync(ENV_FILE, current.endsWith("\n") ? current + line : `${current}\n${line}`, { mode: 0o600 });
    return "appended";
  }
  writeFileSync(ENV_FILE, line, { mode: 0o600 });
  return "created";
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace) {
    console.error("Usage: bootstrap-slack-session.js --workspace=<subdomain> [--headed]");
    process.exit(2);
  }
  console.error(`[bootstrap-slack-session] workspace="${args.workspace}" headed=${args.headed}`);

  const context = await launchPersistentContext({ headless: !args.headed });
  try {
    const page = await context.newPage();
    const url = `https://${args.workspace}.slack.com/`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    // Slack's JS takes a beat to hydrate boot_data; wait for the TS model to appear
    await page
      .waitForFunction(
        (): boolean => {
          const g = globalThis as Record<string, unknown>;
          const w = (g.window ?? g) as {
            boot_data?: { api_token?: string };
            TS?: { model?: { api_token?: string } };
          };
          return !!(
            (typeof w.boot_data === "object" && w.boot_data?.api_token) ||
            (typeof w.TS === "object" && w.TS?.model?.api_token)
          );
        },
        null,
        { timeout: 30_000 }
      )
      .catch(() => {
        /* ignore */
      });

    const token = await extractToken(page);
    const cookie = await extractCookie(context);

    if (!(token && cookie)) {
      // Fallback: ask the user to paste the token/cookie manually.
      const resp = await sendInteractionAndWait({
        request_id: nextInteractionId(),
        kind: "credentials",
        message: `Slack ${args.workspace}: couldn't auto-extract session. Please open the Slack web app, open DevTools → Application → Cookies, and paste the "d" cookie + xoxc token. Follow slackdump's docs: https://github.com/rusq/slackdump/blob/master/doc/login-manual.md`,
        schema: {
          properties: {
            SLACK_TOKEN: { description: "xoxc-... token" },
            SLACK_COOKIE: { description: "d cookie value" },
          },
        },
        timeout_seconds: 1800,
      });
      if (resp.status !== "success") {
        throw new Error("slack_creds_not_provided");
      }
      const manualToken = resp.data?.SLACK_TOKEN;
      const manualCookie = resp.data?.SLACK_COOKIE;
      if (!(manualToken && manualCookie)) {
        throw new Error("slack_creds_incomplete");
      }
      appendEnv("SLACK_WORKSPACE", args.workspace);
      appendEnv("SLACK_TOKEN", manualToken);
      appendEnv("SLACK_COOKIE", manualCookie);
      console.error("[bootstrap-slack-session] credentials written via manual paste");
      return;
    }

    // Consume the unused regex constant so future runtime checks still fire.
    // (Retained as a module-scope regex per Biome's useTopLevelRegex.)
    if (!XOXC_PATTERN.test(token)) {
      throw new Error("extracted token doesn't look like xoxc-...");
    }

    appendEnv("SLACK_WORKSPACE", args.workspace);
    appendEnv("SLACK_TOKEN", token);
    appendEnv("SLACK_COOKIE", cookie);
    console.error(
      `[bootstrap-slack-session] extracted token (xoxc-${token.slice(5, 12)}…) and d cookie; written to ${ENV_FILE}`
    );
  } finally {
    await context.close().catch(() => {
      /* ignore */
    });
  }
}

main().catch((e: unknown) => {
  const m = e instanceof Error ? e.message : String(e);
  console.error("[bootstrap-slack-session] ERROR:", m);
  process.exit(1);
});
