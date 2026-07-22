// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

// Unit tests for the pure CDP input-event translator and screencast-param
// builder (server/streaming/cdp-companion.ts).
//
// `mapInputEventToCdp` translates a wire input event into an ordered list of
// CDP commands; `buildScreencastParams` derives clamped screencast params from
// a viewport. Both are pure. Assertions pin the command sequences (a dblclick
// is four events with the right clickCounts), the button map, the printable-vs-
// rawKeyDown branch, the touchEnd empty-touchpoints rule, the invalid-input
// error code, and the quality/dimension clamps.

import { test } from 'node:test';
import { strict as assert } from 'node:assert';

import { buildScreencastParams, mapInputEventToCdp } from '../server/streaming/cdp-companion.ts';

const codeIs = (code) => (err) => err.code === code;

test('mapInputEventToCdp rejects non-object events', () => {
  assert.throws(() => mapInputEventToCdp(null), codeIs('invalid_input'));
  assert.throws(() => mapInputEventToCdp('x'), codeIs('invalid_input'));
  assert.throws(() => mapInputEventToCdp({ type: 'nope' }), codeIs('invalid_input'));
});

test('mouse mousemove dispatches a single mouseMoved with button none', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'mousemove', x: 10, y: 20 });
  assert.deepEqual(cmds, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseMoved', x: 10, y: 20, button: 'none' } },
  ]);
});

test('mouse click is a press then release with clickCount 1', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'click', x: 1, y: 2 });
  assert.equal(cmds.length, 2);
  assert.equal(cmds[0].params.type, 'mousePressed');
  assert.equal(cmds[1].params.type, 'mouseReleased');
  assert.equal(cmds[0].params.clickCount, 1);
});

test('mouse dblclick emits four events ending in clickCount 2', () => {
  const cmds = mapInputEventToCdp({ type: 'mouse', action: 'dblclick', x: 5, y: 6 });
  assert.equal(cmds.length, 4);
  assert.deepEqual(cmds.map((c) => c.params.type), ['mousePressed', 'mouseReleased', 'mousePressed', 'mouseReleased']);
  assert.deepEqual(cmds.map((c) => c.params.clickCount), [1, 1, 2, 2]);
});

test('mouse button map resolves 0/1/2 and falls back to left', () => {
  assert.equal(mapInputEventToCdp({ type: 'mouse', action: 'mousedown', x: 0, y: 0, button: 1 })[0].params.button, 'middle');
  assert.equal(mapInputEventToCdp({ type: 'mouse', action: 'mousedown', x: 0, y: 0, button: 2 })[0].params.button, 'right');
  // Unknown button code falls back to 'left'.
  assert.equal(mapInputEventToCdp({ type: 'mouse', action: 'mousedown', x: 0, y: 0, button: 9 })[0].params.button, 'left');
  // Absent button defaults to 0 → 'left'.
  assert.equal(mapInputEventToCdp({ type: 'mouse', action: 'mousedown', x: 0, y: 0 })[0].params.button, 'left');
});

test('mouse rejects non-finite coordinates and unknown actions', () => {
  assert.throws(() => mapInputEventToCdp({ type: 'mouse', action: 'click', x: 'a', y: 2 }), codeIs('invalid_input'));
  assert.throws(() => mapInputEventToCdp({ type: 'mouse', action: 'wiggle', x: 1, y: 2 }), codeIs('invalid_input'));
});

test('keyboard keydown of a printable char emits keyDown with text', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: 'a' });
  assert.equal(cmds.length, 1);
  assert.equal(cmds[0].params.type, 'keyDown');
  assert.equal(cmds[0].params.text, 'a');
});

test('keyboard keydown of a named key emits rawKeyDown with virtual key code and no text', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: 'Enter' });
  assert.equal(cmds[0].params.type, 'rawKeyDown');
  assert.equal(cmds[0].params.windowsVirtualKeyCode, 13);
  assert.equal(cmds[0].params.nativeVirtualKeyCode, 13);
  assert.equal(cmds[0].params.text, undefined); // named keys carry no text
});

test('keyboard keyup emits keyUp and preserves modifiers', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keyup', key: 'a', modifiers: 2 });
  assert.equal(cmds[0].params.type, 'keyUp');
  assert.equal(cmds[0].params.modifiers, 2);
});

test('keyboard rejects a missing key and unknown action', () => {
  assert.throws(() => mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: '' }), codeIs('invalid_input'));
  assert.throws(() => mapInputEventToCdp({ type: 'keyboard', action: 'hold', key: 'a' }), codeIs('invalid_input'));
});

test('keyboard defaults non-finite modifiers to 0', () => {
  const cmds = mapInputEventToCdp({ type: 'keyboard', action: 'keydown', key: 'a', modifiers: 'nope' });
  assert.equal(cmds[0].params.modifiers, 0);
});

test('touch start/move include the touch point; touchEnd sends empty touchPoints', () => {
  const start = mapInputEventToCdp({ type: 'touch', action: 'touchstart', x: 3, y: 4, id: 7 });
  assert.equal(start[0].params.type, 'touchStart');
  assert.deepEqual(start[0].params.touchPoints, [{ x: 3, y: 4, id: 7 }]);
  const end = mapInputEventToCdp({ type: 'touch', action: 'touchend', x: 3, y: 4 });
  assert.equal(end[0].params.type, 'touchEnd');
  assert.deepEqual(end[0].params.touchPoints, []);
});

test('touch defaults id to 1 and rejects unknown actions', () => {
  const move = mapInputEventToCdp({ type: 'touch', action: 'touchmove', x: 1, y: 1 });
  assert.equal(move[0].params.touchPoints[0].id, 1);
  assert.throws(() => mapInputEventToCdp({ type: 'touch', action: 'tap', x: 1, y: 1 }), codeIs('invalid_input'));
});

test('scroll maps to a mouseWheel with the deltas', () => {
  const cmds = mapInputEventToCdp({ type: 'scroll', x: 1, y: 2, deltaX: 3, deltaY: -4 });
  assert.deepEqual(cmds, [
    { method: 'Input.dispatchMouseEvent', params: { type: 'mouseWheel', x: 1, y: 2, deltaX: 3, deltaY: -4 } },
  ]);
});

test('paste inserts text and rejects a non-string', () => {
  assert.deepEqual(mapInputEventToCdp({ type: 'paste', text: 'hi' }), [
    { method: 'Input.insertText', params: { text: 'hi' } },
  ]);
  assert.throws(() => mapInputEventToCdp({ type: 'paste', text: 42 }), codeIs('invalid_input'));
});

test('viewport emits device-metrics override then restart screencast', () => {
  const cmds = mapInputEventToCdp({ type: 'viewport', width: 800, height: 600 });
  assert.equal(cmds[0].method, 'Emulation.setDeviceMetricsOverride');
  assert.deepEqual(cmds[0].params, { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
  assert.equal(cmds[1].method, 'Page.stopScreencast');
  assert.equal(cmds[2].method, 'Page.startScreencast');
  assert.equal(cmds[2].params.maxWidth, 800);
  assert.equal(cmds[2].params.maxHeight, 600);
});

test('buildScreencastParams clamps quality into [1,100] and floors it', () => {
  assert.equal(buildScreencastParams({ quality: 70 }).quality, 70);
  assert.equal(buildScreencastParams({ quality: 0 }).quality, 1); // below min
  assert.equal(buildScreencastParams({ quality: 500 }).quality, 100); // above max
  assert.equal(buildScreencastParams({ quality: 55.9 }).quality, 55); // floored
});

test('buildScreencastParams uses viewport dimensions when positive, else defaults', () => {
  const withViewport = buildScreencastParams({ viewport: { width: 1024, height: 768 } });
  assert.equal(withViewport.maxWidth, 1024);
  assert.equal(withViewport.maxHeight, 768);
  // Non-positive / missing viewport → 1280x720 defaults.
  const defaults = buildScreencastParams({ viewport: { width: 0, height: -5 } });
  assert.equal(defaults.maxWidth, 1280);
  assert.equal(defaults.maxHeight, 720);
  assert.equal(buildScreencastParams().maxWidth, 1280);
});

test('buildScreencastParams always advertises jpeg every-frame', () => {
  const params = buildScreencastParams({ viewport: { width: 640, height: 480 } });
  assert.equal(params.format, 'jpeg');
  assert.equal(params.everyNthFrame, 1);
});
