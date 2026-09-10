// ============================================================
// Seeds a temporary customer + agent + Cartesia avatar + KB entries + API
// key for the "Cartesia voice test console" page
// (/voice/cartesia-test-console). Idempotent: re-running finds the existing
// temp customer by its marker name instead of creating a duplicate.
//
// This is throwaway test data — clearly labeled, isolated from real
// customers, and does not touch any existing row.
//
// Usage (from apps/api): npx ts-node scripts/create-temp-voice-test-customer.ts
// Add --teardown to delete everything this script created instead.
// ============================================================

import crypto from "crypto";
import { pool } from "../src/config/db";
import { generateEmbedding } from "../src/services/llm";

const MARKER_NAME = "__TEMP_CARTESIA_VOICE_TEST_CONSOLE__";

const SYSTEM_PROMPT =
  "You are a helpful support assistant for Convixx, a voice-AI platform. Answer briefly and clearly, in 1-3 sentences, based only on the knowledge base provided.";

const KB_ENTRIES: Array<{ question: string; answer: string }> = [
  {
    question: "What are your business hours?",
    answer: "Our support team is available Monday to Saturday, 9 AM to 7 PM Indian Standard Time.",
  },
  {
    question: "How do I reset my password?",
    answer: "Go to the login page, click 'Forgot password', and follow the link sent to your registered email.",
  },
  {
    question: "Do you offer a free trial?",
    answer: "Yes, we offer a 14-day free trial with full access to all features, no credit card required.",
  },
  {
    question: "How can I contact customer support?",
    answer: "You can reach us by email at support@example.com or call our helpline during business hours.",
  },
  {
    question: "Can I cancel my subscription anytime?",
    answer: "Yes, you can cancel your subscription anytime from the billing settings page with no cancellation fee.",
  },
  {
    question: "What payment methods do you accept?",
    answer: "We accept all major credit and debit cards, UPI, and net banking for Indian customers.",
  },
];

async function teardown(): Promise<void> {
  const existing = await pool.query(`SELECT id FROM customers WHERE name = $1`, [MARKER_NAME]);
  if (existing.rows.length === 0) {
    console.log("No temp customer found — nothing to tear down.");
    await pool.end();
    return;
  }
  const customerId = existing.rows[0].id as string;
  // customers row cascades to agents/kb_entries/cartesia_avatars/api_keys/customer_settings
  // via ON DELETE CASCADE on customer_id, so deleting the customer row is sufficient.
  await pool.query(`DELETE FROM customers WHERE id = $1`, [customerId]);
  console.log(`Tore down temp customer ${customerId} and all dependent rows.`);
  await pool.end();
}

async function main(): Promise<void> {
  if (process.argv.includes("--teardown")) {
    await teardown();
    return;
  }

  const existing = await pool.query(
    `SELECT id FROM customers WHERE name = $1`,
    [MARKER_NAME]
  );

  let customerId: string;
  if (existing.rows.length > 0) {
    customerId = existing.rows[0].id as string;
    console.log(`Temp customer already exists: ${customerId} — reusing it (idempotent).`);
  } else {
    const customerInsert = await pool.query(
      `INSERT INTO customers (name, system_prompt) VALUES ($1, $2) RETURNING id`,
      [MARKER_NAME, SYSTEM_PROMPT]
    );
    customerId = customerInsert.rows[0].id as string;
    console.log(`Created temp customer: ${customerId}`);
  }

  // customer_settings row is auto-created by trigger on customer INSERT (migration 005).
  await pool.query(
    `UPDATE customer_settings
        SET voicebot_enabled = TRUE,
            stt_provider = 'sarvam',
            tts_provider = 'cartesia',
            rag_use_history = FALSE
      WHERE customer_id = $1`,
    [customerId]
  );
  console.log("Configured customer_settings (stt=sarvam, tts=cartesia).");

  // Reuse a real, already-configured Cartesia voice_id from the existing
  // cartesia_avatars table rather than inventing one, per instruction.
  const sourceAvatar = await pool.query(
    `SELECT voice_id, model_id FROM cartesia_avatars WHERE is_active = TRUE ORDER BY created_at LIMIT 1`
  );
  if (sourceAvatar.rows.length === 0) {
    throw new Error("No existing cartesia_avatars row found to source a voice_id from.");
  }
  const { voice_id: voiceId, model_id: modelId } = sourceAvatar.rows[0] as {
    voice_id: string;
    model_id: string;
  };
  console.log(`Sourced Cartesia voice_id=${voiceId} model_id=${modelId} from an existing avatar.`);

  const existingAvatar = await pool.query(
    `SELECT id FROM cartesia_avatars WHERE customer_id = $1 LIMIT 1`,
    [customerId]
  );
  let avatarId: string;
  if (existingAvatar.rows.length > 0) {
    avatarId = existingAvatar.rows[0].id as string;
  } else {
    const avatarInsert = await pool.query(
      `INSERT INTO cartesia_avatars (customer_id, name, description, voice_id, model_id, is_default, is_active)
       VALUES ($1, $2, $3, $4, $5, TRUE, TRUE) RETURNING id`,
      [customerId, "Temp Test Voice", "Temporary voice for the Cartesia test console", voiceId, modelId]
    );
    avatarId = avatarInsert.rows[0].id as string;
  }
  console.log(`Cartesia avatar ready: ${avatarId}`);

  const existingAgent = await pool.query(
    `SELECT id FROM agents WHERE customer_id = $1 LIMIT 1`,
    [customerId]
  );
  let agentId: string;
  if (existingAgent.rows.length > 0) {
    agentId = existingAgent.rows[0].id as string;
    await pool.query(
      `UPDATE agents SET cartesia_avatar_id = $1, is_active = TRUE WHERE id = $2`,
      [avatarId, agentId]
    );
  } else {
    const agentInsert = await pool.query(
      `INSERT INTO agents (customer_id, name, description, system_prompt, is_active, cartesia_avatar_id)
       VALUES ($1, $2, $3, $4, TRUE, $5) RETURNING id`,
      [
        customerId,
        "Temp Test Agent",
        "Temporary agent for the Cartesia voice test console",
        SYSTEM_PROMPT,
        avatarId,
      ]
    );
    agentId = agentInsert.rows[0].id as string;
  }
  console.log(`Agent ready: ${agentId}`);

  const kbCount = await pool.query(`SELECT COUNT(*)::int AS n FROM kb_entries WHERE customer_id = $1`, [customerId]);
  if (kbCount.rows[0].n === 0) {
    console.log(`Embedding + inserting ${KB_ENTRIES.length} KB entries (real generateEmbedding() calls)...`);
    for (const entry of KB_ENTRIES) {
      const embedding = await generateEmbedding(entry.question);
      const embeddingStr = `[${embedding.join(",")}]`;
      await pool.query(
        `INSERT INTO kb_entries (customer_id, question, answer, embedding) VALUES ($1, $2, $3, $4)`,
        [customerId, entry.question, entry.answer, embeddingStr]
      );
    }
    console.log("KB entries inserted.");
  } else {
    console.log(`KB entries already exist (${kbCount.rows[0].n}) — skipping.`);
  }

  const existingKey = await pool.query(
    `SELECT key FROM api_keys WHERE customer_id = $1 AND is_active = TRUE LIMIT 1`,
    [customerId]
  );
  let apiKey: string;
  if (existingKey.rows.length > 0) {
    apiKey = existingKey.rows[0].key as string;
  } else {
    apiKey = `temp_test_${crypto.randomBytes(24).toString("hex")}`;
    await pool.query(
      `INSERT INTO api_keys (customer_id, key, is_active) VALUES ($1, $2, TRUE)`,
      [customerId, apiKey]
    );
  }

  console.log("\n=== Temp voice test console ready ===");
  console.log(`customer_id: ${customerId}`);
  console.log(`agent_id:    ${agentId}`);
  console.log(`api_key:     ${apiKey}`);
  console.log(`voice_id:    ${voiceId} (model ${modelId})`);
  console.log("Page: GET /voice/cartesia-test-console (config auto-resolved server-side by marker name)");

  await pool.end();
}

main().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
