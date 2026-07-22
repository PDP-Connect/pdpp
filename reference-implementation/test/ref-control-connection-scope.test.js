// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REF_CONTROL = fileURLToPath(new URL('../server/ref-control.ts', import.meta.url));

test('connector summaries read schedule evidence through connector_instance_id', async () => {
  const src = await readFile(REF_CONTROL, 'utf8');
  assert.match(
    src,
    /getScheduleFrom\(controller, connectorId, \{ connectorInstanceId \}\)/,
    'listConnectorSummaries must not read schedule evidence by connector type when rendering connection rows',
  );
  assert.match(
    src,
    /getSchedule\(connectorId: string, options\?: \{ readonly connectorInstanceId\?: string \}\)/,
    'controller schedule dependency must expose connection-scoped schedule lookup',
  );
});
