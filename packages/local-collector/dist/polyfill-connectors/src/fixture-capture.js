import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const ARIA_SNAPSHOT_TIMEOUT_MS = 2000;
const LOCATOR_PROBE_TIMEOUT_MS = 1000;
const LOCATOR_PROBE_ARIA_DEPTH = 2;
const safeLabel = (s) => String(s)
    .replace(/[^A-Za-z0-9_.-]/g, "_")
    .slice(0, 120);
function requireProbeMethod(page, key) {
    const method = page[key];
    if (typeof method !== "function") {
        throw new Error(`locator probe page is missing ${String(key)}`);
    }
    return method;
}
function locatorForProbe(page, probe) {
    switch (probe.kind) {
        case "css":
            return page.locator(probe.selector);
        case "label":
            return requireProbeMethod(page, "getByLabel")(probe.text, probe.exact === undefined ? undefined : { exact: probe.exact });
        case "placeholder":
            return requireProbeMethod(page, "getByPlaceholder")(probe.text, probe.exact === undefined ? undefined : { exact: probe.exact });
        case "role": {
            const name = probe.namePattern ? new RegExp(probe.namePattern, probe.nameFlags ?? "i") : probe.name;
            return requireProbeMethod(page, "getByRole")(probe.role, {
                ...(probe.exact === undefined ? {} : { exact: probe.exact }),
                ...(name === undefined ? {} : { name }),
            });
        }
        case "text":
            return requireProbeMethod(page, "getByText")(probe.text, probe.exact === undefined ? undefined : { exact: probe.exact });
        default:
            throw new Error(`unsupported locator probe kind: ${probe.kind ?? "unknown"}`);
    }
}
function probeForReport(probe) {
    const { description: _description, id: _id, kind: _kind, ...rest } = probe;
    return rest;
}
async function captureDomHtml(page, baseDir, label, safe) {
    try {
        const html = await page.content();
        writeFileSync(join(baseDir, "dom", `${safe}.html`), html);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] dom write failed for ${label}: ${message}\n`);
    }
}
async function capturePageMetadata(page, baseDir, label, safe) {
    try {
        const title = await page.title().catch(() => "");
        writeFileSync(join(baseDir, "pages", `${safe}.json`), JSON.stringify({
            captured_at: new Date().toISOString(),
            label,
            title,
            url: page.url(),
        }, null, 2));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] page metadata write failed for ${label}: ${message}\n`);
    }
}
async function captureAriaSnapshot(page, baseDir, label, safe) {
    try {
        const ariaSnapshot = await page.ariaSnapshot({
            depth: Number(process.env.PDPP_CAPTURE_ARIA_DEPTH ?? 8),
            mode: "ai",
            timeout: ARIA_SNAPSHOT_TIMEOUT_MS,
        });
        writeFileSync(join(baseDir, "aria", `${safe}.aria.yml`), ariaSnapshot);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] aria snapshot failed for ${label}: ${message}\n`);
    }
}
async function captureScreenshot(page, baseDir, label, safe) {
    try {
        const screenshot = await page.screenshot({ fullPage: false, type: "png" });
        writeFileSync(join(baseDir, "screenshots", `${safe}.png`), screenshot);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] screenshot write failed for ${label}: ${message}\n`);
    }
}
async function runLocatorProbe(page, probe) {
    const result = {
        id: probe.id,
        kind: probe.kind,
        probe: probeForReport(probe),
    };
    if (probe.description !== undefined) {
        result.description = probe.description;
    }
    try {
        const locator = locatorForProbe(page, probe);
        result.count = await locator.count();
        if (result.count > 0) {
            const first = locator.first();
            result.visible = await first.isVisible();
            result.enabled = await first.isEnabled({ timeout: LOCATOR_PROBE_TIMEOUT_MS }).catch(() => false);
            const ariaSnapshot = await first
                .ariaSnapshot({
                depth: LOCATOR_PROBE_ARIA_DEPTH,
                mode: "ai",
                timeout: LOCATOR_PROBE_TIMEOUT_MS,
            })
                .catch(() => undefined);
            if (ariaSnapshot !== undefined) {
                result.ariaSnapshot = ariaSnapshot;
            }
        }
    }
    catch (err) {
        result.error = err instanceof Error ? err.message : String(err);
    }
    return result;
}
async function writeLocatorProbeReport(page, baseDir, label, safe, results) {
    try {
        writeFileSync(join(baseDir, "locators", `${safe}.json`), JSON.stringify({
            captured_at: new Date().toISOString(),
            label,
            probes: results,
            title: await page.title().catch(() => ""),
            url: page.url(),
        }, null, 2));
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] locator probe write failed for ${label}: ${message}\n`);
    }
}
export function createCaptureSession(connectorName) {
    const alwaysRetain = process.env.PDPP_CAPTURE_FIXTURES === "1";
    const onFailureOnly = process.env.PDPP_CAPTURE_ON_FAILURE === "1";
    if (!(alwaysRetain || onFailureOnly)) {
        return null;
    }
    const keepOnSuccess = alwaysRetain;
    const runId = new Date().toISOString().replace(/[:.]/g, "-");
    const baseDir = join(PACKAGE_ROOT, "fixtures", connectorName, "raw", runId);
    try {
        mkdirSync(join(baseDir, "records"), { recursive: true });
        mkdirSync(join(baseDir, "aria"), { recursive: true });
        mkdirSync(join(baseDir, "dom"), { recursive: true });
        mkdirSync(join(baseDir, "locators"), { recursive: true });
        mkdirSync(join(baseDir, "pages"), { recursive: true });
        mkdirSync(join(baseDir, "screenshots"), { recursive: true });
        mkdirSync(join(baseDir, "traces"), { recursive: true });
        mkdirSync(join(baseDir, "http"), { recursive: true });
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[capture] mkdir failed: ${message}\n`);
        return null;
    }
    let httpSeq = 0;
    let traceCheckpointHook = null;
    let succeeded = false;
    let finalized = false;
    return {
        runId,
        baseDir,
        keepOnSuccess,
        setTraceCheckpointHook(hook) {
            traceCheckpointHook = hook;
        },
        markSucceeded() {
            succeeded = true;
        },
        finalize() {
            if (finalized) {
                return;
            }
            finalized = true;
            if (keepOnSuccess || !succeeded) {
                return;
            }
            try {
                rmSync(baseDir, { force: true, recursive: true });
                process.stderr.write(`[capture] run succeeded; raw capture deleted (${baseDir})\n`);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[capture] cleanup failed for ${baseDir}: ${message}\n`);
            }
        },
        recordRecord(msg) {
            try {
                const file = join(baseDir, "records", `${safeLabel(msg.stream)}.jsonl`);
                appendFileSync(file, `${JSON.stringify(msg.data)}\n`);
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[capture] record write failed: ${message}\n`);
            }
        },
        async captureDom(page, label) {
            const safe = safeLabel(label);
            await captureDomHtml(page, baseDir, label, safe);
            await capturePageMetadata(page, baseDir, label, safe);
            await captureAriaSnapshot(page, baseDir, label, safe);
            await captureScreenshot(page, baseDir, label, safe);
            if (traceCheckpointHook) {
                await traceCheckpointHook(label).catch((err) => {
                    const message = err instanceof Error ? err.message : String(err);
                    process.stderr.write(`[capture] trace checkpoint failed for ${label}: ${message}\n`);
                });
            }
        },
        async captureLocatorProbe(page, label, probes) {
            const safe = safeLabel(label);
            const results = await Promise.all(probes.map((probe) => runLocatorProbe(page, probe)));
            await writeLocatorProbeReport(page, baseDir, label, safe, results);
        },
        captureHttp(label, body, meta = {}) {
            try {
                httpSeq += 1;
                const idx = String(httpSeq).padStart(4, "0");
                const file = join(baseDir, "http", `${idx}-${safeLabel(label)}.json`);
                const payload = { label, meta, body };
                writeFileSync(file, JSON.stringify(payload, null, 2));
            }
            catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                process.stderr.write(`[capture] http write failed for ${label}: ${message}\n`);
            }
        },
    };
}
