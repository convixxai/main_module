// ============================================================
// Echo Detection Utility for Outbound Campaign Calls
// Detects when STT captures the bot's own TTS output in dual-leg calls.
// Reference: docs/OUTBOUND_CALL_AI_FEEDBACK_LOOP_FIX.md
// ============================================================

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
