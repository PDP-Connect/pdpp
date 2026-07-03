import assert from "node:assert/strict";
import { test } from "node:test";
import {
  assessClipboardCapabilities,
  type ClipboardCapabilities,
  type ClipboardCapabilityInput,
  classifyClipboardBrowser,
  clipboardLengthBucket,
  decideClipboardPolicy,
} from "@opendatalabs/remote-surface/client";

function capabilities(overrides: Partial<ClipboardCapabilityInput> = {}): ClipboardCapabilities {
  return assessClipboardCapabilities({
    browserFamily: "chromium",
    isSecureContext: true,
    pointerCoarse: false,
    readPermission: "granted",
    readTextAvailable: true,
    topLevel: true,
    userAgent: "Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36",
    writePermission: "granted",
    writeTextAvailable: true,
    ...overrides,
  });
}

test("classifies mobile Safari as sheet-first with manual read fallback", () => {
  const capabilities = assessClipboardCapabilities({
    browserFamily: classifyClipboardBrowser(
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1"
    ),
    isSecureContext: true,
    pointerCoarse: true,
    readPermission: "unsupported",
    readTextAvailable: true,
    topLevel: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    writePermission: "unsupported",
    writeTextAvailable: true,
  });
  const decision = decideClipboardPolicy({
    capabilities,
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "balanced",
  });
  assert.equal(capabilities.browserFamily, "safari");
  assert.equal(capabilities.mobileLike, true);
  assert.equal(capabilities.needsManualReadFallback, true);
  assert.equal(decision.surface, "mobile-sheet");
  assert.equal(decision.showClipboardSheet, true);
  assert.equal(decision.showDesktopCopyButton, false);
  assert.equal(decision.showDesktopPasteButton, false);
  assert.equal(decision.showMobileCopyButton, true);
  assert.equal(decision.showMobilePasteButton, true);
});

test("desktop Chromium keeps native clipboard capability without stream chrome", () => {
  const desktopCapabilities = capabilities();
  const decision = decideClipboardPolicy({
    capabilities: desktopCapabilities,
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "assistive",
  });
  assert.equal(desktopCapabilities.needsManualReadFallback, false);
  assert.equal(decision.surface, "desktop-inline");
  assert.equal(decision.canForwardNativePasteEvent, true);
  assert.equal(decision.showDesktopCopyButton, false);
  assert.equal(decision.showDesktopPasteButton, false);
  assert.equal(decision.showKeyboardButton, false);
  assert.equal(decision.showMobileCopyButton, false);
  assert.equal(decision.showMobilePasteButton, false);
  assert.equal(decision.allowAssistivePageHelpers, true);
});

test("supported browser families route mobile to sheet and desktop to inline controls", () => {
  const cases = [
    {
      expectedBrowser: "chromium",
      mobileLike: true,
      name: "Android Chrome",
      pointerCoarse: true,
      userAgent:
        "Mozilla/5.0 (Linux; Android 16; Pixel 9 Pro) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Mobile Safari/537.36",
    },
    {
      expectedBrowser: "safari",
      mobileLike: true,
      name: "iOS Safari",
      pointerCoarse: true,
      userAgent:
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1",
    },
    {
      expectedBrowser: "firefox",
      mobileLike: true,
      name: "mobile Firefox",
      pointerCoarse: true,
      userAgent: "Mozilla/5.0 (Android 16; Mobile; rv:144.0) Gecko/144.0 Firefox/144.0",
    },
    {
      expectedBrowser: "chromium",
      mobileLike: false,
      name: "desktop Chrome",
      pointerCoarse: false,
      userAgent: "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36",
    },
    {
      expectedBrowser: "safari",
      mobileLike: false,
      name: "desktop Safari",
      pointerCoarse: false,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_5) AppleWebKit/605.1.15 Version/18.5 Safari/605.1.15",
    },
    {
      expectedBrowser: "firefox",
      mobileLike: false,
      name: "desktop Firefox",
      pointerCoarse: false,
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 15.5; rv:144.0) Gecko/20100101 Firefox/144.0",
    },
  ] as const;

  for (const testCase of cases) {
    const browserFamily = classifyClipboardBrowser(testCase.userAgent);
    const decision = decideClipboardPolicy({
      capabilities: capabilities({
        browserFamily,
        pointerCoarse: testCase.pointerCoarse,
        readPermission: testCase.expectedBrowser === "chromium" ? "granted" : "unsupported",
        userAgent: testCase.userAgent,
        writePermission: testCase.expectedBrowser === "chromium" ? "granted" : "unsupported",
      }),
      directionPolicy: "bidirectional-text",
      hasStreamSession: true,
      helperMode: "balanced",
    });
    assert.equal(browserFamily, testCase.expectedBrowser, testCase.name);
    assert.equal(decision.showClipboardSheet, testCase.mobileLike, testCase.name);
    assert.equal(decision.showMobileCopyButton, testCase.mobileLike, testCase.name);
    assert.equal(decision.showMobilePasteButton, testCase.mobileLike, testCase.name);
    assert.equal(decision.showDesktopCopyButton, false, testCase.name);
    assert.equal(decision.showDesktopPasteButton, false, testCase.name);
    assert.equal(decision.surface, testCase.mobileLike ? "mobile-sheet" : "desktop-inline", testCase.name);
  }
});

test("strict mode never allows assistive page-level clipboard helpers", () => {
  const decision = decideClipboardPolicy({
    capabilities: capabilities(),
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "strict",
  });
  assert.equal(decision.allowAssistivePageHelpers, false);
});

test("disabled policy hides all stream clipboard and keyboard controls", () => {
  const decision = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "disabled",
    hasStreamSession: true,
    helperMode: "balanced",
  });
  assert.equal(decision.surface, "disabled");
  assert.equal(decision.canForwardNativePasteEvent, false);
  assert.equal(decision.canReadLocalClipboard, false);
  assert.equal(decision.canWriteLocalClipboard, false);
  assert.equal(decision.showClipboardSheet, false);
  assert.equal(decision.showDesktopCopyButton, false);
  assert.equal(decision.showDesktopPasteButton, false);
  assert.equal(decision.showKeyboardButton, false);
  assert.equal(decision.showMobileCopyButton, false);
  assert.equal(decision.showMobilePasteButton, false);
});

test("direction policy gates local and remote clipboard directions independently", () => {
  const localOnly = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "local-to-remote",
    hasStreamSession: true,
    helperMode: "balanced",
  });
  assert.equal(localOnly.canForwardNativePasteEvent, true);
  assert.equal(localOnly.canReadLocalClipboard, true);
  assert.equal(localOnly.canWriteLocalClipboard, false);
  assert.equal(localOnly.showMobilePasteButton, true);
  assert.equal(localOnly.showMobileCopyButton, false);

  const remoteOnly = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "remote-to-local",
    hasStreamSession: true,
    helperMode: "balanced",
  });
  assert.equal(remoteOnly.canForwardNativePasteEvent, false);
  assert.equal(remoteOnly.canReadLocalClipboard, false);
  assert.equal(remoteOnly.canWriteLocalClipboard, true);
  assert.equal(remoteOnly.showMobilePasteButton, false);
  assert.equal(remoteOnly.showMobileCopyButton, true);
});

test("denied browser capabilities fail closed for async clipboard APIs", () => {
  const decision = decideClipboardPolicy({
    capabilities: capabilities({
      isSecureContext: false,
      readTextAvailable: false,
      topLevel: false,
      writeTextAvailable: false,
    }),
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "balanced",
  });
  assert.equal(decision.canForwardNativePasteEvent, false);
  assert.equal(decision.canReadLocalClipboard, false);
  assert.equal(decision.canWriteLocalClipboard, false);
});

test("missing stream session disables clipboard policy regardless of browser support", () => {
  const decision = decideClipboardPolicy({
    capabilities: capabilities(),
    directionPolicy: "bidirectional-text",
    hasStreamSession: false,
    helperMode: "balanced",
  });
  assert.equal(decision.surface, "disabled");
  assert.equal(decision.canForwardNativePasteEvent, false);
  assert.equal(decision.canReadLocalClipboard, false);
  assert.equal(decision.canWriteLocalClipboard, false);
});

test("step-5 ruling 1: keyboard button shows only for n.eko mobile sessions", () => {
  // n.eko mobile → button visible
  const nekoMobile = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend: "neko",
  });
  assert.equal(nekoMobile.showKeyboardButton, true);

  // n.eko desktop → still hidden
  const nekoDesktop = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: false }),
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend: "neko",
  });
  assert.equal(nekoDesktop.showKeyboardButton, false);

  // cdp mobile → still hidden (anti-requirement: do not flip for cdp)
  const cdpMobile = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "bidirectional-text",
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend: "cdp",
  });
  assert.equal(cdpMobile.showKeyboardButton, false);

  // disabled session → hidden even on n.eko mobile
  const disabled = decideClipboardPolicy({
    capabilities: capabilities({ pointerCoarse: true }),
    directionPolicy: "disabled",
    hasStreamSession: true,
    helperMode: "balanced",
    sessionBackend: "neko",
  });
  assert.equal(disabled.showKeyboardButton, false);
});

test("length buckets are redacted metadata only", () => {
  assert.equal(clipboardLengthBucket(""), "0");
  assert.equal(clipboardLengthBucket("π\n🔒"), "1-16");
  assert.equal(clipboardLengthBucket("1234567890123456"), "1-16");
  assert.equal(clipboardLengthBucket("x".repeat(64)), "17-64");
  assert.equal(clipboardLengthBucket("x".repeat(256)), "65-256");
  assert.equal(clipboardLengthBucket("x".repeat(1024)), "257-1024");
  assert.equal(clipboardLengthBucket("x".repeat(1025)), "1025+");
});
