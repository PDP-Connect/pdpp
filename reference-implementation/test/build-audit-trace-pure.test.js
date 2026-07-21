// Pure, no-DB unit tests for buildAuditTrace in
// server/routes/_owner-connection-helpers.ts. No test imports it by name. It builds
// and attaches the trace context embedded in every owner-connection mutation
// adapter's spine events; the scenario-id conditional, the trace-header write, and
// the {request_id, scenario_id, trace_id} triple assembly are the contract.
//
// The ctx (createTraceContext / ensureRequestId / setReferenceTraceId) is a fake
// recorder so we can assert the exact calls without a server.
//
// Mutation surface:
//   - a string scenario_id -> createTraceContext({ scenarioId }); otherwise
//     createTraceContext() with no argument.
//   - setReferenceTraceId(res, trace.trace_id) sets the response trace header.
//   - returns { request_id: ensureRequestId(res), scenario_id: trace.scenario_id,
//     trace_id: trace.trace_id }.

import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAuditTrace } from '../server/routes/_owner-connection-helpers.ts';

function makeCtx(trace = { trace_id: 'tr-1', scenario_id: 'scn-from-trace' }) {
  const calls = { createTraceContext: [], ensureRequestId: [], setReferenceTraceId: [] };
  const ctx = {
    createTraceContext: (input) => {
      calls.createTraceContext.push(input);
      // echo the scenario id when supplied so we can assert propagation.
      return { trace_id: trace.trace_id, scenario_id: input?.scenarioId ?? trace.scenario_id };
    },
    ensureRequestId: (res) => {
      calls.ensureRequestId.push(res);
      return 'req-generated';
    },
    setReferenceTraceId: (res, id) => {
      calls.setReferenceTraceId.push([res, id]);
    },
  };
  return { ctx, calls };
}

test('buildAuditTrace: a string scenario_id is threaded into createTraceContext', () => {
  const { ctx, calls } = makeCtx();
  const out = buildAuditTrace(ctx, { tokenInfo: { scenario_id: 'scn-9' } }, 'RES');
  assert.deepEqual(calls.createTraceContext, [{ scenarioId: 'scn-9' }], 'scenario id passed to createTraceContext');
  assert.equal(out.scenario_id, 'scn-9', 'trace scenario_id surfaced');
  assert.equal(out.trace_id, 'tr-1');
  assert.equal(out.request_id, 'req-generated');
});

test('buildAuditTrace: no scenario_id calls createTraceContext with NO argument', () => {
  const { ctx, calls } = makeCtx();
  buildAuditTrace(ctx, {}, 'RES');
  assert.deepEqual(calls.createTraceContext, [undefined], 'createTraceContext called with no scenario input');
});

test('buildAuditTrace: a non-string scenario_id is treated as absent', () => {
  const { ctx, calls } = makeCtx();
  buildAuditTrace(ctx, { tokenInfo: { scenario_id: 42 } }, 'RES');
  assert.deepEqual(calls.createTraceContext, [undefined], 'numeric scenario_id ignored');
});

test('buildAuditTrace: sets the reference trace header from the trace context trace_id', () => {
  const { ctx, calls } = makeCtx({ trace_id: 'tr-XYZ', scenario_id: null });
  buildAuditTrace(ctx, {}, 'THE_RES');
  assert.deepEqual(calls.setReferenceTraceId, [['THE_RES', 'tr-XYZ']], 'header set with (res, trace_id)');
});

test('buildAuditTrace: assembles the request_id/scenario_id/trace_id triple', () => {
  const { ctx } = makeCtx({ trace_id: 'tr-A', scenario_id: 'scn-A' });
  const out = buildAuditTrace(ctx, {}, 'RES');
  assert.deepEqual(Object.keys(out).sort(), ['request_id', 'scenario_id', 'trace_id']);
  assert.equal(out.request_id, 'req-generated');
  assert.equal(out.scenario_id, 'scn-A', 'scenario_id comes from the trace context, not the request');
  assert.equal(out.trace_id, 'tr-A');
});
