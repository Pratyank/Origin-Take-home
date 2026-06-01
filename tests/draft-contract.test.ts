import assert from "node:assert/strict";
import { test } from "node:test";
import { runAgent } from "../src/agent.js";
import { configureTrace } from "../src/tools.js";
import type { InboxItem, ItemOutput } from "../src/types.js";

// CONTRACT UNDER TEST
// -------------------
// Every confident factual claim in a HIGH-VISIBILITY field (draft_reply,
// recommended_next_action, missing_info) must be backed by what a tool actually
// returned, or by an established caller identity. Where the tool state or the
// caller's identity does not support a claim, the gap must be SURFACED in a
// high-visibility field — not buried in decision_rationale, and not silently
// dropped.
//
// These tests are deliberately RED against the current code. Each reproduces one
// of four sites where a draft asserts more than the tools/identity support. They
// read real tool output (not hard-coded strings) so they assert the contract
// itself, and stay valid after the drafts are reworded.

async function run(items: InboxItem[]): Promise<ItemOutput[]> {
  configureTrace({ path: ".trace/test-draft-contract.jsonl" });
  return runAgent(items);
}

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

const toolResult = (o: ItemOutput, name: string): string =>
  o.tools_called.find((t) => t.name === name)?.result_summary ?? "";

// The fields a human reviewer reads first. decision_rationale is deliberately
// EXCLUDED here: surfacing a gap only in the rationale is exactly the failure the
// brief calls out ("not just the decision rationale").
const visibleFields = (o: ItemOutput): string =>
  [o.draft_reply ?? "", o.recommended_next_action, o.missing_info.join(" ")].join("\n");

// A — insurance verification claim ------------------------------------------
// verify_insurance returns "unknown" for any payer the billing system doesn't
// recognize. The draft must not assert in-network coverage in that case; today
// the "verified as in-network" clause is gated only on a payer string existing.
test("A: draft does not assert in-network coverage unless verify_insurance returned in_network", async () => {
  const [o] = await run([
    item({
      id: "unknown_payer",
      channel: "fax_referral",
      sender: "Eastside Pediatrics fax",
      body:
        "Child: Rosa Diaz. DOB: 2018-02-02. Parent: Elena Diaz, 555-0011. " +
        "Discipline requested: SLP. Concern: articulation delay. " +
        "Insurance: Horizon NJ Health. Member ID: HRZ-1.",
    }),
  ]);

  assert.equal(o.classification, "new_referral");
  assert.doesNotMatch(
    toolResult(o, "verify_insurance"),
    /in_network/,
    "precondition: an unrecognized payer should verify as unknown, not in_network",
  );
  assert.ok(o.draft_reply, "a new referral should still draft a reply");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /in[\s-]?network/i,
    `draft asserts in-network coverage the billing system did not verify: ${o.draft_reply}`,
  );
});

// B — caller identity vs system of record -----------------------------------
// search_patient matches an existing child whose guardian on record is Sofia
// Ramirez, but the caller claims to be the parent "Carla Mendez". That conflict
// must reach a reviewer through a high-visibility field, not be discarded.
test("B: caller-identity conflict (claimed parent != guardian on record) is surfaced in a visible field", async () => {
  const [o] = await run([
    item({
      id: "identity_conflict",
      channel: "email",
      sender: "Carla Mendez <carla.mendez@example.com>",
      body:
        "Hello, our pediatrician sent a referral for Mateo Ramirez, DOB 2019-03-15. " +
        "I am his parent, Carla Mendez. We want a PT evaluation for toe walking. " +
        "Insurance is Aetna PPO, member ID AET-9910. Call me at 555-0104.",
    }),
  ]);

  assert.match(
    toolResult(o, "search_patient"),
    /patient match/i,
    "precondition: should match the existing patient record (guardian: Sofia Ramirez)",
  );
  assert.match(
    visibleFields(o),
    /identit|guardian|verify (?:the )?(?:caller|parent|relationship|who)|confirm (?:the )?(?:caller|parent|guardian|relationship|identit)/i,
    "caller-vs-guardian mismatch must be surfaced in a high-visibility field, not dropped",
  );
});

// C — Spanish provider promise ----------------------------------------------
// The Spanish draft promises "una proveedora que habla español" unconditionally.
// For a Spanish-speaking family requesting PT, find_slots(es) returns nothing
// (the only PT provider is English-only), so that promise is unsupported.
test("C: Spanish referral does not promise a Spanish-speaking provider unless find_slots surfaced one", async () => {
  const [o] = await run([
    item({
      id: "es_no_provider",
      channel: "voicemail_transcript",
      sender: "Rosa Mendoza voicemail",
      body:
        "Hola, soy Rosa Mendoza. Llamo por mi hijo Diego, tiene 6 anos. " +
        "He is toe walking and tripping a lot — necesita PT. " +
        "Tenemos Medicaid, miembro MCD-1. Prefiero alguien que hable espanol. " +
        "Mi telefono es 555-0012. Gracias.",
    }),
  ]);

  assert.match(
    toolResult(o, "find_slots"),
    /0 matching slots/,
    "precondition: no Spanish-capable PT provider should be available",
  );
  assert.ok(o.draft_reply, "should draft a reply");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /habla espa[nñ]ol|proveedora?\s+que habla|proveedora?\s+de habla|en espa[nñ]ol con/i,
    `draft promises a Spanish-speaking provider find_slots did not surface: ${o.draft_reply}`,
  );
});

// D — reschedule described as a cancellation --------------------------------
// The parent asked to reschedule (no "cancel"), and the agent neither cancelled
// nor rescheduled anything — it routed to the front desk. The draft must not
// assert that a cancellation was noted.
test("D: a reschedule-only request does not claim a cancellation was noted", async () => {
  const [o] = await run([
    item({
      id: "reschedule_only",
      channel: "email",
      sender: "Anita Patel <anita.patel@example.com>",
      subject: "reschedule today",
      body:
        "Noah threw up at school and I can't make today's 3pm OT appointment. " +
        "Please reschedule. Call me at 555-0108.",
    }),
  ]);

  assert.equal(o.classification, "scheduling");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /noted the cancellation|cancellation (?:has been|is|was) (?:noted|recorded|processed)|we'?ve (?:noted|recorded|processed) the cancellation/i,
    `draft claims a cancellation for a reschedule-only request: ${o.draft_reply}`,
  );
});

// E — unknown payer must surface the verification gap as a staff action -------
// The draft already softens the claim; the actionable field must also flag that
// billing did not recognize the payer, mirroring the out-of-network branch.
test("E: an unrecognized payer surfaces a coverage-verification step in recommended_next_action", async () => {
  const [o] = await run([
    item({
      id: "unknown_payer_action",
      channel: "fax_referral",
      sender: "Eastside Pediatrics fax",
      body:
        "Child: Rosa Diaz. DOB: 2018-02-02. Parent: Elena Diaz, 555-0011. " +
        "Discipline requested: SLP. Concern: articulation delay. " +
        "Insurance: Horizon NJ Health. Member ID: HRZ-1.",
    }),
  ]);

  assert.doesNotMatch(toolResult(o, "verify_insurance"), /in_network/);
  assert.match(
    o.recommended_next_action,
    /verify .*coverage|unrecognized|not (?:recognized|verified)|benefits/i,
    `unrecognized-payer verification gap not surfaced as an action: ${o.recommended_next_action}`,
  );
});

// F — prior authorization (tool state) must be surfaced ----------------------
// verify_insurance returns auth_required:true for Aetna/BCBS/United. That is a
// material gating condition the visible output currently drops entirely.
test("F: an in-network referral requiring prior authorization surfaces it in a visible field", async () => {
  const [o] = await run([
    item({
      id: "auth_required",
      channel: "fax_referral",
      sender: "Northside Pediatrics fax",
      body:
        "Child: Lia Stone. DOB: 2019-07-07. Parent: Bea Stone, 555-0000. " +
        "Discipline requested: SLP. Concern: articulation. " +
        "Insurance: Aetna PPO. Member ID: AET-2.",
    }),
  ]);

  assert.match(toolResult(o, "verify_insurance"), /in_network/, "precondition: Aetna verifies in-network");
  assert.match(
    [o.recommended_next_action, o.missing_info.join(" ")].join("\n"),
    /prior authorization|authorization (?:is )?required|pre-?auth/i,
    `prior-authorization requirement (tool state) not surfaced: ${o.recommended_next_action}`,
  );
});

// G — expired coverage must not be described as out-of-network (Spanish) ------
test("G: a Spanish family with expired coverage is not told they are out-of-network", async () => {
  const [o] = await run([
    item({
      id: "es_expired",
      channel: "voicemail_transcript",
      sender: "Elena Ruiz voicemail",
      body:
        "Hola, soy Elena Ruiz. Mi hijo Diego necesita una evaluación de habla. " +
        "DOB 2018-05-05. Tenemos Sunrise Health, miembro SUN-1. " +
        "Mi telefono es 555-0033. Gracias.",
    }),
  ]);

  assert.match(toolResult(o, "verify_insurance"), /expired/, "precondition: Sunrise verifies as expired");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /fuera de la red/i,
    `expired coverage described as out-of-network: ${o.draft_reply}`,
  );
});

// H — caller-identity conflict in scheduling, not only new_referral ----------
test("H: a non-guardian rescheduling an existing patient is surfaced in a visible field", async () => {
  const [o] = await run([
    item({
      id: "schedule_identity",
      channel: "email",
      sender: "Bob Smith <bob.smith@example.com>",
      subject: "reschedule",
      body:
        "This is Bob Smith. Noah Patel threw up and can't make today's 3pm OT appointment. " +
        "Please reschedule. DOB 2017-11-02. Call me at 555-0199.",
    }),
  ]);

  assert.equal(o.classification, "scheduling");
  assert.match(
    [o.draft_reply ?? "", o.recommended_next_action, o.missing_info.join(" ")].join("\n"),
    /identit|guardian|verify (?:the )?(?:caller|parent|relationship|who)|confirm (?:the )?(?:caller|parent|guardian|relationship|identit)/i,
    "non-guardian caller in a scheduling request must be flagged for staff",
  );
});

// I — greeting must not address the caller by a phone number or email --------
test("I: the draft greeting falls back to a neutral salutation when no name is known", async () => {
  const [o] = await run([
    item({
      id: "no_name",
      channel: "voicemail_transcript",
      sender: "voicemail inbox",
      body: "Hello, I'd like a speech therapy evaluation for my kid. Please call 555-0000.",
    }),
  ]);

  assert.ok(o.draft_reply, "should draft a reply");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /\bHi (?:\+?\d[\d\s-]{3,}|[\w.+-]+@)/i,
    `greeting addresses the caller by a phone/email rather than a name: ${o.draft_reply}`,
  );
});

// J — clinical-question reply must not assert a discipline it cannot back -----
test("J: a motor-development question is not answered as if it were a speech concern", async () => {
  const [o] = await run([
    item({
      id: "motor_question",
      channel: "portal_message",
      sender: "Parent via parent portal",
      subject: "is this normal?",
      body: "Is it normal that my 3-year-old still isn't walking? Should I be worried?",
    }),
  ]);

  assert.equal(o.classification, "clinical_question");
  assert.doesNotMatch(
    o.draft_reply ?? "",
    /speech-language pathologist|speech therap/i,
    `asserts a speech-language pathologist for a motor concern: ${o.draft_reply}`,
  );
});
