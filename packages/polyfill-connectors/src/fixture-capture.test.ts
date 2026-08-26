// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { Page } from "playwright";

import { createCaptureSession, type LocatorProbePage } from "./fixture-capture.ts";

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
    const page: Pick<Page, "ariaSnapshot" | "content" | "locator" | "screenshot" | "title" | "url"> = {
      ariaSnapshot: () => Promise.resolve('- document:\n  - button "Submit" [ref=e1]'),
      content: () => Promise.resolve("<html><title>Fixture</title><body>ok</body></html>"),
      // Screenshots are only written when the page can build a credential
      // mask, so a page double must supply `locator` to get one.
      locator: ((selector: string) => ({ selector })) as unknown as Page["locator"],
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

test("captureLocatorProbe calls getBy* helpers as methods, not detached (production run_1787537596833)", async () => {
  // COUNTERWEIGHT to the object-literal page used by every other test in this
  // file: arrow-function properties ignore `this`, so a literal cannot detect a
  // lost receiver at all. Playwright's real `Page.getByRole` is a PROTOTYPE
  // method whose whole body is `return this.mainFrame().getByRole(...)`, so
  // calling it detached throws `Cannot read properties of undefined (reading
  // 'mainFrame')` — the exact error the `submit-role` probe recorded at
  // `venmo-login-after-submit` in production run_1787537596833, while the css
  // probes beside it (invoked as `page.locator(...)`, receiver intact) returned
  // real counts.
  //
  // This class reproduces that delegation shape faithfully; it is the only
  // reason the test can fail when the bind is removed.
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  const connectorName = `fixture_capture_bind_test_${process.pid}_${Date.now()}`;
  const capture = createCaptureSession(connectorName);
  assert.ok(capture);

  try {
    const fakeLocator = {
      ariaSnapshot: () => Promise.resolve('- button "Log in" [ref=e48]'),
      count: () => Promise.resolve(1),
      first() {
        return this;
      },
      isEnabled: () => Promise.resolve(true),
      isVisible: () => Promise.resolve(true),
    };
    class DelegatingPage {
      readonly _mainFrame = {
        getByLabel: () => fakeLocator,
        getByPlaceholder: () => fakeLocator,
        getByRole: () => fakeLocator,
        getByText: () => fakeLocator,
        locator: () => fakeLocator,
      };
      mainFrame(): DelegatingPage["_mainFrame"] {
        return this._mainFrame;
      }
      getByRole(): typeof fakeLocator {
        return this.mainFrame().getByRole();
      }
      getByLabel(): typeof fakeLocator {
        return this.mainFrame().getByLabel();
      }
      getByPlaceholder(): typeof fakeLocator {
        return this.mainFrame().getByPlaceholder();
      }
      getByText(): typeof fakeLocator {
        return this.mainFrame().getByText();
      }
      locator(): typeof fakeLocator {
        return this.mainFrame().locator();
      }
      title(): Promise<string> {
        return Promise.resolve("Log in | Venmo");
      }
      url(): string {
        return "https://id.venmo.com/signin#/lgn";
      }
    }
    const page = new DelegatingPage() as unknown as LocatorProbePage;

    await capture.captureLocatorProbe?.(page, "venmo-login-after-submit", [
      {
        id: "submit-role",
        kind: "role",
        nameFlags: "i",
        namePattern: "^(log in|sign in|continue|next)$",
        role: "button",
      },
      { id: "by-label", kind: "label", text: "Password" },
      { id: "by-placeholder", kind: "placeholder", text: "Password" },
      { id: "by-text", kind: "text", text: "Log in" },
    ]);

    const report = JSON.parse(readFileSync(`${capture.baseDir}/locators/venmo-login-after-submit.json`, "utf8")) as {
      probes: readonly { readonly count?: number; readonly error?: string; readonly id: string }[];
    };
    for (const probe of report.probes) {
      assert.equal(probe.error, undefined, `probe ${probe.id} must not lose its receiver: ${probe.error ?? ""}`);
      assert.equal(probe.count, 1, `probe ${probe.id} must resolve a real count`);
    }
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
