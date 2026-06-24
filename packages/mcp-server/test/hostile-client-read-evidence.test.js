import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createPdppMcpServer } from '../src/server.js';

function jsonResponse(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

async function connectClient(fakeFetch) {
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch: fakeFetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'hostile-client-test', version: '0.0.0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, server };
}

function textContent(result) {
  return result.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}

function hostileSearchFixture() {
  const calls = [];
  const messageText =
    'LayerZero was the primary bridge path. Hyperlane Bridge + Validator stayed as fallback support.';
  const searchWindowText = `${'Transfer timing depends on signed contracts and validator handoff. '.repeat(3)}Hyperlane Bridge + Validator stayed as fallback support.`;
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ method: init.method ?? 'GET', url: url.toString() });
    if (init.headers?.Authorization !== 'Bearer scoped-token') {
      return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/v1/search') {
      if (url.searchParams.get('q') === 'metadata-only') {
        return jsonResponse({
          hits: [
            {
              id: 'slack-metadata',
              stream: 'messages',
              record_key: 'm-meta',
              connection_id: 'cin_slack',
              connector_key: 'slack',
              display_name: 'Vana Slack',
              title: 'Slack metadata hit',
              field_windows: [
                {
                  field_path: 'display_name',
                  preview_status: 'complete',
                  size_chars: 10,
                  resource_uri: 'pdpp://field-window/metadata-display-name',
                },
              ],
            },
          ],
        });
      }

      if (url.searchParams.get('q') === 'record-uri-only') {
        return jsonResponse({
          hits: [
            {
              record_uri: 'pdpp://record/cin_slack%2Fmessages%3Am1',
              connector_key: 'slack',
              display_name: 'Vana Slack',
              evidence_excerpts: [
                {
                  field_path: 'text',
                  preview_text: 'Hyperlane Bridge + Validator stayed as fallback support.',
                  preview_status: 'truncated',
                  complete: false,
                },
              ],
            },
          ],
        });
      }

      return jsonResponse({
        hits: [
          {
            id: 'slack-msg-1',
            stream: 'messages',
            record_key: 'm1',
            connection_id: 'cin_slack',
            connector_key: 'slack',
            display_name: 'Vana Slack',
            match_windows: [
              {
                field_path: 'text',
                text: searchWindowText,
                start_chars: 37,
                end_chars: 93,
                complete: false,
                next_cursor: 'fw_next_1',
                read: {
                  tool: 'read_record_field',
                  args: {
                    connection_id: 'cin_slack',
                    stream: 'messages',
                    record_id: 'm1',
                    field_path: 'text',
                    offset_chars: 37,
                    limit_chars: 256,
                  },
                },
                resource_uri: 'pdpp://field-window/proven-text-window',
              },
            ],
          },
        ],
      });
    }

    if (url.pathname === '/v1/streams/messages/records/m1') {
      return jsonResponse({
        object: 'document',
        id: 'cin_slack/messages:m1',
        title: 'Vana Slack / messages / m1',
        text: messageText,
        metadata: {
          connection_id: 'cin_slack',
          connector_key: 'slack',
          stream: 'messages',
          record_id: 'm1',
        },
      });
    }

    if (url.pathname === '/v1/streams/messages/records/m1/field-window') {
      return jsonResponse({
        object: 'field_window',
        stream: 'messages',
        record_id: 'm1',
        connection_id: 'cin_slack',
        field: { path: url.searchParams.get('field') ?? 'text', type: 'string' },
        window: {
          text: messageText.slice(37),
          start_chars: 37,
          end_chars: messageText.length,
          limit_chars: Number.parseInt(url.searchParams.get('limit_chars') ?? '256', 10),
          total_chars: messageText.length,
          complete: true,
          has_more: false,
        },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { calls, fetch };
}

function hostileContinuationFixture() {
  const calls = [];
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ method: init.method ?? 'GET', url: url.toString() });
    if (init.headers?.Authorization !== 'Bearer scoped-token') {
      return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }

    if (url.pathname === '/v1/streams/messages/records/m-large/field-window') {
      return jsonResponse({
        object: 'field_window',
        stream: 'messages',
        record_id: 'm-large',
        connection_id: 'cin_slack',
        field: { path: url.searchParams.get('field') ?? 'text', type: 'string' },
        window: {
          text: 'middle field window',
          start_chars: 1000,
          end_chars: 1256,
          limit_chars: Number.parseInt(url.searchParams.get('limit_chars') ?? '256', 10),
          total_chars: 4096,
          complete: false,
          has_more: true,
          next_offset_chars: 1256,
          previous_offset_chars: 744,
        },
      });
    }

    return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };

  return { calls, fetch };
}

test('hostile content-only search exposes proven matched text and tool continuation', async () => {
  const { fetch } = hostileSearchFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: {
      q: 'hyperlane',
      streams: ['messages'],
      connection_id: 'cin_slack',
      limit: 1,
    },
  });
  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError, undefined);
  assert.match(visible, /Hyperlane/);
  assert.match(visible, /Evidence excerpts:/);
  assert.ok(visible.indexOf('Evidence excerpts:') < visible.indexOf('Top results:'), 'evidence must precede generic result wrappers');
  assert.doesNotMatch(visible, /<<ccr:/);
  assert.match(visible, /field_path=text/);
  assert.match(visible, /read_record_field/);
  assert.match(visible, /offset_chars=37/);
  assert.match(visible, /cin_slack\/messages:m1/);
  assert.match(
    result.structuredContent.results[0].evidence_excerpts[0].preview_text,
    /Hyperlane/
  );
  const ladderRecord = result.structuredContent.content_ladder.records[0];
  assert.match(
    ladderRecord.evidence_excerpts[0].preview_text,
    /Hyperlane/
  );
  assert.match(
    ladderRecord.field_windows.find((field) => field.field_path === 'text').preview_text,
    /Hyperlane/
  );
  const readArgs = ladderRecord.field_windows.find((field) => field.field_path === 'text').read.args;
  assert.equal(readArgs.id, 'cin_slack/messages:m1');
  assert.equal(readArgs.connection_id, undefined);
  assert.equal(readArgs.stream, undefined);
  assert.equal(readArgs.record_id, undefined);
  assert.equal(readArgs.field_path, 'text');
  assert.equal(readArgs.offset_chars, 37);
  assert.equal(
    result.content.some((part) => part.type === 'resource_link'),
    false,
    'search evidence must not depend on hosted-client resource/file materialization'
  );
  assert.doesNotMatch(JSON.stringify(result.structuredContent.results), /pdpp:\/\/field-window\//);
  assert.doesNotMatch(JSON.stringify(result.structuredContent.content_ladder), /pdpp:\/\/field-window\//);
});

test('metadata-only search hit does not invent a body match', async () => {
  const { fetch } = hostileSearchFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'search',
    arguments: {
      q: 'metadata-only',
      streams: ['messages'],
      connection_id: 'cin_slack',
      limit: 1,
    },
  });
  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError, undefined);
  assert.match(visible, /slack-metadata/);
  assert.doesNotMatch(visible, /field_path=text/);
  assert.doesNotMatch(visible, /message body/i);
  assert.match(visible, /fetch/);
  assert.equal(result.structuredContent.results[0].evidence_excerpts, undefined);
  assert.equal(result.structuredContent.content_ladder.records[0].evidence_excerpts, undefined);
  assert.equal(
    result.structuredContent.content_ladder.records[0].field_windows.some((field) => field.preview_text),
    false
  );
});

test('read_record_field is an inline small-text fallback, not a resource-only path', async () => {
  const { fetch } = hostileSearchFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'read_record_field',
    arguments: {
      id: 'cin_slack/messages:m1',
      field_path: 'text',
      offset_chars: 37,
      limit_chars: 256,
    },
  });
  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError, undefined);
  assert.match(visible, /Hyperlane Bridge \+ Validator stayed as fallback support/);
  assert.match(visible, /complete=true/);
  assert.equal(
    result.content.some((part) => part.type === 'text' && part.text.includes('Hyperlane Bridge + Validator')),
    true,
    'ordinary small text inspection must be inline, not resource-only'
  );
  assert.equal(
    result.content.some((part) => part.type === 'resource_link'),
    false,
    'ordinary small text inspection must not trigger resource/file materialization'
  );
  assert.match(result.structuredContent.resource.uri, /^pdpp:\/\/field-window\//);
  assert.match(result._meta.resource.uri, /^pdpp:\/\/field-window\//);
});

test('read_record_field incomplete windows expose exact visible continuation calls', async () => {
  const { fetch } = hostileContinuationFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'read_record_field',
    arguments: {
      id: 'cin_slack/messages:m-large',
      field_path: 'text',
      offset_chars: 1000,
      limit_chars: 256,
    },
  });
  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError, undefined);
  assert.match(visible, /complete=false/);
  assert.match(visible, /next_cursor=1256/);
  assert.match(visible, /previous_cursor=744/);
  assert.match(visible, /next_offset_chars=1256/);
  assert.match(visible, /previous_offset_chars=744/);
  assert.equal(
    visible.includes(
      'next read_record_field args={"id":"cin_slack/messages:m-large","field_path":"text","offset_chars":1256,"limit_chars":256}'
    ),
    true,
    'content-only clients must see the exact next-window tool call args'
  );
  assert.equal(
    visible.includes(
      'previous read_record_field args={"id":"cin_slack/messages:m-large","field_path":"text","offset_chars":744,"limit_chars":256}'
    ),
    true,
    'content-only clients must see the exact previous-window tool call args'
  );
  assert.equal(
    result.content.some((part) => part.type === 'resource_link'),
    false,
    'continuation must not depend on resource/file materialization'
  );
});

test('read_record_field accepts visible record_uri handles', async () => {
  const { fetch, calls } = hostileSearchFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'read_record_field',
    arguments: {
      id: 'pdpp://record/cin_slack%2Fmessages%3Am1',
      field_path: 'text',
      q: 'Hyperlane',
      before_chars: 120,
      after_chars: 120,
      limit_chars: 400,
    },
  });

  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(result.isError, undefined);
  assert.match(visible, /Hyperlane Bridge \+ Validator stayed as fallback support/);
  assert.equal(
    calls.some((call) =>
      call.url.includes('/v1/streams/messages/records/m1/field-window') &&
      call.url.includes('connection_id=cin_slack')
    ),
    true,
    'visible pdpp://record handle must route to the bounded field read'
  );
});

// ─── Client matrix: real RS envelope shape (snippet + evidence_excerpts) ─────

// Mirrors what the deployed RS lexical search actually returns: a hit with
// `snippet` + first-class `evidence_excerpts` and NO pre-normalized
// `match_windows`. The hostile fixtures above hand-build `match_windows`, which
// hid the live blocker; this fixture exercises the real seam.
function realEnvelopeSearchFixture() {
  const calls = [];
  const messageText =
    'Are we going to bridging using Hyperlane or LayerZero? Layer Zero for sure.';
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ method: init.method ?? 'GET', url: url.toString() });
    if (init.headers?.Authorization !== 'Bearer scoped-token') {
      return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/v1/search') {
      return jsonResponse({
        hits: [
          {
            id: 'slack-msg-1',
            stream: 'messages',
            record_key: 'm1',
            connection_id: 'cin_slack',
            connector_key: 'slack',
            display_name: 'Vana Slack',
            snippet: { field: 'text', text: '…using <mark>Hyperlane</mark> or LayerZero?…' },
            evidence_excerpts: [
              {
                object: 'evidence_excerpt',
                field_path: 'text',
                preview_text: '…using Hyperlane or LayerZero?…',
                truncated: true,
                provenance: 'lexical_match',
              },
            ],
          },
        ],
      });
    }
    if (url.pathname === '/v1/streams/messages/records/m1/field-window') {
      return jsonResponse({
        object: 'field_window',
        stream: 'messages',
        record_id: 'm1',
        connection_id: 'cin_slack',
        field: { path: url.searchParams.get('field') ?? 'text', type: 'string' },
        window: {
          text: messageText,
          start_chars: 0,
          end_chars: messageText.length,
          limit_chars: Number.parseInt(url.searchParams.get('limit_chars') ?? '256', 10),
          total_chars: messageText.length,
          complete: true,
          has_more: false,
        },
      });
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch };
}

test('search-visible record_uri is the callable handle for evidence continuations', async () => {
  const { fetch, calls } = hostileSearchFixture();
  const { client, server } = await connectClient(fetch);

  const search = await client.callTool({ name: 'search', arguments: { q: 'record-uri-only' } });
  const visible = textContent(search);

  assert.equal(search.isError, undefined);
  assert.match(visible, /Evidence excerpts:/);
  assert.match(visible, /Hyperlane Bridge \+ Validator stayed as fallback support/);
  assert.equal(
    visible.includes('id=pdpp://record/cin_slack%2Fmessages%3Am1'),
    true,
    'search-visible record_uri must be the canonical result id',
  );
  assert.match(visible, /read=read_record_field/);

  const read = await client.callTool({
    name: 'read_record_field',
    arguments: {
      id: 'pdpp://record/cin_slack%2Fmessages%3Am1',
      field_path: 'text',
      q: 'Hyperlane',
      limit_chars: 400,
    },
  });

  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(read.isError, undefined);
  assert.match(textContent(read), /Hyperlane Bridge \+ Validator stayed as fallback support/);
  assert.equal(
    calls.some(
      (call) =>
        call.url.includes('/v1/streams/messages/records/m1/field-window') &&
        call.url.includes('connection_id=cin_slack'),
    ),
    true,
    'search-visible pdpp://record handle must route to bounded field read',
  );
});

test('content-only client sees matched text from the real RS evidence_excerpts envelope', async () => {
  const { fetch } = realEnvelopeSearchFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({ name: 'search', arguments: { q: 'Hyperlane' } });
  const visible = textContent(result);
  await Promise.allSettled([client.close(), server.close()]);

  // A content-only client (reads only content[]) must see the proven matched
  // text and a tool continuation — not just metadata. This is the live B1 path.
  assert.match(visible, /Evidence excerpts:/);
  assert.match(visible, /Hyperlane or LayerZero/);
  assert.match(visible, /read=read_record_field/);
  // The visible excerpt carries the self-contained fetch id derived from the hit.
  assert.match(visible, /id=cin_slack\/messages:slack-msg-1/);
});

test('resource-less client reaches bounded evidence through tool args alone', async () => {
  const { fetch, calls } = realEnvelopeSearchFixture();
  // A client that declares NO resource capability never calls resources/read.
  const { server } = createPdppMcpServer({
    providerUrl: 'https://provider.test',
    accessToken: 'scoped-token',
    fetch,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'resource-less-client', version: '0.0.0' }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  const search = await client.callTool({ name: 'search', arguments: { q: 'Hyperlane' } });
  const searchVisible = textContent(search);
  // The visible continuation names read_record_field with the self-contained id.
  assert.match(searchVisible, /read=read_record_field/);

  // The resource-less client follows it with a plain tool call (no resources/read).
  const read = await client.callTool({
    name: 'read_record_field',
    arguments: { id: 'cin_slack/messages:m1', field_path: 'text' },
  });
  const readVisible = textContent(read);
  await Promise.allSettled([client.close(), server.close()]);

  assert.equal(read.isError, undefined);
  assert.match(readVisible, /Layer Zero for sure/);
  // No resources/read was needed; only model-callable tools were used.
  assert.equal(
    calls.some((call) => call.url.includes('/field-window')),
    true,
    'resource-less continuation must reach the bounded field read via tool args',
  );
});

test('file-materializing host: small text evidence stays inline, never a resource_link or file', async () => {
  const { fetch } = realEnvelopeSearchFixture();
  const { client, server } = await connectClient(fetch);

  const read = await client.callTool({
    name: 'read_record_field',
    arguments: { id: 'cin_slack/messages:m1', field_path: 'text', limit_chars: 512 },
  });
  await Promise.allSettled([client.close(), server.close()]);

  // Small bounded text must arrive as inline text content. A host that
  // materializes resource_link/file parts must NOT be handed one for small
  // evidence (it would dead-end resource-less and file-averse hosts).
  assert.equal(read.isError, undefined);
  const inlineText = read.content.find((part) => part.type === 'text');
  assert.ok(inlineText, 'small field evidence must include inline text content');
  assert.match(inlineText.text, /Layer Zero for sure/);
  assert.equal(
    read.content.some((part) => part.type === 'resource_link' || part.type === 'resource'),
    false,
    'small inline evidence must not force a resource/file part',
  );
});

// ─── Large-field / blob / JSON escalation (deliberate, not accidental) ───────

function largeDataRecordFixture() {
  const calls = [];
  // Comfortably past the MCP fetch-ladder text window (4096 chars) so the large
  // text field genuinely truncates and must escalate to a bounded window read.
  const bigText = `Pasta order. ${'detail '.repeat(800)}END`;
  const record = {
    object: 'record',
    id: 'rec_big',
    stream: 'orders',
    connection_id: 'conn_orders',
    record_key: 'o9',
    data: {
      id: 'o9',
      text: bigText,
      attachment: { object: 'blob_ref', blob_id: 'blob_9', mime_type: 'image/png', size_bytes: 81234 },
      profile: { name: 'Ada', tags: Array.from({ length: 60 }, (_, i) => `tag-${i}`) },
    },
  };
  const fetch = async (urlInput, init = {}) => {
    const url = new URL(urlInput.toString());
    calls.push({ method: init.method ?? 'GET', url: url.toString() });
    if (init.headers?.Authorization !== 'Bearer scoped-token') {
      return new Response(JSON.stringify({ error: { code: 'invalid_token' } }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url.pathname === '/v1/streams/orders/records/o9') {
      return jsonResponse(record);
    }
    return new Response(JSON.stringify({ error: { code: 'not_found' } }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, fetch, bigText };
}

test('large/binary/JSON fields escalate deliberately: bounded previews, no accidental dumps', async () => {
  const { fetch } = largeDataRecordFixture();
  const { client, server } = await connectClient(fetch);

  const result = await client.callTool({
    name: 'fetch',
    arguments: { id: 'conn_orders/orders:o9' },
  });
  const visible = textContent(result);
  const ladder = result.structuredContent?.content_ladder;
  await Promise.allSettled([client.close(), server.close()]);

  assert.ok(ladder, 'fetch must expose a content ladder');

  // Binary blob: metadata only. The base64/blob bytes must NOT appear inline.
  const binary = ladder.binary_fields?.find((f) => f.field_path === 'attachment');
  assert.ok(binary, 'blob field must be surfaced as binary metadata');
  assert.equal(binary.text_like, false);
  assert.equal(binary.preview_status, 'binary-only');
  assert.doesNotMatch(visible, /blob_9[A-Za-z0-9+/=]{40}/); // no raw blob payload dumped

  // JSON object field: bounded preview + deliberate fetch projection continuation.
  const json = ladder.json_fields?.find((f) => f.field_path === 'profile');
  assert.ok(json, 'JSON object field must be surfaced with a bounded preview');
  assert.equal(json.json_field, true);
  assert.equal(json.read.tool, 'fetch');
  assert.deepEqual(json.read.args.fields, ['profile']);

  // Large text field: bounded window with a read_record_field continuation,
  // never the full body inline.
  const textField = ladder.field_windows?.find((f) => f.field_path === 'text');
  assert.ok(textField, 'large text field must be surfaced as a bounded window');
  assert.equal(textField.preview_status, 'truncated');
  assert.equal(textField.read.tool, 'read_record_field');
  assert.equal(textField.read.args.field_path, 'text');
});
