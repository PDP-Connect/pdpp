import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

// Service durability — the documented systemd unit is the artifact operators
// copy onto a durable host. The collector itself is a `Type=oneshot` run that
// scans local source files (a very large active Codex session, say); the
// connector runtime streams the tail so a healthy run stays small, but the host
// supervisor — not the package — owns the resource ceiling that keeps a
// regression or a pathological source from taking the machine down. An uncapped
// unit is exactly what produced a multi-gigabyte service peak that had to be
// killed by hand. This test fails if the documented `[Service]` block ever
// loses the load-bearing cgroup limits, so the durability guidance cannot
// silently regress back to an uncapped example.
//
// See docs/reference/local-collector.md §systemd and
// openspec/specs/reference-implementation-architecture/spec.md
// "Reference local collector scheduling SHALL remain host-supervisor-owned".

const DOC_URL = new URL('../../../docs/reference/local-collector.md', import.meta.url);

/**
 * Extract the first fenced ```ini block in `docs/reference/local-collector.md` that
 * declares a `[Service]` section — that is the systemd service example
 * operators copy. Kept deliberately literal (a fence + section scan, no INI
 * dependency) so the test asserts the exact published shape.
 */
async function loadSystemdServiceBlock() {
  const doc = await readFile(DOC_URL, 'utf8');
  const iniBlocks = [...doc.matchAll(/```ini\n([\s\S]*?)```/g)].map((m) => m[1]);
  const serviceBlock = iniBlocks.find((block) => block.includes('[Service]'));
  if (!serviceBlock) {
    throw new Error(
      'docs/reference/local-collector.md no longer contains an ```ini``` block with a [Service] section'
    );
  }
  return serviceBlock;
}

/** Parse `Key=Value` lines from the `[Service]` section into a map. */
function parseServiceDirectives(serviceBlock) {
  return parseSectionDirectives(serviceBlock, '[Service]');
}

/** Parse `Key=Value` lines from a named INI section into a map. */
function parseSectionDirectives(block, sectionName) {
  const directives = new Map();
  let inSection = false;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('[') && line.endsWith(']')) {
      inSection = line === sectionName;
      continue;
    }
    if (!inSection || !line || line.startsWith('#')) {
      continue;
    }
    const eq = line.indexOf('=');
    if (eq === -1) {
      continue;
    }
    directives.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
  }
  return directives;
}

/**
 * Extract the first fenced ```ini block in the doc that declares a `[Timer]`
 * section — the documented timer example operators copy alongside the
 * `[Service]` unit above.
 */
async function loadSystemdTimerBlock() {
  const doc = await readFile(DOC_URL, 'utf8');
  const iniBlocks = [...doc.matchAll(/```ini\n([\s\S]*?)```/g)].map((m) => m[1]);
  const timerBlock = iniBlocks.find((block) => block.includes('[Timer]'));
  if (!timerBlock) {
    throw new Error(
      'docs/reference/local-collector.md no longer contains an ```ini``` block with a [Timer] section'
    );
  }
  return timerBlock;
}

test('documented systemd [Service] sets a hard memory cap', async () => {
  const directives = parseServiceDirectives(await loadSystemdServiceBlock());
  const memoryMax = directives.get('MemoryMax');
  assert.ok(
    memoryMax,
    'systemd [Service] must set MemoryMax — an uncapped run can consume host memory without bound'
  );
  // Must be a real byte ceiling (e.g. 2G/1536M), never `infinity`, which is the
  // same as no cap.
  assert.match(
    memoryMax,
    /^\d+(\.\d+)?[KMGT]?$/,
    `MemoryMax must be a finite byte size (e.g. 2G), got: ${memoryMax}`
  );
});

test('documented systemd [Service] forbids swap so the cgroup OOM-kills instead of thrashing the host', async () => {
  const directives = parseServiceDirectives(await loadSystemdServiceBlock());
  assert.equal(
    directives.get('MemorySwapMax'),
    '0',
    'MemorySwapMax=0 is the load-bearing line: without it the cgroup spills to swap under pressure and thrashes the whole host instead of failing the one run'
  );
  assert.equal(
    directives.get('OOMPolicy'),
    'kill',
    'OOMPolicy=kill makes the kernel OOM-kill only this run cgroup under memory pressure'
  );
});

test('documented systemd [Service] makes the collector a willing host-wide OOM victim, documented as deliberate', async () => {
  // OOMScoreAdjust raises this run's host-wide OOM "badness" so an unrelated
  // host-wide memory spike sacrifices the durable collector before an
  // interactive app. This is SEPARATE from the cgroup cap (OOMPolicy=kill +
  // MemoryMax + MemorySwapMax handle the run exceeding its OWN budget). It is
  // the line behind "collectors killed under host pressure despite a tiny RSS"
  // looking like a fault when it is expected, durable-by-design behavior — so it
  // must stay positive AND stay documented next to the unit.
  const serviceBlock = await loadSystemdServiceBlock();
  const directives = parseServiceDirectives(serviceBlock);

  const score = directives.get('OOMScoreAdjust');
  assert.ok(score !== undefined, 'systemd [Service] must declare OOMScoreAdjust so victim selection is explicit, not default');
  const parsed = Number(score);
  assert.ok(
    Number.isInteger(parsed) && parsed > 0 && parsed <= 1000,
    `OOMScoreAdjust must be a positive integer (1..1000) so the collector is a preferred host-wide victim, got: ${score}`
  );

  // The line is subtle enough to be mistaken for the cgroup cap, so the unit
  // must carry a comment explaining the host-wide victim semantics. Without
  // this, a future edit could drop or invert it and silently turn an expected
  // sacrifice into an apparent collector failure.
  assert.match(
    serviceBlock,
    /OOMScoreAdjust[\s\S]*?host[\s-]?wide|host[\s-]?wide[\s\S]*?OOMScoreAdjust|#[^\n]*(?:host-wide|preferred[\s-]?victim)[\s\S]*?OOMScoreAdjust/i,
    'the OOMScoreAdjust line must be accompanied by a comment explaining host-wide victim selection'
  );
});

test('documented systemd [Service] bounds oneshot start time and reaps the whole control group on stop', async () => {
  const directives = parseServiceDirectives(await loadSystemdServiceBlock());

  assert.equal(
    directives.has('RuntimeMaxSec'),
    false,
    'RuntimeMaxSec is ignored for Type=oneshot services; use TimeoutStartSec for the collector run wall clock'
  );

  const timeoutStart = directives.get('TimeoutStartSec');
  assert.ok(
    timeoutStart && /^\d+$/.test(timeoutStart) && Number(timeoutStart) > 0,
    `TimeoutStartSec must bound a Type=oneshot collector run to a finite wall clock, got: ${timeoutStart}`
  );

  // control-group kill mode is what guarantees a connector child the collector
  // spawned is reaped with the service, closing the orphaned-child gap on the
  // supervised path.
  assert.equal(
    directives.get('KillMode'),
    'control-group',
    'KillMode=control-group reaps the connector child with the service so nothing is orphaned on stop'
  );
});

test('documented systemd [Service] pins the durable outbox off tmpfs', async () => {
  const directives = parseServiceDirectives(await loadSystemdServiceBlock());
  const queueEnv = [...directives.entries()].find(
    ([key, value]) => key === 'Environment' && value.startsWith('PDPP_COLLECTOR_QUEUE=')
  );
  assert.ok(
    queueEnv,
    'systemd [Service] must pin PDPP_COLLECTOR_QUEUE to a disk-backed path so undrained backlog survives reboot and a tmpfs /tmp never holds collector state'
  );
  assert.ok(
    !queueEnv[1].includes('/tmp/'),
    `PDPP_COLLECTOR_QUEUE must not live under /tmp (tmpfs on many Linux hosts): ${queueEnv[1]}`
  );
});

// Timer durability — OnBootSec=/OnStartupSec=/OnUnitActiveSec= are all
// defined relative to in-memory reference points (boot; service-manager
// start; the timer's own last activation) that a `--user` systemd manager
// restart does not reliably preserve. Per systemd.timer(5), a monotonic
// timer already in the past when the timer unit activates elapses once
// immediately and then has no further trigger from that directive — so
// after a manager restart (session cycling, `systemctl --user restart`, a
// package upgrade) while the machine stays booted, these directives can
// leave the timer permanently dead (`active` with no `NextElapse`) until the
// next machine reboot.
//
// OnStartupSec= was tried first as the fix and looked correct on paper (the
// manager restart IS its reference point), but live acceptance evidence on
// a test laptop after a `daemon-reload` + timer restart showed the same dead
// symptom: `active`, `Trigger: n/a`, next elapse in the past/infinity.
// Replacing it with OnActiveSec=2m — relative to the timer UNIT's own
// activation, re-armed by enable / reload+restart / manager restart —
// immediately produced `active`/`waiting` with a concrete NextElapse ~2
// minutes out under the identical restart procedure. OnUnitInactiveSec=
// carries recurrence from the oneshot service's own completion, which is
// not subject to the same stale in-memory bookkeeping. This test fails if
// the documented `[Timer]` example ever regresses back to any of the three
// manager-restart-fragile directives.
//
// See docs/reference/local-collector.md §systemd, "Why OnBootSec=/
// OnStartupSec=/OnUnitActiveSec= go dead after a manager restart".

test('documented systemd [Timer] survives a user-manager restart (OnActiveSec + OnUnitInactiveSec, not OnBootSec/OnStartupSec/OnUnitActiveSec)', async () => {
  const timerBlock = await loadSystemdTimerBlock();
  const directives = parseSectionDirectives(timerBlock, '[Timer]');

  assert.ok(
    directives.has('OnActiveSec'),
    'documented [Timer] must use OnActiveSec (timer-unit-activation-relative bootstrap) so enable / reload+restart / a user-manager restart all reschedule the initial run'
  );
  assert.ok(
    directives.has('OnUnitInactiveSec'),
    'documented [Timer] must use OnUnitInactiveSec (service-completion-relative recurrence) so recurring runs are not tied to stale in-memory activation bookkeeping'
  );
  assert.equal(
    directives.has('OnBootSec'),
    false,
    'OnBootSec is boot-relative and goes stale-in-the-past after a user-manager restart that does not reboot the machine — do not reintroduce it'
  );
  assert.equal(
    directives.has('OnStartupSec'),
    false,
    'OnStartupSec was tried and failed live acceptance on a test laptop (Trigger: n/a after daemon-reload + timer restart) — do not reintroduce it'
  );
  assert.equal(
    directives.has('OnUnitActiveSec'),
    false,
    'OnUnitActiveSec depends on in-memory last-activation bookkeeping a restarted manager does not have — do not reintroduce it'
  );

  // Persistent= is deliberately absent: per systemd.timer(5) it "only has an
  // effect on timers configured with OnCalendar=", and this timer is purely
  // monotonic (OnActiveSec=/OnUnitInactiveSec=, no OnCalendar=). Asserting a
  // value here would either lock in an inert directive or, worse, imply it
  // provides powered-off catch-up for this timer, which it does not.
  assert.equal(
    directives.has('OnCalendar'),
    false,
    'this timer is documented as purely monotonic — if OnCalendar= is ever added, Persistent=true becomes meaningful and should be reconsidered together with it'
  );
});
