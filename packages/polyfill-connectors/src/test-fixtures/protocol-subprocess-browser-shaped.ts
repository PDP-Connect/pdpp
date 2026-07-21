import type { RecordData, ValidateRecord } from "../connector-runtime.ts";
import { runConnector } from "../connector-runtime.ts";

const validateRecord: ValidateRecord = (stream: string, data: RecordData) => {
  if (stream === "orders" && typeof data.id === "string" && data.source === "browser_fixture") {
    return { ok: true, data };
  }
  return { ok: false, issues: [{ path: "id", message: "expected a browser fixture order id" }] };
};

runConnector({
  name: "protocol-subprocess-browser-shaped",
  validateRecord,
  async collect({ emit, emitRecord }) {
    await emit({ type: "PROGRESS", stream: "orders", message: "replaying browser-shaped fixture data" });
    await emitRecord("orders", {
      id: "order-1",
      source: "browser_fixture",
      captured_from: "orders-list",
    });
    await emit({
      type: "SKIP_RESULT",
      stream: "order_details",
      reason: "fixture_without_browser",
      message: "detail-pane collection intentionally skipped in no-browser fixture",
    });
    await emit({ type: "STATE", stream: "orders", cursor: { last_order_id: "order-1" } });
  },
});
