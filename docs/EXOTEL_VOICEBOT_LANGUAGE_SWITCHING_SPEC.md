# Exotel voicebot: session language policy

This document specifies how the **active call language** must be chosen, stored, and applied across **STT (Sarvam)**, **LLM**, and **TTS** for the Exotel voicebot. It applies when `voicebot_multilingual` is enabled on the tenant and during any call where language must remain predictable for the customer experience.

Implementation will follow this spec in code; this file is the source of truth for product behavior.

---

## 1. Definitions

| Term | Meaning |
|------|---------|
| **Active language** | The single BCP-47 language tag that the pipeline must use for this call at this moment for STT input hints, LLM generation, and TTS output. |
| **Customer query** | One completed **user-turn**: inbound audio processed through STT that yields a **non-empty transcript** intended as the user’s message (exclude pure noise / empty STT). Failed STT or discarded utterances do not increment the query counter. |
| **Early window** | The first **two** customer queries after call start (query index **1** and **2**). |
| **Post-early window** | From customer query **3** onward. |
| **Sarvam detected language** | The language tag Sarvam STT reports for the utterance (must be mapped/normalized to BCP-47 consistently with the rest of the stack). |
| **Sarvam confidence** | The numeric confidence Sarvam returns for that utterance’s language detection (or the documented equivalent field). **Auto language updates require `confidence > 0.80` (strictly greater than 80%).** |

---

## 2. Source of truth and consistency

1. **Database:** `exotel_call_sessions.current_language_code` holds the persisted active language for the call.
2. **In-memory session:** The live `VoicebotSession` must hold the same value in a dedicated field (e.g. `currentLanguageCode` or equivalent), updated **in lockstep** with the DB whenever the active language changes.
3. **Rules:**
   - On **every** change to the active language, update **both** the DB row and the in-memory session **before** the next STT/LLM/TTS step uses language.
   - At call start, initialize active language from the same rule used today (typically `default_language_code` from customer settings snapshot on `exotel_call_sessions`, mirrored into the session).
4. **No drift:** Do not rely on “last STT language” as an implicit session variable without writing it back to `current_language_code` and the session when that value becomes the **active** language.

---

## 3. Forcing active language for STT, LLM, and TTS (multilingual on or off)

**Regardless of `voicebot_multilingual`**, once an active language is set for the call:

- **STT:** Invoke Sarvam with parameters that **target the active language** (e.g. language hint / constrained mode per Sarvam API). Do not let multilingual auto-detection alone override the active language for the *next* pipeline step without going through the policy in §4–§5.
- **LLM:** System/user messaging, RAG hints, and any “respond in language X” instruction must use the **active language**.
- **TTS:** Synthesize in the **active language** (and tenant-approved voice mapping for that tag).

**Interpretation of “multilingual”:** Tenant `voicebot_multilingual` indicates the *product* may support multiple languages during the call, but the **pipeline still runs in exactly one active language at a time**. Multilingual must not mean “each subsystem picks its own language per utterance without session policy.” Sarvam may still *detect* a different language on an utterance; that detection is input to §4–§5, not a direct override of STT/LLM/TTS for the rest of the turn unless the policy applies.

---

## 4. Early window (first two customer queries): silent alignment

**When:** Customer query index is **1** or **2**.

**Condition for silent switch to Sarvam’s detected language:**

1. Sarvam returns a detected language **L** that is **not** the same as the current active language (after normalization; see §7).
2. **confidence > 0.80** for that detection.
3. **L** is **allowed** for the tenant (e.g. present in `allowed_language_codes` or equivalent allowlist). If **L** is not allowed, do **not** switch; keep active language and optionally log.

**Action:** Update active language to **L** (DB + session). **Do not** ask the customer for confirmation. Proceed with STT/LLM/TTS for that turn using **L** as the active language.

**If the condition is not met** (e.g. confidence ≤ 80%, or **L** equals active language, or **L** disallowed): keep the current active language for the turn; do not switch.

---

## 5. Post-early window (third customer query onward): confirmation required

**When:** Customer query index is **≥ 3**.

If Sarvam suggests a language **L** that differs from the active language (after normalization), **even with confidence > 80%**:

1. **Do not** change `current_language_code` or the in-memory active language yet.
2. **Do not** run the main answer in **L** until the customer has explicitly confirmed the switch.
3. Enter a **pending language switch** state (recommended session flags):
   - `pendingLanguageSwitchTo: L` (or null when idle),
   - `pendingLanguageSwitchConfidence`, `pendingLanguageSwitchFromUtteranceSnippet` (optional, for logging/debug),
   - Clear pending state after confirmation, rejection, or timeout (policy choice; see §6).

**Confirmation UX (voice):** Play a short prompt in the **current** active language (or bilingual minimal prompt if product requires), e.g. asking whether to continue in **L**. Treat explicit **yes** / **switch** / **okay** in the **expected** response language or DTMF as confirmation; treat **no** / **cancel** / **keep [current]** as rejection.

**After explicit confirmation:** Set active language to **L**; persist to DB + session; clear pending state; process the **original** or **follow-up** user intent in **L** per implementation (ensure the user is not stuck in a loop).

**After explicit rejection or non-commit:** Keep active language; clear pending state; respond in the **original** active language. Do **not** switch.

---

## 6. Edge cases and implementation notes

1. **Query counting:** Increment the customer-query counter only on successful user turns (non-empty transcript). Reset rules: never reset mid-call; only valid per call.
2. **Greeting:** Greeting playback is outside “customer queries” unless product explicitly counts it; default is **not** to count the greeting as query 1.
3. **Simultaneous signals:** If multiple utterances arrive while `pendingLanguageSwitchTo` is set, do not apply additional auto-switches; either merge into one pending **L** (latest high-confidence) or queue—document the chosen behavior in code comments; prefer **single pending target** + re-prompt if needed.
4. **Timeout:** If confirmation is required but the user stays silent, define behavior (repeat prompt once, then keep current language and clear pending).
5. **Normalization:** Compare language tags in a stable way (e.g. lowercase primary subtag, consistent region/script handling) so `hi` vs `hi-IN` decisions are explicit in implementation.
6. **Analytics (optional later):** `PLATFORM_EXTENSIONS_DESIGN_2026-04-23.md` describes `call_language_events` and related columns; new behavior should emit events such as `auto_detected` (early window) vs `keyword`/confirmation (post-early) when that schema exists.

---

## 7. Summary table

| Phase | Detected **L** ≠ active | Confidence | Allowed **L** | Action |
|-------|-------------------------|------------|---------------|--------|
| Queries 1–2 | yes | > 80% | yes | **Silent switch** to **L**; sync DB + session; STT/LLM/TTS use **L**. |
| Queries 1–2 | yes | ≤ 80% or no | — | **No switch**; keep active language. |
| Queries ≥ 3 | yes | any | yes | **No auto switch**; **require confirmation**; then update DB + session if confirmed. |
| Queries ≥ 3 | yes | any | no | **No switch**; keep active language. |

---

## 8. Out of scope for this document

- Exact Sarvam API field names and request payloads (see Sarvam integration code).
- ElevenLabs vs Sarvam TTS routing; both must respect active language once set.
- Admin overrides or agent handoff—may extend the same table with an explicit trigger type when implemented.

---

*Last updated: 2026-04-28.*
