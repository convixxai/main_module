# Voicebot Post-Script Issues Fix Plan

**Date:** 2026-07-03  
**Status:** Planning  
**Affects:** Both Outbound Campaign and Inbound Call Flows

---

## Executive Summary

After successfully fixing the "AI talking to AI" feedback loop in outbound calls using the Single Active Leg (SAL) pattern, three new critical issues have been identified that affect the post-script conversation phase. These issues likely exist in both outbound campaign flows (after script completion) and normal inbound call flows.

---

## Issue 1: Incorrect Language Detection and Unauthorized Switching

### Problem Description

The system is switching the active conversation language without explicit customer confirmation. The language changes mid-conversation based on STT detection, even when the customer hasn't requested a language change.

### Evidence from Logs

```
21:11:24 - LLM responds in Marathi (mr-IN):
  "पुण्यापासून छावणी लोणावड सुमारे १ तास ३६ मिनिटे, म्हणजे ६८ किलोमीटर आहे।"
  llm_detected_language: "hi-IN" (incorrectly labeled as Hindi)

21:11:29 - STT detects Marathi:
  stt_detected: "mr-IN"
  current_language_code updated to "mr-IN"

21:11:38 - User speaks in Hindi:
  transcript: "और मुझे यह बताइए आपके यहाँ पे कौन से कौन से टाइप के रूम्स अवेलेबल हैं?"
  script_language_override: stt_detected_before: "mr-IN" → script_inferred: "hi-IN"
  Language switches to "hi-IN" automatically
```

### Root Cause Analysis

1. **Automatic Language Override**: The `script_language_override` logic automatically changes the session language based on STT-detected language without requiring customer confirmation.

2. **No Confirmation Threshold**: The system lacks a mechanism to confirm language changes with the customer before switching.

3. **Script Inference Overriding STT**: When the transcript's script (Devanagari for Hindi/Marathi) doesn't match the STT-reported language code, the system "infers" a language based on script detection, which can cause incorrect switches.

4. **Multilingual Ambiguity**: Hindi and Marathi share the same Devanagari script, making script-based inference unreliable for distinguishing between them.

### Proposed Solutions

#### Solution A: Explicit Language Change Confirmation (Recommended)

**Description**: When a language switch is detected, prompt the customer to confirm before changing.

**Implementation**:
1. Add a `pendingLanguageSwitch` field to the session state
2. When STT detects a different language:
   - If confidence is high (>0.8) AND differs from current language
   - Store the detected language in `pendingLanguageSwitch`
   - Generate a confirmation prompt: "I noticed you're speaking in [Language]. Would you like me to continue in [Language]?"
3. On customer confirmation, update the active language
4. On denial or unclear response, continue in the current language

**Pros**:
- User has full control over language
- Prevents accidental/incorrect switches
- Better UX for multilingual customers

**Cons**:
- Adds an extra turn for language switching
- May feel verbose for customers who genuinely switched

#### Solution B: Sticky Language with Threshold

**Description**: Make language changes require multiple consecutive detections in the new language before switching.

**Implementation**:
1. Add `consecutiveLanguageDetections` counter to session
2. Only switch language after N (e.g., 3) consecutive turns in the same different language
3. Reset counter if original language is detected again

**Pros**:
- Less disruptive than confirmation prompts
- Handles temporary code-mixing gracefully

**Cons**:
- May delay legitimate language switches
- Doesn't give user explicit control

#### Solution C: Disable Automatic Language Switching (Simplest)

**Description**: Lock the language to the first detected language (or configured default) for the entire call.

**Implementation**:
1. Add `languageLocked` flag to session
2. After first few turns, set `languageLocked = true`
3. Ignore subsequent language detection changes

**Pros**:
- Simplest to implement
- Predictable behavior

**Cons**:
- Customers can't switch languages mid-call
- Less flexible for multilingual conversations

### Recommendation

**Solution A (Explicit Confirmation)** is recommended for the best balance of user experience and accuracy. It gives customers control while preventing accidental switches.

### Files to Modify

1. `apps/api/src/services/voicebot-session.ts` - Add `pendingLanguageSwitch` field
2. `apps/api/src/routes/exotel-voicebot.ts` - Implement confirmation logic in STT pipeline
3. `apps/api/src/utils/language-utils.ts` (if exists) - Add language switch confirmation helpers

---

## Issue 2: Chat History Not Sent to LLM

### Problem Description

The LLM is not receiving the full chat history of the current session, causing it to lose context. Specifically, information from the campaign script (like booking dates) is not available to the LLM when the customer asks follow-up questions.

### Evidence from Logs

```
21:11:38 - LLM Request shows:
  "history_messages": 6

21:11:40 - LLM Response:
  "मुझे खेद है, पर रूम्स के प्रकार की जानकारी नहीं है।"
  (I'm sorry, but I don't have information about room types)
```

The customer asked about booking dates that were mentioned in the script, but the LLM claims to not have this information.

### Root Cause Analysis

1. **Script Content Not in History**: The campaign script content may not be added to the chat history when it's played. The script is TTS-played but not recorded as an "assistant message" in the conversation history.

2. **Separate Chat Sessions**: The logs show different `chat_session_id` values for different streams:
   - req-2: `chat_session_id: "6fb9649f-c0a6-4887-99bd-29a2cc7fcb08"`
   - req-5: `chat_session_id: "25f4ff73-36f2-4ba0-9721-d9b33b069804"`
   
   This suggests each leg has its own chat session, meaning history isn't shared across legs.

3. **History Truncation**: The `history_messages: 6` might indicate that history is being truncated or filtered incorrectly.

4. **Outbound Campaign Script Isolation**: For outbound campaigns, the script may be treated separately from the conversational history.

### Investigation Steps

1. **Check how campaign script is stored**: Is the script text added to chat history after playback?
2. **Check chat session creation**: Why are there two different `chat_session_id` values?
3. **Check history retrieval logic**: How many messages are fetched? Is there a limit?
4. **Check if script content is included**: Is the campaign script text passed as a "system context" or as an "assistant turn"?

### Proposed Solutions

#### Solution A: Include Script as Initial Assistant Message (Recommended)

**Description**: When the campaign script finishes playing, add it to the chat history as an assistant message.

**Implementation**:
1. After `mark` event indicates script completion:
   - Retrieve the script text from the campaign configuration
   - Insert it as the first assistant message in the chat history
2. Ensure this happens on the active responder stream only (SAL fix ensures single stream)

**Pros**:
- LLM sees exactly what was said to the customer
- Maintains conversation continuity
- Simple conceptual model

**Cons**:
- Script may be long, consuming token budget
- Need to handle script variables (customer name, dates, etc.)

#### Solution B: Pass Script as System Context

**Description**: Include the rendered script in the system prompt as "What you already told the customer."

**Implementation**:
1. Add a `priorContext` field to the LLM request
2. Populate it with the rendered campaign script
3. Include in system prompt: "You have already told the customer the following: [script]"

**Pros**:
- Doesn't count as conversation history
- Clear separation of concerns

**Cons**:
- System prompt becomes longer
- May duplicate information if script is also in history

#### Solution C: Unified Chat Session Across Legs

**Description**: Ensure both WebSocket legs share the same `chat_session_id` so history is synchronized.

**Implementation**:
1. Use `exotel_call_session_id` (which is shared) to derive a single `chat_session_id`
2. Only the active responder writes to history
3. Both legs read from the same history

**Pros**:
- Consistent history regardless of which leg is active
- Handles leg failover gracefully

**Cons**:
- Requires database-level coordination
- More complex session management

### Recommendation

**Combination of Solution A + C** is recommended:
- Ensure unified chat session across legs (Solution C)
- Include the script as the first assistant message (Solution A)

### Files to Modify

1. `apps/api/src/routes/exotel-voicebot.ts` - Add script to history after playback
2. `apps/api/src/services/chat-history.ts` (or equivalent) - Ensure single session per call
3. `apps/api/src/services/voicebot-session.ts` - Store rendered script text for later use

---

## Issue 3: KB Search Fails for Cross-Lingual Queries

### Problem Description

When the customer asks questions in Hindi but the knowledge base (KB) content is in English, the semantic search fails to find relevant matches. The system then tells the customer it doesn't have the information, even though it exists in the KB.

### Evidence from Logs

```
21:11:38 - KB Search:
  Question (Hindi): "ओके, और मुझे यह बताइए आपके यहाँ पर कौन से कौन से टाइप के रूम्स अवेलेबल हैं?"
  (Translation: "OK, and tell me what types of rooms are available at your place?")
  
  KB Matches (English):
  - Rank 1: distance=0.7747 "What is Chavni Lohagad?"
  - Rank 2: distance=0.7861 "How far is Chavni from Mumbai?"
  - Rank 3: distance=0.8374 "How far is Chavni from Pune?"
  
  Threshold: direct_kb_threshold=0.3
  
  Log: kb_search_translate_skipped, reason: "voice_native_indic_embedding"

21:11:40 - LLM Response:
  "मुझे खेद है, पर रूम्स के प्रकार की जानकारी नहीं है।"
  (I'm sorry, but I don't have information about room types)
```

### Root Cause Analysis

1. **Translation Skipped**: The log `kb_search_translate_skipped` with reason `voice_native_indic_embedding` indicates the system skipped translating the Hindi query to English before embedding.

2. **English-Centric Embedding Model**: 
   - Current model: `nomic-embed-text` (384 dimensions)
   - This is an **English-centric** model, NOT multilingual
   - Cross-lingual matching (Hindi query → English KB) performs poorly

3. **High Distance Scores**: The distance scores (0.77, 0.78, 0.83) are far above the threshold (0.3), indicating poor semantic match.

4. **Skip Flag Enabled**: In `exotel-voicebot.ts` line ~4087:
   ```typescript
   voicePreferNativeEmbeddingForIndic: true,  // THIS SKIPS TRANSLATION!
   ```

5. **Missing KB Content**: The actual information about room types may not exist in the KB at all.

### Current Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  CURRENT FLOW (BROKEN)                                                       │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                              │
│  Query (Hindi)                                                               │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────┐                                                     │
│  │ Translation SKIPPED │  ← voicePreferNativeEmbeddingForIndic: true        │
│  │ (voice_native_indic)│                                                     │
│  └─────────────────────┘                                                     │
│       │                                                                      │
│       ▼                                                                      │
│  ┌─────────────────────┐     ┌──────────────────────────────────────────┐   │
│  │ nomic-embed-text    │     │ KB Vectors (English)                     │   │
│  │ (English-centric)   │────▶│ - "What is Chavni Lohagad?"              │   │
│  │ Hindi text → vector │     │ - "How far is Chavni from Mumbai?"       │   │
│  └─────────────────────┘     └──────────────────────────────────────────┘   │
│       │                              │                                       │
│       ▼                              ▼                                       │
│  ┌─────────────────────────────────────────┐                                │
│  │ Vector Distance: 0.77+ (POOR MATCH)     │  ← Threshold: 0.3             │
│  │ Result: "I don't have this information" │                                │
│  └─────────────────────────────────────────┘                                │
│                                                                              │
└─────────────────────────────────────────────────────────────────────────────┘
```

### Self-Hosted Embedding Setup

**Current Configuration:**
- Server: `https://ai.convixx.in/v1` (Ollama with OpenAI-compatible API)
- Model: `nomic-embed-text` (384 dimensions, English-centric)
- Provider: Self-hosted via Ollama

---

## Proposed Solutions with Latency Analysis

### Current Pipeline Timing (from logs)

| Stage | Time |
|-------|------|
| STT (Speech-to-Text) | ~720ms |
| Embedding | ~50ms |
| KB Vector Search | ~10ms |
| LLM Response | ~1500ms |
| TTS (Text-to-Speech) | ~500ms |
| **Total Pipeline** | **~2500-3000ms** |

---

### Solution A: Enable Sarvam Translation (RECOMMENDED - Simplest)

**Description**: Simply disable the skip flag to enable the already-implemented Sarvam translation.

**Implementation** (1 line change):
```typescript
// In apps/api/src/routes/exotel-voicebot.ts line ~4087
// Change from:
voicePreferNativeEmbeddingForIndic: true,
// To:
voicePreferNativeEmbeddingForIndic: false,
```

**Latency Impact:**

| Component | Before | After | Delta |
|-----------|--------|-------|-------|
| Sarvam Translate | 0ms | ~100-150ms | +150ms |
| Embedding | ~50ms | ~50ms | 0ms |
| Total Pipeline | ~2500ms | ~2650ms | **+6%** |

**Pros:**
- ✅ Single line change
- ✅ Sarvam translation already implemented and tested
- ✅ Very fast (~100-150ms)
- ✅ No database changes
- ✅ No model changes
- ✅ Immediate deployment

**Cons:**
- ⚠️ Adds ~150ms latency
- ⚠️ Depends on Sarvam API availability

**Flow After Fix:**
```
Query (Hindi) → Sarvam Translate (~150ms) → nomic-embed-text → KB Search → GOOD MATCH
```

---

### Solution B: Switch to Multilingual Embedding Model (Zero Added Latency)

**Description**: Replace `nomic-embed-text` with a multilingual model that handles Hindi natively.

**Available Multilingual Models for Ollama:**

| Model | Dimensions | Languages | Size | Latency |
|-------|-----------|-----------|------|---------|
| `nomic-embed-text` (current) | 384 | English only | 274MB | ~50ms |
| `snowflake-arctic-embed:m` | 768 | 10+ languages | 547MB | ~60ms |
| `mxbai-embed-large` | 1024 | Multilingual | 669MB | ~80ms |
| `bge-m3` | 1024 | 100+ languages | 1.2GB | ~100ms |

**Latency Impact:**

| Component | Before | After (bge-m3) | Delta |
|-----------|--------|----------------|-------|
| Translation | 0ms | 0ms (not needed) | 0ms |
| Embedding | ~50ms | ~100ms | +50ms |
| Total Pipeline | ~2500ms | ~2550ms | **+2%** |

**Pros:**
- ✅ No translation needed
- ✅ Better semantic understanding of Hindi
- ✅ Works for any language without code changes
- ✅ Minimal latency increase

**Cons:**
- ⚠️ Requires re-indexing all KB content
- ⚠️ Higher memory usage on Ollama server
- ⚠️ Different embedding dimensions (may need DB column change)

---

### Solution C: Parallel Translation (Advanced - Best Latency)

**Description**: Start translation in parallel with other processing to hide latency.

**Implementation:**
```typescript
// Start translation immediately (non-blocking)
const translatePromise = sarvamTranslateToEnglish(query);

// Continue with STT finalization, logging, etc.
// Only await when actually needed for embedding
const translated = await translatePromise;
```

**Latency Impact:**

| Component | Before | After | Delta |
|-----------|--------|-------|-------|
| Translation | 0ms | 0ms (parallel) | 0ms |
| Embedding | ~50ms | ~50ms | 0ms |
| Total Pipeline | ~2500ms | ~2500ms | **~0%** |

**Pros:**
- ✅ Zero effective latency increase
- ✅ Uses existing translation infrastructure

**Cons:**
- ⚠️ More complex implementation
- ⚠️ Need to refactor async flow

---

### Solution D: Translation + LLM Fallback (Most Robust)

**Description**: Enable translation AND add LLM fallback for poor KB matches.

**Implementation:**
1. Enable translation (Solution A)
2. If KB distance > 0.5, still include top results but instruct LLM to be cautious

**Pros:**
- ✅ Handles edge cases gracefully
- ✅ LLM can synthesize partial information

**Cons:**
- ⚠️ Risk of hallucination

---

## Ollama Installation Steps for Multilingual Models

### Step 1: SSH to Your Ollama Server

```bash
ssh user@ai.convixx.in
```

### Step 2: Check Current Models

```bash
ollama list
```

Expected output:
```
NAME                    ID              SIZE      MODIFIED
nomic-embed-text:latest abc123...       274 MB    2 weeks ago
```

### Step 3: Pull Multilingual Embedding Model

**Option A: BGE-M3 (Best multilingual support, 100+ languages)**
```bash
ollama pull bge-m3
```

**Option B: Snowflake Arctic Embed (Good balance of size/quality)**
```bash
ollama pull snowflake-arctic-embed:m
```

**Option C: MXBai Embed Large (Good multilingual)**
```bash
ollama pull mxbai-embed-large
```

### Step 4: Verify Installation

```bash
ollama list
# Should now show both models

# Test the new model
curl http://localhost:11434/api/embeddings -d '{
  "model": "bge-m3",
  "prompt": "कमरे के प्रकार बताइए"
}'
```

### Step 5: Update Code Configuration

```typescript
// In apps/api/src/services/llm.ts
// Change model name from:
model: "nomic-embed-text",
// To:
model: "bge-m3",  // or your chosen model
```

### Step 6: Re-index KB Content

```sql
-- After changing embedding model, you MUST re-embed all KB content
-- The dimensions will change from 384 to 1024

-- Option 1: Update embedding column size (if using fixed-size array)
ALTER TABLE kb_entries 
ALTER COLUMN embedding TYPE vector(1024);

-- Option 2: Re-run embedding job for all entries
-- (This depends on your KB ingestion pipeline)
```

### Step 7: Restart Services

```bash
# On Ollama server
sudo systemctl restart ollama

# On API server
pm2 restart convixx-api
```

---

## Latency Comparison Summary

| Solution | Latency Added | Complexity | DB Changes | Recommended |
|----------|--------------|------------|------------|-------------|
| **A: Enable Translation** | +150ms (6%) | Low (1 line) | None | ✅ **YES** |
| B: Multilingual Model | +50ms (2%) | Medium | Re-index KB | For future |
| C: Parallel Translation | ~0ms | High | None | If A too slow |
| D: Translation + Fallback | +150ms | Medium | None | Enhancement |

---

## Recommended Implementation

### Phase 1: Quick Fix (Solution A) - Deploy Today

```typescript
// apps/api/src/routes/exotel-voicebot.ts line ~4087
voicePreferNativeEmbeddingForIndic: false,  // Enable translation
```

**Why?**
- Immediate fix with 1 line change
- Only 6% latency increase (150ms)
- No database changes
- No model changes
- Can be deployed and tested immediately

### Phase 2: Optimization (Solution B) - Future Enhancement

1. Install `bge-m3` on Ollama server
2. Re-index all KB content
3. Remove translation step entirely
4. Net result: Even lower latency than current

---

### Files to Modify

**For Solution A (Quick Fix):**
1. `apps/api/src/routes/exotel-voicebot.ts` - Change flag to `false`

**For Solution B (Multilingual Model):**
1. `apps/api/src/services/llm.ts` - Change model name
2. `apps/api/src/config/env.ts` - Add model configuration
3. Database - Re-index KB embeddings
4. Ollama server - Install new model

---

## Implementation Order

Based on impact and complexity, the recommended implementation order is:

### Phase 1: Chat History Fix (Issue 2)
**Priority: HIGH | Complexity: MEDIUM**

This affects every conversation after the initial script. Without proper history, the bot appears forgetful and unprofessional.

1. Ensure unified chat session across legs
2. Add campaign script to chat history after playback
3. Verify history_messages includes all relevant turns

### Phase 2: KB Cross-Lingual Search (Issue 3)
**Priority: HIGH | Complexity: MEDIUM**

This affects the bot's ability to answer questions from the knowledge base.

1. Investigate why translation is skipped
2. Enable translation for KB search
3. Add LLM fallback for poor matches

### Phase 3: Language Detection (Issue 1)
**Priority: MEDIUM | Complexity: HIGH**

This is noticeable but less critical than the above two issues.

1. Add explicit language switch confirmation
2. Implement confirmation prompt generation
3. Handle confirmation/denial responses

---

## Testing Plan

### Test Case 1: Chat History Persistence
1. Start outbound campaign call
2. Let script play (contains booking dates)
3. After script, ask: "What dates did you mention for booking?"
4. **Expected**: Bot recalls the dates from the script

### Test Case 2: Cross-Lingual KB Search
1. Add English KB entry: "What room types are available? We have Deluxe, Suite, and Standard rooms."
2. Start call and ask in Hindi: "कौन से प्रकार के कमरे हैं?"
3. **Expected**: Bot responds with room type information

### Test Case 3: Language Switch Confirmation
1. Start call in Hindi
2. Switch to speaking in Marathi
3. **Expected**: Bot asks "I noticed you're speaking in Marathi. Would you like me to continue in Marathi?"

---

## Database Changes Required

### No Schema Changes Required

All proposed solutions work with the existing `exotel_call_sessions.metadata` JSONB field and `chat_history` tables.

### Potential Metadata Fields to Add

```sql
-- For language confirmation tracking
metadata.pending_language_switch = "mr-IN"
metadata.language_locked = true

-- For script history tracking  
metadata.script_added_to_history = true
metadata.rendered_script_text = "..."
```

---

## Configuration Changes

### New Feature Flags (env.ts)

```typescript
// Language switching
voicebot: {
  languageSwitchConfirmationEnabled: boolean;  // Enable explicit confirmation
  languageSwitchConsecutiveThreshold: number;  // N turns before auto-switch
  languageLockAfterTurns: number;              // Lock after N turns (0 = never lock)
}

// KB search
rag: {
  kbSearchTranslationEnabled: boolean;         // Enable query translation
  kbSearchTranslationSkipForIndic: boolean;    // Current behavior (to deprecate)
  kbFallbackToLlmOnPoorMatch: boolean;         // Use LLM when KB match poor
  kbPoorMatchThreshold: number;                // Distance above which = poor match
}
```

---

## Summary

| Issue | Root Cause | Recommended Solution | Priority |
|-------|-----------|---------------------|----------|
| Language Detection | Automatic switch without confirmation | Explicit user confirmation | Medium |
| Chat History | Script not in history, separate sessions | Unified session + script as first message | High |
| KB Search | Translation skipped, cross-lingual mismatch | Enable query translation | High |

---

## Next Steps

1. **Confirm this plan with stakeholder** before implementing
2. **Investigate codebase** to locate exact files for each fix
3. **Implement Phase 1** (Chat History) first
4. **Test thoroughly** before moving to next phase
5. **Monitor logs** after each deployment

---

*Document prepared for review. Do not implement until approved.*
