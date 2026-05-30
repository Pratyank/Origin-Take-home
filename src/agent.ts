import { extractItem } from "./extract.js";
import { enhanceExtraction } from "./llm.js";
import { classify } from "./triage.js";
import { getToolCallsForItem, withItemContext } from "./tools.js";
import type { InboxItem, ItemOutput } from "./types.js";

/**
 * Triage agent. For each inbox item: extract intake fields, detect triage
 * signals, route to a handler that orchestrates the provided tools, then attach
 * the audit trace via getToolCallsForItem(). Items are processed sequentially so
 * each item's tool calls stay isolated under its own withItemContext scope.
 */
export async function runAgent(inbox: InboxItem[]): Promise<ItemOutput[]> {
  const outputs: ItemOutput[] = [];

  for (const item of inbox) {
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
  }

  return outputs;
}
