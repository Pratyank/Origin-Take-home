import type { Extraction } from "./extract.js";
import type { Discipline, InboxItem } from "./types.js";

/**
 * Optional LLM-assisted extraction. Anthropic fills intake fields that the
 * deterministic regex pass missed (the regex is precise on templated faxes but
 * brittle on free-text variants). The model NEVER makes the triage decision:
 *   - intake fields: deterministic value wins when present, LLM fills the gaps
 *   - safeguarding: deterministic keyword check is OR'd with the LLM flag, so an
 *     LLM miss can never downgrade a P0 (defense in depth)
 * Any missing key, API error, timeout, or malformed response falls back to the
 * deterministic extraction unchanged — the validator-passing baseline is safe.
 */

const MODEL = process.env.CLAUDE_MODEL || "claude-haiku-4-5-20251001";
const TIMEOUT_MS = 20_000;

const SYSTEM = `You extract structured intake data from a pediatric therapy practice's inbox messages (faxes, voicemails, portal messages, emails). Return ONLY a JSON object, no prose. Use null for anything not stated. Do not infer or invent.

Fields:
- child_name: string|null (the child, not the parent)
- dob_or_age: string|null (ISO date "YYYY-MM-DD" if a DOB is given, else "age N")
- parent_contact: string|null ("Name, phone, email" with whatever is present)
- discipline: array of "SLP"|"OT"|"PT" or null (SLP=speech/language, OT=sensory/feeding/fine-motor, PT=gait/walking/gross-motor)
- diagnosis_or_concern: string|null
- payer: string|null (insurance plan name)
- member_id: string|null
- safeguarding: boolean (true if the message suggests harm, abuse, neglect, or unsafe caregiving of the child)
- spanish: boolean (family writes in or requests Spanish)
- reschedule: boolean (request to cancel/reschedule an existing appointment)
- same_day: boolean (concerns something happening today)
- clinical_question: boolean (asks for developmental/clinical advice rather than making a referral)`;

interface LlmFields {
  child_name?: string | null;
  dob_or_age?: string | null;
  parent_contact?: string | null;
  discipline?: Discipline[] | null;
  diagnosis_or_concern?: string | null;
  payer?: string | null;
  member_id?: string | null;
  safeguarding?: boolean;
  spanish?: boolean;
  reschedule?: boolean;
  same_day?: boolean;
  clinical_question?: boolean;
}

let client: unknown = null;
async function getClient(): Promise<{ messages: { create: Function } } | null> {
  if (!process.env.ANTHROPIC_API_KEY) return null;
  if (client) return client as { messages: { create: Function } };
  try {
    const mod = await import("@anthropic-ai/sdk");
    const Anthropic = mod.default;
    client = new Anthropic({ timeout: TIMEOUT_MS });
    return client as { messages: { create: Function } };
  } catch {
    return null;
  }
}

export async function enhanceExtraction(
  item: InboxItem,
  base: Extraction,
): Promise<Extraction> {
  const anthropic = await getClient();
  if (!anthropic) return base;

  try {
    const response = await anthropic.messages.create({
      model: MODEL,
      max_tokens: 512,
      temperature: 0,
      system: [{ type: "text", text: SYSTEM, cache_control: { type: "ephemeral" } }],
      messages: [
        {
          role: "user",
          content: `Channel: ${item.channel}\nSubject: ${item.subject}\nBody: ${item.body}`,
        },
      ],
    });

    const text = (response.content || [])
      .filter((b: { type: string }) => b.type === "text")
      .map((b: { text: string }) => b.text)
      .join("");
    const json = text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    const llm = JSON.parse(json) as LlmFields;

    return merge(base, llm);
  } catch {
    return base; // any failure → deterministic result
  }
}

function merge(base: Extraction, llm: LlmFields): Extraction {
  const pick = <T>(deterministic: T | null, fromLlm: T | null | undefined): T | null =>
    deterministic != null ? deterministic : fromLlm ?? null;

  const discipline =
    base.intake.discipline ??
    (Array.isArray(llm.discipline) && llm.discipline.length ? llm.discipline : null);

  const intake = {
    child_name: pick(base.intake.child_name, llm.child_name),
    dob_or_age: pick(base.intake.dob_or_age, llm.dob_or_age),
    parent_contact: pick(base.intake.parent_contact, llm.parent_contact),
    discipline,
    diagnosis_or_concern: pick(base.intake.diagnosis_or_concern, llm.diagnosis_or_concern),
    payer: pick(base.intake.payer, llm.payer),
    member_id: pick(base.intake.member_id, llm.member_id),
  };

  const missing: string[] = [];
  if (!intake.child_name) missing.push("child name");
  if (!intake.dob_or_age) missing.push("date of birth or age");
  if (!intake.parent_contact) missing.push("parent/guardian contact");
  if (!intake.discipline) missing.push("requested discipline");
  if (!intake.payer) missing.push("insurance payer");
  if (!intake.member_id) missing.push("insurance member ID");

  return {
    intake,
    missing,
    signals: {
      // Safety net: never let the LLM downgrade a keyword-detected disclosure.
      safeguarding: base.signals.safeguarding || llm.safeguarding === true,
      spanish: base.signals.spanish || llm.spanish === true,
      reschedule: base.signals.reschedule || llm.reschedule === true,
      sameDay: base.signals.sameDay || llm.same_day === true,
      clinicalQuestion: base.signals.clinicalQuestion || llm.clinical_question === true,
      spam: base.signals.spam,
    },
  };
}
