import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import { configureTrace } from "../src/tools.js";
import type { InboxItem } from "../src/types.js";

const VALID_CLASSES = new Set([
  "new_referral",
  "existing_patient_request",
  "scheduling",
  "clinical_question",
  "billing_question",
  "missing_paperwork",
  "provider_followup",
  "complaint",
  "safeguarding",
  "spam",
  "other",
]);

test("malformed and partial items still produce one valid output each", async () => {
  configureTrace({ path: ".trace/test-robustness.jsonl" });

  // Deliberately malformed: empty object, missing id, unknown channel, non-string body.
  const malformed = [
    {},
    { channel: "carrier_pigeon", subject: "no id here", body: "Please call me back." },
    { id: "weird_1", body: 42, attachments: "nope" },
  ] as unknown as InboxItem[];

  const outputs = await runAgent(malformed);

  assert.equal(outputs.length, 3, "one output per input item");
  const ids = new Set<string>();
  for (const o of outputs) {
    assert.ok(o.item_id && o.item_id.length > 0, "every item has a non-empty id");
    ids.add(o.item_id);
    assert.equal(o.requires_human_review, true);
    assert.ok(VALID_CLASSES.has(o.classification), `valid classification: ${o.classification}`);
    assert.ok(o.recommended_next_action.length > 0);
    assert.ok(Array.isArray(o.tools_called));
  }
  assert.equal(ids.size, 3, "item ids are unique (positional fallback for the missing one)");
});

test("runAgent rejects a non-array input at the boundary", async () => {
  await assert.rejects(
    () => runAgent(null as unknown as InboxItem[]),
    /expected an array/,
  );
});
