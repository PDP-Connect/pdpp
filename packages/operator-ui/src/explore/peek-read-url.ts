/**
 * Reconstruct the `GET /v1/streams/<stream>/records/<id>` URL that
 * `rs-client.ts#getRecord` issues. Kept in a stand-alone module (no
 * `server-only` import, no token reads) so the peek panel can render the
 * literal URL the dashboard used, and a targeted test can pin the shape
 * without spinning up the whole dashboard runtime.
 *
 * `rsBaseUrl` is the RS internal origin (e.g. `http://localhost:8080`).
 * `connector_instance_id` is omitted when null, matching `authedFetch`.
 */
export function buildPeekReadUrl(opts: {
  rsBaseUrl: string;
  connectorId: string;
  stream: string;
  recordId: string;
  connectorInstanceId: string | null;
}): string {
  const base = `${opts.rsBaseUrl}/v1/streams/${encodeURIComponent(opts.stream)}/records/${encodeURIComponent(opts.recordId)}`;
  const params = new URLSearchParams();
  params.set("connector_id", opts.connectorId);
  if (opts.connectorInstanceId) {
    params.set("connector_instance_id", opts.connectorInstanceId);
  }
  return `${base}?${params.toString()}`;
}
