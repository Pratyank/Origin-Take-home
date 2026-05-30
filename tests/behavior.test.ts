import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import { configureTrace } from "../src/tools.js";
import type { InboxItem, ItemOutput } from "../src/types.js";

// These tests drive the FULL agent (extract -> classify -> handler -> tools) on
// the deterministic path (no key) and assert on emitted behavior — urgency,
// escalation, tool branching, draft content — not just which handler is chosen.

async function run(items: InboxItem[]): Promise<ItemOutput[]> {
  configureTrace({ path: ".trace/test-behavior.jsonl" });
  return runAgent(items);
}

const tools = (o: ItemOutput): string[] => o.tools_called.map((t) => t.name);

function item(overrides: Partial<InboxItem>): InboxItem {
  return {
    id: "t",
    channel: "email",
    received_at: "2026-06-01T09:00:00-07:00",
    sender: "Test Sender <test@example.com>",
    subject: "test",
    body: "",
    attachments: [],
    ...overrides,
  };
}

test("safeguarding emits P0 + a P0 escalation object, not just the right handler", async () => {
  const [o] = await run([
    item({
      id: "sg",
      channel: "voicemail_transcript",
      sender: "Parent voicemail",
      body: "My son Eli is 5. His dad gets rough with him on weekends. Call me at 555-0000.",
    }),
  ]);
  assert.equal(o.classification, "safeguarding");
  assert.equal(o.urgency, "P0");
  assert.ok(o.escalation, "must produce an escalation object");
  assert.equal(o.escalation?.severity, "P0");
  assert.ok(tools(o).includes("escalate"));
});

test("same-day reschedule emits P1 and does not escalate", async () => {
  const [o] = await run([
    item({
      id: "rs",
      subject: "reschedule today",
      body: "I can't make today's 3pm OT appointment, please reschedule. 555-0000.",
    }),
  ]);
  assert.equal(o.classification, "scheduling");
  assert.equal(o.urgency, "P1");
  assert.equal(o.escalation, null);
});

test("out-of-network referral routes to billing and does NOT surface slots", async () => {
  const [o] = await run([
    item({
      id: "oon",
      channel: "fax_referral",
      body: "Child: Theo Park. DOB: 2020-01-01. Parent: Ana Park, 555-0000. Discipline requested: OT. Concern: sensory. Insurance: Kaiser HMO. Member ID: KSR-1.",
    }),
  ]);
  assert.equal(o.classification, "new_referral");
  assert.equal(o.urgency, "P2");
  assert.ok(tools(o).includes("verify_insurance"));
  assert.ok(tools(o).some((t) => t === "create_task"));
  assert.ok(!tools(o).includes("find_slots"), "out-of-network must not surface/hold slots");
  assert.ok(!tools(o).includes("hold_slot"));
});

test("in-network referral verifies insurance and surfaces availability", async () => {
  const [o] = await run([
    item({
      id: "inn",
      channel: "fax_referral",
      body: "Child: Lia Stone. DOB: 2019-07-07. Parent: Bea Stone, 555-0000. Discipline requested: SLP. Concern: articulation. Insurance: Aetna PPO. Member ID: AET-1.",
    }),
  ]);
  assert.equal(o.classification, "new_referral");
  assert.equal(o.urgency, "P2");
  assert.ok(tools(o).includes("verify_insurance"));
  assert.ok(tools(o).includes("find_slots"), "in-network should surface slots for review");
});

// The drafting contract the brief and the user emphasized: empathetic, no
// clinical advice, and never imply a message was sent or an appointment booked.
const AFFIRMATIVE_SENT_OR_BOOKED =
  /\b(?:we (?:have )?(?:sent|booked|scheduled|rescheduled)|your (?:appointment|message) (?:has been|is|was) (?:sent|booked|scheduled|rescheduled)|you(?:'re| are) (?:booked|scheduled|all set)|appointment (?:is|has been) (?:booked|scheduled|confirmed)|i(?:'ve| have)? (?:sent|booked|scheduled)|(?:message|reply) (?:has been |was )?sent)\b/i;

test("no draft implies a message was sent or an appointment was booked", async () => {
  const inbox = JSON.parse(
    readFileSync(resolve(process.cwd(), "data/inbox.json"), "utf8"),
  ) as InboxItem[];
  const outputs = await run(inbox);
  for (const o of outputs) {
    if (o.draft_reply) {
      assert.doesNotMatch(
        o.draft_reply,
        AFFIRMATIVE_SENT_OR_BOOKED,
        `${o.item_id} draft implies sent/booked: ${o.draft_reply}`,
      );
    }
  }
});

test("clinical-question reply declines to give advice and offers a next step", async () => {
  const [o] = await run([
    item({
      id: "cq",
      channel: "portal_message",
      sender: "Parent via parent portal",
      subject: "is this normal?",
      body: "Is it normal that my 4-year-old still can't say her R sounds? Should I be worried?",
    }),
  ]);
  assert.equal(o.classification, "clinical_question");
  assert.ok(o.draft_reply, "should draft a reply");
  assert.match(
    o.draft_reply ?? "",
    /not able to give clinical guidance|screening|evaluation/i,
    "reply should decline advice and point to a screening/evaluation",
  );
});
