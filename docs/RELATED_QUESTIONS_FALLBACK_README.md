# Related Question Fallback (KB + General Reasoning) - Design README

## Goal

Allow the assistant to answer **related follow-up questions** that are not explicitly present in the tenant knowledgebase (KB), while still refusing **unrelated** questions.

This keeps the bot useful for business-relevant reasoning (for example, distance calculations from known locations) without turning it into a generic chatbot.

## Problem Statement

Current RAG instructions in the codebase enforce:

- answer only from KB context,
- use `ANSWER_NOT_FOUND` when KB does not directly contain an answer.

Because of this, related questions can fail even when a safe, useful answer can be inferred from:

- known KB entity context, and
- common/general world knowledge or simple calculations from the LLM.

Example:

- KB contains: "Resort is in Lonavala", "distance from Mumbai/Pune".
- User asks: "How far is it from Nashik?"
- Desired behavior: answer with a best-effort estimate (and optionally state it is approximate), not "not found".

But for unrelated questions:

- If KB topic is resort/hospitality and user asks "What is mileage of Mahindra Thar?",
- Desired behavior: refuse as out-of-scope.

## Current Behavior in Codebase

### `/ask` pipeline (`apps/api/src/routes/ask.ts`)

- `RAG_RULES_SUFFIX` says: "Answer using ONLY information supported by KNOWLEDGEBASE."
- Not-found markers (`ANSWER_NOT_FOUND`, etc.) are treated as KB miss.
- User-facing fallback becomes: "I couldn't find an answer to that in the knowledgebase."

### Voicebot pipeline (`apps/api/src/routes/exotel-voicebot.ts`)

- `ragRules` says: "Answer using ONLY information from the KNOWLEDGEBASE below."
- If no passage answers, the no-KB fallback instruction is used.

Result: both channels are intentionally strict and do not support related inference.

## Target Behavior

Introduce a **two-layer policy**:

1. **In-scope related query**: answer is allowed using:
   - KB facts as primary grounding,
   - general knowledge / calculation only when tied to KB entities/business context.
2. **Out-of-scope unrelated query**: refuse politely.

## Scope Decision Policy

Define scope in plain terms:

- **In scope** if user query references:
  - company/business entity from KB (property name, location, services, pricing context, booking context, contact context), or
  - direct related operations around that business (travel time, comparisons, planning, general domain guidance).
- **Out of scope** if user query is about topics not connected to KB/business domain.

The model should not answer unrelated personal, entertainment, vehicle specs, politics, or random trivia unless the tenant KB/business itself is about that domain.

## Proposed Prompt Strategy (No Code Yet)

Replace strict "KB only" instructions with **grounded scope instructions**:

- Use KB as primary source of truth.
- If KB lacks exact fact but query is business-related and in-scope:
  - allow best-effort inference/calculation/general knowledge.
  - clearly label uncertainty when approximate.
- If query is unrelated to business/KB domain:
  - refuse with concise out-of-scope message.
- Never fabricate tenant-specific facts (prices, policies, inventory, operating hours) if absent in KB.

## Suggested Response Rules

For in-scope but non-explicit questions:

- give short answer,
- mention approximation when needed,
- optionally ask one clarifying question if required.

For out-of-scope:

- one-line polite refusal,
- redirect to supported business topics.

## Suggested Output Labels / Telemetry

Track answer reason for observability:

- `kb_direct` (already exists),
- `kb_grounded_inference` (new),
- `out_of_scope_refusal` (new),
- existing `openai` / `self-hosted` source tags stay as transport/provider tags.

This helps monitor drift and safety.

## Tenant Control Recommendations

Add settings (future implementation):

- `allow_related_general_answers` (boolean, default `false` for safe rollout),
- `related_answer_strictness` (`strict` | `balanced` | `permissive`),
- optional custom `out_of_scope_message`.

Rollout:

1. Ship behind feature flag.
2. Enable for selected tenants.
3. Observe logs and user transcripts.
4. Expand gradually.

## Safety Guardrails

Required guardrails when enabling related answers:

- Do not invent internal company data not in KB.
- Mark uncertain estimates ("approximately", "based on general travel routes").
- Keep medical/legal/financial advice constrained to business context or refuse.
- Preserve existing language and voice response constraints.

## Channel Coverage

This policy must be applied consistently to:

- `/ask` text flow (`runAskPipeline` prompt rules),
- `/ask/voice` (uses same pipeline),
- Exotel voicebot RAG prompt block in `exotel-voicebot.ts`.

## Example Behavior Table

- Resort KB + "How far from Nashik?" -> **Answer allowed** (in-scope estimate).
- Resort KB + "Best time to visit during monsoon?" -> **Answer allowed** (domain general + resort context).
- Resort KB + "Mileage of Mahindra Thar?" -> **Refuse** (out-of-scope).
- Resort KB + "What is your checkout time?" when absent in KB -> **Do not invent**; say not available and offer contact/help.

## Acceptance Criteria (for Implementation Phase)

1. Related in-scope queries no longer return KB-not-found by default.
2. Unrelated queries are consistently refused.
3. No fabricated tenant-specific operational facts.
4. Works in both text and voicebot paths.
5. Telemetry can distinguish direct KB vs related inference vs refusal.

## Test Plan (Implementation Phase)

- Unit tests for scope classification prompt logic (prompt snapshots/rules).
- Integration tests for:
  - in-scope inferred answers,
  - out-of-scope refusal,
  - missing tenant fact behavior.
- Voice regression tests for short conversational responses.
- Multilingual tests where applicable.

## Notes for Next Step

When approved, implementation should start by updating prompt/rules construction in:

- `apps/api/src/routes/ask.ts` (`RAG_RULES_SUFFIX` and not-found handling),
- `apps/api/src/routes/exotel-voicebot.ts` (`ragRules` block),
- plus optional settings schema/migration if tenant-level control is required.

