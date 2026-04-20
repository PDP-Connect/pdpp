/**
 * Shared scaffolding for browser-based connectors.
 *
 * Provides a minimal harness that:
 *  - Parses START from stdin
 *  - Opens the shared persistent profile
 *  - Calls a platform-specific `probeSession(ctx, page)` and `scrape(ctx, page, { state, requested, emitRecord, sleep })`
 *  - Handles INTERACTION parking for manual re-auth
 *  - Emits DONE on completion/failure
 *
 * Each connector is:
 *   import { runBrowserScraper } from '../../src/browser-scraper-runtime.js';
 *   runBrowserScraper({
 *     name: 'doordash',
 *     async probeSession(ctx, page) { ... returns boolean ... },
 *     async scrape({ ctx, page, state, requested, emit, emitRecord, sleep, sendInteractionAndWait }) { ... }
 *   });
 */

import { createInterface } from 'node:readline';
import { acquireBrowser } from './browser-profile.js';
import { resourceSet } from './scope-filters.js';
import { stringifyForJsonl } from './safe-emit.js';

export function runBrowserScraper({ name, probeSession, scrape, ensureSession }) {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const emit = (msg) => process.stdout.write(stringifyForJsonl(msg));
  const flushAndExit = (code) => {
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', () => process.exit(code));
      setTimeout(() => process.exit(code), 3000).unref();
    } else process.exit(code);
  };
  const fail = (m, r = false) => { emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable: r } }); flushAndExit(1); };
  const nowIso = () => new Date().toISOString();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  let interactionCounter = 0;
  const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

  async function sendInteractionAndWait(msg) {
    emit(msg);
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

  async function main() {
    const startMsg = await new Promise((resolve, reject) => {
      rl.once('line', (line) => { try { resolve(JSON.parse(line)); } catch (e) { reject(e); } });
    });
    if (startMsg.type !== 'START') return fail('Expected START');

    const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
    if (!requested.size) return fail('START.scope.streams is required');

    const state = startMsg.state || {};
    const emittedAt = nowIso();
    let total = 0;
    const resFilters = new Map();
    for (const [n, r] of requested) resFilters.set(n, resourceSet(r));
    const emitRecord = (stream, data) => {
      if (data.id == null) return;
      const rs = resFilters.get(stream);
      if (rs && !rs.has(String(data.id))) return;
      emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
      total++;
    };

    let context;
    let release = async () => {};
    try {
      ({ context, release } = await acquireBrowser({ headless: true }));
    } catch (err) {
      return fail(`could not open browser profile: ${err.message}`, false);
    }

    try {
      const page = await context.newPage();

      // Preferred: automated re-auth via a connector-supplied ensureSession
      // hook (like ensureUsaaSession). Falls back to passive probe + INTERACTION
      // manual_action if the hook isn't provided.
      if (typeof ensureSession === 'function') {
        try {
          await ensureSession({ context, page, sendInteractionAndWait, nextInteractionId });
        } catch (e) {
          return fail(`${name}_session_failed: ${e.message}`, false);
        }
      } else {
        const sessionOk = await probeSession(context, page);
        if (!sessionOk) {
          await sendInteractionAndWait({
            type: 'INTERACTION',
            request_id: nextInteractionId(),
            kind: 'manual_action',
            message: `${name} session expired. Open the browser and run "pdpp-connectors browser bootstrap ${name}" to re-authenticate.`,
            timeout_seconds: 1800,
          });
          const retry = await probeSession(context, page);
          if (!retry) return fail(`${name}_session_required`, false);
        }
      }

      emit({ type: 'PROGRESS', message: `${name} session verified; scraping` });
      await scrape({
        ctx: context,
        page,
        state,
        requested,
        emit,
        emitRecord,
        sleep,
        sendInteractionAndWait,
        nextInteractionId,
        emittedAt,
      });
    } finally {
      await release().catch(() => {});
    }

    emit({ type: 'DONE', status: 'succeeded', records_emitted: total });
    flushAndExit(0);
  }

  main().catch((e) => {
    const msg = e && e.message ? e.message : String(e);
    emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: msg, retryable: /ECONN|ETIMEDOUT|timeout/i.test(msg) } });
    flushAndExit(1);
  });
}
