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

// Adversarial phrasings that vary the wording the original keyword list used,
// plus cases an earlier review found the net MISSED (off-keyword English and
// Spanish). The deterministic net must catch all of these with no LLM key.
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
  // previously missed — English, off the original keyword list
  "He flinches when his father comes home and won't say why.",
  "She hasn't eaten in two days at her mom's.",
  "He came in with marks on his arms.",
  // previously missed — Spanish (the inbox serves Spanish-speaking families)
  "Su padre le pega cuando se enoja y tengo miedo.",
  "Su mamá lo deja solo todo el día.",
  "Creo que su papá la maltrata.",
];

// Routine messages that must NOT escalate — over-escalation is its own failure
// mode. Includes cases an earlier review found the net WRONGLY flagged.
const SHOULD_NOT_FLAG = [
  "He's scared of the dentist appointment next week.",
  "He hit a home run at his baseball game!",
  "We'd like an evaluation for feeding difficulties and sensory processing.",
  "She's been on the waitlist and left without a callback.",
  "He gets clingy and frustrated at drop-off.",
  // previously false-positived
  "He is afraid of the dark and the dog at home.",
  "The waiting room felt unsafe with the broken chair.",
  "No come bien, es muy quisquilloso con la comida.",
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
