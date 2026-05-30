import { extractItem } from "./extract.js";
import { enhanceExtraction } from "./llm.js";
import { classify } from "./triage.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import type { Channel, InboxItem, ItemOutput } from "./types.js";

const CHANNELS: Channel[] = [
  "fax_referral",
  "voicemail_transcript",
  "portal_message",
  "email",
];

/**
 * Coerce a raw inbox entry into a well-formed InboxItem. Hidden synthetic
 * variants may omit or mistype fields; we normalize at the boundary so a single
 * malformed item cannot break extraction. A missing id is given a stable
 * positional fallback so the item still gets exactly one output.
 */
function sanitizeItem(raw: unknown, index: number): InboxItem {
  const r = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v));
  const id = typeof r.id === "string" && r.id.trim() ? r.id : `item_unindexed_${index}`;
  const channel = CHANNELS.includes(r.channel as Channel) ? (r.channel as Channel) : "email";
  return {
    id,
    channel,
    received_at: str(r.received_at) || new Date(0).toISOString(),
    sender: str(r.sender),
    subject: str(r.subject),
    body: str(r.body),
    attachments: Array.isArray(r.attachments) ? r.attachments.map(str) : [],
  };
}

/** A minimal, valid output for an item whose handler threw unexpectedly. */
function fallbackOutput(item: InboxItem, reason: string): ItemOutput {
  return {
    item_id: item.id,
    classification: "other",
    urgency: "P2",
    requires_human_review: true,
    extracted_intake: {
      child_name: null,
      dob_or_age: null,
      parent_contact: null,
      discipline: null,
      diagnosis_or_concern: null,
      payer: null,
      member_id: null,
    },
    missing_info: ["could not auto-extract; needs manual review"],
    tools_called: getToolCallsForItem(item.id),
    recommended_next_action: "Front desk to read and triage this item manually.",
    draft_reply: null,
    task_ids: [],
    escalation: null,
    decision_rationale: `Automated triage failed for this item (${reason}); routed to a human rather than dropped.`,
  };
}

/**
 * Triage agent. For each inbox item: normalize it, extract intake fields, detect
 * triage signals, route to a handler that orchestrates the provided tools, then
 * attach the audit trace via getToolCallsForItem(). Items are processed
 * sequentially so each item's tool calls stay isolated under its own
 * withItemContext scope. A failure on one item degrades to a human-review
 * output instead of failing the whole batch.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  if (!Array.isArray(inbox)) {
    throw new Error("runAgent: expected an array of inbox items");
  }

  const outputs: ItemOutput[] = [];

  for (let index = 0; index < inbox.length; index += 1) {
    const item = sanitizeItem(inbox[index], index);
    try {
      // Deterministic extraction first; LLM fills gaps and is OR'd into the
      // safeguarding signal. Falls back to deterministic if no key / on error.
      const extraction = await enhanceExtraction(item, extractItem(item));
      const { handler } = classify(item, extraction);
      const decision = await withItemContext(item.id, () => handler(item, extraction));

      outputs.push({
        item_id: item.id,
        extracted_intake: extraction.intake,
        tools_called: getToolCallsForItem(item.id),
        ...decision,
      });
    } catch (error) {
      outputs.push(
        fallbackOutput(item, error instanceof Error ? error.message : String(error)),
      );
    }
  }

  return outputs;
}
