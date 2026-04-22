import { acquireBrowser } from '../src/browser-profile.js';
import { ensureUsaaSession } from '../src/auto-login/usaa.js';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { config as loadEnv } from 'dotenv';

loadEnv({ path: new URL('../../../.env.local', import.meta.url) });

const OTP_FILE = '/tmp/usaa-otp.txt';

const CRITICAL = ['LtpaToken2', 'AST', 'MemberGlobalSession'];

function summarize(cookies) {
  const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
  return {
    total: cookies.length,
    logged_in_marker: byName['UsaaMbWebMemberLoggedIn']?.value || null,
    critical: Object.fromEntries(CRITICAL.map((n) => [n, byName[n] ? 'PRESENT' : 'ABSENT'])),
  };
}

const sendInteractionAndWait = async (msg) => {
  console.log(`\n[INTERACTION ${msg.kind}] ${msg.message}`);
  console.log(`Drop the 6-digit code into ${OTP_FILE} (e.g. \`echo 123456 > ${OTP_FILE}\`)`);
  // Poll the file
  const start = Date.now();
  while (Date.now() - start < (msg.timeout_seconds || 600) * 1000) {
    if (existsSync(OTP_FILE)) {
      const code = (await readFile(OTP_FILE, 'utf8')).trim();
      await unlink(OTP_FILE).catch(() => {});
      if (/^\d{6}$/.test(code)) {
        console.log('[INTERACTION] code received');
        return { status: 'success', data: { code } };
      }
      console.log(`[INTERACTION] invalid code ${JSON.stringify(code)}, ignoring`);
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return { status: 'timeout' };
};

let counter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++counter}`;

async function main() {
  const { context, release } = await acquireBrowser({ headless: true });
  try {
    const pre = await context.cookies('https://www.usaa.com/');
    console.log('[pre-login cookies]', JSON.stringify(summarize(pre), null, 2));

    const page = await context.newPage();
    await ensureUsaaSession({ context, page, sendInteractionAndWait, nextInteractionId });
    console.log('[ensureUsaaSession] returned ok');

    const post = await context.cookies('https://www.usaa.com/');
    console.log('[post-login cookies]', JSON.stringify(summarize(post), null, 2));

    await page.close().catch(() => {});
  } finally {
    await release();
  }

  console.log('[released] attaching again to verify persistence...');
  const { context: ctx2, release: rel2 } = await acquireBrowser({ headless: true });
  try {
    const after = await ctx2.cookies('https://www.usaa.com/');
    console.log('[after-release cookies]', JSON.stringify(summarize(after), null, 2));
  } finally {
    await rel2();
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});
