// ============================================================
// Shared incremental-TTS sentence buffering, for any voicebot route that
// wants to start speaking before the LLM has finished the full answer.
//
// The cut-detection algorithm mirrors exotel-voicebot.ts's own
// findNextSpeakCutElevenLabs (already proven in production) - sentence
// boundary cuts with a generous fallback length, which suits providers like
// Cartesia and ElevenLabs that sound better fed full sentences than tiny
// fragments. exotel-voicebot.ts's own internal implementation is untouched
// by this file; this exists so routes/vodafone-voicebot.ts and
// routes/qa-test-console.ts can share ONE tested implementation instead of
// two more copies of the same ~15 lines.
// ============================================================

// Raised from 220/72 (2026-09-16): a real call recording review found Marathi
// replies getting cut off mid-sentence, and reading the code showed why - a
// natural, conversational Marathi sentence (especially multi-clause direction-
// giving or listing several details, which this bot does constantly) routinely
// runs past 220 characters before its first "."/"।", so the old force-cut was
// firing well before a genuine sentence boundary and chopping speech mid-
// thought. Devanagari text also needs more raw character budget than English
// for the same amount of spoken content (matras/combining marks count as
// separate characters), so 220 was tighter for Marathi/Hindi than it looked.
const FORCE_CUT_LEN = 320;
const FORCE_CUT_SPACE_FLOOR = 100;

/** Index of the last char of the next speakable slice in `s`, or -1 (buffer more). */
export function findNextSentenceCut(s: string): number {
  if (s.length === 0) return -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch && ".!?।".includes(ch)) {
      if (i === s.length - 1 || /\s/.test(s[i + 1]!)) return i;
    }
  }
  if (s.length >= FORCE_CUT_LEN) {
    // Prefer cutting at a comma-like pause near the force-cut point over an
    // arbitrary word boundary, so a forced cut still lands somewhere that
    // sounds like a natural breath rather than a random chop mid-clause.
    const commaIdx = s.lastIndexOf(",", FORCE_CUT_LEN);
    if (commaIdx > FORCE_CUT_SPACE_FLOOR) return commaIdx;
    const sp = s.lastIndexOf(" ", FORCE_CUT_LEN);
    if (sp > FORCE_CUT_SPACE_FLOOR) return sp - 1;
    return FORCE_CUT_LEN - 1;
  }
  return -1;
}

/**
 * Accumulates LLM token deltas (from `streamChatOpenAI`'s `onTextDelta`) and
 * calls `onSentence` for each complete, speakable sentence as soon as it's
 * ready. Call `flush()` once the LLM finishes to emit any trailing partial
 * sentence. `onSentence` calls are awaited and run strictly in order, so a
 * caller that synthesizes+sends audio inside it gets sentences spoken in
 * the same order the LLM produced them.
 */
export class SentenceStreamBuffer {
  private buffer = "";
  private sentenceCount = 0;

  constructor(private readonly onSentence: (sentence: string) => void | Promise<void>) {}

  async push(delta: string): Promise<void> {
    this.buffer += delta;
    for (;;) {
      const cut = findNextSentenceCut(this.buffer);
      if (cut < 0) break;
      const piece = this.buffer.slice(0, cut + 1).trim();
      this.buffer = this.buffer.slice(cut + 1).replace(/^\s+/, "");
      if (piece.length > 0) {
        this.sentenceCount++;
        await this.onSentence(piece);
      }
    }
  }

  async flush(): Promise<void> {
    const rest = this.buffer.trim();
    this.buffer = "";
    if (rest.length > 0) {
      this.sentenceCount++;
      await this.onSentence(rest);
    }
  }

  /** True once at least one sentence has been flushed to `onSentence`. */
  get hasSpokenAnything(): boolean {
    return this.sentenceCount > 0;
  }
}

/**
 * True when a cut sentence is (almost certainly) one of ask.ts's raw RAG
 * sentinel tokens (ANSWER_NOT_FOUND / OUT_OF_SCOPE) rather than natural
 * speech - see NOT_FOUND_MARKERS/OUT_OF_SCOPE_MARKERS and isNotFound/
 * isOutOfScope in routes/ask.ts. The non-streaming pipeline swaps these for
 * a friendly message BEFORE returning the answer to any caller; a naive
 * streaming caller that speaks sentences as they're cut would instead speak
 * the raw token out loud, since that swap can only happen once the full
 * answer is known. Callers pushing LLM deltas through SentenceStreamBuffer
 * should check this on each cut sentence and skip speaking it (falling back
 * to the pipeline's final, already-swapped `answer` once it resolves)
 * rather than ever letting a caller hear "ANSWER_NOT_FOUND" out loud.
 */
export function looksLikeRawRagMarker(sentence: string): boolean {
  return /^(answer_not_found|out_of_scope)$/i.test(sentence.trim());
}
