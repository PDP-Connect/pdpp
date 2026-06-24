import assert from 'node:assert/strict';
import test from 'node:test';

import {
  binaryFieldMetadata,
  buildRecordContentLadder,
  buildRecordSetContentLadder,
  decodeContentHandle,
  defaultEncodeResourceUri,
  extractRecordRows,
  stableInlineJson,
  summarizeRecordEvidence,
} from '../src/index.js';

test('summarizeRecordEvidence is bounded and exposes continuation facts', () => {
  const text = summarizeRecordEvidence(
    {
      data: [
        { id: 'm1', text: 'a'.repeat(2000) },
        { id: 'm2', text: 'short' },
      ],
      has_more: true,
      next_cursor: 'cursor_2',
      meta: { count: { kind: 'exact', value: 9 } },
    },
    'messages',
    { charLimit: 420 }
  );

  assert.match(text, /^messages: 2 record\(s\)\. has_more=true\./);
  assert.match(text, /next_cursor="cursor_2"/);
  assert.match(text, /count=exact:9/);
  assert.match(text, /record_preview_truncated=true|record\[1\]/);
  assert.ok(text.length <= 520);
});

test('summarizeRecordEvidence gives content-only clients a follow-up path for omitted rows', () => {
  const text = summarizeRecordEvidence(
    {
      records: [
        { id: 'm1', text: 'one' },
        { id: 'm2', text: 'two' },
        { id: 'm3', text: 'three' },
      ],
    },
    'messages',
    { recordLimit: 1 }
  );

  assert.match(text, /more_records=2/);
  assert.match(text, /followup=rerun_cursor_or_limit/);
});

test('buildRecordContentLadder creates stable field-window continuation descriptors', () => {
  const ladder = buildRecordContentLadder({
    id: 'cin_a/messages:m1',
    data: {
      id: 'm1',
      text: 'hello world',
      body: 'body text '.repeat(400),
    },
  });

  assert.equal(ladder.id, 'cin_a/messages:m1');
  assert.equal(ladder.connection_id, 'cin_a');
  assert.equal(ladder.stream, 'messages');
  assert.equal(ladder.record_id, 'm1');
  assert.equal(ladder.field_windows.length, 2);
  assert.equal(ladder.field_windows[0].read.tool, 'read_record_field');
  assert.deepEqual(ladder.field_windows[0].read.args, {
    id: 'cin_a/messages:m1',
    field_path: 'text',
    offset_chars: 0,
    limit_chars: 2048,
  });
  assert.equal(ladder.field_windows[1].preview_status, 'truncated');

  const handle = ladder.field_windows[0].resource_uri.replace('pdpp://field-window/', '');
  assert.equal(decodeContentHandle(handle, 'field-window').field_path, 'text');
});

test('content ladder handles are state, not authorization-bearing provider paths', () => {
  const uri = defaultEncodeResourceUri('field-window', {
    connection_id: 'cin_a',
    stream: 'messages',
    record_id: 'm1',
    field_path: 'text',
  });

  assert.match(uri, /^pdpp:\/\/field-window\//);
  assert.doesNotMatch(uri, /messages:m1/);
  assert.doesNotMatch(uri, /text$/);
});

test('binary fields are metadata-only when record carries server blob affordance', () => {
  const metadata = binaryFieldMetadata('attachment', {
    blob_id: 'blob_1',
    mime_type: 'image/png',
    size_bytes: 12_345,
    digest: 'sha256:abc',
  });

  assert.deepEqual(metadata, {
    field_path: 'attachment',
    binary_field: true,
    text_like: false,
    handle_semantics: 'live_lookup',
    preview_status: 'binary-only',
    blob_id: 'blob_1',
    mime_type: 'image/png',
    digest: 'sha256:abc',
    size_bytes: 12_345,
  });
});

test('base64 binary detection is value-shape based, not field-name semantic guessing', () => {
  const ladder = buildRecordContentLadder({
    id: 'cin_a/files:f1',
    data: {
      opaque_payload: 'QUJD'.repeat(80),
    },
  });

  assert.equal(ladder.binary_fields[0].field_path, 'opaque_payload');
  assert.equal(ladder.binary_fields[0].encoding, 'base64');
  assert.equal(ladder.field_windows.length, 0);
});

test('large text gets a bounded continuation while binary stays metadata-only', () => {
  const ladder = buildRecordContentLadder({
    id: 'cin_a/files:f2',
    data: {
      body: 'investigation note '.repeat(300),
      opaque_payload: 'QUJD'.repeat(80),
    },
  });
  assert.equal(ladder.field_windows.length, 1);
  assert.equal(ladder.field_windows[0].field_path, 'body');
  assert.equal(ladder.field_windows[0].preview_status, 'truncated');
  assert.deepEqual(ladder.field_windows[0].read, {
    tool: 'read_record_field',
    args: {
      id: 'cin_a/files:f2',
      field_path: 'body',
      offset_chars: 0,
      limit_chars: 2048,
    },
  });
  assert.equal(ladder.binary_fields.length, 1);
  assert.equal(ladder.binary_fields[0].field_path, 'opaque_payload');
  assert.equal(ladder.binary_fields[0].preview_status, 'binary-only');
});

test('JSON object fields get bounded previews and fetch projection continuation', () => {
  const ladder = buildRecordContentLadder(
    {
      id: 'cin_a/files:f3',
      data: {
        profile: { name: 'Ada', tags: Array.from({ length: 80 }, (_, i) => `tag-${i}`) },
      },
    },
    { jsonPreviewChars: 120 },
  );

  assert.equal(ladder.json_fields.length, 1);
  assert.equal(ladder.json_fields[0].field_path, 'profile');
  assert.equal(ladder.json_fields[0].json_field, true);
  assert.equal(ladder.json_fields[0].text_like, false);
  assert.equal(ladder.json_fields[0].preview_status, 'truncated');
  assert.ok(ladder.json_fields[0].preview_text.length <= 120);
  assert.deepEqual(ladder.json_fields[0].read, {
    tool: 'fetch',
    args: {
      id: 'cin_a/files:f3',
      fields: ['profile'],
    },
  });
});

test('record set ladder is generic and does not infer connector semantics', () => {
  const ladder = buildRecordSetContentLadder({
    records: [
      { id: 'cin_a/chatgpt.messages:r1', data: { content: 'hello', role: 'user' } },
      { id: 'cin_a/gmail.messages:r2', data: { subject: 'hi', from: 'a@example.test' } },
    ],
  });

  assert.equal(ladder.kind, 'record_set');
  assert.equal(ladder.read_tool, 'read_record_field');
  assert.deepEqual(
    ladder.records.map((record) => record.stream),
    ['chatgpt.messages', 'gmail.messages']
  );
  assert.ok(ladder.records.every((record) => !('title' in record)));
});

test('record row extraction covers canonical list envelope shapes', () => {
  assert.deepEqual(extractRecordRows([{ id: 'a' }]), [{ id: 'a' }]);
  assert.deepEqual(extractRecordRows({ records: [{ id: 'b' }] }), [{ id: 'b' }]);
  assert.deepEqual(extractRecordRows({ data: [{ id: 'c' }] }), [{ id: 'c' }]);
  assert.deepEqual(extractRecordRows({ data: { records: [{ id: 'd' }] } }), [{ id: 'd' }]);
});

test('stableInlineJson preserves authored key order for readable previews', () => {
  assert.equal(stableInlineJson({ z: 1, a: { b: 2, a: 1 } }), '{"z":1,"a":{"b":2,"a":1}}');
});
