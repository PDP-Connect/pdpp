// Static audit: semantic_time misuse + closed-enum fragility across every connector.
// Connector-agnostic by construction - it only reads source text, knows no connector.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
const ROOT = "packages/polyfill-connectors/connectors";

function walk(d, out = []) {
  for (const e of readdirSync(d)) {
    const p = join(d, e);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(e) && !/\.test\.ts$/.test(e)) out.push(p);
  }
  return out;
}

// Patterns that assign a NOW-ish or sentinel value into a semantic time field.
const NOW_ASSIGN = [
  /semantic_time\s*:\s*[^,;\n]*\b(Date\.now\(\)|new Date\(\)\.toISOString\(\)|nowIso|now\(\))/i,
  /semanticTime\s*[:=]\s*[^,;\n]*\b(Date\.now\(\)|new Date\(\)\.toISOString\(\)|nowIso|now\(\))/i,
  /semantic_time\s*:\s*[^,;\n]*\?\?\s*[^,;\n]*\b(Date\.now|new Date|nowIso)/i,
];
const EPOCH_RISK = [/rtime_\w+/, /\*\s*1000\b/, /new Date\(\s*\w*(time|date)\w*\s*\*\s*1000/i];
const CLOSED_ENUM = /z\.enum\(\s*\[([^\]]*)\]/g;

const rows = [];
for (const c of readdirSync(ROOT)) {
  const dir = join(ROOT, c);
  if (!statSync(dir).isDirectory()) continue;
  let files = [];
  try { files = walk(dir); } catch { continue; }
  const findings = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const lines = src.split("\n");
    lines.forEach((ln, i) => {
      for (const re of NOW_ASSIGN) if (re.test(ln)) findings.push({ kind: "SEMTIME_NOW", file: f, line: i + 1, text: ln.trim().slice(0, 100) });
      for (const re of EPOCH_RISK) if (re.test(ln) && /semantic|time|date/i.test(ln)) findings.push({ kind: "EPOCH_SENTINEL_RISK", file: f, line: i + 1, text: ln.trim().slice(0, 100) });
    });
    let m;
    const re = new RegExp(CLOSED_ENUM.source, "g");
    while ((m = re.exec(src))) {
      const vals = m[1].split(",").map(s => s.trim().replace(/["']/g, "")).filter(Boolean);
      if (vals.length > 0) findings.push({ kind: "CLOSED_ENUM", file: f, line: src.slice(0, m.index).split("\n").length, text: `${vals.length} values: ${vals.slice(0, 8).join("|")}` });
    }
  }
  if (findings.length) rows.push({ connector: c, findings });
}

const totals = {};
for (const r of rows) for (const f of r.findings) totals[f.kind] = (totals[f.kind] ?? 0) + 1;
console.log("=== CONNECTOR DATE/ENUM AUDIT ===");
console.log("connectors with findings:", rows.length, "/ 42");
console.log("totals:", JSON.stringify(totals));
for (const kind of ["SEMTIME_NOW", "EPOCH_SENTINEL_RISK", "CLOSED_ENUM"]) {
  const hits = rows.flatMap(r => r.findings.filter(f => f.kind === kind).map(f => ({ ...f, connector: r.connector })));
  if (!hits.length) continue;
  console.log(`\n--- ${kind} (${hits.length}) ---`);
  const byConn = {};
  for (const h of hits) (byConn[h.connector] ??= []).push(h);
  for (const [c, hs] of Object.entries(byConn)) {
    console.log(`  ${c} (${hs.length})`);
    for (const h of hs.slice(0, 3)) console.log(`     ${h.file.split("/").slice(-2).join("/")}:${h.line}  ${h.text}`);
  }
}
