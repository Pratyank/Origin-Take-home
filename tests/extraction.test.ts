import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { extractItem } from "../src/extract.js";
import { classify } from "../src/triage.js";
import type { InboxItem } from "../src/types.js";

const inbox = JSON.parse(
  readFileSync(resolve(process.cwd(), "data/inbox.json"), "utf8"),
) as InboxItem[];

const byId = (id: string): InboxItem => {
  const item = inbox.find((i) => i.id === id);
  assert.ok(item, `fixture ${id} missing`);
  return item;
};

test("extracts core intake fields from a templated fax referral (item_1)", () => {
  const { intake } = extractItem(byId("item_1"));
  assert.equal(intake.child_name, "Emma Lee");
  assert.equal(intake.dob_or_age, "2018-09-04");
  assert.deepEqual(intake.discipline, ["SLP"]);
  assert.equal(intake.payer, "Blue Cross Blue Shield PPO");
  assert.equal(intake.member_id, "BCBS-884200");
  assert.match(intake.parent_contact ?? "", /Daniel Lee/);
  assert.match(intake.parent_contact ?? "", /daniel\.lee@example\.com/);
});

test("does not bleed the next labeled field into the name (no '. DOB' suffix)", () => {
  for (const id of ["item_1", "item_3", "item_6"]) {
    const { intake } = extractItem(byId(id));
    assert.ok(intake.child_name, `${id} name should extract`);
    assert.doesNotMatch(intake.child_name ?? "", /DOB|\bWe\b|Llamo/);
  }
});

test("parses age and Spanish member id from a voicemail transcript (item_7)", () => {
  const { intake, signals } = extractItem(byId("item_7"));
  assert.equal(intake.child_name, "Isabella Lopez");
  assert.equal(intake.dob_or_age, "age 5");
  assert.equal(intake.payer, "Medicaid");
  assert.equal(intake.member_id, "MCD-55320");
  assert.equal(signals.spanish, true);
});

test("flags blank fields as missing on an incomplete referral (item_6)", () => {
  const { missing } = extractItem(byId("item_6"));
  for (const field of ["parent/guardian contact", "insurance payer", "insurance member ID"]) {
    assert.ok(missing.includes(field), `expected '${field}' in missing_info`);
  }
});

test("detects a same-day reschedule signal (item_8)", () => {
  const { signals } = extractItem(byId("item_8"));
  assert.equal(signals.reschedule, true);
  assert.equal(signals.sameDay, true);
});

test("detects a clinical-advice question, not a referral (item_5)", () => {
  const { signals } = extractItem(byId("item_5"));
  assert.equal(signals.clinicalQuestion, true);
});

const EXPECTED_HANDLER: Record<string, string> = {
  item_1: "handleNewReferral",
  item_2: "handleSafeguarding",
  item_3: "handleNewReferral",
  item_4: "handleNewReferral",
  item_5: "handleClinicalQuestion",
  item_6: "handleMissingPaperwork",
  item_7: "handleNewReferral",
  item_8: "handleScheduling",
};

test("routes every visible item to the expected handler", () => {
  for (const item of inbox) {
    const { handler } = classify(item, extractItem(item));
    assert.equal(
      handler.name,
      EXPECTED_HANDLER[item.id],
      `${item.id} routed to ${handler.name}, expected ${EXPECTED_HANDLER[item.id]}`,
    );
  }
});

test("safeguarding routing takes precedence over the scheduling ask (item_2)", () => {
  const item = byId("item_2");
  const ex = extractItem(item);
  // The message also contains a scheduling request ("get him in for an eval");
  // safety must win.
  assert.equal(ex.signals.safeguarding, true);
  assert.equal(classify(item, ex).handler.name, "handleSafeguarding");
});
