#!/usr/bin/env node
/**
 * One-shot: extract Slack xoxc token + d cookie from the shared Playwright
 * profile for a given workspace and write them to .env.the owner.local.
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

import { config as dotenvConfig } from 'dotenv';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchPersistentContext } from '../src/browser-profile.js';
import { handleInteraction } from '../src/interaction-handler.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ENV_FILE = join(REPO_ROOT, '.env.the owner.local');

dotenvConfig({ path: ENV_FILE });

function parseArgs(argv) {
  const out = { headed: false, workspace: null };
  for (const a of argv) {
    if (a === '--headed') out.headed = true;
    else if (a.startsWith('--workspace=')) out.workspace = a.slice(12);
  }
  return out;
}

let _ic = 0;
const nextInteractionId = () => `int_${Date.now()}_${++_ic}`;
const sendInteractionAndWait = (msg) => handleInteraction(msg, { connectorName: 'slack-bootstrap' });

async function extractToken(page) {
  // The usual places Slack stashes the xoxc token:
  return await page.evaluate(() => {
    const candidates = [];
    try {
      if (typeof window.boot_data === 'object' && window.boot_data?.api_token) {
        candidates.push(window.boot_data.api_token);
      }
    } catch (_) {}
    try {
      if (typeof window.TS === 'object' && window.TS?.model?.api_token) {
        candidates.push(window.TS.model.api_token);
      }
    } catch (_) {}
    // Look in localStorage for any xoxc token
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const v = localStorage.getItem(k) || '';
        const m = v.match(/xoxc-[A-Za-z0-9-]+/);
        if (m) candidates.push(m[0]);
      }
    } catch (_) {}
    // Return the first xoxc- match
    return candidates.find((t) => t && t.startsWith('xoxc-')) || null;
  });
}

async function extractCookie(context) {
  const cookies = await context.cookies('https://slack.com');
  const d = cookies.find((c) => c.name === 'd');
  return d ? d.value : null;
}

function appendEnv(varName, value) {
  const line = `${varName}=${value}\n`;
  if (existsSync(ENV_FILE)) {
    const current = readFileSync(ENV_FILE, 'utf8');
    if (new RegExp(`^${varName}=`, 'm').test(current)) {
      const updated = current.replace(new RegExp(`^${varName}=.*$`, 'm'), `${varName}=${value}`);
      writeFileSync(ENV_FILE, updated, { mode: 0o600 });
      return 'updated';
    }
    writeFileSync(ENV_FILE, current.endsWith('\n') ? current + line : current + '\n' + line, { mode: 0o600 });
    return 'appended';
  }
  writeFileSync(ENV_FILE, line, { mode: 0o600 });
  return 'created';
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.workspace) {
    console.error('Usage: bootstrap-slack-session.js --workspace=<subdomain> [--headed]');
    process.exit(2);
  }
  console.error(`[bootstrap-slack-session] workspace="${args.workspace}" headed=${args.headed}`);

  const context = await launchPersistentContext({ headless: !args.headed });
  try {
    const page = await context.newPage();
    const url = `https://${args.workspace}.slack.com/`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    // Slack's JS takes a beat to hydrate boot_data; wait for the TS model to appear
    await page.waitForFunction(
      () => (typeof window.boot_data === 'object' && window.boot_data?.api_token) || (typeof window.TS === 'object' && window.TS?.model?.api_token),
      { timeout: 30000 },
    ).catch(() => {});

    const token = await extractToken(page);
    const cookie = await extractCookie(context);

    if (!token || !cookie) {
      // Fallback: ask the user to paste the token/cookie manually.
      const resp = await sendInteractionAndWait({
        type: 'INTERACTION',
        request_id: nextInteractionId(),
        kind: 'credentials',
        message: `Slack ${args.workspace}: couldn't auto-extract session. Please open the Slack web app, open DevTools → Application → Cookies, and paste the "d" cookie + xoxc token. Follow slackdump's docs: https://github.com/rusq/slackdump/blob/master/doc/login-manual.md`,
        schema: {
          type: 'object',
          properties: {
            SLACK_TOKEN: { type: 'string', format: 'password', description: 'xoxc-... token' },
            SLACK_COOKIE: { type: 'string', format: 'password', description: 'd cookie value' },
          },
          required: ['SLACK_TOKEN', 'SLACK_COOKIE'],
        },
        timeout_seconds: 1800,
      });
      if (resp.status !== 'success') throw new Error('slack_creds_not_provided');
      const manualToken = resp.data?.SLACK_TOKEN;
      const manualCookie = resp.data?.SLACK_COOKIE;
      if (!manualToken || !manualCookie) throw new Error('slack_creds_incomplete');
      appendEnv('SLACK_WORKSPACE', args.workspace);
      appendEnv('SLACK_TOKEN', manualToken);
      appendEnv('SLACK_COOKIE', manualCookie);
      console.error('[bootstrap-slack-session] credentials written via manual paste');
      return;
    }

    appendEnv('SLACK_WORKSPACE', args.workspace);
    appendEnv('SLACK_TOKEN', token);
    appendEnv('SLACK_COOKIE', cookie);
    console.error(`[bootstrap-slack-session] extracted token (xoxc-${token.slice(5, 12)}…) and d cookie; written to ${ENV_FILE}`);
  } finally {
    await context.close().catch(() => {});
  }
}

main().catch((e) => {
  console.error('[bootstrap-slack-session] ERROR:', e.message || e);
  process.exit(1);
});
