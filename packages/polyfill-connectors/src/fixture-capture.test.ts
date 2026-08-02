// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";

import type { Page } from "playwright";

import {
  createCaptureSession,
  createSafeCaptureSession,
  type LocatorProbePage,
  SAFE_CAPTURE_MAX_BYTES,
  SAFE_CAPTURE_MAX_FILE_BYTES,
  SAFE_CAPTURE_MAX_FILES,
} from "./fixture-capture.ts";

function withEnv<T>(vars: Record<string, string | undefined>, body: () => T): T {
  const previous: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(vars)) {
    previous[k] = process.env[k];
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
  try {
    return body();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  }
}

test("captureDom writes html, aria, page metadata, and screenshot in raw local capture mode", async () => {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  const connectorName = `fixture_capture_test_${process.pid}_${Date.now()}`;
  const capture = createCaptureSession(connectorName);
  assert.ok(capture);

  try {
    const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve('- document:\n  - button "Submit" [ref=e1]'),
      content: () => Promise.resolve("<html><title>Fixture</title><body>ok</body></html>"),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Fixture"),
      url: () => "https://example.test/current",
    };

    await capture.captureDom(page as Page, "page/state:before click");

    const safe = "page_state_before_click";
    assert.equal(
      readFileSync(`${capture.baseDir}/dom/${safe}.html`, "utf8"),
      "<html><title>Fixture</title><body>ok</body></html>"
    );
    const pageMeta = JSON.parse(readFileSync(`${capture.baseDir}/pages/${safe}.json`, "utf8"));
    const { captured_at: capturedAt, ...stableMeta } = pageMeta;
    assert.equal(typeof capturedAt, "string");
    assert.deepEqual(stableMeta, {
      label: "page/state:before click",
      title: "Fixture",
      url: "https://example.test/current",
    });
    assert.equal(
      readFileSync(`${capture.baseDir}/aria/${safe}.aria.yml`, "utf8"),
      '- document:\n  - button "Submit" [ref=e1]'
    );
    assert.equal(readFileSync(`${capture.baseDir}/screenshots/${safe}.png`, "utf8"), "png");
  } finally {
    rmSync(capture.baseDir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
});

test("captureLocatorProbe writes locator counts and first-match state", async () => {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  const connectorName = `fixture_capture_locator_test_${process.pid}_${Date.now()}`;
  const capture = createCaptureSession(connectorName);
  assert.ok(capture);

  try {
    const fakeLocator = {
      ariaSnapshot: () => Promise.resolve('- button "Download" [ref=e2]'),
      count: () => Promise.resolve(1),
      first() {
        return this;
      },
      isEnabled: () => Promise.resolve(true),
      isVisible: () => Promise.resolve(true),
    };
    const page: Pick<LocatorProbePage, "getByRole" | "locator" | "title" | "url"> = {
      getByRole: (role: string, options: unknown) => {
        assert.equal(role, "button");
        assert.deepEqual(options, {
          name: "Download",
        });
        return fakeLocator;
      },
      locator: () => fakeLocator,
      title: () => Promise.resolve("Fixture"),
      url: () => "https://example.test/current",
    };

    await capture.captureLocatorProbe?.(page, "download form", [
      {
        description: "Primary download affordance",
        id: "download-button",
        kind: "role",
        name: "Download",
        role: "button",
      },
    ]);

    const report = JSON.parse(readFileSync(`${capture.baseDir}/locators/download_form.json`, "utf8"));
    const { captured_at: capturedAt, ...stableReport } = report;
    assert.equal(typeof capturedAt, "string");
    assert.deepEqual(stableReport, {
      label: "download form",
      probes: [
        {
          ariaSnapshot: '- button "Download" [ref=e2]',
          count: 1,
          description: "Primary download affordance",
          enabled: true,
          id: "download-button",
          kind: "role",
          probe: {
            name: "Download",
            role: "button",
          },
          visible: true,
        },
      ],
      title: "Fixture",
      url: "https://example.test/current",
    });
  } finally {
    rmSync(capture.baseDir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
});

test("captureDom invokes an optional trace checkpoint hook after page capture", async () => {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  const connectorName = `fixture_capture_hook_test_${process.pid}_${Date.now()}`;
  const capture = createCaptureSession(connectorName);
  assert.ok(capture);

  try {
    const labels: string[] = [];
    capture.setTraceCheckpointHook?.((label) => {
      labels.push(label);
      return Promise.resolve();
    });
    const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve("- document"),
      content: () => Promise.resolve("<html><body>ok</body></html>"),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Fixture"),
      url: () => "https://example.test/current",
    };

    await capture.captureDom(page as Page, "after download click");

    assert.deepEqual(labels, ["after download click"]);
  } finally {
    rmSync(capture.baseDir, { force: true, recursive: true });
    if (previous === undefined) {
      delete process.env.PDPP_CAPTURE_FIXTURES;
    } else {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
});

test("createCaptureSession returns null when raw capture mode is disabled", () => {
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: undefined }, () => {
    assert.equal(createCaptureSession(`fixture_capture_disabled_${process.pid}_${Date.now()}`), null);
  });
});

test("createCaptureSession honors PDPP_CAPTURE_ROOT_DIR", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-capture-root-"));
  withEnv({ PDPP_CAPTURE_FIXTURES: "1", PDPP_CAPTURE_ON_FAILURE: undefined, PDPP_CAPTURE_ROOT_DIR: root }, () => {
    const connectorName = `fixture_capture_custom_root_${process.pid}_${Date.now()}`;
    const capture = createCaptureSession(connectorName);
    assert.ok(capture);
    try {
      assert.equal(capture.baseDir.startsWith(join(root, connectorName, "raw")), true);
      assert.equal(existsSync(`${capture.baseDir}/records`), true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

test("createCaptureSession honors PDPP_CAPTURE_ON_FAILURE=1 with keepOnSuccess=false", () => {
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1" }, () => {
    const capture = createCaptureSession(`fixture_capture_on_failure_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    try {
      assert.equal(capture.keepOnSuccess, false);
    } finally {
      rmSync(capture.baseDir, { force: true, recursive: true });
    }
  });
});

test("PDPP_CAPTURE_FIXTURES wins over PDPP_CAPTURE_ON_FAILURE (always retain)", () => {
  withEnv({ PDPP_CAPTURE_FIXTURES: "1", PDPP_CAPTURE_ON_FAILURE: "1" }, () => {
    const capture = createCaptureSession(`fixture_capture_both_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    try {
      assert.equal(capture.keepOnSuccess, true);
      capture.markSucceeded();
      capture.finalize();
      // Always-retain mode never deletes on success.
      assert.equal(existsSync(capture.baseDir), true);
    } finally {
      rmSync(capture.baseDir, { force: true, recursive: true });
    }
  });
});

test("PDPP_CAPTURE_ON_FAILURE finalize() deletes raw dir on success", async () => {
  await withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1" }, async () => {
    const capture = createCaptureSession(`fixture_capture_on_failure_success_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve("- document"),
      content: () => Promise.resolve("<html><body>ok</body></html>"),
      screenshot: () => Promise.resolve(Buffer.from("png")),
      title: () => Promise.resolve("Fixture"),
      url: () => "https://example.test/page",
    };
    await capture.captureDom(page as Page, "before-success");
    assert.equal(existsSync(capture.baseDir), true);
    assert.equal(existsSync(`${capture.baseDir}/dom/before-success.html`), true);

    capture.markSucceeded();
    capture.finalize();
    assert.equal(existsSync(capture.baseDir), false);

    // Second finalize() is a no-op (still no dir, no throw).
    capture.finalize();
    assert.equal(existsSync(capture.baseDir), false);
  });
});

test("PDPP_CAPTURE_ON_FAILURE finalize() retains raw dir when markSucceeded was not called", async () => {
  await withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1" }, async () => {
    const capture = createCaptureSession(`fixture_capture_on_failure_fail_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    try {
      const page: Pick<Page, "ariaSnapshot" | "content" | "screenshot" | "title" | "url"> = {
        ariaSnapshot: () => Promise.resolve("- document"),
        content: () => Promise.resolve("<html><body>ok</body></html>"),
        screenshot: () => Promise.resolve(Buffer.from("png")),
        title: () => Promise.resolve("Fixture"),
        url: () => "https://example.test/page",
      };
      await capture.captureDom(page as Page, "before-fail");
      assert.equal(existsSync(`${capture.baseDir}/dom/before-fail.html`), true);

      // markSucceeded() NOT called — simulating a failure.
      capture.finalize();
      assert.equal(existsSync(capture.baseDir), true);
      assert.equal(existsSync(`${capture.baseDir}/dom/before-fail.html`), true);
    } finally {
      rmSync(capture.baseDir, { force: true, recursive: true });
    }
  });
});

test("PDPP_CAPTURE_FIXTURES finalize() retains raw dir on success (always-retain)", () => {
  withEnv({ PDPP_CAPTURE_FIXTURES: "1", PDPP_CAPTURE_ON_FAILURE: undefined }, () => {
    const capture = createCaptureSession(`fixture_capture_always_retain_${process.pid}_${Date.now()}`);
    assert.ok(capture);
    try {
      capture.markSucceeded();
      capture.finalize();
      assert.equal(existsSync(capture.baseDir), true);
    } finally {
      rmSync(capture.baseDir, { force: true, recursive: true });
    }
  });
});

function walkFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walkFiles(path));
    } else if (entry.isFile()) {
      out.push(path);
    }
  }
  return out;
}

test("safe capture inventory contains only bounded redacted evidence and deletes its temp run", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-safe-capture-inventory-"));
  const connectorName = `safe_inventory_${process.pid}_${Date.now()}`;
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1", PDPP_CAPTURE_ROOT_DIR: root }, () => {
    const capture = createSafeCaptureSession(connectorName);
    assert.ok(capture);
    try {
      for (const forbiddenMethod of [
        "captureDom",
        "captureHttp",
        "captureLocatorProbe",
        "recordRecord",
        "setTraceCheckpointHook",
      ]) {
        assert.equal(forbiddenMethod in capture, false, `${forbiddenMethod} must not be reachable from safe mode`);
        assert.equal(typeof Reflect.get(capture, forbiddenMethod), "undefined");
      }
      assert.deepEqual(Object.keys(capture).sort(), [
        "baseDir",
        "captureSafe",
        "finalize",
        "inventory",
        "keepOnSuccess",
        "markSucceeded",
        "mode",
        "runId",
      ]);

      const surfacePayload = {
        capture_state: "captured",
        candidate_count: 10_000_000,
        candidates: [
          {
            aria_disabled: false,
            class_tokens: "as_credit__utility-bar-item as_credit__export account-123456 token=SECRET",
            disabled: false,
            kind: "export",
            role: "button",
            tag: "BUTTON",
            text: "Export account ACCT-123456 transaction PRIVATE MERCHANT token=SECRET",
            type: "button",
            visible: true,
          },
        ],
        control_count: 1000,
        controls: [
          {
            aria_disabled: false,
            class_tokens: "dialog-control account-123456",
            disabled: false,
            name: "selectionType",
            role: "combobox",
            tag: "SELECT",
            text: "transaction text PRIVATE MERCHANT",
            type: null,
            visible: true,
          },
        ],
        phase: "after_export_affordance_probe",
      };
      const rawBody = Buffer.from("Date,Description,Amount\nPRIVATE MERCHANT,10.00,token=SECRET\n", "utf8");
      const artifactPayload = {
        artifact: {
          body: rawBody,
          contentDisposition: 'attachment; filename="../../account-123.csv"',
          contentType: "text/csv; charset=utf-8",
          method: "TRACE",
          status: 200,
          url: "https://www.usaa.com/export/account-123?token=SECRET",
        },
        download: {
          bytes: rawBody.length,
          downloadFailure: "raw download error token=SECRET",
          saveAsError: "raw save error body=PRIVATE MERCHANT",
          source: "saveAs",
          suggestedFilename: "../account-123.csv",
          url: "https://www.usaa.com/download/account-123?token=SECRET",
        },
        phase: "artifact_failed",
        response_candidates: [],
        response_summary: { candidate_count: 1, cdp_ready: true },
      };

      capture.captureSafe({ kind: "surface_manifest", payload: surfacePayload });
      capture.captureSafe({ kind: "artifact_metadata", payload: artifactPayload });
      for (let index = 0; index < SAFE_CAPTURE_MAX_FILES + 8; index += 1) {
        capture.captureSafe({ kind: "surface_manifest", payload: surfacePayload });
      }

      const inventory = capture.inventory();
      assert.ok(inventory.files > 0);
      assert.ok(inventory.files <= SAFE_CAPTURE_MAX_FILES);
      assert.ok(inventory.bytes <= SAFE_CAPTURE_MAX_BYTES);
      assert.equal(inventory.cleanup_failures, 0);
      assert.equal(inventory.partial_writes, 0);
      assert.ok(inventory.rejected > 0, "file cap must reject excess safe events");
      const files = walkFiles(capture.baseDir);
      assert.equal(files.length, inventory.files);
      assert.ok(files.every((path) => path.endsWith(".json")));
      assert.ok(
        files.every((path) => /^(?:\d{4})-(?:artifact|surface)\.json$/u.test(relative(capture.baseDir, path))),
        "safe mode may only write fixed safe evidence filenames"
      );
      assert.ok(files.every((path) => !/(?:dom|pages|aria|screenshots|traces|records|http)/u.test(path)));
      assert.equal(
        files.reduce((total, path) => total + statSync(path).size, 0),
        inventory.bytes,
        "inventory bytes must cover the recursive safe-file inventory"
      );
      for (const path of files) {
        const info = statSync(path);
        assert.ok(info.size <= SAFE_CAPTURE_MAX_FILE_BYTES);
        const content = readFileSync(path, "utf8");
        assert.doesNotMatch(
          content,
          /ACCT-123456|PRIVATE MERCHANT|token=SECRET|raw download error|raw save error|https?:\/\//
        );
        assert.doesNotMatch(content, /account-123/);
      }
      const serialized = files.map((path) => readFileSync(path, "utf8")).join("\n");
      assert.match(serialized, /selectionType/);
      assert.match(serialized, /as_credit__export/);
      assert.match(serialized, /"byte_count":\d+/u);

      capture.markSucceeded();
      capture.finalize();
      assert.equal(existsSync(capture.baseDir), false, "success must delete the safe run directory");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
    assert.equal(existsSync(root), false, "the temporary inventory root must be deleted");
  });
});

test("safe capture rejects a write after the deadline without invoking the writer", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-safe-capture-deadline-"));
  let nowMs = 1000;
  let writes = 0;
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1", PDPP_CAPTURE_ROOT_DIR: root }, () => {
    const capture = createSafeCaptureSession(`safe_deadline_${process.pid}_${Date.now()}`, {
      now: () => nowMs,
      writeFile: () => {
        writes += 1;
      },
    });
    assert.ok(capture);
    try {
      nowMs = 3000;
      capture.captureSafe({ kind: "surface_manifest", payload: { phase: "account_page_settled" } });
      assert.equal(writes, 0, "no filesystem write may begin after the capture deadline");
      assert.deepEqual(capture.inventory(), {
        bytes: 0,
        cleanup_failures: 0,
        deadline_at_ms: 3000,
        deadline_exceeded: true,
        files: 0,
        partial_writes: 0,
        rejected: 1,
      });
      assert.deepEqual(walkFiles(capture.baseDir), []);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

test("safe capture inventory accounts for partial writes and removes the partial file", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-safe-capture-partial-"));
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1", PDPP_CAPTURE_ROOT_DIR: root }, () => {
    const capture = createSafeCaptureSession(`safe_partial_${process.pid}_${Date.now()}`, {
      writeFile: (path, data) => {
        writeFileSync(path, data, "utf8");
        throw new Error("synthetic partial write");
      },
    });
    assert.ok(capture);
    try {
      capture.captureSafe({ kind: "surface_manifest", payload: { phase: "account_page_settled" } });
      assert.deepEqual(capture.inventory(), {
        bytes: 0,
        cleanup_failures: 0,
        deadline_at_ms: capture.inventory().deadline_at_ms,
        deadline_exceeded: false,
        files: 0,
        partial_writes: 1,
        rejected: 1,
      });
      assert.deepEqual(walkFiles(capture.baseDir), [], "a failed write must not remain in the safe inventory");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});

test("safe capture inventory records cleanup failure and closes the session", () => {
  const root = mkdtempSync(join(tmpdir(), "pdpp-safe-capture-cleanup-"));
  withEnv({ PDPP_CAPTURE_FIXTURES: undefined, PDPP_CAPTURE_ON_FAILURE: "1", PDPP_CAPTURE_ROOT_DIR: root }, () => {
    const capture = createSafeCaptureSession(`safe_cleanup_${process.pid}_${Date.now()}`, {
      removeDirectory: () => {
        throw new Error("synthetic cleanup failure");
      },
    });
    assert.ok(capture);
    try {
      capture.markSucceeded();
      capture.finalize();
      assert.equal(capture.inventory().cleanup_failures, 1);
      assert.equal(existsSync(capture.baseDir), true);
      capture.captureSafe({ kind: "surface_manifest", payload: { phase: "account_page_settled" } });
      assert.equal(capture.inventory().files, 0, "a finalized session cannot write after cleanup failure");
      capture.finalize();
      assert.equal(capture.inventory().cleanup_failures, 1, "cleanup failure is recorded once");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
