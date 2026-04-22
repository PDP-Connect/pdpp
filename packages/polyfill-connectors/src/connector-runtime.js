/**
 * One runtime for every connector.
 *
 * The protocol — START → RECORD/STATE/SKIP_RESULT/PROGRESS → DONE — is
 * framework, not business logic. A connector should express WHAT it
 * collects, not HOW the protocol handshake works. This module owns the
 * handshake; connectors own the collection.
 *
 *   import { runConnector } from '../../src/connector-runtime.js';
 *   import { validateRecord } from './schemas.js';
 *
 *   runConnector({
 *     name: 'notion',
 *     validateRecord,
 *     async collect({ scope, state, emit, emitRecord, progress }) {
 *       // pure business logic
 *     },
 *   });
 *
 * For browser-based connectors, add `browser: { profileName, headless }`
 * and the runtime acquires an isolated Playwright context, passing `page`
 * and `ctx` into collect(). Optional `ensureSession` and `probeSession`
 * callbacks automate re-auth on session expiry.
 *
 *   runConnector({
 *     name: 'amazon',
 *     validateRecord,
 *     browser: { profileName: 'amazon' },
 *     async ensureSession({ context, page, sendInteraction }) { … },
 *     async collect({ page, emitRecord, capture }) { … },
 *   });
 *
 * What the runtime owns (connector never writes this code again):
 *   - Reading START from stdin, validating shape
 *   - Building scope.streams into a Map + resourceSet filters
 *   - Zod shape-check via validateRecord; SKIP_RESULT on drift
 *   - Scope time_range filter on records with a .date field
 *   - Counters (emitted + skipped)
 *   - Browser acquire + release + finally cleanup
 *   - Playwright tracing lifecycle (PDPP_TRACE=1)
 *   - Fixture capture lifecycle (PDPP_CAPTURE_FIXTURES=1)
 *   - Terminal DONE + flushAndExit on both success and throw
 *   - Retryable-error detection via retryablePattern regex
 *
 * What the connector owns:
 *   - name (string) + validateRecord (fn from schemas.js)
 *   - collect(ctx): the only required function; produces records
 *   - Optional: browser config, ensureSession/probeSession, sessionExpiredError,
 *     retryablePattern, onSuccess hook for final STATE emission
 */

import { createInterface } from 'node:readline';
import { emitToStdout } from './safe-emit.js';
import { resourceSet } from './scope-filters.js';
import { createCaptureSession } from './fixture-capture.js';

// Primitive helpers. Exported so connectors that need them inline can import
// without pulling in the whole runtime surface.
export const nowIso = () => new Date().toISOString();

// Intentional pacing delay for anti-bot throttling between requests.
// Distinct from Playwright's sync primitives (waitForSelector, waitForURL,
// etc.) which wait for a page condition. This one is "slow us down so we
// look human", not "wait until X is ready". The name is the interface: if
// you're reaching for this in new code, first check whether a real waitFor
// fits — it usually does. See docs/connector-authoring-guide.md §7.
export const politeDelay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Run a connector end-to-end. This is the only entry point connectors should
 * use. See module docstring for the shape of `config`.
 */
export function runConnector(config) {
  if (!config?.name) throw new Error('runConnector: config.name required');
  if (typeof config.collect !== 'function') throw new Error('runConnector: config.collect required');

  const {
    name,
    validateRecord,
    collect,
    browser,           // { profileName, headless } | undefined
    ensureSession,     // ({ context, page, sendInteraction }) => void
    probeSession,      // ({ context, page }) => boolean
    retryablePattern = /ECONN|ETIMEDOUT|timeout/i,
    // Which record field `scope.time_range` filters on. Default `.date`;
    // connectors that use other timestamp fields (e.g. Slack's `sent_at`)
    // override here so they don't have to bypass the runtime's emitRecord.
    // Can be a string (applied to all streams) or a (streamName) => string
    // function for per-stream overrides.
    timeRangeField = 'date',
    // Tombstone predicate: given (stream, data) returns true if the record
    // represents a deletion. The runtime strips data down to { id } and
    // emits with op: 'delete'. Covers Notion archived-pages, YNAB deleted-
    // transactions, and similar shapes without connector-level wrappers.
    isTombstone,
  } = config;

  const timeRangeFieldFor = typeof timeRangeField === 'function'
    ? timeRangeField
    : () => timeRangeField;

  // Capture session: created only when PDPP_CAPTURE_FIXTURES=1. Null otherwise.
  const capture = createCaptureSession(name);

  // stdin reader for START + INTERACTION_RESPONSE.
  const rl = createInterface({ input: process.stdin, terminal: false });

  // emit() wraps stdout write with backpressure handling. RECORD messages
  // are auto-captured when a capture session is active.
  const emit = (msg) => {
    if (capture && msg.type === 'RECORD') capture.recordRecord(msg);
    return emitToStdout(msg);
  };

  if (capture) {
    process.stderr.write(`[capture] PDPP_CAPTURE_FIXTURES=1; writing to ${capture.baseDir}\n`);
  }

  const flushAndExit = (code) => {
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', () => process.exit(code));
      setTimeout(() => process.exit(code), 3000).unref();
    } else {
      process.exit(code);
    }
  };

  const emitFailed = (message, retryable = false, records_emitted = 0) => {
    emit({ type: 'DONE', status: 'failed', records_emitted, error: { message, retryable } });
    flushAndExit(1);
  };

  let interactionCounter = 0;
  const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

  // Send an INTERACTION and block until the matching INTERACTION_RESPONSE
  // arrives on stdin. Used for OTP, credential prompts, and manual_action
  // re-auth flows.
  const sendInteraction = (msg) => {
    const request_id = msg.request_id ?? nextInteractionId();
    const wrapped = { ...msg, type: 'INTERACTION', request_id };
    emit(wrapped);
    return new Promise((resolve, reject) => {
      const onLine = (line) => {
        try {
          const parsed = JSON.parse(line);
          if (parsed.type === 'INTERACTION_RESPONSE' && parsed.request_id === request_id) {
            rl.off('line', onLine);
            resolve(parsed);
          }
        } catch (err) { reject(err); }
      };
      rl.on('line', onLine);
    });
  };

  // Read the START message off stdin.
  const readStart = () => new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      try { resolve(JSON.parse(line)); } catch (err) { reject(err); }
    });
  });

  const progress = (message, extra = {}) => emit({ type: 'PROGRESS', message, ...extra });

  run().catch((err) => {
    const message = err?.message || String(err);
    emitFailed(message, retryablePattern.test(message));
  });

  async function run() {
    const startMsg = await readStart();
    if (startMsg?.type !== 'START') return emitFailed('Expected START message');

    const requested = new Map((startMsg.scope?.streams || []).map((s) => [s.name, s]));
    if (!requested.size) return emitFailed('START.scope.streams is required');

    const state = startMsg.state || {};
    const emittedAt = nowIso();
    const counters = { totalEmitted: 0, totalSkipped: 0 };
    const resFilters = new Map();
    for (const [streamName, scope] of requested) resFilters.set(streamName, resourceSet(scope));

    // The core emit primitive connectors interact with. Returns the emit
    // Promise so callers can await for backpressure; ignoring the return is
    // fine for small records.
    const emitRecord = (stream, data) => {
      if (data?.id == null) return Promise.resolve();
      const rs = resFilters.get(stream);
      if (rs && !rs.has(String(data.id))) return Promise.resolve();

      // Tombstones: platforms that mark records as deleted in-place rather
      // than omitting them (Notion archived, YNAB deleted). Strip to { id }
      // and emit with op: 'delete' so downstream consumers apply a delete.
      if (isTombstone && isTombstone(stream, data)) {
        counters.totalEmitted++;
        return emit({ type: 'RECORD', stream, key: data.id, data: { id: data.id }, emitted_at: emittedAt, op: 'delete' });
      }

      // scope.time_range filter. Field name is configurable per connector/
      // stream (default 'date'); connectors using other timestamp fields
      // (e.g. Slack's 'sent_at') override via config.timeRangeField.
      const scope = requested.get(stream);
      if (scope?.time_range) {
        const field = timeRangeFieldFor(stream);
        const v = data[field];
        if (v) {
          if (scope.time_range.since && v < scope.time_range.since.slice(0, 10)) return Promise.resolve();
          if (scope.time_range.until && v >= scope.time_range.until.slice(0, 10)) return Promise.resolve();
        }
      }

      if (validateRecord) {
        const result = validateRecord(stream, data);
        if (!result.ok) {
          counters.totalSkipped++;
          return emit({
            type: 'SKIP_RESULT',
            stream,
            reason: 'shape_check_failed',
            message: `${data.id}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
            diagnostics: { id: data.id, issues: result.issues, record: data },
          });
        }
      }
      counters.totalEmitted++;
      return emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
    };

    // Browser branch: acquire isolated context, optionally ensureSession,
    // then invoke collect with { context, page, ... } in addition to the
    // base context.
    if (browser) {
      const { acquireIsolatedBrowser } = await import('./browser-daemon.js');
      const profileName = browser.profileName || name;
      const headless = browser.headless ?? (process.env[`PDPP_${profileName.toUpperCase()}_HEADLESS`] !== '0');

      let ctx;
      let release = async () => {};
      try {
        ({ context: ctx, release } = await acquireIsolatedBrowser({ profileName, headless }));
      } catch (err) {
        return emitFailed(`could not open browser profile: ${err.message}`, false);
      }

      const tracer = makeTracer(ctx, name, emit);
      await tracer.start();

      try {
        const page = await ctx.newPage();

        if (typeof ensureSession === 'function') {
          try {
            await ensureSession({
              context: ctx,
              page,
              sendInteraction,
              progress,
            });
          } catch (err) {
            return emitFailed(`${name}_session_failed: ${err.message}`, false);
          }
        } else if (typeof probeSession === 'function') {
          const ok = await probeSession({ context: ctx, page });
          if (!ok) {
            await sendInteraction({
              kind: 'manual_action',
              message: `${name} session expired. Open the browser and re-authenticate, then continue.`,
              timeout_seconds: 1800,
            });
            const retry = await probeSession({ context: ctx, page });
            if (!retry) return emitFailed(`${name}_session_required`, false);
          }
        }

        await collect({
          scope: startMsg.scope,
          state,
          requested,
          emit,
          emitRecord,
          progress,
          capture,
          sendInteraction,
          context: ctx,
          page,
          emittedAt,
        });
      } finally {
        await tracer.stop();
        await release().catch(() => {});
      }
    } else {
      // Non-browser: API, file-based, or otherwise. No context/page.
      await collect({
        scope: startMsg.scope,
        state,
        requested,
        emit,
        emitRecord,
        progress,
        capture,
        sendInteraction,
        emittedAt,
      });
    }

    if (counters.totalSkipped > 0) {
      progress(`shape-check skipped ${counters.totalSkipped} record(s); see SKIP_RESULT events above`);
    }
    emit({ type: 'DONE', status: 'succeeded', records_emitted: counters.totalEmitted });
    flushAndExit(0);
  }
}

/**
 * Playwright tracing helper, gated on PDPP_TRACE=1. Produces a replayable
 * .zip in /tmp for debugging silent scraper failures. See
 * docs/connector-authoring-guide.md §9.
 */
function makeTracer(context, name, emit) {
  const enabled = process.env.PDPP_TRACE === '1';
  return {
    async start() {
      if (!enabled || !context) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const traceName = `${name}-${ts}`;
      await context.tracing.start({
        name: traceName,
        screenshots: true,
        snapshots: true,
        sources: true,
      }).catch(() => {});
      emit({ type: 'PROGRESS', message: `tracing enabled (PDPP_TRACE=1); will write /tmp/${traceName}.zip on exit` });
    },
    async stop() {
      if (!enabled || !context) return;
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const tracePath = `/tmp/${name}-trace-${ts}.zip`;
      try {
        await context.tracing.stop({ path: tracePath });
        emit({ type: 'PROGRESS', message: `trace written to ${tracePath} — replay with: npx playwright show-trace ${tracePath}` });
      } catch (err) {
        emit({ type: 'PROGRESS', message: `failed to write trace: ${err.message}` });
      }
    },
  };
}
