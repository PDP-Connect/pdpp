/**
 * Shared connector runtime helpers.
 *
 * Every connector needs the same small set of utilities:
 *   - stdin readline for receiving START + INTERACTION_RESPONSE messages
 *   - stdout emit with backpressure-safe write (emitToStdout)
 *   - flushAndExit — proper exit after draining stdout
 *   - fail — terminal DONE with retryable flag
 *   - nowIso — current ISO-8601 timestamp
 *   - nextInteractionId — monotonic ID for INTERACTION messages
 *   - sendInteractionAndWait — ask the orchestrator a question and block
 *     on the INTERACTION_RESPONSE
 *   - validated emitRecord factory — wraps Zod shape-check + SKIP_RESULT
 *     + resources filter + running counter
 *
 * Extracted after the 4-connector refactor (amazon, chase, chatgpt, usaa)
 * made the duplication obvious. The guide explicitly said "extract after
 * 3 examples"; we have 4.
 *
 * Migration notes for existing connectors:
 *   - `createConnectorRuntime` replaces ~80 lines of boilerplate per
 *     connector.
 *   - Each connector still owns its `main()` function shape — the runtime
 *     provides helpers, not control flow. This keeps the Collection
 *     Profile protocol explicit (START → emit RECORD/STATE/SKIP_RESULT →
 *     DONE) rather than hidden behind a framework.
 */

import { createInterface } from 'node:readline';
import { emitToStdout } from './safe-emit.js';
import { resourceSet } from './scope-filters.js';

export function nowIso() {
  return new Date().toISOString();
}

/**
 * Intentionally-named pacing delay for anti-bot throttling between
 * requests. Distinct from `waitFor*` sync primitives. Use sparingly —
 * prefer real Playwright sync primitives where possible.
 */
export function politeDelay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Create a fresh connector runtime. Call once at connector startup.
 *
 * Returns:
 *   - emit(msg)           — send any JSONL message to stdout (backpressure-safe)
 *   - flushAndExit(code)  — drain stdout then exit
 *   - fail(msg, retryable) — emit terminal DONE{status:failed} + exit 1
 *   - nextInteractionId() — monotonic "int_<timestamp>_<n>" identifier
 *   - sendInteractionAndWait(msg) — block until INTERACTION_RESPONSE with matching request_id
 *   - makeEmitRecord({ validateRecord, requested, emittedAt }) — returns an
 *     emitRecord(stream, data) function that:
 *       * skips records whose id is null
 *       * applies grant-level `resources` filtering
 *       * runs Zod shape-check, emits SKIP_RESULT on failure
 *       * emits RECORD on pass
 *       * returns { totalEmitted, totalSkipped } accessor
 *
 * Does NOT start the readline loop or parse START. The caller still
 * drives the protocol: await first line → parse START → call
 * makeEmitRecord → iterate → emit DONE.
 */
export function createConnectorRuntime() {
  const rl = createInterface({ input: process.stdin, terminal: false });
  const emit = (msg) => emitToStdout(msg);

  const flushAndExit = (code) => {
    if (process.stdout.writableLength > 0) {
      process.stdout.once('drain', () => process.exit(code));
      setTimeout(() => process.exit(code), 3000).unref();
    } else {
      process.exit(code);
    }
  };

  const fail = (m, retryable = false) => {
    emit({ type: 'DONE', status: 'failed', records_emitted: 0, error: { message: m, retryable } });
    flushAndExit(1);
  };

  let interactionCounter = 0;
  const nextInteractionId = () => `int_${Date.now()}_${++interactionCounter}`;

  const sendInteractionAndWait = (msg) => {
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
  };

  // Read one full line (JSON message) from stdin. For START consumption
  // at the top of main().
  const readOneLine = () => new Promise((resolve, reject) => {
    rl.once('line', (line) => {
      try { resolve(JSON.parse(line)); } catch (e) { reject(e); }
    });
  });

  /**
   * Build an emitRecord function bound to this run's validator, requested
   * streams, and emittedAt timestamp.
   *
   * @param {object} opts
   * @param {function} opts.validateRecord - (stream, data) => { ok, data | issues }
   * @param {Map<string, object>} opts.requested - scope entries per stream from START
   * @param {string} opts.emittedAt - ISO timestamp for all RECORDs this run
   * @returns {object} { emitRecord, counters: { totalEmitted, totalSkipped } }
   *   (counters is a live-updating object; read after the run)
   */
  const makeEmitRecord = ({ validateRecord, requested, emittedAt }) => {
    const counters = { totalEmitted: 0, totalSkipped: 0 };
    const resFilters = new Map();
    for (const [name, scope] of requested) resFilters.set(name, resourceSet(scope));

    const emitRecord = (stream, data) => {
      if (data.id == null) return;
      const rs = resFilters.get(stream);
      if (rs && !rs.has(String(data.id))) return;
      const result = validateRecord(stream, data);
      if (!result.ok) {
        counters.totalSkipped++;
        emit({
          type: 'SKIP_RESULT',
          stream,
          reason: 'shape_check_failed',
          message: `${data.id}: ${result.issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
          diagnostics: { id: data.id, issues: result.issues, record: data },
        });
        return;
      }
      emit({ type: 'RECORD', stream, key: data.id, data, emitted_at: emittedAt });
      counters.totalEmitted++;
    };

    return { emitRecord, counters };
  };

  /**
   * Emit a final DONE{status:succeeded} plus a PROGRESS note for any
   * skipped records (shape-check failures). Call at the end of main()
   * before flushAndExit(0).
   */
  const emitSucceeded = (counters) => {
    if (counters.totalSkipped > 0) {
      emit({
        type: 'PROGRESS',
        message: `shape-check skipped ${counters.totalSkipped} record(s); see SKIP_RESULT events above`,
      });
    }
    emit({ type: 'DONE', status: 'succeeded', records_emitted: counters.totalEmitted });
  };

  /**
   * Start/stop Playwright tracing gated behind PDPP_TRACE=1.
   *
   * Usage:
   *   const tracer = makeTracer(context, 'amazon');
   *   await tracer.start();
   *   try { ... } finally { await tracer.stop(); }
   */
  const makeTracer = (context, connectorName) => {
    const enabled = process.env.PDPP_TRACE === '1';
    return {
      enabled,
      async start() {
        if (!enabled || !context) return;
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const traceName = `${connectorName}-${ts}`;
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
        const tracePath = `/tmp/${connectorName}-trace-${ts}.zip`;
        try {
          await context.tracing.stop({ path: tracePath });
          emit({ type: 'PROGRESS', message: `trace written to ${tracePath} — replay with: npx playwright show-trace ${tracePath}` });
        } catch (err) {
          emit({ type: 'PROGRESS', message: `failed to write trace: ${err.message}` });
        }
      },
    };
  };

  return {
    rl,
    emit,
    flushAndExit,
    fail,
    nextInteractionId,
    sendInteractionAndWait,
    readOneLine,
    makeEmitRecord,
    emitSucceeded,
    makeTracer,
  };
}
