# Blob Fetch Runbook

**Purpose:** operator-replayable walkthrough of the `blob_ref` / `fetch_url`
surface. Proves the grant-scoped byte-fetch flow end-to-end and documents the
exact request/response contract. Gmail `attachments` is the first and currently
only shipping hydration path; the examples below use it.

This runbook is read-only from the server's perspective. It does not change server
behaviour and makes no mutations beyond the seeding steps.

---

## What blob_ref / fetch_url is

When a connector stores binary content (e.g., a Gmail attachment PDF), the
reference implementation stores the bytes in a content-addressed blob table and
records a `blob_ref` on the attachment record:

```json
{
  "id": "msg-1:2",
  "message_id": "msg-1",
  "filename": "invoice.pdf",
  "content_type": "application/pdf",
  "blob_ref": {
    "blob_id": "blob_sha256_e3b0c44298fc1c149afb",
    "mime_type": "application/pdf",
    "size_bytes": 42317,
    "sha256": "e3b0c44298fc1c149afb..."
  }
}
```

When a client queries the record under a grant that includes the `attachments`
stream with the `blob_ref` field, the RS decorates `blob_ref` with a
`fetch_url`:

```json
{
  "blob_ref": {
    "blob_id": "blob_sha256_e3b0c44298fc1c149afb",
    "mime_type": "application/pdf",
    "size_bytes": 42317,
    "sha256": "e3b0c44298fc1c149afb...",
    "fetch_url": "/v1/blobs/blob_sha256_e3b0c44298fc1c149afb"
  }
}
```

`fetch_url` is a relative path. Prepend the RS base URL. The `GET /v1/blobs/:blob_id`
route enforces grant scope — the token used to read the record is **the same
token** used to fetch the blob. No extra credential is needed.

---

## Full walkthrough

Set environment variables first:

```bash
AS_URL="http://localhost:7662"   # authorization server
RS_URL="http://localhost:7763"   # resource server
CONNECTOR_ID="https://registry.pdpp.org/connectors/gmail"
SUBJECT_ID="owner_local"
```

### Step 1 — Upload the blob (connector/owner write path)

The connector runtime normally writes blobs during a collection run. For manual
replay, use the blob upload endpoint directly. Owner token required.

```bash
# Get an owner token via the device flow
DEVICE=$(curl -s -X POST "$AS_URL/oauth/device_authorization" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "client_id=pdpp-cli")
USER_CODE=$(echo "$DEVICE" | jq -r .user_code)
DEVICE_CODE=$(echo "$DEVICE" | jq -r .device_code)

# Approve as owner (lab/local only — on a real deployment this happens in the UI)
curl -s -X POST "$AS_URL/device/approve" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "user_code=$USER_CODE&subject_id=$SUBJECT_ID"

# Exchange for the owner token
OWNER_TOKEN=$(curl -s -X POST "$AS_URL/oauth/token" \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=$DEVICE_CODE&client_id=pdpp-cli" \
  | jq -r .access_token)
```

Upload the bytes. Bind the blob to the attachment record that will reference it:

```bash
RECORD_KEY="msg-1:2"

BLOB_RESP=$(curl -s -X POST \
  "$RS_URL/v1/blobs?connector_id=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CONNECTOR_ID'))")&stream=attachments&record_key=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$RECORD_KEY'))")" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/pdf" \
  --data-binary @invoice.pdf)

BLOB_ID=$(echo "$BLOB_RESP" | jq -r .blob_id)
BLOB_MIME=$(echo "$BLOB_RESP" | jq -r .mime_type)
BLOB_SIZE=$(echo "$BLOB_RESP" | jq -r .size_bytes)
BLOB_SHA256=$(echo "$BLOB_RESP" | jq -r .sha256)
echo "Stored blob: $BLOB_ID"
```

Upload response shape (`HTTP 200`):

```json
{
  "blob_id": "blob_sha256_e3b0c44298fc1c149afb",
  "mime_type": "application/pdf",
  "size_bytes": 42317,
  "sha256": "e3b0c44298fc1c149afb..."
}
```

### Step 2 — Seed the parent message and the attachment record

Blobs are only reachable via a record that declares `blob_ref`. Seed both:

```bash
# Seed the parent Gmail message
curl -s -X POST \
  "$RS_URL/v1/ingest/messages?connector_id=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CONNECTOR_ID'))")" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  -d '{"key":"msg-1","data":{"id":"msg-1","thread_id":"thread-1","subject":"Invoice Nov 2025","received_at":"2025-11-01T10:00:00Z","to":[],"cc":[],"bcc":[],"reply_to":[],"references":[],"labels":[],"is_draft":false,"is_flagged":false,"is_seen":true,"is_answered":false,"has_attachments":true,"snippet":"Please find the invoice attached."},"emitted_at":"2025-11-01T10:00:00Z"}'

# Seed the attachment record that carries blob_ref
curl -s -X POST \
  "$RS_URL/v1/ingest/attachments?connector_id=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CONNECTOR_ID'))")" \
  -H "Authorization: Bearer $OWNER_TOKEN" \
  -H "Content-Type: application/x-ndjson" \
  -d "{\"key\":\"msg-1:2\",\"data\":{\"id\":\"msg-1:2\",\"message_id\":\"msg-1\",\"filename\":\"invoice.pdf\",\"content_type\":\"application/pdf\",\"size_bytes\":$BLOB_SIZE,\"content_id\":null,\"is_inline\":false,\"encoding\":\"base64\",\"part_index\":\"2\",\"message_received_at\":\"2025-11-01T10:00:00Z\",\"blob_ref\":{\"blob_id\":\"$BLOB_ID\",\"mime_type\":\"$BLOB_MIME\",\"size_bytes\":$BLOB_SIZE,\"sha256\":\"$BLOB_SHA256\"},\"content_sha256\":\"$BLOB_SHA256\",\"hydration_status\":\"hydrated\",\"hydration_error\":null},\"emitted_at\":\"2025-11-01T10:00:00Z\"}"
```

### Step 3 — Issue a grant-scoped client token that includes `blob_ref`

```bash
PAR=$(curl -s -X POST "$AS_URL/oauth/par" \
  -H "Content-Type: application/json" \
  -d "{
    \"client_id\": \"my_client\",
    \"authorization_details\": [{
      \"type\": \"https://pdpp.org/data-access\",
      \"source\": { \"kind\": \"connector\", \"id\": \"$CONNECTOR_ID\" },
      \"purpose_code\": \"assist.export\",
      \"purpose_description\": \"Export Gmail attachment bytes for local archival.\",
      \"access_mode\": \"single_use\",
      \"streams\": [
        {
          \"name\": \"messages\",
          \"fields\": [\"id\", \"thread_id\", \"subject\", \"received_at\", \"has_attachments\"]
        },
        {
          \"name\": \"attachments\",
          \"fields\": [\"id\", \"message_id\", \"filename\", \"content_type\", \"size_bytes\", \"blob_ref\"]
        }
      ]
    }]
  }")
REQUEST_URI=$(echo "$PAR" | jq -r .request_uri)

CLIENT_TOKEN=$(curl -s -X POST "$AS_URL/consent/approve" \
  -H "Content-Type: application/json" \
  -d "{\"request_uri\": \"$REQUEST_URI\", \"subject_id\": \"$SUBJECT_ID\"}" \
  | jq -r .token)
```

**Key point:** `blob_ref` must be listed in `streams[attachments].fields`.
If it is absent, the RS redacts the `blob_ref` field before returning records
and `fetch_url` is never decorated — the blob is not reachable via that token.

### Step 4 — Query records and read the `fetch_url`

```bash
RECORDS=$(curl -s \
  "$RS_URL/v1/streams/attachments/records?connector_id=$(python3 -c "import urllib.parse; print(urllib.parse.quote('$CONNECTOR_ID'))")" \
  -H "Authorization: Bearer $CLIENT_TOKEN")
echo "$RECORDS" | jq .
```

Representative response:

```json
{
  "object": "list",
  "data": [
    {
      "object": "record",
      "id": "msg-1:2",
      "stream": "attachments",
      "data": {
        "id": "msg-1:2",
        "message_id": "msg-1",
        "filename": "invoice.pdf",
        "content_type": "application/pdf",
        "size_bytes": 42317,
        "blob_ref": {
          "blob_id": "blob_sha256_e3b0c44298fc1c149afb",
          "mime_type": "application/pdf",
          "size_bytes": 42317,
          "sha256": "e3b0c44298fc1c149afb...",
          "fetch_url": "/v1/blobs/blob_sha256_e3b0c44298fc1c149afb"
        }
      },
      "emitted_at": "2025-11-01T10:00:00Z"
    }
  ],
  "has_more": false
}
```

Extract the fetch URL:

```bash
FETCH_URL=$(echo "$RECORDS" | jq -r '.data[0].data.blob_ref.fetch_url')
```

### Step 5 — Fetch the blob bytes

```bash
curl -s -o invoice_downloaded.pdf -D - \
  "${RS_URL}${FETCH_URL}" \
  -H "Authorization: Bearer $CLIENT_TOKEN"
```

Expected response headers:

```
HTTP/1.1 200 OK
Content-Type: application/pdf
Content-Length: 42317
Cache-Control: private, no-store
```

The bytes are the raw content uploaded in Step 1. Verify integrity:

```bash
sha256sum invoice_downloaded.pdf
# must match $BLOB_SHA256
```

### Step 6 — Grant enforcement: blob is invisible without a matching token

Fetching the same blob with a **different token** that does not grant access to
the `attachments` stream (or whose grant does not include `blob_ref` in its
field projection) returns `blob_not_found`:

```bash
curl -s "${RS_URL}${FETCH_URL}" \
  -H "Authorization: Bearer $SOME_OTHER_TOKEN"
```

```json
{
  "error": { "code": "blob_not_found", "message": "Blob not found" }
}
```

HTTP status: `404`.

The enforcement logic:
1. The RS loads all `blob_bindings` for the requested `blob_id`.
2. For each binding whose `connector_id` matches the token's resolved storage
   binding, it attempts to load the bound record under the token's grant.
3. If the grant projection does not include `blob_ref`, the field is stripped
   from the record response and the record is considered invisible.
4. If no binding produces a visible record, the route returns `blob_not_found`.
   The caller learns only that the blob does not exist — not which connector
   owns it.

---

## Contract summary

| Property | Value |
| --- | --- |
| Endpoint | `GET /v1/blobs/:blob_id` |
| Auth | Same bearer token used to read the record |
| `blob_ref` visibility | Only present on records when the grant includes the `blob_ref` field in the stream projection |
| Response `Content-Type` | The `mime_type` stored at upload time |
| `Cache-Control` | `private, no-store` (always) |
| `Content-Length` | Exact `size_bytes` stored at upload time |
| Grant enforcement | Token's grant must grant visibility to the record that carries the `blob_ref`; otherwise `404 blob_not_found` |
| `fetch_url` shape | Relative path `/v1/blobs/<blob_id>` — prepend RS base URL |

---

## Conformance note

`query-contract.test.js` in `reference-implementation/test/` contains the
authoritative conformance test for this surface:

- `gmail messages expand hydrated attachments with grant-visible blob_ref fetch_url`
  — proves Steps 3-5 above using an in-process harness
- The test at L2913 proves the `blob_not_found` enforcement from Step 6

The tests in `reference-implementation/test/b4-blob-fetch-conformance.test.js`
prove the documented contract shapes in isolation (upload → record query → blob
fetch → header assertions → grant enforcement).
