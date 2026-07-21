/**
 * Schema tests for the Uber connector.
 *
 * IMPORTANT: uber/index.ts does not yet emit any RECORD (GraphQL extraction is
 * deferred; it emits SKIP_RESULT). So these fixtures are NOT parser-derived —
 * they are records shaped to the connector's MANIFEST stream contract
 * (manifests/uber.json). They prove the schema accepts the declared contract
 * and rejects representative drift, so the first real emit is shape-checked.
 * Whoever wires extraction MUST replace these with fixture-proven records and
 * tighten the id/fare shapes.
 */

import assert from "node:assert/strict";
import { test } from "node:test";
import { tripsSchema, validateRecord } from "./schemas.ts";

const TRIP_RECORD = {
  id: "b3a1c2d4-5e6f-7081-92a3-b4c5d6e7f809",
  status: "COMPLETED",
  product_type: "UberX",
  requested_at: "2024-05-01T18:00:00.000Z",
  started_at: "2024-05-01T18:04:00.000Z",
  completed_at: "2024-05-01T18:32:00.000Z",
  pickup_address: "1 Market St, San Francisco, CA",
  pickup_lat: 37.7936,
  pickup_lng: -122.395,
  dropoff_address: "1455 Market St, San Francisco, CA",
  dropoff_lat: 37.7766,
  dropoff_lng: -122.4169,
  distance_meters: 3210.5,
  duration_seconds: 1680,
  fare_total: "$18.42",
  fare_total_cents: 1842,
  currency: "USD",
  tip_cents: 300,
  surge_multiplier: 1.0,
  driver_name: "Jordan",
  vehicle_description: "Toyota Prius (Silver)",
  receipt_url: "https://riders.uber.com/trips/b3a1c2d4/receipt",
};

test("trips schema accepts a contract-shaped record", () => {
  const result = tripsSchema.safeParse(TRIP_RECORD);
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("trips schema accepts a canceled trip (null fare / coords / driver)", () => {
  const result = tripsSchema.safeParse({
    ...TRIP_RECORD,
    status: "CANCELED",
    started_at: null,
    completed_at: null,
    pickup_lat: null,
    pickup_lng: null,
    dropoff_address: null,
    dropoff_lat: null,
    dropoff_lng: null,
    distance_meters: null,
    duration_seconds: null,
    fare_total: null,
    fare_total_cents: null,
    currency: null,
    tip_cents: null,
    surge_multiplier: null,
    driver_name: null,
    vehicle_description: null,
    receipt_url: null,
  });
  assert.ok(result.success, JSON.stringify(result.error?.issues));
});

test("trips schema rejects a negative fare_total_cents", () => {
  assert.equal(tripsSchema.safeParse({ ...TRIP_RECORD, fare_total_cents: -1 }).success, false);
});

test("trips schema rejects a non-ISO currency", () => {
  assert.equal(tripsSchema.safeParse({ ...TRIP_RECORD, currency: "dollars" }).success, false);
});

test("trips schema rejects a non-URL receipt_url", () => {
  assert.equal(tripsSchema.safeParse({ ...TRIP_RECORD, receipt_url: "emailed receipt" }).success, false);
});

test("validateRecord routes trips and passes unknown streams through", () => {
  assert.equal(validateRecord("trips", TRIP_RECORD).ok, true);
  assert.equal(validateRecord("eats_orders", { id: "x" }).ok, true);
});
