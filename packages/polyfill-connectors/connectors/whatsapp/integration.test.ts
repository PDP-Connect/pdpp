import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import type { EmittedMessage } from "../../src/connector-runtime.ts";
import { runConnectorProtocolSubprocess } from "../../src/test-harness.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(__dirname, "../..");
const WHATSAPP_ENTRYPOINT = join(PACKAGE_ROOT, "connectors", "whatsapp", "index.ts");

const VALID_EXPORT = `[6/5/24, 9:15:22 AM] Alice: Hello
[6/5/24, 9:16:00 AM] Bob: <attached: IMG-20240605-WA0001.jpg>`;

function zipHeader(signature: number, size: number): Buffer {
  const header = Buffer.alloc(size);
  header.writeUInt32LE(signature, 0);
  return header;
}

function makeStoredZip(entries: readonly { name: string; data: string | Buffer }[]): Buffer {
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, "utf8");
    const local = zipHeader(0x04_03_4b_50, 30);
    local.writeUInt16LE(0x08_00, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt32LE(0, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    chunks.push(local, name, data);

    const directory = zipHeader(0x02_01_4b_50, 46);
    directory.writeUInt16LE(20, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt16LE(0x08_00, 8);
    directory.writeUInt16LE(0, 10);
    directory.writeUInt32LE(0, 16);
    directory.writeUInt32LE(data.length, 20);
    directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, name);
    offset += local.length + name.length + data.length;
  }
  const centralStart = offset;
  const centralBytes = Buffer.concat(central);
  const end = zipHeader(0x06_05_4b_50, 22);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(centralStart, 16);
  return Buffer.concat([...chunks, centralBytes, end]);
}

function records(messages: readonly EmittedMessage[], stream: string): Record<string, unknown>[] {
  return messages
    .filter((message): message is Extract<EmittedMessage, { type: "RECORD" }> => message.type === "RECORD")
    .filter((message) => message.stream === stream)
    .map((message) => message.data);
}

async function writeMediaZip(importRoot: string): Promise<void> {
  const stagedDir = join(importRoot, "artifact_123");
  await mkdir(stagedDir, { recursive: true });
  const zip = makeStoredZip([
    { name: "WhatsApp Chat - Alice.txt", data: VALID_EXPORT },
    { name: "IMG-20240605-WA0001.jpg", data: Buffer.from([1, 2, 3, 4]) },
  ]);
  await writeFile(join(stagedDir, "Alice export.zip"), zip);
}

async function runWhatsAppImport(
  importRoot: string,
  env: Record<string, string> = {}
): Promise<{ attachment: Record<string, unknown>; messages: EmittedMessage[] }> {
  const result = await runConnectorProtocolSubprocess({
    cwd: PACKAGE_ROOT,
    entrypoint: WHATSAPP_ENTRYPOINT,
    env: {
      PDPP_OWNER_TOKEN: "",
      PDPP_RS_URL: "",
      RS_URL: "",
      WHATSAPP_EXPORT_DIR: importRoot,
      ...env,
    },
    start: {
      scope: { streams: [{ name: "chats" }, { name: "messages" }, { name: "attachments" }] },
      type: "START",
    },
  });
  const attachmentRecords = records(result.messages, "attachments");
  assert.equal(attachmentRecords.length, 1);
  return { attachment: attachmentRecords[0] ?? {}, messages: result.messages };
}

function readRequestBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function withBlobServer<T>(
  handler: (req: IncomingMessage) => Promise<{ body: unknown; status: number }>,
  fn: (baseUrl: string) => Promise<T>
): Promise<T> {
  const server = createServer((req, res) => {
    handler(req)
      .then(({ body, status }) => {
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end(JSON.stringify(body));
      })
      .catch((err: unknown) => {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: err instanceof Error ? err.message : "test server error" }));
      });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address() as AddressInfo;
    return await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  }
}

test("WhatsApp connector imports zip media as deferred attachment records when blob upload is unavailable", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-media-"));
  try {
    await writeMediaZip(importRoot);
    const { attachment, messages } = await runWhatsAppImport(importRoot);

    assert.deepEqual(attachment.blob_ref, null);
    assert.equal(attachment.filename, "IMG-20240605-WA0001.jpg");
    assert.equal(attachment.content_type, "image/jpeg");
    assert.equal(attachment.size_bytes, 4);
    assert.equal(attachment.hydration_status, "deferred");
    assert.match(String(attachment.content_sha256), /^[0-9a-f]{64}$/);
    assert.match(String(attachment.message_id), /^[0-9a-f]{16}:1$/);

    assert.equal(records(messages, "chats").length, 1);
    assert.equal(records(messages, "messages").length, 2);
    const done = messages.at(-1);
    assert.equal(done?.type, "DONE");
    if (done?.type === "DONE") {
      assert.equal(done.status, "succeeded");
      assert.equal(done.records_emitted, 4);
    }
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("WhatsApp connector hydrates zip media through the reference blob endpoint", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-media-"));
  try {
    await writeMediaZip(importRoot);
    await withBlobServer(
      async (req) => {
        assert.equal(req.headers.authorization, "Bearer owner-token");
        assert.equal(req.headers["content-type"], "image/jpeg");
        assert.equal(req.url?.startsWith("/v1/blobs?"), true);
        const url = new URL(req.url ?? "", "http://127.0.0.1");
        assert.equal(url.searchParams.get("connector_id"), "https://registry.pdpp.org/connectors/whatsapp");
        assert.equal(url.searchParams.get("connector_instance_id"), "cin_whatsapp_media");
        assert.equal(url.searchParams.get("stream"), "attachments");
        assert.match(url.searchParams.get("record_key") ?? "", /^[0-9a-f]{16}:attachment:[0-9a-f]{16}$/);
        const body = await readRequestBody(req);
        const sha256 = createHash("sha256").update(body).digest("hex");
        return {
          body: {
            blob_id: `blob_sha256_${sha256}`,
            mime_type: req.headers["content-type"],
            object: "blob",
            sha256,
            size_bytes: body.byteLength,
          },
          status: 200,
        };
      },
      async (baseUrl) => {
        const { attachment } = await runWhatsAppImport(importRoot, {
          PDPP_CONNECTOR_INSTANCE_ID: "cin_whatsapp_media",
          PDPP_OWNER_TOKEN: "owner-token",
          PDPP_RS_URL: baseUrl,
        });
        assert.equal(attachment.hydration_status, "hydrated");
        assert.equal(attachment.hydration_error, null);
        assert.deepEqual(attachment.blob_ref, {
          blob_id: `blob_sha256_${attachment.content_sha256}`,
          mime_type: "image/jpeg",
          sha256: attachment.content_sha256,
          size_bytes: 4,
        });
      }
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});

test("WhatsApp connector marks media hydration failed when blob upload fails", async () => {
  const importRoot = await mkdtemp(join(tmpdir(), "pdpp-whatsapp-media-"));
  try {
    await writeMediaZip(importRoot);
    await withBlobServer(
      async () => ({ body: { error: "synthetic upload failure" }, status: 500 }),
      async (baseUrl) => {
        const { attachment } = await runWhatsAppImport(importRoot, {
          PDPP_OWNER_TOKEN: "owner-token",
          PDPP_RS_URL: baseUrl,
        });
        assert.equal(attachment.hydration_status, "failed");
        assert.deepEqual(attachment.blob_ref, null);
        assert.match(String(attachment.hydration_error), /500.*synthetic upload failure/);
      }
    );
  } finally {
    await rm(importRoot, { force: true, recursive: true });
  }
});
