function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function parseJsonObject(value) {
  if (value == null || String(value).trim() === '') return {};
  let parsed;
  try {
    parsed = JSON.parse(String(value));
  } catch {
    const err = new Error('data_json must be valid JSON');
    err.code = 'invalid_request';
    err.param = 'data_json';
    throw err;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const err = new Error('data_json must decode to an object');
    err.code = 'invalid_request';
    err.param = 'data_json';
    throw err;
  }
  return parsed;
}

function requireController(controller) {
  if (
    !controller ||
    typeof controller.getPendingInteraction !== 'function' ||
    typeof controller.respondToInteraction !== 'function'
  ) {
    const err = new Error('Controller is not configured on this server');
    err.code = 'not_found';
    throw err;
  }
}

function getPendingOrThrow(controller, runId) {
  const pending = controller.getPendingInteraction(runId);
  if (!pending) {
    const err = new Error(`No pending interaction for run ${runId}`);
    err.code = 'not_found';
    throw err;
  }
  return pending;
}

function renderInboxPage({ pending, error = null }) {
  const runId = escapeHtml(pending.run_id);
  const interactionId = escapeHtml(pending.interaction_id);
  const connectorId = escapeHtml(pending.connector_id);
  const kind = escapeHtml(pending.kind);
  const stream = pending.stream ? escapeHtml(pending.stream) : 'none';
  const errorBlock = error
    ? `<p role="alert" style="color:#b00020">${escapeHtml(error)}</p>`
    : '';

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>PDPP Inbox: ${runId}</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; line-height: 1.5; margin: 2rem; max-width: 46rem; }
    dt { font-weight: 700; }
    dd { margin: 0 0 .75rem; }
    textarea { box-sizing: border-box; display: block; font-family: ui-monospace, SFMono-Regular, monospace; min-height: 8rem; width: 100%; }
    button { margin-top: .75rem; }
    .secondary { margin-top: 2rem; }
  </style>
</head>
<body>
  <main>
    <h1>Pending interaction</h1>
    ${errorBlock}
    <dl>
      <dt>Run</dt><dd><code>${runId}</code></dd>
      <dt>Connector</dt><dd><code>${connectorId}</code></dd>
      <dt>Interaction</dt><dd><code>${interactionId}</code></dd>
      <dt>Kind</dt><dd><code>${kind}</code></dd>
      <dt>Stream</dt><dd><code>${stream}</code></dd>
    </dl>

    <form method="post" action="/_ref/inbox/${encodeURIComponent(pending.run_id)}/respond">
      <input type="hidden" name="interaction_id" value="${interactionId}">
      <label for="data_json">Success data JSON</label>
      <textarea id="data_json" name="data_json" spellcheck="false">{}</textarea>
      <button type="submit">Send success</button>
    </form>

    <form class="secondary" method="post" action="/_ref/inbox/${encodeURIComponent(pending.run_id)}/dismiss">
      <input type="hidden" name="interaction_id" value="${interactionId}">
      <button type="submit">Cancel interaction</button>
    </form>
  </main>
</body>
</html>`;
}

export function registerInboxRoutes(app, { controller, ownerAuth, pdppError, handleError }) {
  app.get('/_ref/inbox/:runId.json', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      requireController(controller);
      const runId = decodeURIComponent(req.params.runId);
      const pending = getPendingOrThrow(controller, runId);
      res.json({ object: 'ref_inbox_item', data: pending });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.get('/_ref/inbox/:runId', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      requireController(controller);
      const runId = decodeURIComponent(req.params.runId);
      const pending = getPendingOrThrow(controller, runId);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.send(renderInboxPage({ pending }));
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/inbox/:runId/respond', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      requireController(controller);
      const runId = decodeURIComponent(req.params.runId);
      const body = req.body || {};
      const interactionId = String(body.interaction_id || '').trim();
      if (!interactionId) {
        return pdppError(res, 400, 'invalid_request', 'interaction_id is required', 'interaction_id');
      }
      const data = parseJsonObject(body.data_json);
      const result = controller.respondToInteraction(runId, {
        interaction_id: interactionId,
        status: 'success',
        data,
      });
      res.status(202).json({
        object: 'run_interaction_ack',
        run_id: runId,
        interaction_id: interactionId,
        status: result.status,
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  app.post('/_ref/inbox/:runId/dismiss', ownerAuth.requireOwnerSession, async (req, res) => {
    try {
      requireController(controller);
      const runId = decodeURIComponent(req.params.runId);
      const body = req.body || {};
      const interactionId = String(body.interaction_id || '').trim();
      if (!interactionId) {
        return pdppError(res, 400, 'invalid_request', 'interaction_id is required', 'interaction_id');
      }
      const result = controller.respondToInteraction(runId, {
        interaction_id: interactionId,
        status: 'cancelled',
      });
      res.status(202).json({
        object: 'run_interaction_ack',
        run_id: runId,
        interaction_id: interactionId,
        status: result.status,
      });
    } catch (err) {
      handleError(res, err);
    }
  });
}
