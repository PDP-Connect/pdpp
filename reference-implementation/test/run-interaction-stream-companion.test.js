/**
 * Unit tests for the streaming companion CDP mapping. The wire shape sent
 * by the viewer is translated to a deterministic CDP command list. These
 * tests pin the translation so a viewer-side change cannot accidentally
 * widen the kinds of commands the runtime will dispatch.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { mapInputEventToCdp, buildScreencastParams, createMockCompanion } from '../server/streaming/cdp-companion.ts';
import { createDefaultStreamingCompanionFactory } from '../server/streaming/companion-factory.ts';

test('mouse mousemove → Input.dispatchMouseEvent (mouseMoved)', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'mousemove', x: 100, y: 200 });
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].method, 'Input.dispatchMouseEvent');
  assert.equal(cmds[0].params.type, 'mouseMoved');
  assert.equal(cmds[0].params.x, 100);
  assert.equal(cmds[0].params.y, 200);
});

test('mouse click → press + release', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'click', x: 10, y: 20, button: 0 });
  assert.deepEqual(
    cmds.map((c) => c.params.type),
    ['mousePressed', 'mouseReleased'],
  );
  assert.equal(cmds[0].params.button, 'left');
});

test('mouse dblclick emits two press/release pairs with clickCount progression', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'dblclick', x: 1, y: 1 });
  assert.equal(cmds.length, 4);
  assert.equal(cmds[0].params.clickCount, 1);
  assert.equal(cmds[1].params.clickCount, 1);
  assert.equal(cmds[2].params.clickCount, 2);
  assert.equal(cmds[3].params.clickCount, 2);
});

test('keyboard printable key sets text and keyDown', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: 'a', code: 'KeyA' });
  assert.equal(cmds[0].method, 'Input.dispatchKeyEvent');
  assert.equal(cmds[0].params.type, 'keyDown');
  assert.equal(cmds[0].params.text, 'a');
});

test('keyboard named key uses rawKeyDown and a virtual key code', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: 'Enter', code: 'Enter' });
  assert.equal(cmds[0].params.type, 'rawKeyDown');
  assert.equal(cmds[0].params.windowsVirtualKeyCode, 13);
  assert.equal(cmds[0].params.text, undefined);
});

test('touch start translates to Input.dispatchTouchEvent with one touch point', () => {
  const cmds = mapInputEventToCdp({ type: 'touch', action: 'touchstart', x: 10, y: 20, id: 1 });
  assert.equal(cmds[0].method, 'Input.dispatchTouchEvent');
  assert.equal(cmds[0].params.type, 'touchStart');
  assert.deepEqual(cmds[0].params.touchPoints, [{ x: 10, y: 20, id: 1 }]);
});

test('touch end emits an empty touchPoints list', () => {
  const cmds = mapInputEventToCdp({ type: 'touch', action: 'touchend', x: 0, y: 0 });
  assert.equal(cmds[0].params.type, 'touchEnd');
  assert.deepEqual(cmds[0].params.touchPoints, []);
});

test('scroll → mouseWheel with deltas', () => {
  const cmds = mapInputEventToCdp({ type: 'scroll', x: 5, y: 6, deltaX: 1, deltaY: -2 });
  assert.equal(cmds[0].params.type, 'mouseWheel');
  assert.equal(cmds[0].params.deltaX, 1);
  assert.equal(cmds[0].params.deltaY, -2);
});

test('viewport → Emulation.setDeviceMetricsOverride and restarts screencast', () => {
  const cmds = mapInputEventToCdp({
    type: 'viewport',
    width: 390,
    height: 844,
    deviceScaleFactor: 3,
    mobile: true,
  });
  assert.deepEqual(
    cmds.map((cmd) => cmd.method),
    ['Emulation.setDeviceMetricsOverride', 'Page.stopScreencast', 'Page.startScreencast'],
  );
  assert.equal(cmds[0].method, 'Emulation.setDeviceMetricsOverride');
  assert.equal(cmds[0].params.width, 390);
  assert.equal(cmds[0].params.height, 844);
  assert.equal(cmds[0].params.deviceScaleFactor, 3);
  assert.equal(cmds[0].params.mobile, true);
  assert.equal(cmds[2].params.maxWidth, 390);
  assert.equal(cmds[2].params.maxHeight, 844);
});

test('unknown event types raise invalid_input', () => {
  assert.throws(
    () => mapInputEventToCdp({ type: 'mouse', action: 'spin', x: 0, y: 0 }),
    (err) => err.code === 'invalid_input',
  );
  assert.throws(
    () => mapInputEventToCdp({ type: 'fly' }),
    (err) => err.code === 'invalid_input',
  );
  assert.throws(
    () => mapInputEventToCdp({ type: 'mouse', action: 'click', x: 'oops', y: 0 }),
    (err) => err.code === 'invalid_input',
  );
});

test('buildScreencastParams clamps quality and applies sane defaults', () => {
  assert.deepEqual(
    buildScreencastParams({ viewport: { width: 1024, height: 768 }, quality: 999 }),
    { format: 'jpeg', quality: 100, maxWidth: 1024, maxHeight: 768, everyNthFrame: 1 },
  );
  assert.deepEqual(
    buildScreencastParams({}),
    { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 },
  );
});

test('mock companion routes pushFrame to subscribers and accumulates dispatched commands', async () => {
  const companion = createMockCompanion({ browser_session_id: 'mock' });
  const seen = [];
  const unsub = companion.onFrame((frame) => seen.push(frame));
  await companion.start({ width: 800, height: 600 });
  companion.pushFrame({ sessionId: 1, data: 'AAAA' });
  unsub();
  companion.pushFrame({ sessionId: 2, data: 'BBBB' });
  assert.equal(seen.length, 1);

  await companion.dispatch({ type: 'mouse', action: 'click', x: 1, y: 1 });
  assert.equal(companion.inputs.length, 1);
  assert.ok(companion.cdpCalls.some((c) => c.method === 'Input.dispatchMouseEvent'));
  assert.ok(companion.cdpCalls.some((c) => c.method === 'Page.startScreencast'));
});

test('resolved companion can resolve n.eko backend before start', async () => {
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => ({
      backend: 'neko',
      base_url: 'http://neko:8080/neko',
    }),
    WebSocketCtor: function FakeWebSocket() {},
    fetchImpl: async () => {
      throw new Error('resolveBackend must not perform network I/O');
    },
  });
  const companion = factory({
    browser_session_id: 'bs_neko',
    interaction_id: 'int_neko',
    run_id: 'run_neko',
  });

  assert.equal(await companion.resolveBackend(), 'neko');
  assert.equal(companion.backend, 'neko');
});

test('resolved companion prefers route-resolved target over legacy registry resolver', async () => {
  const factory = createDefaultStreamingCompanionFactory({
    resolveTargetForInteraction: () => {
      throw new Error('legacy resolver must not run when route supplied a target');
    },
    WebSocketCtor: function FakeWebSocket() {},
    fetchImpl: async () => {
      throw new Error('resolveBackend must not perform network I/O');
    },
  });
  const companion = factory({
    browser_session_id: 'bs_route_target',
    interaction_id: 'asst_route_target',
    run_id: 'run_route_target',
    target: {
      backend: 'neko',
      base_url: 'http://neko:8080/neko',
      interaction_id: 'asst_route_target',
      lease_id: 'lease_route_target',
      profile_key: 'chatgpt:cin_route_target',
      surface_id: 'surface_route_target',
    },
  });

  assert.equal(await companion.resolveBackend(), 'neko');
  assert.equal(companion.backend, 'neko');
});
