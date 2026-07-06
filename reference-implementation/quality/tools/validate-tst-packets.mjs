// Local validation harness for tst-* test-coverage packets (WORKER AG).
// Read-only: loads each packet YAML with the ENGINE's own parser (hone/lib/yaml.mjs),
// runs the hone reference validator with ctx.repoDir set to reference-implementation/
// (enables the touchset + shared-DB + restore-masks-rc + abs-path lints), and prints
// errors/warnings per file. This mirrors exactly what the executor's `hone` sees.
//
// Usage: node quality/tools/validate-tst-packets.mjs [filename-substring]
//   default validates every quality/packets/*.yaml whose name contains 'tst-'
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseYaml } from '/home/tnunamak/.tmp/minnows-substrate/tools/hone/lib/yaml.mjs';
import { validatePacket } from '/home/tnunamak/.tmp/minnows-substrate/tools/hone/lib/validate-packet.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repoDir = join(here, '..', '..'); // reference-implementation/
const packetsDir = join(here, '..', 'packets');
const filter = process.argv[2] ?? 'tst-';

const files = readdirSync(packetsDir)
  .filter((f) => f.endsWith('.yaml') && f.includes(filter))
  .sort();

let hadError = false;
for (const f of files) {
  const warns = [];
  let p;
  try {
    p = parseYaml(readFileSync(join(packetsDir, f), 'utf8'));
  } catch (e) {
    hadError = true;
    process.stdout.write(`PARSE-FAIL  ${f}: ${e.message}\n`);
    continue;
  }
  const errs = validatePacket(p, { repoDir, warn: (m) => warns.push(m) });
  const absWarns = warns.filter((w) => /absolute path/.test(w));
  const status = errs.length ? 'INVALID' : 'valid';
  if (errs.length) hadError = true;
  process.stdout.write(`${status}  ${f}  (${errs.length} err, ${warns.length} warn, ${absWarns.length} abs-path warn)\n`);
  for (const e of errs) process.stdout.write(`    ERROR: ${e}\n`);
  for (const w of warns) process.stdout.write(`    warn:  ${w}\n`);
}
process.exit(hadError ? 1 : 0);
