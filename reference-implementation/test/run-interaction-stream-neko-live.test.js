import test from 'node:test';
import assert from 'node:assert/strict';

import { createNekoCompanion } from '../server/streaming/neko-adapter.js';

const LIVE_ENABLED = process.env.PDPP_TEST_LIVE_NEKO === '1';
const NEKO_ORIGIN = process.env.PDPP_TEST_LIVE_NEKO_ORIGIN || process.env.NEKO_ORIGIN;

test(
  'live n.eko smoke emits a screenshot frame',
  { skip: LIVE_ENABLED && NEKO_ORIGIN ? false : 'set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run' },
  async () => {
    const companion = createNekoCompanion({
      origin: NEKO_ORIGIN,
      env: process.env,
      pollIntervalMs: 100,
    });
    let firstFrame = null;
    companion.onFrame((frame) => {
      firstFrame ||= frame;
    });

    try {
      await companion.start({ width: 1280, height: 720 });
      const deadline = Date.now() + 10_000;
      while (!firstFrame && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(firstFrame, 'expected n.eko screenshot frame');
      assert.equal(typeof firstFrame.data, 'string');
      assert.ok(firstFrame.data.length > 0);
    } finally {
      await companion.stop();
    }
  },
);

test(
  'live n.eko mobile viewport smoke emits a mobile-shaped screenshot frame',
  { skip: LIVE_ENABLED && NEKO_ORIGIN ? false : 'set PDPP_TEST_LIVE_NEKO=1 and NEKO_ORIGIN to run' },
  async () => {
    const companion = createNekoCompanion({
      origin: NEKO_ORIGIN,
      env: process.env,
      pollIntervalMs: 100,
    });
    let firstFrame = null;
    companion.onFrame((frame) => {
      firstFrame ||= frame;
    });

    try {
      await companion.start({
        width: 390,
        height: 844,
        screenWidth: 390,
        screenHeight: 844,
        deviceScaleFactor: 2,
        mobile: true,
        hasTouch: true,
      });
      const deadline = Date.now() + 10_000;
      while (!firstFrame && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(firstFrame, 'expected n.eko mobile screenshot frame');
      assert.equal(typeof firstFrame.data, 'string');
      assert.ok(firstFrame.data.length > 0);
      assert.equal(firstFrame.metadata.device_width, 390);
      assert.equal(firstFrame.metadata.device_height, 844);
      assert.equal(firstFrame.metadata.page_scale_factor, 2);
    } finally {
      await companion.stop();
    }
  },
);
