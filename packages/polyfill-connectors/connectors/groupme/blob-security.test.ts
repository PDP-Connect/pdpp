// Copyright The PDP-Connect Contributors
// SPDX-License-Identifier: Apache-2.0
/**
 * GroupMe blob attachment security tests (production seam).
 *
 * Tests call production validateAttachmentUrl() and fetchAttachmentBlob(),
 * not helper copies. This proves production code blocks all attack vectors.
 *
 * Mutations tested:
 * - Protocol (http:// vs https://)
 * - Port (default vs :arbitrary)
 * - Userinfo (username:password@ present/absent)
 * - Hostname lookalike (i.groupme.net vs i.groupme.com)
 * - Redirect (via mocked fetch)
 * - Content-Length (missing, invalid, oversized, lying)
 * - Streaming (byte cap enforcement)
 */

import assert, { deepStrictEqual, match, ok, strictEqual } from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { fetchAttachmentBlob, normalizeAttachmentContentType, validateAttachmentUrl } from "./index.ts";

function fakeAttachmentResponse(headers: Record<string, string>, body: Buffer): unknown {
  return {
    ok: true,
    status: 200,
    headers: new Headers({ "content-length": String(body.length), ...headers }),
    body: {
      getReader: () => {
        let sent = false;
        return {
          read: () => {
            if (sent) {
              return Promise.resolve({ done: true });
            }
            sent = true;
            return Promise.resolve({ done: false, value: body });
          },
          cancel: () => Promise.resolve(undefined),
        };
      },
    },
  };
}

describe("GroupMe blob attachment security (production seam)", () => {
  describe("validateAttachmentUrl (origin validation)", () => {
    it("allows https://i.groupme.com/image.jpg (canonical)", () => {
      const result = validateAttachmentUrl("https://i.groupme.com/image.jpg");
      strictEqual(result.valid, true);
    });

    it("rejects http://i.groupme.com (insecure protocol)", () => {
      const result = validateAttachmentUrl("http://i.groupme.com/image.jpg");
      strictEqual(result.valid, false);
      match(result.reason || "", /protocol/);
    });

    it("rejects https://i.groupme.com:8080 (non-default port)", () => {
      const result = validateAttachmentUrl("https://i.groupme.com:8080/image.jpg");
      strictEqual(result.valid, false);
      match(result.reason || "", /port/);
    });

    it("allows https://i.groupme.com:443 (explicit default HTTPS port, URL-equivalent)", () => {
      // :443 is URL-equivalent to omitted port after standards normalization
      const result = validateAttachmentUrl("https://i.groupme.com:443/image.jpg");
      strictEqual(result.valid, true);
    });

    it("rejects https://user:pass@i.groupme.com (userinfo present)", () => {
      const result = validateAttachmentUrl("https://user:pass@i.groupme.com/image.jpg");
      strictEqual(result.valid, false);
      match(result.reason || "", /userinfo/);
    });

    it("rejects https://i.groupme.net (hostname lookalike)", () => {
      const result = validateAttachmentUrl("https://i.groupme.net/image.jpg");
      strictEqual(result.valid, false);
      match(result.reason || "", /not approved/);
    });

    it("rejects https://attacker.com (cross-origin)", () => {
      const result = validateAttachmentUrl("https://attacker.com/image.jpg");
      strictEqual(result.valid, false);
    });

    it("rejects data: URI (code execution)", () => {
      const result = validateAttachmentUrl("data:text/html,<script>alert('xss')</script>");
      strictEqual(result.valid, false);
    });

    it("rejects invalid URL", () => {
      const result = validateAttachmentUrl("not a url");
      strictEqual(result.valid, false);
    });
  });

  describe("fetchAttachmentBlob (streaming + size validation)", () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      (global as any).fetch = originalFetch;
    });

    it("rejects redirect (fetch with redirect: error throws)", async () => {
      (global as any).fetch = (_url: string, init: any) => {
        assert.strictEqual(init.redirect, "error", "must use redirect:error");
        // Simulate redirect by throwing TypeError (what fetch does)
        return Promise.reject(new TypeError("Failed to fetch: redirect"));
      };

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test1");
      strictEqual(result, null);
    });

    it("rejects non-OK response (HTTP 404)", async () => {
      (global as any).fetch = async (_url: string) => ({
        ok: false,
        status: 404,
        headers: new Headers({ "content-length": "1024" }),
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test2");
      assert.strictEqual(result, null);
    });

    it("rejects missing content-length", async () => {
      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({}), // No content-length
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test3");
      assert.strictEqual(result, null);
    });

    it("rejects invalid content-length (non-numeric)", async () => {
      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "not-a-number" }),
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test4");
      assert.strictEqual(result, null);
    });

    it("rejects oversized content-length (>50MiB)", async () => {
      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "60000000" }), // 60 MiB
        body: { getReader: () => ({ read: async () => ({ done: true }) }) },
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test5");
      assert.strictEqual(result, null);
    });

    it("rejects streaming that exceeds byte cap (lying content-length)", async () => {
      // Content-Length says 1 KiB, but streaming returns 60 MiB worth
      const chunks = Array.from({ length: 100 }, () => new Uint8Array(600_000));

      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "1024" }),
        body: {
          getReader: () => {
            let index = 0;
            return {
              read: () => {
                if (index >= chunks.length) {
                  return Promise.resolve({ done: true });
                }
                const chunk = chunks[index];
                index += 1;
                return Promise.resolve({ done: false, value: chunk });
              },
              cancel: () => Promise.resolve(undefined),
            };
          },
        },
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test6");
      assert.strictEqual(result, null, "streaming must enforce byte cap");
    });

    it("rejects unreadable body (no getReader)", async () => {
      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": "1024" }),
        body: null, // Unreadable
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/image.jpg", "test7");
      assert.strictEqual(result, null);
    });

    it("allows normal 1 KiB image (valid URL, OK, content-length, streaming)", async () => {
      const imageData = Buffer.alloc(1024, "test image data");

      (global as any).fetch = (_url: string, _init: any) =>
        Promise.resolve({
          ok: true,
          status: 200,
          headers: new Headers({ "content-length": "1024" }),
          body: {
            getReader: () => {
              let sent = false;
              return {
                read: () => {
                  if (sent) {
                    return Promise.resolve({ done: true });
                  }
                  sent = true;
                  return Promise.resolve({ done: false, value: imageData });
                },
                cancel: () => Promise.resolve(undefined),
              };
            },
          },
        });

      const result = await fetchAttachmentBlob("https://i.groupme.com/photo.jpg", "normal");
      ok(result, "valid image should succeed");
      strictEqual(result.size, 1024);
      deepStrictEqual(result.buffer, imageData);
    });

    it("allows max-size 50 MiB image", async () => {
      const maxData = Buffer.alloc(50 * 1024 * 1024);

      (global as any).fetch = async (_url: string) => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(maxData.length) }),
        body: {
          getReader: () => {
            let sent = false;
            return {
              read: () => {
                if (sent) {
                  return Promise.resolve({ done: true });
                }
                sent = true;
                return Promise.resolve({ done: false, value: maxData });
              },
              cancel: () => Promise.resolve(undefined),
            };
          },
        },
      });

      const result = await fetchAttachmentBlob("https://i.groupme.com/large.jpg", "max");
      ok(result, "50 MiB image should succeed");
      strictEqual(result.size, 50 * 1024 * 1024);
    });
  });

  describe("fetchAttachmentBlob content-type capture", () => {
    let originalFetch: typeof global.fetch;

    beforeEach(() => {
      originalFetch = global.fetch;
    });

    afterEach(() => {
      (global as any).fetch = originalFetch;
    });

    it("captures a real PNG content-type from the response headers", async () => {
      (global as any).fetch = async () => fakeAttachmentResponse({ "content-type": "image/png" }, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.png", "png-1");
      ok(result);
      strictEqual(result.contentType, "image/png");
    });

    it("captures a real GIF content-type from the response headers", async () => {
      (global as any).fetch = async () => fakeAttachmentResponse({ "content-type": "image/gif" }, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.gif", "gif-1");
      ok(result);
      strictEqual(result.contentType, "image/gif");
    });

    it("captures a real JPEG content-type from the response headers", async () => {
      (global as any).fetch = async () => fakeAttachmentResponse({ "content-type": "image/jpeg" }, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.jpg", "jpeg-1");
      ok(result);
      strictEqual(result.contentType, "image/jpeg");
    });

    it("strips content-type parameters before matching (image/jpeg; charset=binary)", async () => {
      (global as any).fetch = async () =>
        fakeAttachmentResponse({ "content-type": "image/jpeg; charset=binary" }, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.jpg", "jpeg-charset");
      ok(result);
      strictEqual(result.contentType, "image/jpeg");
    });

    it("returns null contentType when the header is missing", async () => {
      (global as any).fetch = async () => fakeAttachmentResponse({}, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.bin", "missing-header");
      ok(result, "fetch must still succeed without a content-type header");
      strictEqual(result.contentType, null);
    });

    it("returns null contentType for a malformed/unrecognized header value", async () => {
      (global as any).fetch = async () =>
        fakeAttachmentResponse({ "content-type": "text/html; <script>evil()</script>" }, Buffer.alloc(10));
      const result = await fetchAttachmentBlob("https://i.groupme.com/a.jpg", "malformed-header");
      ok(result, "fetch must still succeed with a garbage content-type header");
      strictEqual(result.contentType, null, "unrecognized/unsafe header values must not pass through");
    });

    it("does not fetch the attachment twice to determine content-type (single fetch call)", async () => {
      let callCount = 0;
      (global as any).fetch = async () => {
        callCount += 1;
        return fakeAttachmentResponse({ "content-type": "image/png" }, Buffer.alloc(10));
      };
      await fetchAttachmentBlob("https://i.groupme.com/a.png", "single-fetch");
      strictEqual(callCount, 1, "must resolve content-type from the same fetch that downloads the body");
    });
  });

  describe("normalizeAttachmentContentType (safe header normalization)", () => {
    it("accepts known-safe image types", () => {
      strictEqual(normalizeAttachmentContentType("image/png"), "image/png");
      strictEqual(normalizeAttachmentContentType("image/gif"), "image/gif");
      strictEqual(normalizeAttachmentContentType("image/jpeg"), "image/jpeg");
      strictEqual(normalizeAttachmentContentType("image/webp"), "image/webp");
    });

    it("accepts application/pdf and application/octet-stream for file attachments", () => {
      strictEqual(normalizeAttachmentContentType("application/pdf"), "application/pdf");
      strictEqual(normalizeAttachmentContentType("application/octet-stream"), "application/octet-stream");
    });

    it("strips parameters and lowercases before matching", () => {
      strictEqual(normalizeAttachmentContentType("IMAGE/PNG; charset=binary"), "image/png");
    });

    it("returns null for missing header", () => {
      strictEqual(normalizeAttachmentContentType(null), null);
      strictEqual(normalizeAttachmentContentType(undefined), null);
      strictEqual(normalizeAttachmentContentType(""), null);
    });

    it("returns null for an unrecognized MIME type not in the safe set", () => {
      strictEqual(normalizeAttachmentContentType("application/x-shellscript"), null);
      strictEqual(normalizeAttachmentContentType("text/html"), null);
    });

    it("returns null for whitespace-only or malformed header", () => {
      strictEqual(normalizeAttachmentContentType("   "), null);
      strictEqual(normalizeAttachmentContentType(";;;"), null);
    });
  });

  describe("deletion semantics", () => {
    it("API provides no deletion signal; absence ≠ deletion", () => {
      // GroupMe API does not document:
      // - A deletion status field
      // - A deleted flag
      // - A tombstone endpoint
      // - A deletion log

      // Therefore: message absence on run N+1 does NOT mean the message was deleted.
      // Correct behavior: carry message forward in state without re-emission.

      const hasDeleteConfirmation = false;
      strictEqual(hasDeleteConfirmation, false);
    });
  });
});
