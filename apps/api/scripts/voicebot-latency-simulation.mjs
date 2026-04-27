#!/usr/bin/env node
/**
 * Monte-Carlo style simulation of voicebot phase timings (no live Sarvam/OpenAI).
 * Adjust BASE_* ms to match your environment after measuring `pipeline.utterance.timing` logs.
 *
 * Run: node scripts/voicebot-latency-simulation.mjs
 */

const N = 2000;
const JITTER_FRAC = 0.12;

function jitter(base) {
  const j = base * JITTER_FRAC * (Math.random() * 2 - 1);
  return Math.max(20, Math.round(base + j));
}

/** Target profile after STT idle + linear16 TTS improvements (illustrative). */
const BASE = {
  endpointingMs: 500,
  sttMs: 900,
  embedKbMs: 140,
  llmFirstTokenMs: 350,
  llmRestMs: 400,
  ttsFirstSentenceMs: 550,
  exotelSendMs: 40,
};

function oneRun() {
  const e = jitter(BASE.endpointingMs);
  const s = jitter(BASE.sttMs);
  const emb = jitter(BASE.embedKbMs);
  const llm1 = jitter(BASE.llmFirstTokenMs);
  const llm2 = jitter(BASE.llmRestMs);
  const tts = jitter(BASE.ttsFirstSentenceMs);
  const ex = jitter(BASE.exotelSendMs);
  const ttfa = s + emb + llm1 + tts + ex;
  const total = s + emb + llm1 + llm2 + tts + ex;
  return { e, s, emb, llm1, llm2, tts, ex, ttfa, total };
}

function pct(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  const i = Math.min(a.length - 1, Math.floor((p / 100) * a.length));
  return a[i];
}

const ttfa = [];
const totals = [];
for (let i = 0; i < N; i++) {
  const r = oneRun();
  ttfa.push(r.ttfa);
  totals.push(r.total);
}

console.log("Voicebot latency simulation (synthetic — not live API calls)");
console.log("=".repeat(60));
console.log(`Iterations: ${N}, jitter: ±${JITTER_FRAC * 100}% per phase`);
console.log("Base profile (ms):", BASE);
console.log("");
console.log("TTFA (STT done → first audio to Exotel, simplified stack):");
console.log(`  p50: ${pct(ttfa, 50)} ms`);
console.log(`  p75: ${pct(ttfa, 75)} ms`);
console.log(`  p90: ${pct(ttfa, 90)} ms`);
console.log(`  p99: ${pct(ttfa, 99)} ms`);
console.log("");
console.log("Total turn (STT + RAG + one TTS chunk + send):");
console.log(`  p50: ${pct(totals, 50)} ms`);
console.log(`  p90: ${pct(totals, 90)} ms`);
console.log("");
console.log(
  `Share of runs with TTFA < 2000 ms: ${((ttfa.filter((x) => x < 2000).length / N) * 100).toFixed(1)}%`
);
console.log("");
console.log(
  "Interpretation: tune BASE_* from production `pipeline.utterance.timing` logs;"
);
console.log(
  "  stt_ms, ask_pipeline_ms (embed+LLM+incremental TTS), final_tts_ms, total_ms."
);
