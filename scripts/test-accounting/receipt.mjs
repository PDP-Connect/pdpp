// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

const RESULT_PREFIX = 'PDPP_TEST_ACCOUNTING_RESULT ';
const EVENT_PREFIX = 'PDPP_TEST_ACCOUNTING_EVENT ';

function fail(message) { throw new Error(`test accounting result: ${message}`); }

export function accountingResultLine(result) { return `${RESULT_PREFIX}${JSON.stringify(result)}`; }
export function accountingEventLine(event) { return `${EVENT_PREFIX}${JSON.stringify(event)}`; }

export function structuredNodeSummary(output) {
  const events = output.split('\n').filter((line) => line.startsWith(EVENT_PREFIX)).map((line) => {
    try { return JSON.parse(line.slice(EVENT_PREFIX.length)); } catch { fail('reporter emitted malformed structured event'); }
  });
  if (events.length === 0) fail('runner emitted no structured node events');
  const skipReasons = {}; let assertions = 0; let passed = 0; let failed = 0; let skipped = 0;
  for (const event of events) {
    if (!['test:pass', 'test:fail'].includes(event.type) || event.details?.type !== 'test') continue;
    assertions += 1;
    const skip = event.details.skip;
    if (skip !== false && skip !== undefined && skip !== null) {
      const reason = typeof skip === 'string' ? skip.trim() : event.details.name?.match(/\(skipped:\s*([^)]+)\)|:\s*skipped\s*\(([^)]+)\)/i)?.slice(1).find(Boolean)?.trim();
      if (!reason) fail(`unexplained skip: ${event.details.name ?? 'unnamed test'}`);
      skipped += 1; skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
    } else if (event.type === 'test:pass') passed += 1;
    else failed += 1;
  }
  return { assertions, passed, failed, skipped, skip_reasons: skipReasons };
}

export function structuredPythonSummary(output, status) {
  const assertions = [...output.matchAll(/Ran (\d+) tests? in /g)].reduce((sum, match) => sum + Number.parseInt(match[1], 10), 0);
  if (assertions === 0) fail('python runner emitted no test count');
  const skipReasons = {};
  for (const match of output.matchAll(/^.+\.\.\. skipped ['"](.+)['"]$/gm)) {
    const reason = match[1].trim();
    if (!reason) fail('python runner emitted an unexplained skip');
    skipReasons[reason] = (skipReasons[reason] ?? 0) + 1;
  }
  const reportedSkips = [...output.matchAll(/skipped=(\d+)/g)].reduce((sum, match) => sum + Number.parseInt(match[1], 10), 0);
  if (reportedSkips !== Object.values(skipReasons).reduce((sum, count) => sum + count, 0)) fail('python runner omitted a skip reason');
  const failed = [...output.matchAll(/(?:failures|errors|unexpected successes)=(\d+)/g)].reduce((sum, match) => sum + Number.parseInt(match[1], 10), 0);
  if (status !== 0 && failed === 0) fail('python runner failed without structured failure count');
  const passed = assertions - failed - reportedSkips;
  if (passed < 0) fail('python runner emitted inconsistent counts');
  return { assertions, passed, failed, skipped: reportedSkips, skip_reasons: skipReasons };
}

export function readStructuredChildResult(output) {
  const lines = output.split('\n').filter((line) => line.startsWith(RESULT_PREFIX));
  if (lines.length !== 1) fail('runner must emit exactly one structured result');
  try { return JSON.parse(lines[0].slice(RESULT_PREFIX.length)); } catch { fail('runner emitted malformed structured result'); }
}

export function repositoryPaths(directory, paths) {
  return paths.map((path) => `${directory}/${path}`.replaceAll('\\', '/')).sort();
}
