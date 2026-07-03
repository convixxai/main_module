// ============================================================
// Echo Detection Utility for Outbound Campaign Calls
// Detects when STT captures the bot's own TTS output in dual-leg calls.
// Reference: docs/OUTBOUND_CALL_AI_FEEDBACK_LOOP_FIX.md
// Phase 2: Cross-leg echo detection via shared DB buffer
// Reference: docs/OUTBOUND_CALL_CROSS_LEG_ECHO_FIX_PLAN.md
// ============================================================

import type { Pool } from "pg";

/**
 * Normalize text for comparison by:
 * - Converting to lowercase
 * - Removing punctuation and special characters
 * - Collapsing multiple spaces
 * - Trimming whitespace
 */
export function normalizeTextForComparison(text: string): string {
  if (!text) return "";
  return text
    .toLowerCase()
    .replace(/[।,.!?;:'"…\-–—()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Calculate Levenshtein distance between two strings.
 * Used for fuzzy text matching in echo detection.
 */
function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  const matrix: number[][] = [];

  for (let i = 0; i <= b.length; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= a.length; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= b.length; i++) {
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1, // insertion
          matrix[i - 1][j] + 1 // deletion
        );
      }
    }
  }

  return matrix[b.length][a.length];
}

/**
 * Calculate similarity ratio between two strings (0 to 1).
 * 1 = identical, 0 = completely different.
 */
export function calculateSimilarity(a: string, b: string): number {
  const normA = normalizeTextForComparison(a);
  const normB = normalizeTextForComparison(b);

  if (!normA && !normB) return 1;
  if (!normA || !normB) return 0;

  const maxLen = Math.max(normA.length, normB.length);
  if (maxLen === 0) return 1;

  const distance = levenshteinDistance(normA, normB);
  return 1 - distance / maxLen;
}

/**
 * Check if a transcript is likely an echo of recent TTS content.
 * Uses partial matching to detect when STT captures a portion of the TTS.
 */
export function isEchoOfRecentTTS(
  transcript: string,
  recentTTSBuffer: Array<{ text: string; timestamp: number }>,
  options: {
    similarityThreshold?: number;
    maxAgeMs?: number;
    minTranscriptLength?: number;
  } = {}
): { isEcho: boolean; matchedText?: string; similarity?: number } {
  const {
    similarityThreshold = 0.6,
    maxAgeMs = 30000,
    minTranscriptLength = 5,
  } = options;

  const normTranscript = normalizeTextForComparison(transcript);
  
  if (!normTranscript || normTranscript.length < minTranscriptLength) {
    return { isEcho: false };
  }

  const now = Date.now();
  const validBuffer = recentTTSBuffer.filter(
    (entry) => now - entry.timestamp < maxAgeMs
  );

  for (const entry of validBuffer) {
    const normTTS = normalizeTextForComparison(entry.text);
    if (!normTTS) continue;

    // Full similarity check
    const fullSimilarity = calculateSimilarity(normTranscript, normTTS);
    if (fullSimilarity >= similarityThreshold) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: fullSimilarity,
      };
    }

    // Partial match: check if transcript is a substring of TTS (or vice versa)
    // This handles cases where STT only captures part of the TTS output
    if (normTTS.includes(normTranscript)) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: 0.95, // High confidence for substring match
      };
    }
    
    if (normTranscript.includes(normTTS) && normTTS.length > 20) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: 0.9,
      };
    }

    // Windowed comparison for long TTS: compare transcript against sliding windows
    if (normTTS.length > normTranscript.length * 1.5) {
      const windowSize = normTranscript.length;
      for (let i = 0; i <= normTTS.length - windowSize; i += Math.floor(windowSize / 3)) {
        const window = normTTS.slice(i, i + windowSize);
        const windowSimilarity = calculateSimilarity(normTranscript, window);
        if (windowSimilarity >= similarityThreshold + 0.1) {
          return {
            isEcho: true,
            matchedText: entry.text.slice(0, 100),
            similarity: windowSimilarity,
          };
        }
      }
    }
  }

  return { isEcho: false };
}

/**
 * Add TTS text to the recent buffer and prune old entries.
 */
export function addToRecentTTSBuffer(
  buffer: Array<{ text: string; timestamp: number }>,
  text: string,
  maxAgeMs: number = 30000
): Array<{ text: string; timestamp: number }> {
  const now = Date.now();
  
  // Prune expired entries
  const validBuffer = buffer.filter((entry) => now - entry.timestamp < maxAgeMs);
  
  // Add new entry
  validBuffer.push({ text, timestamp: now });
  
  return validBuffer;
}

/**
 * Prune old entries from the TTS buffer.
 */
export function pruneRecentTTSBuffer(
  buffer: Array<{ text: string; timestamp: number }>,
  maxAgeMs: number = 30000
): Array<{ text: string; timestamp: number }> {
  const now = Date.now();
  return buffer.filter((entry) => now - entry.timestamp < maxAgeMs);
}

// ============================================================
// Shared Database TTS Buffer (Cross-Leg Echo Detection)
// ============================================================

export interface SharedTTSEntry {
  text: string;
  timestamp: string; // ISO string for JSON compatibility
  stream_sid: string;
}

/**
 * Add TTS text to the shared database buffer for cross-leg echo detection.
 * This allows other WebSocket streams for the same call to detect echoes.
 * Automatically prunes entries older than maxAgeSecs.
 */
export async function addToSharedTTSBuffer(
  pool: Pool,
  callSessionId: string,
  text: string,
  streamSid: string,
  maxAgeSecs: number = 60
): Promise<void> {
  if (!callSessionId || !text.trim()) return;

  try {
    await pool.query(
      `UPDATE exotel_call_sessions
       SET metadata = jsonb_set(
         COALESCE(metadata, '{}'::jsonb),
         '{shared_tts_buffer}',
         (
           SELECT COALESCE(
             (
               SELECT jsonb_agg(entry)
               FROM jsonb_array_elements(
                 COALESCE(metadata->'shared_tts_buffer', '[]'::jsonb)
               ) AS entry
               WHERE (entry->>'timestamp')::timestamptz > NOW() - ($4::int || ' seconds')::interval
             ),
             '[]'::jsonb
           ) || jsonb_build_array(
             jsonb_build_object(
               'text', $1::text,
               'timestamp', NOW()::text,
               'stream_sid', $2::text
             )
           )
         )
       )
       WHERE id = $3::uuid`,
      [text, streamSid, callSessionId, maxAgeSecs]
    );
  } catch (err) {
    // Non-fatal: log but don't throw
    console.error("[echo-detection] Failed to add to shared TTS buffer:", err);
  }
}

/**
 * Read the shared TTS buffer from the database.
 * Returns entries from all streams for this call session.
 */
export async function getSharedTTSBuffer(
  pool: Pool,
  callSessionId: string
): Promise<SharedTTSEntry[]> {
  if (!callSessionId) return [];

  try {
    const result = await pool.query(
      `SELECT metadata->'shared_tts_buffer' AS buffer
       FROM exotel_call_sessions
       WHERE id = $1::uuid`,
      [callSessionId]
    );

    if (result.rows.length === 0 || !result.rows[0].buffer) {
      return [];
    }

    return result.rows[0].buffer as SharedTTSEntry[];
  } catch (err) {
    console.error("[echo-detection] Failed to read shared TTS buffer:", err);
    return [];
  }
}

/**
 * Check if a transcript matches any entry in the shared TTS buffer.
 * Similar to isEchoOfRecentTTS but works with the database buffer format.
 */
export function isEchoOfSharedTTS(
  transcript: string,
  sharedBuffer: SharedTTSEntry[],
  options: {
    similarityThreshold?: number;
    maxAgeMs?: number;
    minTranscriptLength?: number;
    excludeStreamSid?: string; // Optionally exclude current stream's own TTS
  } = {}
): { isEcho: boolean; matchedText?: string; similarity?: number; matchedStreamSid?: string } {
  const {
    similarityThreshold = 0.6,
    maxAgeMs = 60000,
    minTranscriptLength = 5,
    excludeStreamSid,
  } = options;

  const normTranscript = normalizeTextForComparison(transcript);
  
  if (!normTranscript || normTranscript.length < minTranscriptLength) {
    return { isEcho: false };
  }

  const now = Date.now();

  for (const entry of sharedBuffer) {
    // Optionally skip entries from the same stream
    if (excludeStreamSid && entry.stream_sid === excludeStreamSid) {
      continue;
    }

    // Check age
    const entryTime = new Date(entry.timestamp).getTime();
    if (now - entryTime >= maxAgeMs) {
      continue;
    }

    const normTTS = normalizeTextForComparison(entry.text);
    if (!normTTS) continue;

    // Full similarity check
    const fullSimilarity = calculateSimilarity(normTranscript, normTTS);
    if (fullSimilarity >= similarityThreshold) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: fullSimilarity,
        matchedStreamSid: entry.stream_sid,
      };
    }

    // Partial match: check if transcript is a substring of TTS (or vice versa)
    if (normTTS.includes(normTranscript)) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: 0.95,
        matchedStreamSid: entry.stream_sid,
      };
    }
    
    if (normTranscript.includes(normTTS) && normTTS.length > 20) {
      return {
        isEcho: true,
        matchedText: entry.text.slice(0, 100),
        similarity: 0.9,
        matchedStreamSid: entry.stream_sid,
      };
    }

    // Windowed comparison for long TTS
    if (normTTS.length > normTranscript.length * 1.5) {
      const windowSize = normTranscript.length;
      for (let i = 0; i <= normTTS.length - windowSize; i += Math.floor(windowSize / 3)) {
        const window = normTTS.slice(i, i + windowSize);
        const windowSimilarity = calculateSimilarity(normTranscript, window);
        if (windowSimilarity >= similarityThreshold + 0.1) {
          return {
            isEcho: true,
            matchedText: entry.text.slice(0, 100),
            similarity: windowSimilarity,
            matchedStreamSid: entry.stream_sid,
          };
        }
      }
    }
  }

  return { isEcho: false };
}

/**
 * Mark script playback as complete in the database.
 * Called when the winning stream receives the mark event for script completion.
 */
export async function markScriptPlaybackComplete(
  pool: Pool,
  callSessionId: string
): Promise<void> {
  if (!callSessionId) return;

  try {
    await pool.query(
      `UPDATE exotel_call_sessions
       SET metadata = COALESCE(metadata, '{}'::jsonb) ||
           jsonb_build_object(
             'script_playback_complete', true,
             'script_completed_at', NOW()::text
           )
       WHERE id = $1::uuid`,
      [callSessionId]
    );
  } catch (err) {
    console.error("[echo-detection] Failed to mark script complete:", err);
  }
}

/**
 * Check if script playback is complete.
 * Used by secondary streams to know when to re-enable STT.
 */
export async function isScriptPlaybackComplete(
  pool: Pool,
  callSessionId: string
): Promise<boolean> {
  if (!callSessionId) return true;

  try {
    const result = await pool.query(
      `SELECT metadata->>'script_playback_complete' AS complete
       FROM exotel_call_sessions
       WHERE id = $1::uuid`,
      [callSessionId]
    );

    if (result.rows.length === 0) return true;
    return result.rows[0].complete === "true";
  } catch (err) {
    console.error("[echo-detection] Failed to check script complete:", err);
    return true; // Assume complete on error to not block STT
  }
}

/**
 * Estimate TTS duration based on text length.
 * Uses conservative estimates: ~15 characters per second for Indian languages.
 * Returns duration in milliseconds.
 */
export function estimateTTSDurationMs(text: string): number {
  if (!text) return 0;
  
  // Average speaking rate: ~12-18 chars/sec for Indian languages
  // Using 15 chars/sec as conservative middle ground
  const charsPerSecond = 15;
  const textLength = text.length;
  const durationSecs = textLength / charsPerSecond;
  
  // Add minimum of 2 seconds, cap at 60 seconds
  return Math.min(60000, Math.max(2000, durationSecs * 1000));
}
