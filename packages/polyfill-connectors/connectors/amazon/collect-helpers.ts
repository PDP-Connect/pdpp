/**
 * Collect-layer helpers for the Amazon connector.
 *
 * Lives in its own file (not index.ts) because index.ts calls
 * `runConnector({...})` at module load — importing it in a test keeps
 * the Node event loop alive waiting for the stdin protocol. This file
 * contains only pure, stateless helpers + their types, safe to import
 * from test code without side effects.
 */

import type { BrowserCollectContext } from "../../src/connector-runtime.ts";
import { buildOrderItemRecord, buildOrderRecord, mergeOrderItems } from "./parsers.ts";
import type { ListPageOrder, OrderDetail } from "./types.ts";

export type EmitFn = BrowserCollectContext["emit"];
export type EmitRecordFn = BrowserCollectContext["emitRecord"];
export type CaptureDep = BrowserCollectContext["capture"];

/** Ephemeral per-run flags that cross year boundaries. */
export interface RunFlags {
  detailCaptured: boolean;
}

/** Per-run dependencies threaded through processListOrder → emitOrderAndItems. */
export interface EmitDeps {
  capture: CaptureDep;
  emit: EmitFn;
  emitRecord: EmitRecordFn;
  emittedAt: string;
  skipDetail: boolean;
  wantsItems: boolean;
  wantsOrders: boolean;
}

/** Emit the order record + per-item records for a single list-page order.
 *
 * The invariants this enforces:
 *   1. The order record emits BEFORE its item records (so downstream
 *      readers see the parent-child relationship in order).
 *   2. Items emit in mergeOrderItems() order — list-page items first,
 *      detail-only items appended — which is the dedup + enrichment
 *      order consumers depend on.
 *   3. Streams disabled via scope (wantsOrders/wantsItems) emit nothing;
 *      the other stream still flows.
 * Regressing any of these is a real bug; integration.test.ts covers them.
 */
export async function emitOrderAndItems(
  deps: EmitDeps,
  listOrder: ListPageOrder,
  detail: OrderDetail | null,
  orderDate: string
): Promise<void> {
  if (deps.wantsOrders) {
    await deps.emitRecord("orders", buildOrderRecord(listOrder, detail, orderDate, deps.emittedAt));
  }
  if (deps.wantsItems) {
    for (const merged of mergeOrderItems(listOrder, detail)) {
      await deps.emitRecord("order_items", buildOrderItemRecord(listOrder.orderId, orderDate, merged));
    }
  }
}
