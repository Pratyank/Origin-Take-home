import {
  create_task,
  draft_message,
  escalate,
  find_slots,
  hold_slot,
  lookup_policy,
  search_patient,
  verify_insurance,
} from "./tools.js";
import type { Extraction } from "./extract.js";
import type {
  Classification,
  Discipline,
  InboxItem,
  ItemOutput,
  Urgency,
} from "./types.js";

/** The decision fields for an item; tools_called is attached by the agent loop. */
export type Decision = Omit<ItemOutput, "item_id" | "tools_called" | "extracted_intake">;

function dueDate(item: InboxItem, offsetDays: number): string {
  const base = item.received_at.slice(0, 10); // YYYY-MM-DD
  const date = new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + offsetDays);
  return date.toISOString().slice(0, 10);
}

interface Channelled {
  recipient: string;
  channel: "portal" | "email" | "phone";
}

function replyTarget(item: InboxItem, ex: Extraction): Channelled {
  const email = ex.intake.parent_contact?.match(/[\w.+-]+@[\w-]+\.[\w.-]+/)?.[0];
  const phone = ex.intake.parent_contact?.match(/\d{3}-\d{3}-\d{4}|\d{3}-\d{4}/)?.[0];
  if (item.channel === "email" && email) return { recipient: email, channel: "email" };
  if (item.channel === "portal_message")
    return { recipient: ex.intake.parent_contact || item.sender, channel: "portal" };
  if (phone) return { recipient: phone, channel: "phone" };
  if (email) return { recipient: email, channel: "email" };
  return { recipient: item.sender, channel: "phone" };
}

function firstName(full: string | null): string {
  return full?.trim().split(/\s+/)[0] || "there";
}

/** A salutation first name for the caller, or "there" when we only have a phone
 * or email and no actual name — never address someone by a contact handle. */
function greetingName(contact: string | null): string {
  return firstName(parentName(contact));
}

/** The name segment of a parent_contact string ("Carla Mendez, 555-…, a@b") if
 * the leading segment is a name rather than a phone/email; null otherwise. */
function parentName(contact: string | null): string | null {
  if (!contact) return null;
  const first = contact.split(",")[0].trim();
  if (!first || /@/.test(first) || /\d{3}-?\d{3,4}/.test(first)) return null;
  return first;
}

/** True when two person names share no name token — i.e. they look like
 * different people. Conservative: any shared token (e.g. a surname, or a first
 * name when only one is given) counts as a match, not a conflict. */
function namesConflict(a: string | null, b: string | null): boolean {
  const tokens = (s: string): Set<string> =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-zñáéíóú\s]/gi, " ")
        .split(/\s+/)
        .filter((t) => t.length > 1 && !["jr", "sr", "ii", "iii", "iv"].includes(t)),
    );
  if (!a || !b) return false;
  const ta = tokens(a);
  const tb = tokens(b);
  if (ta.size === 0 || tb.size === 0) return false;
  for (const t of ta) if (tb.has(t)) return false;
  return true;
}

/** Safeguarding disclosure → P0, escalate to clinical lead, neutral acknowledgement only. */
async function handleSafeguarding(item: InboxItem, ex: Extraction): Promise<Decision> {
  const child = ex.intake.child_name || "the child";
  await lookup_policy({ topic: "safeguarding" });
  await escalate({
    item_id: item.id,
    reason: `Possible unsafe caregiving disclosed in message regarding ${child}; mandated same-hour clinical review.`,
    severity: "P0",
  });
  const task = await create_task({
    assignee: "clinical_lead",
    title: `Same-hour safeguarding review: ${child}`,
    due: dueDate(item, 0),
    notes:
      "Voicemail contains a possible safeguarding disclosure. Clinical lead to review within the hour per safeguarding policy. Do not provide investigative advice in outbound messages.",
  });

  const target = replyTarget(item, ex);
  const body = `Hi ${greetingName(ex.intake.parent_contact)}, thank you for reaching out about ${child}. A member of our clinical team will contact you today to follow up and talk through next steps for an evaluation. We want to make sure ${child} gets the right support.`;
  await draft_message({
    recipient: target.recipient,
    channel: target.channel,
    language: ex.signals.spanish ? "es" : "en",
    body,
  });

  return {
    classification: "safeguarding",
    urgency: "P0",
    requires_human_review: true,
    missing_info: ex.missing.filter((m) => m === "child name" || m === "date of birth or age"),
    recommended_next_action:
      "Clinical lead must review within the hour and decide on safeguarding follow-up before any other action.",
    draft_reply: body,
    task_ids: [task.data.task_id],
    escalation: {
      reason: `Possible unsafe caregiving disclosed regarding ${child}; same-hour clinical review required.`,
      severity: "P0",
    },
    decision_rationale:
      "Message embeds a possible safeguarding disclosure inside a routine scheduling request. Safeguarding policy makes this P0: escalate to clinical lead, open a same-hour review task, and draft only a neutral acknowledgement (no investigative or clinical advice).",
  };
}

/** Same-day reschedule/cancellation → P1 operational; do not reschedule, route to front desk. */
async function handleScheduling(item: InboxItem, ex: Extraction): Promise<Decision> {
  const child = ex.intake.child_name || "the patient";
  // Confirm the appointment belongs to a known patient before routing the
  // reschedule; the match result is threaded into the task so the front desk
  // knows whether identity still needs verifying.
  let patientNote = "";
  let guardianOnRecord: string | null = null;
  if (ex.intake.dob_or_age?.match(/\d{4}-\d{2}-\d{2}/)) {
    const found = await search_patient({ name: child, dob: ex.intake.dob_or_age });
    if (found.data.length > 0) {
      guardianOnRecord = found.data[0].guardian_name;
      patientNote = ` Matched existing patient ${found.data[0].patient_id} (${found.data[0].status}).`;
    } else {
      patientNote = " No existing patient match — front desk to confirm identity.";
    }
  }
  // A caller asking to change an existing patient's appointment should reconcile
  // with the guardian on record before the front desk acts on the request.
  const claimedParent = parentName(ex.intake.parent_contact);
  const identityConflict = !!guardianOnRecord && namesConflict(claimedParent, guardianOnRecord);
  const identityFlag = identityConflict
    ? `caller identity unverified: caller presents as "${claimedParent}" but the guardian on record is "${guardianOnRecord}"`
    : null;
  await lookup_policy({ topic: "scheduling" });
  const sameDay = ex.signals.sameDay;
  const task = await create_task({
    assignee: "front_desk",
    title: `${sameDay ? "Same-day " : ""}reschedule request: ${child}`,
    due: dueDate(item, 0),
    notes: `Parent requests to ${/cancel/i.test(item.body) ? "cancel" : "reschedule"} an appointment for ${child}.${patientNote} Front desk to contact the family and arrange a new time. Agent did not reschedule.`,
  });

  const target = replyTarget(item, ex);
  const childFirst = ex.intake.child_name ? firstName(ex.intake.child_name) : "your child";
  // Only wish a speedy recovery if the message actually mentions illness; and
  // describe what the agent did (passed the request on) rather than asserting a
  // cancellation the family did not request and the agent did not perform.
  const ill =
    /\b(threw up|throw(?:ing)? up|vomit|fever|sick|ill|unwell|not feeling well|under the weather|temperature|flu|cold|cough)\b/i.test(
      item.body,
    );
  const illLine = ill ? ` We hope ${childFirst} feels better soon.` : "";
  const body = `Hi ${greetingName(ex.intake.parent_contact)}, thanks for letting us know ${childFirst} can't make the appointment. We've passed this to our front-desk team, who will follow up to arrange a new time. Nothing has been changed or rescheduled yet.${illLine}`;
  await draft_message({
    recipient: target.recipient,
    channel: target.channel,
    language: ex.signals.spanish ? "es" : "en",
    body,
  });

  return {
    classification: "scheduling",
    urgency: sameDay ? "P1" : "P2",
    requires_human_review: true,
    missing_info: identityFlag
      ? [...ex.missing.filter((m) => m === "child name"), identityFlag]
      : ex.missing.filter((m) => m === "child name"),
    recommended_next_action: identityConflict
      ? `Verify the caller's identity and relationship to ${child} (claimed "${claimedParent}" vs guardian of record "${guardianOnRecord}") before discussing or changing this appointment; then front desk to contact the family and arrange a new time. Do not auto-reschedule.`
      : "Front desk to contact the family and arrange a new appointment time. Do not auto-reschedule.",
    draft_reply: body,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale: `${
      sameDay
        ? "A same-day reschedule is a P1 operational issue per scheduling policy. Agent records the request and routes to front desk; it does not schedule appointments."
        : "Reschedule request without a same-day deadline; treated as normal scheduling (P2) and routed to front desk."
    }${identityConflict ? ` Caller identity is unverified (claimed "${claimedParent}" vs guardian of record "${guardianOnRecord}"), flagged for the front desk before any change.` : ""}`,
  };
}

/** Developmental / clinical-advice question → no clinical advice over message; route to clinician. */
async function handleClinicalQuestion(item: InboxItem, ex: Extraction): Promise<Decision> {
  const child = ex.intake.child_name || "your child";
  await lookup_policy({ topic: "clinical_advice" });
  const task = await create_task({
    assignee: "clinical_lead",
    title: `Clinician review: developmental question re ${child}`,
    due: dueDate(item, 2),
    notes: `Parent asked a developmental question about ${child}. Route to a clinician for a screening or evaluation recommendation. Do not answer the clinical question by message.`,
  });

  const target = replyTarget(item, ex);
  // Name the clinician type only when the concern points to one; otherwise stay
  // neutral rather than asserting a speech-language pathologist by default.
  const discipline = ex.intake.discipline?.[0];
  const clinician =
    discipline === "OT"
      ? "an occupational therapist"
      : discipline === "PT"
        ? "a physical therapist"
        : discipline === "SLP"
          ? "a speech-language pathologist"
          : "one of our clinicians";
  const body = `Hi ${greetingName(ex.intake.parent_contact)}, thank you for reaching out about ${child}. We're not able to give clinical guidance by message, but ${clinician} can look into your question. The best next step is a brief screening or evaluation, and a team member will follow up with options. Nothing has been booked yet.`;
  await draft_message({
    recipient: target.recipient,
    channel: target.channel,
    language: ex.signals.spanish ? "es" : "en",
    body,
  });

  return {
    classification: "clinical_question",
    urgency: "P2",
    requires_human_review: true,
    missing_info: ex.missing.filter((m) => m === "child name" || m === "date of birth or age"),
    recommended_next_action:
      "Route to a clinician for a screening/evaluation recommendation; do not answer the clinical question by message.",
    draft_reply: body,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "This is a clinical-advice question, not a referral. Policy forbids giving clinical advice by message, so the agent routes it to a clinician and drafts an empathetic reply that offers a screening/evaluation without answering the question.",
  };
}

/** Referral with too many blank fields → cannot intake; request missing info. */
async function handleMissingPaperwork(item: InboxItem, ex: Extraction): Promise<Decision> {
  const child = ex.intake.child_name || "the referred child";
  await lookup_policy({ topic: "service_lines" });
  const task = await create_task({
    assignee: "intake",
    title: `Incomplete referral: obtain missing info for ${child}`,
    due: dueDate(item, 1),
    notes: `Referral from ${item.sender} is missing: ${ex.missing.join(", ")}. Intake to contact the referring provider to complete the referral before scheduling.`,
  });

  return {
    classification: "missing_paperwork",
    urgency: "P2",
    requires_human_review: true,
    missing_info: ex.missing,
    recommended_next_action: `Intake to contact ${item.sender} to obtain: ${ex.missing.join(", ")} before the referral can proceed.`,
    draft_reply: null,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "Referral is missing the fields needed to open intake (DOB, guardian, insurance). No family contact is available to draft to, so the agent opens an intake task to chase the referring provider rather than guessing missing data.",
  };
}

const DISCIPLINE_LABEL: Record<Discipline, string> = {
  SLP: "speech therapy",
  OT: "occupational therapy",
  PT: "physical therapy",
};

/** New referral → verify insurance, check for existing patient, route per coverage. */
async function handleNewReferral(item: InboxItem, ex: Extraction): Promise<Decision> {
  const child = ex.intake.child_name || "the child";
  const discipline = ex.intake.discipline?.[0];
  const language = ex.signals.spanish ? "es" : "en";

  let existing = false;
  let guardianOnRecord: string | null = null;
  if (ex.intake.dob_or_age?.match(/\d{4}-\d{2}-\d{2}/)) {
    const found = await search_patient({ name: child, dob: ex.intake.dob_or_age });
    existing = found.data.length > 0;
    guardianOnRecord = found.data[0]?.guardian_name ?? null;
  }

  // Caller-identity check: if we matched an existing record, does the caller's
  // claimed name reconcile with the guardian on file? A mismatch must be
  // surfaced for staff and must hold back coverage details from the reply.
  const claimedParent = parentName(ex.intake.parent_contact);
  const identityConflict = existing && namesConflict(claimedParent, guardianOnRecord);

  let insuranceStatus: string = "unknown";
  let authRequired = false;
  if (ex.intake.payer) {
    const ins = await verify_insurance({
      payer: ex.intake.payer,
      member_id: ex.intake.member_id || undefined,
    });
    insuranceStatus = ins.data.status;
    authRequired = ins.data.auth_required === true;
  }

  if (ex.signals.spanish) await lookup_policy({ topic: "language_access" });

  const target = replyTarget(item, ex);
  const blockedByInsurance = insuranceStatus === "out_of_network" || insuranceStatus === "expired";

  if (blockedByInsurance) {
    await lookup_policy({ topic: "insurance" });
    const task = await create_task({
      assignee: "billing",
      title: `Review ${insuranceStatus.replace(/_/g, "-")} coverage for ${child}`,
      due: dueDate(item, 2),
      notes: `${ex.intake.payer} returned ${insuranceStatus} for ${child}. Billing to call the family for a benefits conversation before any slot is held or scheduled.`,
    });
    // Describe the actual verification result; expired coverage is not the same
    // as out-of-network, and the Spanish copy must not collapse the two.
    const enStatus =
      insuranceStatus === "expired" ? "expired" : "out of network for Cedar Kids Therapy";
    const esStatus =
      insuranceStatus === "expired" ? "vencido" : "fuera de la red para Cedar Kids Therapy";
    const body = spanishOrEnglish(
      language,
      `Hi ${greetingName(ex.intake.parent_contact)}, thank you for ${child}'s referral. Our billing team needs to review the ${ex.intake.payer} plan, which appears to be ${enStatus}, before we move forward. A team member will follow up with options. Nothing has been scheduled yet.`,
      `Hola ${greetingName(ex.intake.parent_contact)}, gracias por la referencia de ${child}. Nuestro equipo de facturación necesita revisar el plan ${ex.intake.payer}, que parece estar ${esStatus}, antes de continuar. Un miembro de nuestro equipo le contactará con opciones. Todavía no hemos agendado ninguna cita.`,
    );
    await draft_message({ recipient: target.recipient, channel: target.channel, language, body });
    return {
      classification: "new_referral",
      urgency: "P2",
      requires_human_review: true,
      missing_info: ex.missing,
      recommended_next_action:
        "Billing to hold the referral and call the family for a benefits conversation before any slot is held or scheduled.",
      draft_reply: body,
      task_ids: [task.data.task_id],
      escalation: null,
      decision_rationale: `Clinical intake is sufficient, but insurance verification returned ${insuranceStatus}. Policy requires a benefits conversation before any slot hold, so the agent routes to billing and drafts a holding reply rather than offering times.`,
    };
  }

  // In-network or unknown payer: surface availability for staff review.
  let slotNote = "no matching slots found";
  let heldNote = "";
  // When the family asked for Spanish, find_slots is filtered to es-capable
  // providers, so a returned slot is proof a Spanish-speaking provider exists.
  let spanishProviderFound = false;
  const taskIds: string[] = [];
  if (discipline) {
    const slots = await find_slots({ discipline, language: ex.signals.spanish ? "es" : undefined });
    if (slots.data.length > 0) {
      const first = slots.data[0];
      slotNote = `earliest ${first.start} with ${first.provider_name}`;
      spanishProviderFound = ex.signals.spanish;
      // Hold the earliest slot only for an established patient — reviewable, not scheduled.
      if (existing) {
        const hold = await hold_slot({
          slot_id: first.slot_id,
          patient_ref: child,
        });
        heldNote = ` A slot was tentatively held (${hold.data.hold_id}, pending review).`;
      }
    }
  }

  const task = await create_task({
    assignee: "intake",
    title: `New ${discipline ?? ""} referral intake: ${child}`,
    due: dueDate(item, 2),
    notes: `New referral for ${child} (${DISCIPLINE_LABEL[discipline as Discipline] ?? "discipline TBD"}). Insurance ${insuranceStatus}. Availability: ${slotNote}.${heldNote} Intake to confirm discipline and offer times for staff to schedule.`,
  });
  taskIds.push(task.data.task_id);

  // Only assert verified in-network coverage when verify_insurance actually
  // returned in_network AND the caller's identity is not in question; otherwise
  // promise a confirmation rather than stating one.
  const insuranceVerified = insuranceStatus === "in_network" && !identityConflict;
  const enInsurance = insuranceVerified
    ? `${ex.intake.payer} is verified as in-network. `
    : ex.intake.payer
      ? `We'll confirm your ${ex.intake.payer} coverage as part of intake. `
      : "";
  const esInsurance = insuranceVerified
    ? `Su seguro ${ex.intake.payer} está verificado dentro de la red. `
    : ex.intake.payer
      ? `Confirmaremos su cobertura de ${ex.intake.payer} durante el proceso de admisión. `
      : "";
  // Only promise a Spanish-speaking provider if find_slots actually surfaced one.
  const esProvider = spanishProviderFound ? ", con un proveedor que habla español" : "";

  const body = spanishOrEnglish(
    language,
    `Hi ${greetingName(ex.intake.parent_contact)}, thank you for ${child}'s referral for ${discipline ? DISCIPLINE_LABEL[discipline] : "therapy"}. ${enInsurance}A member of our intake team will follow up to confirm availability for an evaluation. Nothing has been booked yet.`,
    `Hola ${greetingName(ex.intake.parent_contact)}, gracias por la referencia de ${child} para una evaluación de ${discipline === "SLP" ? "habla" : "terapia"}. ${esInsurance}Un miembro de nuestro equipo de admisión la contactará para coordinar una evaluación${esProvider}. Todavía no hemos agendado ninguna cita.`,
  );
  await draft_message({ recipient: target.recipient, channel: target.channel, language, body });

  const identityFlag = identityConflict
    ? `caller identity unverified: caller presents as "${claimedParent}" but the guardian on record is "${guardianOnRecord}"`
    : null;

  // Surface verification gaps the tools returned but the reply does not assert:
  // an unrecognized payer, and any prior-authorization requirement.
  const coverageUnverified = !!ex.intake.payer && insuranceStatus === "unknown";
  const verifyNotes: string[] = [];
  if (coverageUnverified)
    verifyNotes.push(`verify ${ex.intake.payer} coverage (billing did not recognize the payer)`);
  if (authRequired) verifyNotes.push("obtain prior authorization");

  const baseAction = identityConflict
    ? `Verify the caller's identity and relationship to ${child} (claimed "${claimedParent}" vs guardian of record "${guardianOnRecord}") before sharing coverage details or scheduling; then intake to confirm discipline and offer evaluation times.`
    : "Intake to confirm requested discipline and offer evaluation times; staff to schedule (and confirm any tentative hold).";

  const missingExtra: string[] = [];
  if (identityFlag) missingExtra.push(identityFlag);
  if (coverageUnverified)
    missingExtra.push(`insurance not verified (payer "${ex.intake.payer}" unrecognized by billing)`);

  return {
    classification: "new_referral",
    urgency: "P2",
    requires_human_review: true,
    missing_info: missingExtra.length ? [...ex.missing, ...missingExtra] : ex.missing,
    recommended_next_action: verifyNotes.length
      ? `${baseAction} Before scheduling: ${verifyNotes.join("; ")}.`
      : baseAction,
    draft_reply: body,
    task_ids: taskIds,
    escalation: null,
    decision_rationale: `New referral with sufficient intake data and ${insuranceStatus === "unknown" ? "an unverified" : insuranceStatus} payer status.${identityConflict ? ` Caller identity is unverified (claimed "${claimedParent}" vs guardian of record "${guardianOnRecord}"), so coverage was not confirmed in the reply and identity verification was flagged for staff.` : ""}${authRequired ? " Prior authorization is required before scheduling." : ""} Agent verified insurance, ${existing ? "matched an existing patient, " : ""}surfaced availability for staff review, and drafted a welcoming reply without booking or implying a booking.`,
  };
}

function spanishOrEnglish(lang: "en" | "es", en: string, es: string): string {
  return lang === "es" ? es : en;
}

export function classify(item: InboxItem, ex: Extraction): {
  handler: (item: InboxItem, ex: Extraction) => Promise<Decision>;
} {
  if (ex.signals.safeguarding) return { handler: handleSafeguarding };
  if (ex.signals.spam) return { handler: handleSpam };
  if (ex.signals.reschedule) return { handler: handleScheduling };
  if (ex.signals.clinicalQuestion) return { handler: handleClinicalQuestion };
  if (item.channel === "fax_referral" && ex.missing.length >= 3)
    return { handler: handleMissingPaperwork };
  if (ex.intake.discipline || ex.intake.diagnosis_or_concern)
    return { handler: handleNewReferral };
  return { handler: handleOther };
}

async function handleSpam(item: InboxItem, ex: Extraction): Promise<Decision> {
  return {
    classification: "spam",
    urgency: "P3",
    requires_human_review: true,
    missing_info: [],
    recommended_next_action: "No action; flag as spam for a quick human glance and discard.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: "Message matches spam heuristics and contains no actionable clinical or operational request.",
  };
}

async function handleOther(item: InboxItem, ex: Extraction): Promise<Decision> {
  await lookup_policy({ topic: "service_lines" });
  const task = await create_task({
    assignee: "front_desk",
    title: `Triage review: ${item.subject}`,
    due: dueDate(item, 2),
    notes: `Item did not match a known intake pattern. Front desk to read and route. Sender: ${item.sender}.`,
  });
  return {
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    missing_info: ex.missing,
    recommended_next_action: "Front desk to read and route; item did not match a known intake pattern.",
    draft_reply: null,
    task_ids: [task.data.task_id],
    escalation: null,
    decision_rationale:
      "Item did not match referral, scheduling, clinical-question, or safeguarding patterns. Defaulted to P2 with a front-desk review task rather than guessing an action.",
  };
}
