import assert from "node:assert/strict";
import { test } from "node:test";
import { extractItem } from "../src/extract.js";
import type { InboxItem } from "../src/types.js";

function voicemail(body: string): InboxItem {
  return {
    id: "rt",
    channel: "voicemail_transcript",
    received_at: "2026-04-28T08:00:00-07:00",
    sender: "red-team",
    subject: "test",
    body,
    attachments: [],
  };
}

const isSafeguarding = (body: string): boolean =>
  extractItem(voicemail(body)).signals.safeguarding;

// Adversarial phrasings that vary the wording the original keyword list used.
// The deterministic net must catch these even with no LLM key present.
const SHOULD_FLAG = [
  "His dad started getting rough with him on the weekends.",
  "My husband hits him when he gets frustrated.",
  "I'm scared of what happens at his father's house.",
  "She keeps coming home with bruises.",
  "The kids are home alone all day while I work.",
  "I think she's being neglected at her mom's.",
  "He's afraid to go home after the visits.",
  "There's domestic violence going on at home.",
  "My partner gets violent when he drinks.",
  "He's not being fed at his dad's place.",
];

// Routine messages that must NOT escalate — over-escalation is its own failure
// mode, and feeding/sensory wording is normal OT-referral language.
const SHOULD_NOT_FLAG = [
  "He's scared of the dentist appointment next week.",
  "He hit a home run at his baseball game!",
  "We'd like an evaluation for feeding difficulties and sensory processing.",
  "She's been on the waitlist and left without a callback.",
  "He gets clingy and frustrated at drop-off.",
];

for (const body of SHOULD_FLAG) {
  test(`flags safeguarding: "${body.slice(0, 40)}..."`, () => {
    assert.equal(isSafeguarding(body), true);
  });
}

for (const body of SHOULD_NOT_FLAG) {
  test(`does not over-escalate: "${body.slice(0, 40)}..."`, () => {
    assert.equal(isSafeguarding(body), false);
  });
}
