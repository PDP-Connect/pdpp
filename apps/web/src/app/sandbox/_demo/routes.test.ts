import assert from "node:assert/strict";
import test from "node:test";
import { GET as grantTimelineGet } from "../ref/grants/[grantId]/timeline/route.ts";
import { GET as schemaGet } from "../v1/schema/route.ts";
import { GET as searchGet } from "../v1/search/route.ts";
import { GET as recordsListGet } from "../v1/streams/[stream]/records/route.ts";
import { GET as streamDetailGet } from "../v1/streams/[stream]/route.ts";
import { GET as authServerGet } from "../well-known/oauth-authorization-server/route.ts";

const SANDBOX_ISSUER_RE = /\/sandbox$/;
const SANDBOX_AUTHORIZE_RE = /\/sandbox\/authorize$/;

async function jsonOf(res: Response): Promise<unknown> {
  return JSON.parse(await res.text());
}

test("/sandbox/v1/schema returns the schema graph with demo flags", async () => {
  const res = schemaGet();
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-pdpp-demo"), "1");
  const body = (await jsonOf(res)) as { object: string; is_demo: boolean };
  assert.equal(body.object, "schema_graph");
  assert.equal(body.is_demo, true);
});

test("/sandbox/v1/search?q=payroll returns hits", async () => {
  const res = searchGet(new Request("https://example.invalid/sandbox/v1/search?q=payroll"));
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { object: string; total: number; hits: unknown[] };
  assert.equal(body.object, "search_result");
  assert.ok(body.total > 0);
  assert.equal(body.hits.length, body.total);
});

test("/sandbox/v1/streams/:stream returns 404 for unknown stream", async () => {
  const res = await streamDetailGet(new Request("https://example.invalid/sandbox/v1/streams/no_such"), {
    params: Promise.resolve({ stream: "no_such" }),
  });
  assert.equal(res.status, 404);
  const body = (await jsonOf(res)) as { error: string };
  assert.equal(body.error, "not_found");
});

test("/sandbox/v1/streams/pay_statements/records paginates with limit", async () => {
  const res = await recordsListGet(
    new Request("https://example.invalid/sandbox/v1/streams/pay_statements/records?limit=2"),
    { params: Promise.resolve({ stream: "pay_statements" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { data: unknown[]; has_more: boolean };
  assert.equal(body.data.length, 2);
  assert.equal(body.has_more, true);
});

test("/sandbox/_ref/grants/:id/timeline returns ordered events", async () => {
  const res = await grantTimelineGet(
    new Request("https://example.invalid/sandbox/_ref/grants/grant_sb_quill_paystmt/timeline"),
    { params: Promise.resolve({ grantId: "grant_sb_quill_paystmt" }) }
  );
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { events: Array<{ occurred_at: string }> };
  assert.ok(body.events.length >= 3);
  const sorted = [...body.events].sort((a, b) => (a.occurred_at < b.occurred_at ? -1 : 1));
  assert.deepEqual(
    body.events.map((e) => e.occurred_at),
    sorted.map((e) => e.occurred_at)
  );
});

test("/sandbox/.well-known/oauth-authorization-server advertises sandbox endpoints", async () => {
  const res = authServerGet();
  assert.equal(res.status, 200);
  const body = (await jsonOf(res)) as { is_demo: boolean; issuer: string; authorization_endpoint: string };
  assert.equal(body.is_demo, true);
  assert.match(body.issuer, SANDBOX_ISSUER_RE);
  assert.match(body.authorization_endpoint, SANDBOX_AUTHORIZE_RE);
});
