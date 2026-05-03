/**
 * Run-interaction streaming companion routes (reference-only).
 *
 * Owner-authenticated mint:
 *   POST /_ref/runs/:runId/run-interaction-stream
 *     body: { interaction_id, viewport?: { width, height, deviceScaleFactor?, mobile? } }
 *     emits run.stream_session_requested
 *
 * Token-only frame channel (SSE):
 *   GET  /_ref/run-interaction-streams/:token/events
 *     emits run.stream_session_opened on attach, run.stream_session_resolved on close
 *
 * Token-only input dispatch:
 *   POST /_ref/run-interaction-streams/:token/input
 *     body: an input event matching `mapInputEventToCdp`
 *
 * Token-only viewport / lifecycle:
 *   POST /_ref/run-interaction-streams/:token/viewport
 *   POST /_ref/run-interaction-streams/:token/close
 *
 * The token is the only credential the viewer presents after mint. It is short
 * lived (default 5 min), single-attach, scoped to one (run, interaction,
 * browser session), and invalidated when the interaction resolves or the run
 * ends. The token never authorizes record reads, consent approval, grant
 * issuance, or unrelated browser access.
 */
import { emitSpineEvent } from '../../lib/spine.ts';

function pdppError(res, status, code, message, param = null) {
  const body = { error: { type: 'invalid_request_error', code, message } };
  if (param) body.error.param = param;
  if (status === 401) {
    res.status(status).header('WWW-Authenticate', 'Bearer realm="pdpp-stream"').json(body);
    return;
  }
  res.status(status).json(body);
}

function safeRunId(req) {
  return decodeURIComponent(req.params.runId);
}

function pickViewport(input) {
  if (!input || typeof input !== 'object') return null;
  const width = Number(input.width);
  const height = Number(input.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  const out = { width: Math.floor(width), height: Math.floor(height) };
  if (Number.isFinite(input.deviceScaleFactor) && input.deviceScaleFactor > 0) {
    out.deviceScaleFactor = Number(input.deviceScaleFactor);
  }
  if (input.mobile === true) out.mobile = true;
  return out;
}

/**
 * @param {object} deps
 * @param {object} deps.app                    fastify app
 * @param {object} deps.controller             controller exposing getPendingInteraction
 * @param {object} deps.ownerAuth              owner auth middleware bag
 * @param {object} deps.streamingSessions      session store (createStreamingSessionStore)
 * @param {Function|null} deps.companionFactory   ({ run_id, interaction_id }) => Companion.
 *                                                When `null`, mint fails closed with 503
 *                                                `streaming_companion_unavailable` instead of
 *                                                handing out a token that only fails at attach.
 * @param {Function} deps.makeBrowserSessionId optional id minter for tests
 * @param {Function} deps.now                  optional clock for tests
 * @param {Function} deps.emitTimelineEvent    optional override for tests; defaults to emitSpineEvent
 */
export function registerStreamingRoutes({
  app,
  controller,
  ownerAuth,
  streamingSessions,
  companionFactory,
  makeBrowserSessionId,
  now = () => Date.now(),
  emitTimelineEvent = emitSpineEvent,
}) {
  if (!app || !ownerAuth || !streamingSessions) {
    throw new Error('registerStreamingRoutes: missing dependency');
  }
  if (companionFactory != null && typeof companionFactory !== 'function') {
    throw new Error('registerStreamingRoutes: companionFactory must be a function or null');
  }

  // Companion instances by browser_session_id. One companion per pending
  // interaction; reused for the SSE attach + input POSTs while the session is
  // alive.
  const companions = new Map();

  function getCompanion(browser_session_id) {
    return companions.get(browser_session_id) || null;
  }

  async function destroyCompanion(browser_session_id) {
    const companion = companions.get(browser_session_id);
    if (!companion) return;
    companions.delete(browser_session_id);
    try {
      await companion.stop();
    } catch {
      // Best-effort teardown: companion errors must not bubble out of cleanup.
    }
  }

  async function emit(event_type, payload) {
    try {
      await emitTimelineEvent({
        event_type,
        actor_type: 'reference',
        actor_id: 'run-interaction-stream',
        object_type: 'run',
        object_id: payload.run_id,
        run_id: payload.run_id,
        interaction_id: payload.interaction_id,
        status: payload.status || 'started',
        data: payload.data || {},
      });
    } catch {
      // Spine emit best-effort: refusing to mint over a logging error would
      // give worse UX than a missing diagnostic event.
    }
  }

  // ── Mint ──────────────────────────────────────────────────────────────────
  app.post(
    '/_ref/runs/:runId/run-interaction-stream',
    ownerAuth.requireOwnerSession,
    async (req, res) => {
      try {
        if (!controller || typeof controller.getPendingInteraction !== 'function') {
          return pdppError(res, 404, 'not_found', 'Controller is not configured on this server');
        }
        const runId = safeRunId(req);
        const body = req.body || {};
        const interactionId = String(body.interaction_id || '').trim();
        if (!interactionId) {
          return pdppError(res, 400, 'invalid_request', 'interaction_id is required', 'interaction_id');
        }
        const pending = controller.getPendingInteraction(runId);
        if (!pending) {
          return pdppError(res, 409, 'no_pending_interaction', 'No pending interaction for this run');
        }
        if (pending.interaction_id !== interactionId) {
          return pdppError(
            res,
            409,
            'interaction_id_mismatch',
            `Pending interaction is ${pending.interaction_id}, not ${interactionId}`,
            'interaction_id',
          );
        }
        // Streaming companion is for `manual_action` — the only kind that needs
        // browser control rather than a credential/OTP form. The historical
        // `host_browser_required` kind was retired with the host-browser bridge
        // in `introduce-local-collector-runner`; surface a clear error if any
        // legacy connector still emits it.
        if (pending.kind !== 'manual_action') {
          return pdppError(
            res,
            409,
            'stream_not_supported_for_kind',
            `Streaming is not supported for interaction kind ${pending.kind}`,
          );
        }
        // Fail closed when no real CDP companion is configured. The viewer
        // must not receive a token that only errors at attach time; that
        // makes the dashboard primary action a dead button.
        if (typeof companionFactory !== 'function') {
          return pdppError(
            res,
            503,
            'streaming_companion_unavailable',
            'Streaming companion is not configured on this server. Set PDPP_RUN_INTERACTION_CDP_WS_URL or inject a streamingCompanionFactory to enable run-interaction streaming.',
          );
        }
        const viewport = pickViewport(body.viewport);
        const browser_session_id =
          (typeof makeBrowserSessionId === 'function' ? makeBrowserSessionId() : null) ||
          `bs_${Math.floor(now()).toString(36)}_${Math.random().toString(36).slice(2, 8)}`;

        const { token, session } = streamingSessions.mint({
          run_id: runId,
          interaction_id: interactionId,
          browser_session_id,
          viewport,
        });

        // Build companion eagerly; the SSE attach reuses it. companionFactory
        // is the seam tests use to substitute the deterministic mock.
        const companion = companionFactory({
          run_id: runId,
          interaction_id: interactionId,
          browser_session_id,
        });
        companions.set(browser_session_id, companion);

        await emit('run.stream_session_requested', {
          run_id: runId,
          interaction_id: interactionId,
          status: 'started',
          data: {
            browser_session_id,
            expires_at_ms: session.expires_at,
            viewport,
            kind: pending.kind,
          },
        });

        return res.status(201).json({
          object: 'run_interaction_stream_session',
          run_id: runId,
          interaction_id: interactionId,
          browser_session_id,
          token,
          expires_at_ms: session.expires_at,
          viewer_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/events`,
          input_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/input`,
          viewport_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/viewport`,
          close_path: `/_ref/run-interaction-streams/${encodeURIComponent(token)}/close`,
        });
      } catch (err) {
        return pdppError(res, 500, 'api_error', err.message || 'mint failed');
      }
    },
  );

  // ── SSE attach (token-only) ───────────────────────────────────────────────
  app.get('/_ref/run-interaction-streams/:token/events', async (req, res) => {
    let session;
    try {
      session = streamingSessions.attach({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_consumed' ? 409 : err.code === 'session_expired' ? 410 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }

    res.hijack();
    const raw = res.raw;
    raw.statusCode = 200;
    raw.setHeader('Content-Type', 'text/event-stream');
    raw.setHeader('Cache-Control', 'no-cache, no-transform');
    raw.setHeader('Connection', 'keep-alive');
    raw.setHeader('X-Accel-Buffering', 'no');
    raw.flushHeaders?.();

    function writeEvent(name, data) {
      raw.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`);
    }

    writeEvent('attached', {
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      browser_session_id: session.browser_session_id,
      viewport: session.viewport,
    });

    const unsubscribe = companion.onFrame((frame) => {
      writeEvent('frame', {
        session_id: frame.sessionId,
        data_base64: frame.data,
        metadata: frame.metadata || null,
      });
      // CDP `Page.startScreencast` only delivers the next frame after the
      // previous one is acknowledged. Without this ack the stream stalls
      // after the first frame against a real Chromium. Best-effort: a
      // failed ack must not crash the SSE response (the next frame's ack
      // can recover, and if the companion really is gone, teardown will
      // fire from the close handler).
      if (Number.isFinite(frame.sessionId) && typeof companion.ackFrame === 'function') {
        Promise.resolve(companion.ackFrame(frame.sessionId)).catch(() => {
          /* best-effort ack; surfaced via companion logger if configured */
        });
      }
    });

    let closed = false;
    async function teardown(reason) {
      if (closed) return;
      closed = true;
      try {
        unsubscribe();
      } catch {
        /* unsubscribe best-effort */
      }
      streamingSessions.invalidate({
        run_id: session.run_id,
        interaction_id: session.interaction_id,
        reason,
      });
      await emit('run.stream_session_resolved', {
        run_id: session.run_id,
        interaction_id: session.interaction_id,
        status: 'completed',
        data: { browser_session_id: session.browser_session_id, reason },
      });
      await destroyCompanion(session.browser_session_id);
      try {
        raw.end();
      } catch {
        /* socket may already be gone */
      }
    }

    req.raw.on('close', () => {
      teardown('viewer_disconnected');
    });

    try {
      await companion.start(session.viewport || null);
    } catch (err) {
      writeEvent('error', { code: err.code || 'companion_start_failed', message: err.message });
      teardown('companion_start_failed');
      return;
    }

    await emit('run.stream_session_opened', {
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      status: 'started',
      data: { browser_session_id: session.browser_session_id, viewport: session.viewport },
    });
  });

  // ── Input dispatch (token-only) ───────────────────────────────────────────
  app.post('/_ref/run-interaction-streams/:token/input', async (req, res) => {
    let session;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_not_attached' ? 409 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }
    try {
      await companion.dispatch(req.body || {});
    } catch (err) {
      return pdppError(res, 400, err.code || 'invalid_input', err.message);
    }
    return res.status(202).json({ object: 'run_interaction_stream_input_ack' });
  });

  // ── Viewport (token-only) ────────────────────────────────────────────────
  app.post('/_ref/run-interaction-streams/:token/viewport', async (req, res) => {
    let session;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_not_attached' ? 409 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    const viewport = pickViewport(req.body || {});
    if (!viewport) {
      return pdppError(res, 400, 'invalid_request', 'viewport.width and viewport.height are required', 'viewport');
    }
    const companion = getCompanion(session.browser_session_id);
    if (!companion) {
      return pdppError(res, 410, 'companion_unavailable', 'Streaming companion is no longer attached');
    }
    try {
      await companion.dispatch({ type: 'viewport', ...viewport });
    } catch (err) {
      return pdppError(res, 400, err.code || 'invalid_input', err.message);
    }
    return res.status(202).json({ object: 'run_interaction_stream_viewport_ack', viewport });
  });

  // ── Close (token-only) ────────────────────────────────────────────────────
  app.post('/_ref/run-interaction-streams/:token/close', async (req, res) => {
    let session;
    try {
      session = streamingSessions.authorize({ token: req.params.token });
    } catch (err) {
      const status = err.code === 'session_not_attached' ? 409 : 401;
      return pdppError(res, status, err.code || 'invalid_token', err.message);
    }
    streamingSessions.invalidate({
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      reason: 'viewer_closed',
    });
    await emit('run.stream_session_resolved', {
      run_id: session.run_id,
      interaction_id: session.interaction_id,
      status: 'completed',
      data: { browser_session_id: session.browser_session_id, reason: 'viewer_closed' },
    });
    await destroyCompanion(session.browser_session_id);
    return res.status(202).json({ object: 'run_interaction_stream_close_ack' });
  });

  return {
    /**
     * Hook for the controller to call when an interaction resolves or the run
     * ends. Invalidates the token and tears down the companion if any.
     */
    async invalidateForInteractionResolved({ run_id, interaction_id, reason }) {
      const summary = streamingSessions.getSummary({ run_id, interaction_id });
      if (!summary) return;
      streamingSessions.invalidate({ run_id, interaction_id, reason: reason || 'interaction_resolved' });
      await emit('run.stream_session_resolved', {
        run_id,
        interaction_id,
        status: 'completed',
        data: { browser_session_id: summary.browser_session_id, reason: reason || 'interaction_resolved' },
      });
      await destroyCompanion(summary.browser_session_id);
    },
    _internal: { companions, getCompanion },
  };
}
