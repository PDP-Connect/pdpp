import assert from "node:assert/strict";
import test from "node:test";
import type { DashboardDataSource } from "../lib/data-source.ts";
import type { ConnectorManifest, StreamMetadata } from "../lib/rs-client.ts";
import { buildPeekRelationships, hasPeekRelationships } from "./explore-peek-relationships.ts";

// A minimal data source stub exposing only the three reads the helper calls.
function stubDataSource(over: {
  manifests?: ConnectorManifest[];
  streamMetadata?: Record<string, StreamMetadata>;
  summaries?: Array<{ connection_id: string; connector_id: string; connector_instance_id?: string }>;
}): DashboardDataSource {
  const summaries = over.summaries ?? [{ connection_id: "conn_bank_chk", connector_id: "chase" }];
  return {
    listConnectorSummaries: () => Promise.resolve({ object: "list", data: summaries, has_more: false } as never),
    listConnectorManifests: () => Promise.resolve(over.manifests ?? []),
    getStreamMetadata: (_connectorId: string, stream: string) => {
      const meta = over.streamMetadata?.[stream];
      if (!meta) {
        return Promise.resolve({ name: stream } as StreamMetadata);
      }
      return Promise.resolve(meta);
    },
  } as unknown as DashboardDataSource;
}

test("buildPeekRelationships resolves a child → parent back-link from a child-declared has_one", async () => {
  // Chase-shaped: transactions declare a `has_one` to accounts via `account_id`.
  const manifests: ConnectorManifest[] = [
    {
      connector_id: "chase",
      streams: [
        {
          name: "transactions",
          relationships: [{ name: "account", stream: "accounts", foreign_key: "account_id", cardinality: "has_one" }],
        },
        { name: "accounts" },
      ],
    },
  ];
  const rels = await buildPeekRelationships(
    {
      connectorId: "chase",
      connectionId: "conn_bank_chk",
      stream: "transactions",
      recordId: "rec_tx_41203",
      data: { amount: -640, account_id: "acct_checking_4417" },
    },
    stubDataSource({ manifests })
  );

  assert.equal(rels.parentBackLinks.length, 1);
  assert.equal(rels.parentBackLinks[0]?.parentStream, "accounts");
  assert.equal(rels.parentBackLinks[0]?.childParentKeyField, "account_id");
  // The href targets the parent record's detail page in the records route — the
  // SAME href the records detail page produces (one source of truth).
  assert.equal(rels.parentBackLinks[0]?.href, "/dashboard/records/conn_bank_chk/accounts/acct_checking_4417");
  assert.equal(hasPeekRelationships(rels), true);
});

test("buildPeekRelationships resolves a parent → child has_many link from expand_capabilities", async () => {
  // Inspecting a PARENT (accounts) record whose metadata declares has_many → transactions.
  const streamMetadata: Record<string, StreamMetadata> = {
    accounts: {
      name: "accounts",
      expand_capabilities: [
        {
          name: "transactions",
          target_stream: "transactions",
          child_parent_key_field: "account_id",
          cardinality: "has_many",
          usable: true,
        },
      ],
    },
  };
  const rels = await buildPeekRelationships(
    {
      connectorId: "chase",
      connectionId: "conn_bank_chk",
      stream: "accounts",
      recordId: "acct_checking_4417",
      data: { name: "checking ····4417" },
    },
    stubDataSource({ streamMetadata })
  );

  assert.equal(rels.relatedLinks.length, 1);
  assert.equal(rels.relatedLinks[0]?.relation, "transactions");
  assert.equal(rels.relatedLinks[0]?.navigable, true);
  // has_many → filtered child list keyed by the parent record's key. The
  // bracket form is literal; only the field name and value are percent-encoded.
  assert.equal(
    rels.relatedLinks[0]?.href,
    "/dashboard/records/conn_bank_chk/transactions?filter[account_id]=acct_checking_4417"
  );
});

test("buildPeekRelationships returns empty (never throws) when no declared edge exists", async () => {
  const rels = await buildPeekRelationships(
    {
      connectorId: "gmail",
      connectionId: "conn_mail_work",
      stream: "messages",
      recordId: "rec_msg_8841",
      data: { subject: "hi", from: "dana@studio.example" },
    },
    stubDataSource({ summaries: [{ connection_id: "conn_mail_work", connector_id: "gmail" }] })
  );
  assert.deepEqual(rels, { relatedLinks: [], reverseChildListLinks: [], parentBackLinks: [] });
  assert.equal(hasPeekRelationships(rels), false);
});
