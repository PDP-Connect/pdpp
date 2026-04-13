/**
 * Webhook-to-RS Adapter (Experiment)
 *
 * Receives webhook POSTs from a cooperating platform and ingests
 * RECORD messages directly to the PDPP resource server.
 *
 * This is NOT a connector. It does not use the Collection Profile's
 * START/RECORD/STATE/DONE protocol. It uses the RS's ingest endpoint
 * (POST /v1/ingest/{stream}) with an owner token, which is the same
 * endpoint that the connector runtime uses after receiving RECORD
 * messages from a connector process.
 *
 * The experiment tests whether push delivery can be cleanly handled
 * as a runtime/orchestrator concern without needing a companion spec.
 *
 * Status: Experimental (reference architecture, non-normative)
 *
 * Key question this experiment answers:
 * - Does push-to-RS-ingest work without a Push Profile?
 * - What interoperability surface, if any, does the webhook contract create?
 * - Is the ingest endpoint sufficient, or does push delivery need
 *   its own wire-level contract?
 */

import http from 'node:http';
import crypto from 'node:crypto';

/**
 * Create a webhook receiver that ingests records to the RS.
 *
 * @param {object} opts
 * @param {number} opts.port - Port to listen on
 * @param {string} opts.ownerToken - Owner bearer token for RS ingest
 * @param {string} opts.rsUrl - Resource server base URL
 * @param {string} opts.webhookSecret - Shared secret for webhook auth (HMAC-SHA256)
 * @param {object} opts.streamMapping - Maps webhook event types to PDPP stream names
 * @param {function} opts.onRecord - Optional callback for each ingested record
 * @returns {{ server: http.Server, stats: { received: number, ingested: number, errors: number } }}
 */
export function createWebhookAdapter(opts) {
  const {
    port = 9100,
    ownerToken,
    rsUrl = process.env.RS_URL || 'http://localhost:7663',
    webhookSecret,
    streamMapping = {},
    onRecord = () => {},
  } = opts;

  const stats = { received: 0, ingested: 0, errors: 0 };

  const server = http.createServer(async (req, res) => {
    // Only accept POST
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'method_not_allowed' }));
      return;
    }

    // Read body
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf-8');
    stats.received++;

    // Validate webhook signature if secret is configured
    if (webhookSecret) {
      const signature = req.headers['x-webhook-signature'];
      if (!signature || !verifySignature(body, signature, webhookSecret)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_signature' }));
        stats.errors++;
        return;
      }
    }

    // Parse webhook payload
    let payload;
    try {
      payload = JSON.parse(body);
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_json' }));
      stats.errors++;
      return;
    }

    // Map webhook event to PDPP stream
    const eventType = payload.type || payload.event_type || 'unknown';
    const streamName = streamMapping[eventType];
    if (!streamName) {
      // Unknown event type — acknowledge but don't ingest
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ignored', event_type: eventType }));
      return;
    }

    // Transform webhook payload to PDPP RECORD format
    const record = {
      stream: streamName,
      key: payload.id || payload.key || `webhook_${Date.now()}`,
      data: payload.data || payload,
      emitted_at: new Date().toISOString(),
    };

    // Ingest to RS via owner token
    try {
      const ingestUrl = `${rsUrl}/v1/ingest/${streamName}`;
      const ingestRes = await fetch(ingestUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ownerToken}`,
        },
        body: JSON.stringify({ records: [record] }),
      });

      if (!ingestRes.ok) {
        const err = await ingestRes.text();
        stats.errors++;
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'ingest_failed', detail: err }));
        return;
      }

      stats.ingested++;
      onRecord(record);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ingested', stream: streamName, key: record.key }));
    } catch (err) {
      stats.errors++;
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ingest_failed', detail: err.message }));
    }
  });

  server.listen(port, () => {
    process.stderr.write(`[webhook-adapter] listening on :${port}\n`);
  });

  return { server, stats };
}

/**
 * Verify HMAC-SHA256 webhook signature.
 */
function verifySignature(body, signature, secret) {
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expected, 'hex')
    );
  } catch {
    return false;
  }
}

// ─── Observations for the post-experiment memo ──────────────────────────────
//
// After running this experiment, answer:
//
// 1. Did this fit cleanly as runtime/reference architecture?
//    → If the adapter just calls POST /v1/ingest/{stream} with an owner token,
//      and the RS treats webhook-ingested records identically to connector-ingested
//      records, then YES — push delivery is pure runtime. No spec needed.
//
// 2. Did it expose a real interoperability contract?
//    → The webhook contract (event format, signature scheme, stream mapping)
//      is between the cooperating platform and this adapter. It is NOT between
//      two PDPP implementations. Unless multiple PDPP servers need to agree on
//      a webhook format, this stays runtime-local.
//
// 3. What would change this answer?
//    → If a platform says "I will send PDPP-formatted webhooks to any PDPP
//      server" — THEN you need a wire-level contract for the webhook format.
//      That is a Push Delivery Profile. But today, no platform says this.
//
// 4. What is the smallest profile boundary if one is needed?
//    → Define: (a) the webhook payload format (RECORD envelope over HTTP),
//      (b) the endpoint path convention, (c) the authentication scheme,
//      (d) replay protection (idempotency keys), (e) event ordering guarantees.
//      Model after WebSub + IETF SET push delivery (RFC 8935).
