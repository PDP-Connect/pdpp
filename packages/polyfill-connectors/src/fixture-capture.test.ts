import assert from "node:assert/strict";
import { readFileSync, rmSync } from "node:fs";
import test from "node:test";

import type { Page } from "playwright";

import { createCaptureSession } from "./fixture-capture.ts";

test("captureDom writes html, page metadata, and screenshot in raw local capture mode", async () => {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  process.env.PDPP_CAPTURE_FIXTURES = "1";
  const connectorName = `fixture_capture_test_${process.pid}_${Date.now()}`;
  const capture = createCaptureSession(connectorName);
  assert.ok(capture);

  try {
    const page: Pick<Page, "content" | "screenshot" | "title" | "url"> = {
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

test("createCaptureSession returns null when raw capture mode is disabled", () => {
  const previous = process.env.PDPP_CAPTURE_FIXTURES;
  delete process.env.PDPP_CAPTURE_FIXTURES;
  try {
    assert.equal(createCaptureSession(`fixture_capture_disabled_${process.pid}_${Date.now()}`), null);
  } finally {
    if (previous !== undefined) {
      process.env.PDPP_CAPTURE_FIXTURES = previous;
    }
  }
});
