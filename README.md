# Referral Inbox Triage Agent

An AI agent prototype that turns a messy Monday inbox (pediatrician fax referrals,
parent voicemails, portal messages, emails) into a sorted, **human-reviewable**
action plan: one auditable triage decision per item, with classification, urgency,
extracted intake, tool-backed actions, and a drafted reply.

## 1. How to run

```bash
npm install
npm run triage   -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run validate -- --input data/inbox.json --output output.json --trace .trace/tool-calls.jsonl
npm run typecheck
npm test          # extraction, routing, safeguarding red-team, behavior & draft-compliance, boundary
```

Both commands also work with **no flags** and default to the paths above.

The agent runs fully **without an API key** (deterministic path). To enable the
optional LLM-assisted extraction, set the key before running — nothing else
changes:

```bash
ANTHROPIC_API_KEY=sk-... npm run triage
```

End-to-end runtime is seconds without a key, and roughly a minute with the LLM
path (one small extraction call per item).

## 2. Stack and runtime

- **Language/runtime:** TypeScript on Node LTS, run via `tsx`, npm. No build step.
- **Validation:** the provided `ajv` JSON-schema validator + trace checks (unchanged).
- **Tests:** Node's built-in `node:test` via `tsx` — no extra dependencies.
- **Runtime LLM (optional):** Anthropic via `@anthropic-ai/sdk`, a Claude Haiku 4.5
  snapshot (`claude-haiku-4-5-20251001` by default; override with `CLAUDE_MODEL`),
  used **only for intake-field extraction**, with temperature 0 and prompt caching. If `ANTHROPIC_API_KEY` is
  unset, or any call errors/times out/returns malformed JSON, the agent silently
  falls back to deterministic extraction. The LLM never makes the triage decision.
- **Assumptions:** the provided tools in `src/tools.ts` are the only side-effecting
  actions and are used unmodified; they produce the audit trace the validator reads.
  Synthetic data only.

## 3. Architecture

Per-item pipeline (`src/agent.ts`):

```
extract (regex)  →  enhance (LLM, optional, gap-fill + safety OR)  →  classify  →  handler (orchestrates tools)  →  assemble ItemOutput
                                                                         │
                                              tools_called = getToolCallsForItem(item.id)   ← passed through unchanged
```

- **`src/extract.ts`** — deterministic field extraction (child, DOB/age, contact,
  discipline, payer, member ID, concern) plus boolean triage *signals*
  (safeguarding, Spanish, reschedule, same-day, clinical-question, spam).
- **`src/llm.ts`** — optional Anthropic extraction. Merge rule: a non-null
  deterministic field always wins; the LLM only fills gaps. The **safeguarding
  signal is `deterministic_keyword OR llm_flag`** — defense in depth so an LLM
  miss can never downgrade a P0.
- **`src/triage.ts`** — classification + urgency rules and one handler per class.
  Handlers run inside `withItemContext(item.id, …)` and orchestrate the tools.
- **`src/agent.ts`** — the loop; attaches the audit trace via `getToolCallsForItem`.

**Safety-first routing.** Classification checks safeguarding *before* anything
else, so a disclosure buried inside a routine scheduling ask (item 2: "dad started
getting rough with him") is caught and escalated rather than scheduled.

**Action model — how tools drive decisions, not just satisfy a threshold:**

| Class | Urgency | Tools used as part of the decision |
|---|---|---|
| safeguarding | **P0** | `lookup_policy(safeguarding)` → `escalate(P0)` → `create_task(clinical_lead, same-hour)` → neutral `draft_message` |
| scheduling (same-day reschedule) | **P1** | `search_patient` → `lookup_policy(scheduling)` → `create_task(front_desk)` → `draft_message` |
| new_referral, out-of-network | P2 | `verify_insurance` (→ out_of_network) → `lookup_policy(insurance)` → `create_task(billing)` → holding `draft_message` |
| new_referral, in-network | P2 | `search_patient` → `verify_insurance` → `find_slots` → `hold_slot` (only for an established patient; reviewable, not scheduled) → `create_task(intake)` → `draft_message` |
| new_referral, Spanish | P2 | `verify_insurance` → `lookup_policy(language_access)` → `find_slots(es)` → `create_task` → `draft_message` **in Spanish** |
| clinical_question | P2 | `lookup_policy(clinical_advice)` → `create_task(clinical_lead)` → `draft_message` that declines advice and offers a screening |
| missing_paperwork | P2 | `lookup_policy(service_lines)` → `create_task(intake)` to chase the referrer |

All 8 tools are exercised across the batch. **Every item sets
`requires_human_review = true`** — nothing is auto-sent or auto-scheduled.

**Boundary hardening.** Raw items are normalized in `runAgent` (missing/mistyped
fields coerced, unknown channels defaulted), and each item's handler is wrapped so
an unexpected failure degrades to a human-review output rather than dropping the
item or failing the batch — the "output for every item" floor holds for malformed
*field* values. (A truly id-less input item is a separate matter: the validator
itself keys coverage off the input `id`, so it can't be satisfied without one; the
agent assigns a positional fallback id so it still emits a row, but that case is
inherently outside what `validate` can check.)

**Draft replies** are clear, empathetic, concise, and operationally useful; they
**never give clinical advice** (the clinical-question reply explicitly declines and
routes to a clinician) and **never imply a message was sent or an appointment was
booked** (future-tense, often ending "Nothing has been booked/rescheduled yet").
Insurance and out-of-network conflicts surface the billing-system status per policy.

## 4. Failure modes and production eval

**Failure modes**

- **Regex brittleness on variants.** The deterministic extractor keys off
  templated phrasing; off-template free text degrades to null fields. *Mitigation:*
  the LLM gap-fills, and missing fields are reported in `missing_info` rather than
  guessed.
- **LLM hallucination.** *Mitigation:* deterministic values win for present fields;
  the LLM only fills gaps; temperature 0; safeguarding is OR-gated so the LLM can
  only ever *raise* caution, never lower it.
- **Safeguarding recall is the highest-stakes risk, and the deterministic net is
  best-effort.** A missed disclosure is far worse than a false alarm. The keyword
  net covers explicit English **and Spanish** harm/neglect/fear language with
  precision guards (so "scared of the dentist", "feeding therapy", or an "unsafe
  waiting room" don't escalate), and is pinned by a red-team test set
  (`tests/safeguarding.test.ts`). **But regex recall is inherently bounded** —
  subtler or novel phrasings ("he won't say why he flinches") depend on the LLM
  flag, which is OR'd in. On the **no-key default path, recall is limited to what
  the keyword set anticipates**; production needs the labeled red-team set wired
  into CI with a recall target near 100% and the LLM (or a fine-tuned classifier)
  as the primary detector, keywords as the floor.
- **Over-escalation** is itself a failure mode; the agent defaults to P2 and only
  emits P0 for safeguarding and P1 for genuine same-day operational issues.
- **Payer matching** relies on substring rules in the mock billing tool; a real
  system needs an eligibility integration and fuzzy plan-name resolution.

**Production eval**

- **Golden set + hidden variants:** per-field extraction accuracy, classification
  and urgency confusion matrices, exact safeguarding **recall/precision**.
- **Safety gate:** block release on any safeguarding false negative; alert on P0/P1
  rate drift (over-escalation guard).
- **Draft quality:** LLM-as-judge + human spot-checks for empathy/clarity and a
  hard classifier that fails any draft containing clinical advice or "sent/booked"
  language.
- **Audit:** every action flows through the traced tools; reconcile `tools_called`
  against the trace (the validator already does a version of this) and keep
  decisions human-reviewable.

## 5. What I chose not to build, and why

- **LLM-generated draft replies.** Kept drafts **templated/deterministic** for
  reproducible output and a guaranteed no-clinical-advice / no-"sent" property
  under the time box. LLM drafting is a clear next step but needs a guardrail
  classifier first (see §6).
- **Provider ranking / scheduling optimization.** Out of scope — the agent
  *recommends* and *holds* for review; it must not schedule.
- **Retries, backoff, structured-output tool use, confidence scoring.** Skipped for
  time; the LLM path fails safe to deterministic instead.
- **PHI handling / redaction.** Synthetic data only, per the brief.

There **is** a focused test suite (`npm test`, 57 tests): extraction value checks,
a safeguarding **red-team set** (English + Spanish adversarial phrasings the net
must catch, with precision guards so dentist/baseball/feeding/violent-video-games/
"unsafe waiting room" do *not* escalate, and curly-apostrophe transcripts still
match), **behavior tests** that drive the full agent and assert emitted
urgency + escalation, the insurance fork (out-of-network → billing, no slots;
in-network → slots), a **draft-compliance test** (no draft implies a message was
sent or an appointment booked; the clinical-question reply declines advice), and
malformed-input boundary tests. It is intentionally a slice, not full coverage —
the deeper eval harness is §6.

## 6. What I would do with another 4 hours

1. **Eval harness** with a labeled set (incl. adversarial safeguarding phrasings)
   reporting extraction accuracy, urgency confusion, and safeguarding recall.
2. **LLM-drafted replies** behind a guardrail classifier (rejects clinical advice /
   "sent" language) with the templated draft as fallback.
3. **Structured-output tool use** for extraction instead of JSON-string parsing,
   plus per-field **confidence + abstain** so low-confidence fields route to a human.
4. **Better identity resolution** (dedup against the patient index beyond the two
   stubbed matches) and a real insurance-eligibility integration.
5. **Broader language access** beyond Spanish, with locale-aware draft templates.
