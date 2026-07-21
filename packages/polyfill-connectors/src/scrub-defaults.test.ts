import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultScrubRules } from "./scrub-defaults.ts";
import { applyScrubRules } from "./scrubber.ts";

test("default scrub rules redact deterministic PII patterns", () => {
  const raw = [
    "Email: alice.owner@example.com",
    "Phone: (512) 555-0199",
    "SSN: 123-45-6789",
    "Card: 4111 1111 1111 1111",
    "Account number: 9876543210",
    "Ship to: Alice Example",
    "Address: 123 Private Oak Street, Austin, TX 78701",
  ].join("\n");

  const scrubbed = applyScrubRules(raw, defaultScrubRules, "all");

  assert.match(scrubbed, /redacted@example\.com/);
  assert.match(scrubbed, /555-555-5555/);
  assert.match(scrubbed, /000-00-0000/);
  assert.match(scrubbed, /0000-0000-0000-0000/);
  assert.match(scrubbed, /\[REDACTED_ACCOUNT\]/);
  assert.match(scrubbed, /\[REDACTED_NAME\]/);
  assert.match(scrubbed, /\[REDACTED_ADDRESS\]/);

  assert.doesNotMatch(scrubbed, /alice\.owner@example\.com/);
  assert.doesNotMatch(scrubbed, /123-45-6789/);
  assert.doesNotMatch(scrubbed, /4111 1111 1111 1111/);
  assert.doesNotMatch(scrubbed, /9876543210/);
  assert.doesNotMatch(scrubbed, /Alice Example/);
  assert.doesNotMatch(scrubbed, /123 Private Oak Street/);
});

test("default scrub rules preserve JSON shape", () => {
  const raw = JSON.stringify({
    id: "order-1",
    accountNumber: "123456789012",
    customerName: "Alice Example",
    email: "alice@example.com",
    items: [{ title: "Parser-relevant product title", total: 42.5 }],
  });

  const scrubbed = applyScrubRules(raw, defaultScrubRules, "json");
  const parsed = JSON.parse(scrubbed) as {
    id: string;
    accountNumber: string;
    customerName: string;
    email: string;
    items: Array<{ title: string; total: number }>;
  };

  assert.equal(parsed.id, "order-1");
  assert.equal(parsed.accountNumber, "[REDACTED_ACCOUNT]");
  assert.equal(parsed.customerName, "[REDACTED_NAME]");
  assert.equal(parsed.email, "redacted@example.com");
  assert.deepEqual(parsed.items, [{ title: "Parser-relevant product title", total: 42.5 }]);
});

test("default scrub rules preserve HTML selectors and attributes", () => {
  const raw = `
    <section data-testid="order-card" data-order-id="111-2222222-3333333">
      <span class="customer">Name: Alice Example</span>
      <a href="mailto:alice@example.com">alice@example.com</a>
      <span class="address">123 Private Oak Street, Austin, TX 78701</span>
    </section>
  `;

  const scrubbed = applyScrubRules(raw, defaultScrubRules, "html");

  assert.match(scrubbed, /data-testid="order-card"/);
  assert.match(scrubbed, /data-order-id="111-2222222-3333333"/);
  assert.match(scrubbed, /class="customer"/);
  assert.match(scrubbed, /redacted@example\.com/);
  assert.match(scrubbed, /\[REDACTED_NAME\]/);
  assert.match(scrubbed, /\[REDACTED_ADDRESS\]/);
});

test("connector-specific rules run after defaults and can redact platform identifiers", () => {
  const connectorRules = [
    {
      pattern: /\border-\d{3}-\d{7}-\d{7}\b/g,
      replacement: "order-[REDACTED]",
      scope: "all" as const,
    },
  ];
  const raw = "buyer alice@example.com placed order-111-2222222-3333333";

  const scrubbed = applyScrubRules(raw, [...defaultScrubRules, ...connectorRules], "all");

  assert.equal(scrubbed, "buyer redacted@example.com placed order-[REDACTED]");
});
