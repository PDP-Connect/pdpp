# Patchright init script not injecting over `connectOverCDP` — debug notes

## TL;DR

Patchright's `addInitScript` over `connectOverCDP` is a **known fragile path**. The fact that you can see `Fetch.fulfillRequest` going out with the modified body but the rendered DOM still shows the *original* HTML is consistent with a small set of well-documented Chromium behaviors around `Fetch.fulfillRequest`. In your specific trace the most likely culprits are, in order:

1. **Patchright is sending the body as a raw UTF-8 string, not base64 — and Chrome silently treats malformed/non-base64 bodies as empty / falls back to the network body.** This is by far the strongest hypothesis given the source.
2. **A second navigation (the real network fetch) is racing the fulfilled one** because the `app://`/`data:` initial page or a redirect triggers an extra `requestPaused` whose body Patchright keeps from the upstream — and the final committed document is that one, not the fulfilled one.
3. **The `<head>` insertion finds nothing useful** in a `<!doctype html><html><body>…` document with no `<head>` — Patchright synthesizes one but Chrome's HTML parser may already have committed the original byte stream.
4. CSP / `--remote-allow-origins=*` is *not* the issue. Patchright actively rewrites CSP. The flag only relaxes the CDP origin check.

Confidence: H/M/L noted per hypothesis below.

---

## What the Patchright source actually does

`crNetworkManager.js` `fulfill()` (lines 549–618):

```js
const body = response.isBase64 ? response.body : Buffer.from(response.body).toString("base64");
```

That line is the smoking gun for hypothesis #1.

The flow earlier in the function:

1. If response is base64 (it always is — Chrome returns `getResponseBody` body as base64=true), set `response.isBase64 = false` and `response.body = Buffer.from(body, "base64").toString("utf-8")`.
2. Mutate `response.body` (CSP meta rewrite, then `_injectIntoHead(...)`).
3. At the end: **re-encode as base64 only if `isBase64` is false**. The condition is inverted-looking but actually correct: when `response.isBase64` is `true`, it was never decoded and is already base64; when it's `false`, we just produced a UTF-8 string and need to base64 it.

So that line is *probably* fine in steady state, but it explodes if **the response body contains any non-UTF-8 byte** (e.g. a stray 0x80–0xFF from the original page even though you say "tiny HTML"). `Buffer.from(str, "base64").toString("utf-8")` will *lossily* replace those bytes with `U+FFFD`. The reverse `Buffer.from(str).toString("base64")` then emits a body that doesn't match the original byte length. If the response also carried `Content-Length` from the original server, the values disagree → Chrome can discard the fulfilled body. **Action: trace the actual `Fetch.fulfillRequest` payload bytes and verify the base64 round-trip matches your server output byte-for-byte.** This is the single most useful next step.

### `_injectIntoHead` walk-through (lines 690–731) on a `<!doctype html>…` body

For your minimal HTML (`<!doctype html><html><head></head><body>…</body></html>`):

- `lower.indexOf("<head")` returns the index of `<head` → branch A.
- `headStartTagEndIndex` = position after `>`.
- `headEndTagIndex` = position of `</head>`.
- `headContent` is the empty string → no `<script>` found → `firstScriptIndex = -1`.
- `insertAt = headEndTagIndex` → injection lands right before `</head>`.

That logic is fine for any document with an explicit `<head>`. **But if your test page has NO `<head>` element** (e.g. `<!doctype html><html><body>…`), it takes the `doctypeIndex === 0` branch and injects directly after the doctype, *outside* any element — Chrome's parser will still pick it up, but some sniffing paths get unhappy. **Action: confirm your test HTML literally contains `<head></head>`.** If it doesn't, add one and retest.

### `crPage.js` line 80

```js
this._networkManager.setRequestInterception(true);
```

This is called *unconditionally* in the CRPage constructor — including for pages discovered via `connectOverCDP`. So interception is wired. That matches your trace.

The constructor also kicks off `this._mainFrameSession._initialize(...)` async (line 90). **Pages that already exist at the moment of `connectOverCDP` attach can have already-committed documents.** `addInitScript` only injects on the *next* HTML response. You say you `newPage()` + `goto()` after `addInitScript`, so this shouldn't bite you — but verify the page you're evaluating on is the one created post-attach, not the neko `--app=data:text/html,...` page that already exists.

---

## Web findings ranked by relevance

### Known Patchright limitation (HIGH confidence this is the framing)

DeepWiki: *"Patchright uses a non-standard approach for InitScript functionality that can cause compatibility issues. Patchright InitScripts won't cause any bugs that wouldn't be caused by normal Playwright Routes."* In other words: **init scripts inherit every quirk of Playwright Routes, and the maintainer treats some of those as wontfix.** ([DeepWiki — Known Limitations](https://deepwiki.com/Kaliiiiiiiiii-Vinyzu/patchright/4.3-known-limitations-and-troubleshooting))

Patchright README confirms the mechanism: *"To be able to use InitScripts without `Runtime.enable`, Patchright uses Playwright Routes to inject JavaScript into HTML requests. Playwright Routes may cause some bugs in other parts of your code."* ([Patchright repo](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright))

### Chrome silently drops `Fetch.fulfillRequest` body in adjacent scenarios (HIGH)

[Schniz/chrome-fulfill-request-issue](https://github.com/Schniz/chrome-fulfill-request-issue): Chrome ignores fulfill bodies when `Content-Encoding` indicates compression but the body is plain. Generalization: **if response headers describe a body that doesn't match the bytes you sent, Chrome can fall back to the network body or render an empty doc.** Your trace says no `content-encoding` and no `transfer-encoding`, but you *do* preserve the original `Content-Length`. Patchright does NOT strip or rewrite `Content-Length`. The injected `<script>` tag makes the body longer than `Content-Length`. **High suspicion this mismatch is the actual cause.** ([chromedp/chromedp#722 — large body handling](https://github.com/chromedp/chromedp/issues/722) is a related crash mode.)

> **Action: in the CDP trace, dump the `responseHeaders` array sent in `Fetch.fulfillRequest`. If `Content-Length` is still the original number, that's the bug.** Strip it on the test server (or rewrite Patchright to strip it) and retest.

### Playwright upstream: CDP Fetch response modifications not propagating (MEDIUM)

[microsoft/playwright#34826](https://github.com/microsoft/playwright/issues/34826) — modifying response headers via `Fetch.fulfillRequest` doesn't show up in subsequent Playwright `response` events. Less directly relevant (your symptom is the DOM, not the response object), but it confirms the path is buggy in adjacent ways.

### Patchright issue tracker (LOW for your specific symptom)

The pinned "[BUGS] Current Bugs of Patchright" issue #30 in [Kaliiiiiiiiii-Vinyzu/patchright/issues](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues) is the canonical bug list. I did not find an existing issue matching your exact symptom (fulfill body visible on the wire but not in the rendered DOM via `connectOverCDP`). Worth filing.

### Browser flags (LOW)

`--remote-allow-origins=*` only affects the CDP HTTP upgrade check. `--disable-features=RenderDocument` changes the per-navigation RenderFrameHost reuse policy. Neither is documented to affect Fetch interception. Your trace shows interception working, so we can rule these out.

---

## Ranked hypotheses

| # | Hypothesis | Confidence | Test |
|---|---|---|---|
| 1 | `Content-Length` retained from original response, mismatches injected body length → Chrome discards body or truncates | **High** | Dump `responseHeaders` in `Fetch.fulfillRequest`. Strip `Content-Length` server-side. |
| 2 | Non-UTF-8 round-trip corrupts body when Patchright decodes/re-encodes | Medium-High | Compare base64 of original body vs. base64 in `fulfillRequest` payload for a body with no script-injection-eligible markers (e.g. force `isTextHtml=false` path) |
| 3 | `_injectIntoHead` lands the script at a location Chrome's parser doesn't honor for *this* document shape | Medium | Verify test HTML has explicit `<head></head>`; also try `<head><meta></head>` |
| 4 | Race: page already committed an earlier document (neko `--app=data:...`) and `evaluate` runs against the wrong frame | Medium | Log `page.url()` immediately before `evaluate`; ensure `newPage()` returned a fresh target ID |
| 5 | Known general fragility — Patchright maintainer marks Routes-based injection as "wontfix" for some edge cases | Background — informs revision risk | Read [DeepWiki notes](https://deepwiki.com/Kaliiiiiiiiii-Vinyzu/patchright/4.3-known-limitations-and-troubleshooting) |
| 6 | CSP, `--remote-allow-origins`, `--disable-features=RenderDocument` | **Ruled out** | n/a |

## Is this a known Patchright limitation that breaks the SLVP plan?

**Yes, partially — loudly.** The Routes-based injection mechanism is documented by the Patchright maintainer as inheriting all Playwright Route bugs, and they explicitly punt those to upstream Playwright. Using `connectOverCDP` against a *long-lived neko Chromium* multiplies the risk surface (pre-existing targets, the `--app=data:` page, response timing). If SLVP relies on init scripts firing reliably on every navigation in this topology, **plan B should be on the table**: either (a) launch Chromium under Patchright instead of `connectOverCDP`-ing into neko's, or (b) inject via a different mechanism (e.g. a Chromium extension loaded via `--load-extension`, or DOM-mutation injection from inside the page) that doesn't depend on response-body rewriting.

## Recommended next debugging step (single highest-value)

Capture the **full `Fetch.fulfillRequest` payload** Patchright sends for the navigation request. Specifically:

1. Base64-decode the `body` field. Diff against your server's response body. They should be **identical except for** the injected `<script>` tag near `</head>` and any CSP rewrites.
2. Dump `responseHeaders`. Confirm `Content-Length` is either absent or matches `body.length` post-decode. **If `Content-Length` is present and stale, that is your bug.**
3. If both look correct: add `<head></head>` to the test HTML if missing, re-run.

If `Content-Length` is the issue, the minimal Patchright patch is in `crNetworkManager.js` `fulfill()`: strip `content-length` from `responseHeaders` before sending `Fetch.fulfillRequest` whenever the body was modified.

---

## Sources

- [Patchright repo (Kaliiiiiiiiii-Vinyzu/patchright)](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright)
- [Patchright known limitations — DeepWiki](https://deepwiki.com/Kaliiiiiiiiii-Vinyzu/patchright/4.3-known-limitations-and-troubleshooting)
- [Patchright open bugs issue #30](https://github.com/Kaliiiiiiiiii-Vinyzu/patchright/issues)
- [Schniz/chrome-fulfill-request-issue — Chrome ignoring fulfill bodies](https://github.com/Schniz/chrome-fulfill-request-issue)
- [chromedp/chromedp#722 — fulfillRequest large body crash](https://github.com/chromedp/chromedp/issues/722)
- [microsoft/playwright#34826 — CDP Fetch.fulfillRequest header modification not propagating](https://github.com/microsoft/playwright/issues/34826)
- [SeleniumHQ/selenium#10734 — response headers not appearing via fulfillRequest](https://github.com/SeleniumHQ/selenium/issues/10734)
- [CDP Fetch domain spec](https://chromedevtools.github.io/devtools-protocol/tot/Fetch/)
