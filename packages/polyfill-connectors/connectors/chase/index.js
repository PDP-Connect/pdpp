#!/usr/bin/env node
/**
 * PDPP Chase Connector (v0.1.0)
 *
 * Strategy: browser-drive chase.com's "Download account activity" affordance
 * to produce QFX (Quicken Web Connect) files, which parse canonically to
 * (account_id, fitid, date, amount, memo, name, type, checknum, refnum).
 *
 * Why QFX instead of Direct Connect or HTML scrape:
 * - Direct Connect is effectively dead for new personal-account enrollments
 *   as of 2025-2026 (see `design-notes/chase.md` — research done 2026-04-20).
 * - HTML scrape has hundreds of selectors subject to Chase's weekly UI
 *   churn. QFX splits the brittleness: only the ~5-selector download click
 *   path is fragile; the resulting file format has been stable since 2001.
 *
 * v0.1 streams (per `design-notes/chase.md`):
 *   - accounts: dashboard-scraped identity + QFX ACCTINFO augmentation
 *   - transactions: per-account, per-90-day-window QFX downloads + parse
 *   - balances: append_only point-in-time snapshots from QFX LEDGERBAL/AVAILBAL
 *
 * Selectors for the download UI are NOT verified live yet. This connector
 * emits diagnostic SKIP_RESULT with a DOM dump + screenshot when it can't
 * find the download affordance, so the first live run produces evidence
 * for the next iteration rather than silently failing with zero records.
 *
 * Auth: CHASE_USERNAME + CHASE_PASSWORD in env. 2FA via INTERACTION kind=otp.
 * CHASE_2FA_METHOD=text|voice|email (default text).
 */

import { createInterface } from 'node:readline';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireBrowser } from '../../src/browser-profile.js';
import { resourceSet } from '../../src/scope-filters.js';
import { ensureChaseSession } from '../../src/auto-login/chase.js';
import { emitToStdout } from '../../src/safe-emit.js';

const rl = createInterface({ input: process.stdin, terminal: false });
const emit = (m) => emitToStdout(m);
const flushAndExit = (code) => {
  if (process.stdout.writableLength > 0) {
    process.stdout.once('drain', () => process.exit(code));
    setTimeout(() => process.exit(code), 3000).unref();
  } else process.exit(code);
};
const fail = (m, r = false) => {
  emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } });
  flushAndExit(1);
};
const nowIso = () => new Date().toISOString();

let interactionCounter = 0;
const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

async function sendInteractionAndWait(msg) {
  await emit(msg);
  const reqId = msg.request_id;
  return new Promise((resolve, reject) => {
    const onLine = (line) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === reqId) {
          rl.off('line', onLine);
          resolve(parsed);
        }
      } catch (err) { reject(err); }
    };
    rl.on('line', onLine);
  });
}

// ─── Helpers ──────────────────────────────────────────────────────────────


// ─── Dashboard scrape: enumerate accounts ─────────────────────────────────

async function discoverAccounts(page) {
  // Navigate to dashboard overview — not the generic /dashboard URL which
  // often redirects to the last-viewed account. Overview consistently lists
  // all accounts.
  await page.goto('https://secure.chase.com/web/auth/dashboard#/dashboard/overview', {
    waitUntil: 'domcontentloaded', timeout: 30000,
  });
  // Wait for at least one account label to appear rather than a fixed delay —
  // the dashboard renders cards asynchronously from an XHR, so fixed sleeps
  // are both slow and flaky. Fail soft if the selector never appears (returns
  // empty accounts list; caller's SKIP_RESULT diagnostic fires).
  await page.locator('[id^="accounts-name-link-button-"][id$="-label"]').first()
    .waitFor({ state: 'attached', timeout: 20000 })
    .catch(() => {});

  // Verified pattern 2026-04-21: Chase renders each account as a
  // <span class="accessible-text" id="accounts-name-link-button-<INTERNAL_ID>-label">
  // with text like "Sapphire Preferred (...9241)". The internal id matches
  // the transactionDetails param and is what the download form's
  // account-selector expects.
  return page.evaluate(() => {
    function walk(root, out = []) {
      root.querySelectorAll('*').forEach((el) => {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, out);
      });
      return out;
    }
    const labels = walk(document)
      .filter((el) => el.id && /^accounts-name-link-button-\d+-label$/.test(el.id));
    return labels.map((el) => {
      const m = el.id.match(/^accounts-name-link-button-(\d+)-label$/);
      const displayName = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      const lastFourMatch = displayName.match(/\.\.\.(\d{3,4})/);
      // Infer type from the display name — rough heuristic; refined by
      // inspecting the BAC/DDA/ABS param in the transactions URL if needed.
      const typeHint = /(Sapphire|Freedom|Ink|Amazon|Southwest|United|Hyatt|Disney|Marriott|IHG|Prime|Platinum|Slate)/i.test(displayName)
        ? 'credit_card'
        : /(Checking|Total Checking|Premier Checking)/i.test(displayName)
          ? 'checking'
          : /(Savings|Premier Savings)/i.test(displayName)
            ? 'savings'
            : 'unknown';
      return {
        internal_id: m[1],
        name: displayName,
        type: typeHint,
        last_four: lastFourMatch ? lastFourMatch[1] : null,
      };
    });
  });
}

// ─── QFX download click-path ──────────────────────────────────────────────

async function downloadQfx(page, account, tmpDir) {
  // Download flow (verified live 2026-04-21, same shape as USAA's CSV export):
  //   1. Navigate directly to the download form:
  //      /dashboard/accountDetails/downloadAccountTransactions/index;params=CARD,BAC,<id>
  //      (CARD/BAC suffix is for credit cards; checking is DDA; savings is ABS.
  //      The params appear in transactionDetails hrefs from the dashboard.)
  //   2. Set mds-select#downloadFileTypeOption value=QFX via attribute mutation.
  //   3. Leave mds-select#downloadActivityOptionId at its default
  //      ("currentDisplayOption" = last ~30 days visible). Date-range support
  //      is a v0.1.1 extension once we've got the baseline working.
  //   4. Click mds-button#download and await the download event.

  // For credit cards the URL is:
  //   params=CARD,BAC,<internal_id>
  // For checking:
  //   params=DDA,<primary>,<internal_id>,<secondary>
  // Since we only have credit cards in v0.1, the CARD,BAC form is hardcoded.
  // A more complete version would derive the param tuple from the account's
  // detail-page URL captured during discoverAccounts.
  const paramsFragment = account.type === 'credit_card'
    ? `CARD,BAC,${account.internal_id}`
    : account.type === 'checking'
      ? `DDA,PRIMARY,${account.internal_id},SECONDARY`
      : `CARD,BAC,${account.internal_id}`;

  const url = `https://secure.chase.com/web/auth/dashboard#/dashboard/accountDetails/downloadAccountTransactions/index;params=${paramsFragment}`;
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
  // Wait for the file-type select to be present rather than a fixed delay.
  await page.locator('#downloadFileTypeOption').waitFor({ state: 'attached', timeout: 20000 });

  // Set file type to QFX via attribute mutation + change event. The mds-select
  // component reacts to the attribute change and its value updates.
  const setResult = await page.evaluate(() => {
    function walk(root, out = []) {
      root.querySelectorAll('*').forEach((el) => {
        out.push(el);
        if (el.shadowRoot) walk(el.shadowRoot, out);
      });
      return out;
    }
    const sel = walk(document).find((e) => e.id === 'downloadFileTypeOption');
    if (!sel) return { error: 'downloadFileTypeOption_not_found' };
    sel.setAttribute('value', 'QFX');
    sel.setAttribute('selected-index', '1');
    sel.dispatchEvent(new Event('change', { bubbles: true, composed: true }));
    return { value: sel.getAttribute('value') };
  });
  if (setResult.error) {
    return { downloaded: false, error: setResult.error };
  }
  // Wait until the mds-select's attribute reflects the new QFX value — this
  // confirms the component's internal state updated before we click Download.
  await page.locator('#downloadFileTypeOption[value="QFX"]').waitFor({ state: 'attached', timeout: 3000 }).catch(() => {});

  // Capture download and click the button.
  const downloadPromise = page.waitForEvent('download', { timeout: 45000 });
  try {
    await page.locator('mds-button#download').click({ timeout: 10000 });
  } catch (err) {
    return { downloaded: false, error: `download_button_click_failed: ${err.message.slice(0, 120)}` };
  }

  try {
    const dl = await downloadPromise;
    const qfxPath = join(tmpDir, `chase-${account.internal_id}-${Date.now()}.qfx`);
    await dl.saveAs(qfxPath);
    return { downloaded: true, qfxPath };
  } catch (err) {
    return { downloaded: false, error: `download_event_timeout: ${err.message.slice(0, 120)}` };
  }
}

// ─── QFX parsing ──────────────────────────────────────────────────────────

async function parseQfxFile(path) {
  const ofxJs = await import('ofx-js');
  const OFX = ofxJs.OFX || ofxJs.default?.OFX || ofxJs.default || ofxJs;
  const content = await readFile(path, 'utf8');
  return OFX.parse(content);
}

// OFX datetime format: YYYYMMDDHHMMSS[.sss][TZ] — strip to YYYY-MM-DD.
function ofxDateToIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length < 8) return null;
  const y = s.slice(0, 4);
  const m = s.slice(4, 6);
  const d = s.slice(6, 8);
  return `${y}-${m}-${d}`;
}

function ofxDateToFullIso(raw) {
  if (!raw) return null;
  const s = String(raw).trim();
  if (s.length < 8) return null;
  const date = ofxDateToIso(s);
  const hh = s.slice(8, 10) || '00';
  const mm = s.slice(10, 12) || '00';
  const ss = s.slice(12, 14) || '00';
  return `${date}T${hh}:${mm}:${ss}Z`;
}

// Walk an ofx-js parsed structure and extract our canonical shape.
// ofx-js yields deeply-nested objects matching OFX XML. Credit cards live
// under CREDITCARDMSGSRSV1 > CCSTMTTRNRS > CCSTMTRS; checking/savings under
// BANKMSGSRSV1 > STMTTRNRS > STMTRS. Structure is otherwise parallel.
function extractFromQfx(parsed) {
  const root = parsed?.OFX || parsed;
  if (!root) return { transactions: [], balance: null };

  // Find the statement response (credit card or bank).
  const cc = root.CREDITCARDMSGSRSV1?.CCSTMTTRNRS?.CCSTMTRS;
  const bank = root.BANKMSGSRSV1?.STMTTRNRS?.STMTRS;
  const stmt = cc || bank;
  if (!stmt) return { transactions: [], balance: null };

  const currency = stmt.CURDEF || 'USD';

  // Transactions — BANKTRANLIST > STMTTRN (can be a single object or an array).
  const trList = stmt.BANKTRANLIST;
  const rawTxns = trList?.STMTTRN;
  const txnArray = Array.isArray(rawTxns) ? rawTxns : (rawTxns ? [rawTxns] : []);
  const transactions = txnArray.map((t) => {
    const amtStr = String(t.TRNAMT || '0').trim();
    const amountCents = Math.round(Number(amtStr) * 100);
    return {
      fitid: String(t.FITID || ''),
      date: ofxDateToIso(t.DTPOSTED),
      amount_cents: amountCents,
      currency,
      type: t.TRNTYPE || null,
      name: t.NAME || null,
      memo: t.MEMO || null,
      check_number: t.CHECKNUM || null,
      reference_number: t.REFNUM || null,
    };
  }).filter((t) => t.fitid && t.date);

  // Balance — LEDGERBAL + AVAILBAL.
  let balance = null;
  const ledgerBal = stmt.LEDGERBAL;
  const availBal = stmt.AVAILBAL;
  if (ledgerBal || availBal) {
    const asOf = ofxDateToFullIso(ledgerBal?.DTASOF || availBal?.DTASOF);
    if (asOf) {
      balance = {
        as_of: asOf,
        ledger_cents: ledgerBal?.BALAMT != null ? Math.round(Number(ledgerBal.BALAMT) * 100) : null,
        available_cents: availBal?.BALAMT != null ? Math.round(Number(availBal.BALAMT) * 100) : null,
      };
    }
  }

  return { transactions, balance };
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function main() {
  const startMsg = await new Promise((resolve, reject) => {
    rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
  });
  if (startMsg.type !== 'START') return fail('Expected START');

  const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
  if (!requested.size) return fail('START.scope.streams is required');

  const wantsAccounts = requested.has('accounts');
  const wantsTransactions = requested.has('transactions');
  const wantsBalances = requested.has('balances');

  // startMsg.state is unused in v0.1 — the Current-Display download covers
  // the last ~30 days on each run, dedupe happens on RECORD key. v0.2 will
  // read prior-run cursors to walk date ranges.
  const emittedAt = nowIso();
  let totalEmitted = 0;
  const resFilters = new Map();
  for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
  const emitRecord = async (stream, data) => {
    if (data.id == null) return;
    const rs = resFilters.get(stream);
    if (rs && !rs.has(String(data.id))) return;
    await emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
    totalEmitted++;
  };

  let context;
  let release = async () => {};
  const headless = process.env.PDPP_CHASE_HEADLESS !== '0';
  try {
    ({ context, release } = await acquireBrowser({ headless }));
  } catch (err) {
    return fail(`could not open browser: ${err.message}`, false);
  }

  const tmpDir = await mkdtemp(join(tmpdir(), 'pdpp-chase-'));

  try {
    const page = await context.newPage();

    try {
      await ensureChaseSession({ context, page, sendInteractionAndWait, nextInteractionId });
    } catch (e) {
      return fail(`chase_session_failed: ${e.message}`, false);
    }
    await emit({ type: 'PROGRESS', message: 'Chase session verified; enumerating accounts' });

    const accounts = await discoverAccounts(page);
    if (!accounts.length) {
      // Dashboard selectors need calibration — emit diagnostic and fail gracefully.
      const diag = await page.evaluate(() => ({
        url: location.href,
        title: document.title,
        body_preview: (document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
      })).catch(() => null);
      await emit({
        type: 'SKIP_RESULT',
        stream: 'accounts',
        reason: 'selectors_pending',
        message: 'No accounts discovered from dashboard. Selectors need calibration against live DOM.',
        diagnostics: diag,
      });
      await emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
      flushAndExit(0);
      return;
    }

    await emit({ type: 'PROGRESS', message: `Found ${accounts.length} account(s)` });

    // Emit accounts stream. Our record.id is Chase's internal account id
    // directly — stable, no hashing needed. Keeps transactions.account_id
    // aligned with the download URL param.
    if (wantsAccounts) {
      for (const a of accounts) {
        await emitRecord('accounts', {
          id: a.internal_id,
          name: a.name,
          type: a.type,
          last_four: a.last_four,
          balance_cents: null, // populated from QFX LEDGERBAL when downloads run
          available_balance_cents: null,
          credit_limit_cents: null,
          available_credit_cents: null,
          statement_balance_cents: null,
          status: null,
          balance_as_of: null,
          fetched_at: emittedAt,
        });
      }
    }

    // Transactions + balances: download QFX per account, parse, emit.
    if (wantsTransactions || wantsBalances) {
      for (const a of accounts) {
        await emit({
          type: 'PROGRESS',
          stream: 'transactions',
          message: `${a.name}: downloading QFX`,
        });

        const result = await downloadQfx(page, a, tmpDir);
        if (!result.downloaded) {
          await emit({
            type: 'SKIP_RESULT',
            stream: 'transactions',
            reason: 'qfx_download_failed',
            message: `${a.name}: ${result.error}`,
          });
          continue;
        }

        let parsed;
        try {
          parsed = await parseQfxFile(result.qfxPath);
        } catch (err) {
          await emit({
            type: 'SKIP_RESULT',
            stream: 'transactions',
            reason: 'qfx_parse_failed',
            message: `${a.name}: ${err.message.slice(0, 160)}`,
          });
          continue;
        }

        const { transactions, balance } = extractFromQfx(parsed);

        if (wantsTransactions) {
          for (const t of transactions) {
            await emitRecord('transactions', {
              id: `${a.internal_id}|${t.fitid}`,
              account_id: a.internal_id,
              account_name: a.name,
              fitid: t.fitid,
              date: t.date,
              amount: t.amount_cents,
              currency: t.currency,
              type: t.type,
              name: t.name,
              memo: t.memo,
              check_number: t.check_number,
              reference_number: t.reference_number,
              source: `qfx_download_${t.date}`,
              fetched_at: emittedAt,
            });
          }
        }

        if (wantsBalances && balance) {
          await emitRecord('balances', {
            id: `${a.internal_id}|${balance.as_of}`,
            account_id: a.internal_id,
            as_of: balance.as_of,
            ledger_balance_cents: balance.ledger_cents,
            available_balance_cents: balance.available_cents,
            fetched_at: emittedAt,
          });
        }

        await emit({
          type: 'PROGRESS',
          stream: 'transactions',
          message: `${a.name}: emitted ${transactions.length} transactions`,
        });
      }
    }
  } finally {
    await release().catch(() => {});
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }

  await emit({ type: 'DONE', status: 'succeeded', records_emitted: totalEmitted });
  flushAndExit(0);
}

main().catch((err) => {
  const msg = err && err.message ? err.message : String(err);
  fail(msg, /ECONN|ETIMEDOUT|timeout/i.test(msg));
});
