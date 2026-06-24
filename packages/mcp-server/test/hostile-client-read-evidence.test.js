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
  assert.equal(result.structuredContent.resource, undefined);
  assert.doesNotMatch(JSON.stringify(result.structuredContent), /pdpp:\/\/field-window\//);
  assert.match(result._meta.resource.uri, /^pdpp:\/\/field-window\//);
});
