// ============================================================
// Mid-call CRM tool calling (docs/CRM_TOOL_CALLING_PLAN_2026-11-05.md, goal 2:
// fetch data mid-conversation). Shared by Vodafone (via runAskPipeline) and
// Exotel (exotel-voicebot.ts runVoicebotAskPipeline).
//
// Two tool sources, both read straight from the SaaS tables on the shared DB:
//   - native Convixx CRM (crm_settings.provider = 'native' and records exist):
//     one read tool, crm_lookup_customer, matched on the caller's last 10
//     digits (same convention as the SaaS CallSync and engine number routing);
//   - custom CRM API tools (crm_tools, status='verified' AND is_active), the
//     customer's own endpoints defined in the SaaS tool builder (p7-p20):
//     URL/headers/body {{placeholders}} bound through param_map
//     (caller_phone | conversation | record_field | static), auth from
//     auth_type + the Laravel-encrypted secret, output reduced through
//     response_map.
// Plus the optional per-customer tool_calling_prompt (customer_settings),
// which tells the model WHEN to call tools.
//
// A tenant with neither native records nor active custom tools gets `null`
// from loadCallToolset(): every call path is then byte-identical to before.
// ============================================================

import crypto from "crypto";
import dns from "dns/promises";
import net from "net";
import type OpenAI from "openai";
import { pool } from "../../config/db";
import { env } from "../../config/env";
import { getCustomerSettings } from "../customer-settings";
import { decryptLaravelString } from "./laravel-crypt";

export type ToolDef = OpenAI.Chat.ChatCompletionTool;

export interface CallToolContext {
  customerId: string;
  /** The customer on the line (inbound: caller; outbound: the lead). Any format. */
  customerPhone: string | null;
  callId?: string | null;
  /** What the caller said this turn, and the bot's previous line: the write-confirmation guard. */
  userUtterance?: string | null;
  lastAssistantMessage?: string | null;
  log?: { info: (o: object, m: string) => void; warn: (o: object, m: string) => void };
}

interface CustomToolRow {
  id: string;
  company_id: string;
  title: string;
  description: string | null;
  condition: string | null;
  method: string;
  url: string;
  headers: Record<string, string> | null;
  body_template: string | null;
  auth_type: string;
  secret: string | null;
  has_secret: boolean;
  param_map: Record<string, string> | null;
  response_map: Record<string, string> | null;
}

export interface CallToolset {
  companyId: string;
  tools: ToolDef[];
  /** Appended to the system prompt: default tool rules + the customer's tool_calling_prompt. */
  promptBlock: string;
  /** Runs one tool call; never throws (errors come back as {error}). */
  execute: (name: string, argsJson: string, ctx: CallToolContext) => Promise<ToolExecution>;
  /**
   * True for tools that only READ data (native lookup, custom GET/HEAD). The
   * "please hold" line is spoken only when a read tool runs; write tools
   * (custom POST/PUT/PATCH/DELETE) run without it (product rule 2026-11-05).
   */
  isReadTool: (name: string) => boolean;
  /** SAVE tools (fire-and-forget capture): the reply never waits on their result. */
  isSilentTool: (name: string) => boolean;
  summary: { native: boolean; custom: string[] };
  /**
   * LIVE CAPTURE (2026-11-28): the tenant has SAVE tools. Voice routes that
   * pass `liveCapture` to runAskPipeline call `captureFromConversation` after
   * every caller turn (background, never awaited by the reply); the answering
   * model then gets `liveTools` / `livePromptBlock` (no SAVE tools), so a save
   * never costs the caller an extra LLM round (~1 s seen on 2026-11-28).
   */
  hasLiveCapture: boolean;
  liveTools: ToolDef[];
  livePromptBlock: string;
  captureFromConversation: (getLines: () => CaptureLine[], ctx: CallToolContext) => void;
  /** QA: the fields live capture would extract from the customer lines from `fromIndex` on, per SAVE tool. Sends nothing. */
  previewCapture: (
    lines: CaptureLine[],
    fromIndex: number,
    saved: Record<string, string>
  ) => Promise<Record<string, Record<string, string>>>;
}

/** One line of the call, for live capture. */
export interface CaptureLine {
  role: "bot" | "customer";
  text: string;
  /** Language the speech-to-text heard on a customer line (BCP-47, e.g. mr-IN). */
  lang?: string | null;
}

export interface ToolExecution {
  name: string;
  ok: boolean;
  latencyMs: number;
  /** JSON string handed back to the model as the tool message content. */
  content: string;
}

const NATIVE_TOOL = "crm_lookup_customer";
const TOOL_TIMEOUT_MS = Number(process.env.CRM_TOOL_TIMEOUT_MS || 4000);
const MAX_TOOL_OUTPUT_CHARS = 2000;
const CACHE_TTL_MS = 60_000;

const toolsetCache = new Map<string, { at: number; value: CallToolset | null }>();

export function invalidateToolsetCache(customerId?: string): void {
  if (customerId) toolsetCache.delete(customerId);
  else toolsetCache.clear();
}

// ---------- phone helpers ----------

function last10(phone: string | null | undefined): string {
  return String(phone ?? "").replace(/\D/g, "").slice(-10);
}

/** "+91XXXXXXXXXX" for a 10-digit Indian number, else "+<digits>". */
function e164ish(phone: string | null | undefined): string {
  const d = String(phone ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.length === 10) return `+91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `+91${d.slice(1)}`;
  return `+${d}`;
}

// ---------- prompt ----------

const DEFAULT_TOOL_RULES = `--- LIVE DATA TOOLS ---
You can call tools to fetch live data about THIS caller and their account (CRM record, orders, bookings, payments, tickets, etc.).
- Call a tool only when the caller asks for something specific to them or their account that the KNOWLEDGEBASE cannot answer. Do NOT call tools for general questions the KNOWLEDGEBASE answers.
- The caller is already being asked to hold while a tool runs: never mention tools, systems or "checking the CRM" yourself.
- Data returned by a tool is authoritative for this caller and may be used together with the KNOWLEDGEBASE. Use ONLY the values the tool returned; never invent or guess values.
- If a tool returns found=false or an error, say briefly that you could not find it right now and offer to help another way.
- Do not read out internal IDs, full phone numbers or emails unless the caller asks for them.
- SAVE tools (marked "SAVE / UPDATE": they record what the caller tells you, e.g. save lead, update record, add note) are silent and continuous: call one as soon as the caller gives the FIRST useful answer, then call it again every time they give a new or corrected answer, each time with everything known so far. Never ask permission to save, never read the details back to confirm a save, and never mention saving, noting or the CRM. Keep the conversation going in the same reply.
- ACTION tools (marked "ACTION": they book, schedule, cancel or pay for something) need the caller's confirmation ONCE: repeat the exact details, ask "shall I go ahead?", and call the tool only after a clear yes. Never ask for confirmation again in this call for something already confirmed; a correction the caller makes afterwards is sent without asking again.
- A tool result of submitted=true means it has been sent: treat it as done and move on.
- Keep the reply short and spoken, in the call's current language.`;

const LIVE_CAPTURE_RULES = `--- CUSTOMER DETAILS ---
Everything the customer tells you (interest, name, visit day/time, budget, preferences...) is recorded automatically in the background from this conversation. You have no save tool and nothing to call for it.
- Just follow your call flow: ask your next question in the same reply.
- Never say you are saving, noting or updating anything, never mention a CRM or system, and never read the customer's details back only to confirm them.
- The phone number is already known: never ask for it or read it aloud.`;

/** Prompt block when SAVE tools are replaced by live capture (any remaining READ/ACTION tools keep their rules). */
function buildLivePromptBlock(hasOtherTools: boolean): string {
  return hasOtherTools ? `${DEFAULT_TOOL_RULES}\n\n${LIVE_CAPTURE_RULES}` : LIVE_CAPTURE_RULES;
}

function buildPromptBlock(customerPrompt: string | null | undefined): string {
  const extra = String(customerPrompt ?? "").trim();
  return extra
    ? `${DEFAULT_TOOL_RULES}\n\nCustomer instructions for when to use tools (follow these):\n${extra}`
    : DEFAULT_TOOL_RULES;
}

// ---------- registry ----------

export async function loadCallToolset(customerId: string): Promise<CallToolset | null> {
  const cached = toolsetCache.get(customerId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.value;
  let value: CallToolset | null = null;
  try {
    value = await buildToolset(customerId);
  } catch {
    // SaaS tables missing / query error: behave exactly as if no tools exist.
    value = null;
  }
  toolsetCache.set(customerId, { at: Date.now(), value });
  return value;
}

async function buildToolset(customerId: string): Promise<CallToolset | null> {
  const cs = await getCustomerSettings(customerId);
  const settings = cs as unknown as { tool_calling_enabled?: boolean; tool_calling_prompt?: string | null } | null;
  if (settings?.tool_calling_enabled === false) return null;

  const companyRes = await pool.query(
    `SELECT c.id::text AS id, s.provider
       FROM companies c LEFT JOIN crm_settings s ON s.company_id = c.id
      WHERE c.engine_customer_id = $1
      LIMIT 1`,
    [customerId]
  );
  const company = companyRes.rows[0] as { id: string; provider: string | null } | undefined;
  if (!company) return null;

  const [nativeRes, customRes] = await Promise.all([
    company.provider === "native"
      ? pool.query(`SELECT 1 FROM crm_records WHERE company_id = $1 AND deleted_at IS NULL LIMIT 1`, [company.id])
      : Promise.resolve({ rows: [] as unknown[] }),
    pool.query(
      `SELECT id::text, company_id::text, title, description, condition, method, url, headers, body_template,
              auth_type, secret, has_secret, param_map, response_map
         FROM crm_tools
        WHERE company_id = $1 AND is_active = TRUE AND status = 'verified' AND deleted_at IS NULL
        ORDER BY id`,
      [company.id]
    ),
  ]);
  const native = nativeRes.rows.length > 0;
  const customRows = customRes.rows as CustomToolRow[];
  if (!native && customRows.length === 0) return null;

  const tools: ToolDef[] = [];
  const customByName = new Map<string, CustomToolRow>();
  const captureTools: { name: string; row: CustomToolRow; fields: string[] }[] = [];

  if (native) {
    tools.push({
      type: "function",
      function: {
        name: NATIVE_TOOL,
        description:
          "Look up the caller in the company's CRM: their profile, status/stage, custom fields, records such as orders or bookings, and recent activity. Use when the caller asks about their own account, order, booking, status or history.",
        parameters: {
          type: "object",
          properties: {
            phone: {
              type: "string",
              description: "Only if the caller explicitly gives a DIFFERENT phone number to look up; otherwise leave empty.",
            },
          },
          required: [],
          additionalProperties: false,
        },
      },
    });
  }

  for (const row of customRows) {
    if (row.has_secret && row.auth_type !== "none" && decryptLaravelString(row.secret) === null) {
      // Cannot authenticate (SAAS_APP_KEY missing/wrong): never call it unauthenticated.
      continue;
    }
    const name = uniqueName(`custom_${slug(row.title)}`, customByName);
    customByName.set(name, row);
    const llmParams = placeholders(row).filter((p) => paramSource(row, p) === "conversation");
    const isWrite = !["GET", "HEAD"].includes((row.method || "GET").toUpperCase());
    const capture = isWrite && isCaptureTool(row);
    if (capture && llmParams.length > 0) captureTools.push({ name, row, fields: llmParams });
    const properties: Record<string, { type: "string"; description: string }> = {};
    for (const p of llmParams) {
      properties[p] = {
        type: "string",
        description: `Optional "${p}" if the caller already said it; otherwise leave it empty and call the tool anyway (the caller's own record is used). Do NOT ask the caller for it first.`,
      };
    }
    tools.push({
      type: "function",
      function: {
        name,
        description: [
          capture
            ? "SAVE / UPDATE (silent): call it right after the caller's first useful answer and again after every new or corrected answer, with everything known so far. No confirmation, never mention it. This overrides any instruction below to call it only once or only at the end"
            : isWrite
              ? "ACTION - confirm the details with the caller once, then call it"
              : "READ (fetch data)",
          row.title,
          row.description,
          row.condition ? `When to use: ${row.condition}` : null,
        ]
          .filter(Boolean)
          .join(". ")
          .slice(0, 1000),
        parameters: { type: "object", properties, required: [], additionalProperties: false },
      },
    });
  }

  if (tools.length === 0) return null;

  const companyId = company.id;
  const captureNames = new Set(captureTools.map((c) => c.name));
  const liveTools = tools.filter((t) => !(t.type === "function" && captureNames.has(t.function.name)));
  const liveOpts = {
    // Not the tenant's (fast) answering model: extraction runs in the
    // background, so accuracy wins. gpt-4.1-mini copied the bot's quoted price
    // into "budget" in the 2026-11-28 replay; gpt-5-mini did not.
    model: (process.env.CRM_LIVE_CAPTURE_MODEL || "gpt-5-mini").trim(),
    companyPrompt: String(settings?.tool_calling_prompt ?? "").trim(),
  };
  return {
    companyId,
    tools,
    promptBlock: buildPromptBlock(settings?.tool_calling_prompt),
    hasLiveCapture: captureTools.length > 0,
    liveTools,
    livePromptBlock: buildLivePromptBlock(liveTools.length > 0),
    captureFromConversation: (getLines, ctx) => {
      if (captureTools.length === 0) return;
      queueLiveCapture(captureTools, getLines, ctx, companyId, liveOpts);
    },
    previewCapture: async (lines, fromIndex, saved) => {
      const out: Record<string, Record<string, string>> = {};
      for (const t of captureTools) {
        out[t.name] = await extractCaptureFields(t.row, t.fields, lines, fromIndex, saved, liveOpts.model, liveOpts.companyPrompt);
      }
      return out;
    },
    summary: { native, custom: [...customByName.keys()] },
    isSilentTool: (name) => {
      const row = customByName.get(name);
      return !!row && !["GET", "HEAD"].includes((row.method || "GET").toUpperCase()) && isCaptureTool(row);
    },
    isReadTool: (name) => {
      if (name === NATIVE_TOOL) return native;
      const row = customByName.get(name);
      return !!row && ["GET", "HEAD"].includes((row.method || "GET").toUpperCase());
    },
    execute: async (name, argsJson, ctx) => {
      const t0 = Date.now();
      let args: Record<string, unknown> = {};
      try {
        args = argsJson ? (JSON.parse(argsJson) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      try {
        let content: string;
        if (name === NATIVE_TOOL && native) {
          content = JSON.stringify(await nativeLookup(companyId, String(args.phone || "") || ctx.customerPhone));
        } else if (customByName.has(name)) {
          const row = customByName.get(name)!;
          const isWrite = !["GET", "HEAD"].includes((row.method || "GET").toUpperCase());
          const callKey = `${ctx.customerId}|${ctx.callId || "-"}|${name}`;
          if (!isWrite) {
            content = await runCustomTool(row, args, ctx, companyId);
          } else if (isCaptureTool(row)) {
            content = submitCapture(row, args, ctx, companyId, callKey, name);
          } else {
            const st = callWriteState(callKey);
            const argKey = normalizeArgs(args);
            if (!st.confirmed && !callerConfirmed(ctx)) {
              // Hard guard (the prompt rule alone is not reliable): an action
              // runs only after the caller clearly said yes, once per call.
              ctx.log?.info({ tool: name }, "crm-tools: action blocked until the caller confirms (once per call)");
              content = JSON.stringify({
                not_executed: true,
                needs_confirmation: true,
                instruction: "Do NOT say it is done. Repeat the exact details to the caller and ask them to confirm once. It will be executed after they say yes.",
              });
            } else if (st.sentArgs.has(argKey)) {
              // The very same request was already sent in this call: never twice.
              content = JSON.stringify({ already_done: true });
            } else {
              st.confirmed = true; // confirmation is asked only once per call
              st.sentArgs.add(argKey);
              content = submitWriteInBackground(row, args, ctx, companyId, () => st.sentArgs.delete(argKey));
            }
          }
        } else {
          content = JSON.stringify({ error: "unknown_tool" });
        }
        return { name, ok: !content.startsWith('{"error"'), latencyMs: Date.now() - t0, content: clip(content) };
      } catch (err) {
        ctx.log?.warn({ err: String(err), tool: name }, "crm-tools: tool execution failed");
        return { name, ok: false, latencyMs: Date.now() - t0, content: JSON.stringify({ error: "unavailable" }) };
      }
    },
  };
}

// ---------- writes (fire-and-forget) ----------
//
// Product rules (2026-11-06/07): writes never make the caller wait; SAVE
// tools (lead capture, record updates, notes) run silently after every new
// answer with only what changed; ACTION tools (bookings, cancellations) are
// confirmed once per call. All writes of one tool in one call are sent in
// order (the first save creates the lead, later ones update it, never two
// creates racing each other).

const CALL_STATE_TTL_MS = 30 * 60_000;

interface CallWriteState {
  at: number;
  /** ACTION tools: the caller already confirmed once in this call. */
  confirmed: boolean;
  /** ACTION tools: normalized args already sent (exact repeats are dropped). */
  sentArgs: Set<string>;
  /** SAVE tools: last value sent per conversation field. */
  sent: Record<string, string>;
  /** Serializes this tool's background requests for this call. */
  chain: Promise<unknown>;
}
const callWrites = new Map<string, CallWriteState>();

function callWriteState(key: string): CallWriteState {
  let st = callWrites.get(key);
  if (!st) {
    st = { at: Date.now(), confirmed: false, sentArgs: new Set(), sent: {}, chain: Promise.resolve() };
    callWrites.set(key, st);
    if (callWrites.size > 500) {
      const cutoff = Date.now() - CALL_STATE_TTL_MS;
      for (const [k, v] of callWrites) if (v.at < cutoff) callWrites.delete(k);
    }
  }
  st.at = Date.now();
  return st;
}

/**
 * SAVE tools record what the caller says (the SaaS "Save lead" capture hook,
 * or any write titled save / update / note / log / capture / record), as
 * opposed to ACTION tools that do something (book, cancel, pay).
 */
export function isCaptureTool(row: { url: string; title: string }): boolean {
  if (/\/hooks\/crm\/[^/]+\/leads\//.test(row.url || "")) return true;
  return /\b(save|saves|capture|update|updates|note|notes|log|record|lead)\b/i.test(row.title || "");
}

function sameValue(a: string, b: string): boolean {
  const n = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  return n(a) === n(b);
}

const EMPTY_VALUES = new Set(["", "null", "none", "n/a", "na", "unknown", "-", "not provided", "not mentioned"]);

/**
 * SAVE tool call: sends only the fields that are new or changed since the
 * last save in this call (the capture hook keeps the rest), in order, in the
 * background. Nothing new: nothing is sent.
 */
function submitCapture(
  row: CustomToolRow,
  args: Record<string, unknown>,
  ctx: CallToolContext,
  companyId: string,
  callKey: string,
  name: string
): string {
  const st = callWriteState(callKey);
  const needsPhone = placeholders(row).some((p) => paramSource(row, p) === "caller_phone");
  if (needsPhone && last10(ctx.customerPhone).length < 10) {
    ctx.log?.warn({ tool: name }, "crm-tools: save skipped, the customer's number is not known on this call");
    return JSON.stringify({ submitted: false, reason: "customer_number_unknown", instruction: "Continue the conversation normally." });
  }
  const changed: Record<string, unknown> = {};
  const changedKeys: string[] = [];
  for (const [k, v] of Object.entries(args)) {
    const val = String(v ?? "").trim();
    if (EMPTY_VALUES.has(val.toLowerCase())) continue;
    // Same value up to case/punctuation ("3-4 pm" vs ", 3-4 PM"): not resent.
    if (st.sent[k] !== undefined && sameValue(st.sent[k], val)) continue;
    changed[k] = val;
    changedKeys.push(k);
  }
  if (changedKeys.length === 0) {
    return JSON.stringify({ submitted: true, unchanged: true, instruction: "Already saved. Continue the conversation; do not mention it." });
  }
  const previous: Record<string, string | undefined> = {};
  for (const k of changedKeys) {
    previous[k] = st.sent[k];
    st.sent[k] = String(changed[k]);
  }
  const revert = () => {
    for (const k of changedKeys) {
      if (st.sent[k] !== String(changed[k])) continue;
      if (previous[k] === undefined) delete st.sent[k];
      else st.sent[k] = previous[k] as string;
    }
  };
  ctx.log?.info({ tool: name, fields: changedKeys }, "crm-tools: save queued (background)");
  st.chain = st.chain
    .then(() => runCustomTool(row, changed, ctx, companyId))
    .then((result) => {
      if (result.startsWith('{"error"')) {
        revert(); // resent with the next save
        ctx.log?.warn({ tool: row.title, result: result.slice(0, 300) }, "crm-tools: background save failed");
      }
    })
    .catch((err) => {
      revert();
      ctx.log?.warn({ err: String(err), tool: row.title }, "crm-tools: background save failed");
    });
  return JSON.stringify({
    submitted: true,
    instruction: "Saved in the background. Do not mention saving or ask to confirm; continue the conversation.",
  });
}

/**
 * ACTION tool call, sent in the background (the caller never waits on the
 * customer's API). The run is logged in crm_tool_runs; onFail lets the same
 * request be sent again later.
 */
function submitWriteInBackground(
  row: CustomToolRow,
  args: Record<string, unknown>,
  ctx: CallToolContext,
  companyId: string,
  onFail: () => void
): string {
  const st = callWriteState(`${ctx.customerId}|${ctx.callId || "-"}|${row.id}#action`);
  st.chain = st.chain
    .then(() => runCustomTool(row, args, ctx, companyId))
    .then((result) => {
      if (result.startsWith('{"error"')) {
        onFail();
        ctx.log?.warn({ tool: row.title, result: result.slice(0, 300) }, "crm-tools: background write failed");
      }
    })
    .catch((err) => {
      onFail();
      ctx.log?.warn({ err: String(err), tool: row.title }, "crm-tools: background write failed");
    });
  return JSON.stringify({
    submitted: true,
    instruction: "The request has been sent. Briefly confirm to the caller that it is done, then continue. Do not say you are waiting or checking.",
  });
}

// ---------- live capture (background extraction after every caller turn) ----------
//
// User rule 2026-11-28: whatever the bot learns on the call (interest first,
// then name, visit time, any other field) goes to the CRM in real time,
// without delaying or disturbing the call. The answering model proved
// unreliable at calling the SAVE tool (one save in an 8-turn call; the visit
// time was never saved) and each save cost the reply an extra LLM round. So a
// separate small LLM request reads the conversation after every caller turn,
// returns the tool's fields, and submitCapture sends only what changed. Runs
// one at a time per call; a turn that arrives meanwhile re-runs it once with
// the latest conversation.

const LIVE_MAX_LINES = 40;
const LIVE_TIMEOUT_MS = 20_000;

interface LiveRun {
  at: number;
  running: boolean;
  again: boolean;
  phoneWarned: boolean;
  /** Per SAVE tool: conversation lines already handled (only newer customer lines are read). */
  done: Record<string, number>;
}
const liveRuns = new Map<string, LiveRun>();

function liveGenerationParams(model: string, maxTokens: number): Record<string, unknown> {
  if (/^gpt-6/i.test(model)) return { max_completion_tokens: maxTokens, reasoning_effort: "none" };
  if (/^gpt-5/i.test(model)) return { max_completion_tokens: maxTokens + 400, reasoning_effort: "minimal" };
  return { max_tokens: maxTokens, temperature: 0 };
}

const LANGUAGE_NAMES: Record<string, string> = {
  mr: "Marathi", hi: "Hindi", en: "English", gu: "Gujarati", ta: "Tamil", te: "Telugu",
  kn: "Kannada", ml: "Malayalam", bn: "Bengali", pa: "Punjabi", or: "Odia",
};
function languageName(tag: string): string {
  return LANGUAGE_NAMES[tag.toLowerCase().split(/[-_]/)[0]] ?? tag;
}

function istToday(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  const day = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][d.getUTCDay()];
  return `${d.toISOString().slice(0, 10)} (${day})`;
}

function liveCaptureSystemPrompt(row: CustomToolRow, fields: string[], companyPrompt: string): string {
  return [
    "You keep a CRM lead record up to date DURING a live phone call between BOT (calling for the company) and CUSTOMER.",
    "The lines are numbered. You get the conversation, the values already saved, and which CUSTOMER lines are NEW.",
    "Return only the fields that the NEW customer lines give or change.",
    "",
    'Output JSON: {"fields": {"<key>": {"value": "<value>", "line": <number of the NEW CUSTOMER line it comes from>}}}. Nothing new: {"fields": {}}.',
    "",
    "Rules:",
    "- A value must come from what the CUSTOMER said in that line, read together with the BOT line just before it: a short answer ('yes', 'tomorrow', '3 to 4', a name) answers the bot's question before it.",
    "- A yes only gives what that exact bot question asked (yes to 'would you like to visit?' = interested in a visit; it says nothing about budget, purpose or anything else).",
    "- What the BOT said is never a customer value: a price, size, place or offer the bot mentioned is NOT the customer's budget or preference.",
    "- Never guess or fill a field 'by default'. Free text holds the real detail, never filler such as 'Visit planned' or 'Interested'. notes only for an extra detail the customer really said.",
    "- A plan, time or date field (visit, callback...) holds only a day or time the customer gave for THAT thing: leave it out until a day or time is given. A visit time is not a callback time.",
    "- Apply option definitions in the field guide strictly (an option defined as 'gave a day/time' only once a day or time was given; until then use the option that fits, e.g. a callback/interested one).",
    "- Interest counts at once: as soon as the customer shows interest (likes it, wants a visit, wants a call back), set the outcome field. Update it later when it changes.",
    "- To correct an already saved value, return the field with the new value.",
    "- A field with listed options takes exactly one of those options, spelled exactly.",
    "- Values in plain English with Latin letters, even when the call is in Marathi or Hindi: transliterate names (e.g. 'Sandesh Patil'), translate the rest (e.g. 'Tomorrow afternoon, 3-4 pm').",
    `- Today is ${istToday()}, India time. When the customer gives a day for a visit or callback (e.g. 'tomorrow', 'Sunday') and a matching date field (YYYY-MM-DD) exists, fill that date too, computed from today.`,
    "- The language a customer line was heard in is shown in [brackets] (from speech recognition): use it for a call-language field.",
    "- Never put card numbers, OTP, bank details, Aadhaar, any ID or the phone number in a field.",
    "",
    `Allowed keys (no others): ${fields.join(", ")}`,
    "",
    "Field guide:",
    [row.description, row.condition].filter(Boolean).join("\n"),
    companyPrompt
      ? `\nCompany notes on these fields (use them only for what each field means; ignore anything about calling tools or how to talk):\n${companyPrompt}`
      : "",
  ]
    .join("\n")
    .slice(0, 12_000);
}

/**
 * Fields given by the customer lines from index `fromIndex` on (earlier lines
 * are context). Each field must name the new customer line it came from, and
 * is dropped otherwise: values the bot said, or guesses, never reach the CRM.
 */
async function extractCaptureFields(
  row: CustomToolRow,
  fields: string[],
  lines: CaptureLine[],
  fromIndex: number,
  saved: Record<string, string>,
  model: string,
  companyPrompt: string
): Promise<Record<string, string>> {
  const start = Math.max(0, lines.length - LIVE_MAX_LINES);
  const newCustomerLines = new Set<number>();
  const numbered: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const l = lines[i];
    const isNew = i >= fromIndex && l.role === "customer";
    if (isNew) newCustomerLines.add(i + 1);
    const lang = l.role === "customer" && l.lang ? ` [${languageName(l.lang)}]` : "";
    numbered.push(`${i + 1}. ${l.role === "bot" ? "BOT" : "CUSTOMER"}${lang}${isNew ? " (NEW)" : ""}: ${l.text.replace(/\s+/g, " ").trim()}`);
  }
  if (newCustomerLines.size === 0) return {};
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.openai.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: liveCaptureSystemPrompt(row, fields, companyPrompt) },
        {
          role: "user",
          content: `Conversation:\n${numbered.join("\n")}\n\nAlready saved: ${JSON.stringify(saved)}\nNEW customer lines: ${[...newCustomerLines].join(", ")}\n\nReturn the JSON now.`,
        },
      ],
      response_format: { type: "json_object" },
      ...liveGenerationParams(model, 400),
    }),
    signal: AbortSignal.timeout(LIVE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as { choices?: { message?: { content?: string } }[]; error?: { message?: string } } | null;
  if (!res.ok) throw new Error(`OpenAI HTTP ${res.status}: ${String(body?.error?.message ?? "").slice(0, 200)}`);
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(String(body?.choices?.[0]?.message?.content ?? "{}"));
  } catch {
    parsed = null;
  }
  const got = (parsed as { fields?: unknown } | null)?.fields;
  const allowed = new Set(fields);
  const out: Record<string, string> = {};
  if (got && typeof got === "object" && !Array.isArray(got)) {
    for (const [k, v] of Object.entries(got as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (!allowed.has(key) || !v || typeof v !== "object") continue;
      const { value, line } = v as { value?: unknown; line?: unknown };
      if (!newCustomerLines.has(Number(line))) continue; // no evidence in a new customer line
      if (value === null || value === undefined || typeof value === "object") continue;
      const val = String(value).trim();
      if (val && !EMPTY_VALUES.has(val.toLowerCase())) out[key] = val.slice(0, 200);
    }
  }
  return out;
}

function queueLiveCapture(
  captureTools: { name: string; row: CustomToolRow; fields: string[] }[],
  getLines: () => CaptureLine[],
  ctx: CallToolContext,
  companyId: string,
  opts: { model: string; companyPrompt: string }
): void {
  const key = `${ctx.customerId}|${ctx.callId || "-"}|live`;
  let run = liveRuns.get(key);
  if (!run) {
    run = { at: Date.now(), running: false, again: false, phoneWarned: false, done: {} };
    liveRuns.set(key, run);
    if (liveRuns.size > 500) {
      const cutoff = Date.now() - CALL_STATE_TTL_MS;
      for (const [k, v] of liveRuns) if (v.at < cutoff && !v.running) liveRuns.delete(k);
    }
  }
  run.at = Date.now();
  if (run.running) {
    run.again = true; // re-run once with the newest lines when this one ends
    return;
  }
  const r = run;
  r.running = true;
  void (async () => {
    try {
      do {
        r.again = false;
        const lines = getLines().slice();
        for (const t of captureTools) {
          const needsPhone = placeholders(t.row).some((p) => paramSource(t.row, p) === "caller_phone");
          if (needsPhone && last10(ctx.customerPhone).length < 10) {
            if (!r.phoneWarned) {
              r.phoneWarned = true;
              ctx.log?.warn({ tool: t.name }, "crm-tools: live capture off for this call, the customer's number is not known");
            }
            continue;
          }
          const from = r.done[t.name] ?? 0;
          if (!lines.slice(from).some((l) => l.role === "customer" && l.text.trim().length > 1)) continue;
          const callKey = `${ctx.customerId}|${ctx.callId || "-"}|${t.name}`;
          const t0 = Date.now();
          try {
            const saved = { ...callWriteState(callKey).sent };
            const values = await extractCaptureFields(t.row, t.fields, lines, from, saved, opts.model, opts.companyPrompt);
            r.done[t.name] = lines.length; // these lines are handled (a failure leaves them for the next run)
            if (Object.keys(values).length === 0) continue;
            const result = submitCapture(t.row, values, ctx, companyId, callKey, t.name);
            ctx.log?.info(
              { tool: t.name, extractMs: Date.now() - t0, values, unchanged: result.includes('"unchanged":true') },
              "crm-tools: live capture"
            );
          } catch (err) {
            ctx.log?.warn({ err: String(err), tool: t.name }, "crm-tools: live capture extraction failed (the next turn retries)");
          }
        }
      } while (r.again);
    } finally {
      r.running = false;
    }
  })();
}

const YES_RE = new RegExp(
  [
    "\\b(yes|yeah|yep|yup|sure|ok|okay|okey|confirm|confirmed|correct|right|go ahead|please do|do it|book it|fine|perfect|absolutely|definitely)\\b",
    "\\b(haan|han|haa|ha ji|haanji|ji haan|ji|theek hai|thik hai|theek|bilkul|zaroor|kar do|kardo|ho|hoy|chalel|chalega|barobar|nakki)\\b",
    "(\u0939\u093e\u0901|\u0939\u093e\u0902|\u0939\u093e\u0928|\u091c\u0940|\u0920\u0940\u0915|\u092c\u093f\u0932\u094d\u0915\u0941\u0932|\u091c\u093c\u0930\u0942\u0930|\u0939\u094b|\u0939\u094b\u092f|\u091a\u093e\u0932\u0947\u0932|\u092c\u0930\u094b\u092c\u0930|\u0928\u0915\u094d\u0915\u0940|\u0939\u093e)",
    "(\u0b86\u0bae\u0bcd|\u0c05\u0c35\u0c41\u0c28\u0c41|\u0cb9\u0ccc\u0ca6\u0cc1|\u0cb9\u0ccc|\u0d36\u0d30\u0d3f|\u0a39\u0a3e\u0a02|\u0aa8\u0abe|\u0ab9\u0abe|\u09b9\u09cd\u09af\u09be\u0981)",
  ].join("|"),
  "i"
);
const NO_RE = /\b(no|nope|not now|don't|do not|cancel|wait|nahi|nahin|mat|nako|nai)\b|(\u0928\u0939\u0940\u0902|\u0928\u0939\u0940|\u092e\u0924|\u0928\u0915\u094b|\u0928\u093e\u0939\u0940)/i;

/** The bot's previous line asked something and the caller's reply is an affirmative (and not a refusal). */
function callerConfirmed(ctx: CallToolContext): boolean {
  const said = String(ctx.userUtterance ?? "").trim();
  const asked = String(ctx.lastAssistantMessage ?? "");
  if (!said || !/[?\uff1f]/.test(asked)) return false;
  return YES_RE.test(said) && !NO_RE.test(said);
}
function normalizeArgs(args: Record<string, unknown>): string {
  return JSON.stringify(
    Object.keys(args)
      .sort()
      .map((k) => [k, String(args[k] ?? "").trim().toLowerCase().replace(/\s+/g, " ")])
  );
}

/**
 * Heuristic: is this question about the caller's OWN data? Used to keep the
 * instant kb_direct answer for general questions on tool-enabled tenants
 * while personal ones ("where is my order", "mera plan") still reach the
 * model and its tools. English, Hinglish, Hindi and Marathi first-person forms.
 */
export function looksPersonalQuestion(q: string): boolean {
  const t = ` ${String(q || "").toLowerCase()} `;
  if (/\b(my|mine|me|i|i'm|our|mera|meri|mere|mujhe|mujhko|hamara|hamari|maza|majha|mazi|mazha|mala|amcha|amchi)\b/.test(t)) return true;
  if (/(मेरा|मेरी|मेरे|मुझे|हमारा|हमारी|माझा|माझी|माझे|मला|आमचा|आमची)/.test(t)) return true;
  return /\b(order|booking|account|plan|subscription|payment|invoice|refund|delivery|ticket|complaint|visit|appointment|status)\b/.test(t);
}

function slug(s: string): string {
  return (
    String(s || "tool")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 48) || "tool"
  );
}

function uniqueName(base: string, taken: Map<string, unknown>): string {
  let n = base.slice(0, 60);
  let i = 2;
  while (taken.has(n) || n === NATIVE_TOOL) n = `${base.slice(0, 57)}_${i++}`;
  return n;
}

function clip(s: string): string {
  return s.length <= MAX_TOOL_OUTPUT_CHARS ? s : s.slice(0, MAX_TOOL_OUTPUT_CHARS);
}

// ---------- native CRM ----------

async function nativeLookup(companyId: string, phone: string | null): Promise<Record<string, unknown>> {
  const key = last10(phone);
  if (key.length < 10) return { found: false, reason: "no_phone" };
  const rec = await pool.query(
    `SELECT id, type, full_name, email, company_name, city, stage, status, score, value,
            preferred_language, lifecycle, notes, last_call_at
       FROM crm_records
      WHERE company_id = $1 AND deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(phone_e164, phone, ''), '\\D', '', 'g'), 10) = $2
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 1`,
    [companyId, key]
  );
  const r = rec.rows[0];
  if (!r) return { found: false };

  const [fields, tables, acts] = await Promise.all([
    pool.query(
      `SELECT f.label, f.type, v.value_text, v.value_number, v.value_date
         FROM crm_field_values v JOIN crm_fields f ON f.id = v.crm_field_id AND f.deleted_at IS NULL
        WHERE v.crm_record_id = $1`,
      [r.id]
    ),
    pool.query(
      `SELECT t.name, t.columns, tr.data
         FROM crm_table_rows tr JOIN crm_tables t ON t.id = tr.crm_table_id AND t.deleted_at IS NULL
        WHERE tr.crm_record_id = $1 AND tr.deleted_at IS NULL
        ORDER BY t.position, tr.position DESC
        LIMIT 30`,
      [r.id]
    ),
    pool.query(
      `SELECT kind, summary, occurred_at FROM crm_activities WHERE crm_record_id = $1 ORDER BY occurred_at DESC LIMIT 3`,
      [r.id]
    ),
  ]);

  const customFields: Record<string, unknown> = {};
  for (const f of fields.rows) {
    const v = f.value_text ?? (f.value_number != null ? Number(f.value_number) : null) ?? f.value_date ?? null;
    if (v !== null && v !== "") customFields[f.label] = v instanceof Date ? v.toISOString().slice(0, 10) : v;
  }
  const tableData: Record<string, Record<string, unknown>[]> = {};
  for (const t of tables.rows) {
    const cols = Array.isArray(t.columns) ? (t.columns as { key?: string; label?: string }[]) : [];
    const labelOf = (k: string) => cols.find((c) => c.key === k)?.label || k;
    const row: Record<string, unknown> = {};
    for (const [k, v] of Object.entries((t.data ?? {}) as Record<string, unknown>)) row[labelOf(k)] = v;
    (tableData[t.name] ??= []).length < 5 && tableData[t.name].push(row);
  }

  return {
    found: true,
    name: r.full_name,
    type: r.type,
    stage: r.stage,
    status: r.status,
    score: r.score,
    value: r.value != null ? Number(r.value) : null,
    city: r.city,
    company: r.company_name,
    email_on_file: !!r.email,
    preferred_language: r.preferred_language,
    last_call_at: r.last_call_at ? new Date(r.last_call_at).toISOString() : null,
    notes: r.notes ? String(r.notes).slice(0, 300) : null,
    fields: customFields,
    records: tableData,
    recent_activity: acts.rows.map((a) => ({
      kind: a.kind,
      summary: a.summary,
      at: a.occurred_at ? new Date(a.occurred_at).toISOString().slice(0, 10) : null,
    })),
  };
}

/** Value of a record_field placeholder: core column or custom field key, from the native record. */
async function recordFieldValue(companyId: string, phone: string | null, field: string): Promise<string> {
  const key = last10(phone);
  if (key.length < 10) return "";
  const core = ["full_name", "email", "company_name", "city", "stage", "status", "reference", "phone"];
  const rec = await pool.query(
    `SELECT id, full_name, email, company_name, city, stage, status, reference, phone FROM crm_records
      WHERE company_id = $1 AND deleted_at IS NULL
        AND RIGHT(regexp_replace(COALESCE(phone_e164, phone, ''), '\\D', '', 'g'), 10) = $2
      ORDER BY updated_at DESC NULLS LAST LIMIT 1`,
    [companyId, key]
  );
  const r = rec.rows[0];
  if (!r) return "";
  const f = field === "name" ? "full_name" : field;
  if (core.includes(f)) return String(r[f] ?? "");
  const v = await pool.query(
    `SELECT COALESCE(v.value_text, v.value_number::text, v.value_date::text) AS v
       FROM crm_field_values v JOIN crm_fields fd ON fd.id = v.crm_field_id
      WHERE v.crm_record_id = $1 AND fd.key = $2 LIMIT 1`,
    [r.id, field]
  );
  return String(v.rows[0]?.v ?? "");
}

// ---------- custom CRM API tools ----------

const PLACEHOLDER_RE = /\{\{\s*([a-z0-9_.]+)\s*\}\}/gi;
const PHONE_PLACEHOLDERS = new Set(["phone", "caller_phone", "mobile", "msisdn", "phone_number", "customer_phone"]);

function placeholders(row: CustomToolRow): string[] {
  const hay = `${row.url} ${JSON.stringify(row.headers ?? {})} ${row.body_template ?? ""}`;
  const out = new Set<string>();
  for (const m of hay.matchAll(PLACEHOLDER_RE)) out.add(m[1].toLowerCase());
  return [...out];
}

function paramSource(row: CustomToolRow, p: string): string {
  const mapped = row.param_map?.[p] ?? row.param_map?.[p.toLowerCase()];
  if (mapped) return mapped;
  return PHONE_PLACEHOLDERS.has(p) ? "caller_phone" : "conversation";
}

async function runCustomTool(
  row: CustomToolRow,
  args: Record<string, unknown>,
  ctx: CallToolContext,
  companyId: string
): Promise<string> {
  const values: Record<string, string> = {};
  for (const p of placeholders(row)) {
    const src = paramSource(row, p);
    if (src === "caller_phone") values[p] = e164ish(ctx.customerPhone);
    else if (src === "record_field") values[p] = await recordFieldValue(companyId, ctx.customerPhone, p);
    else if (src === "static") values[p] = "";
    else values[p] = String(args[p] ?? "").slice(0, 200);
  }

  const fill = (s: string, mode: "url" | "json" | "text") =>
    s.replace(PLACEHOLDER_RE, (_m, name: string) => {
      const v = values[name.toLowerCase()] ?? "";
      if (mode === "url") return encodeURIComponent(v);
      if (mode === "json") return JSON.stringify(v).slice(1, -1);
      return v;
    });

  const url = fill(row.url, "url");
  const headers: Record<string, string> = { Accept: "application/json" };
  for (const [k, v] of Object.entries(row.headers ?? {})) headers[k] = fill(String(v), "text");
  const secret = row.has_secret ? decryptLaravelString(row.secret) : null;
  if (secret) {
    if (row.auth_type === "bearer") headers.Authorization = `Bearer ${secret}`;
    else if (row.auth_type === "api_key") headers["X-API-Key"] = secret;
    else if (row.auth_type === "basic") headers.Authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
  }
  const method = (row.method || "GET").toUpperCase();
  let body: string | undefined;
  if (method !== "GET" && method !== "HEAD" && row.body_template) {
    const tpl = row.body_template.trim();
    body = fill(row.body_template, tpl.startsWith("{") || tpl.startsWith("[") ? "json" : "text");
    if (!Object.keys(headers).some((h) => h.toLowerCase() === "content-type")) {
      headers["Content-Type"] = tpl.startsWith("{") || tpl.startsWith("[") ? "application/json" : "text/plain";
    }
  }

  const t0 = Date.now();
  let status: number | null = null;
  let decoded: unknown = null;
  let error: string | null = null;
  let runStatus: "ok" | "err" | "timeout" = "err";
  try {
    await assertSafeUrl(url);
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TOOL_TIMEOUT_MS);
    try {
      const res = await fetch(url, { method, headers, body, signal: ac.signal, redirect: "error" });
      status = res.status;
      const text = (await res.text()).slice(0, 64_000);
      try {
        decoded = JSON.parse(text);
      } catch {
        decoded = text.slice(0, 500);
      }
      runStatus = res.ok ? "ok" : "err";
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    runStatus = /abort/i.test(msg) ? "timeout" : "err";
    error = msg.slice(0, 300);
  }
  const latency = Date.now() - t0;

  void logToolRun(row, ctx, { url, method, headers, body }, runStatus, status, latency, decoded, error);
  ctx.log?.info(
    { tool: row.title, status: runStatus, httpStatus: status, latencyMs: latency },
    "crm-tools: custom tool executed"
  );

  if (runStatus !== "ok") {
    return JSON.stringify({ error: runStatus === "timeout" ? "timeout" : "unavailable", http_status: status });
  }
  return JSON.stringify(mapResponse(decoded, row.response_map));
}

/** Same path convention as the SaaS ToolService::flatten: "$.a.b", lists kept as values. */
function flatten(data: unknown, prefix = "$", out: Record<string, unknown> = {}): Record<string, unknown> {
  if (data && typeof data === "object" && !Array.isArray(data)) {
    for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
      const path = `${prefix}.${k}`;
      if (v && typeof v === "object" && !Array.isArray(v) && Object.keys(v as object).length > 0) flatten(v, path, out);
      else out[path] = v;
    }
  } else {
    out[prefix] = data;
  }
  return out;
}

function mapResponse(decoded: unknown, responseMap: Record<string, string> | null): unknown {
  const map = responseMap && Object.keys(responseMap).length > 0 ? responseMap : null;
  if (!map) return decoded;
  const flat = flatten(decoded);
  const out: Record<string, unknown> = {};
  for (const [path, label] of Object.entries(map)) {
    if (path in flat) out[label || path] = flat[path];
    else {
      // Path pointing at an object/list (not flattened to a leaf): resolve directly.
      const v = path
        .replace(/^\$\.?/, "")
        .split(".")
        .filter(Boolean)
        .reduce<unknown>((acc, k) => (acc && typeof acc === "object" ? (acc as Record<string, unknown>)[k] : undefined), decoded);
      if (v !== undefined) out[label || path] = v;
    }
  }
  return Object.keys(out).length > 0 ? out : { found: false };
}

// ---------- SSRF guard (mirrors the SaaS SsrfGuard) ----------

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split(".").map(Number);
    return (
      a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224
    );
  }
  const v = ip.toLowerCase();
  return v === "::1" || v === "::" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe80") || v.startsWith("::ffff:127.");
}

async function assertSafeUrl(raw: string): Promise<void> {
  const u = new URL(raw);
  const allowPrivate = process.env.CRM_TOOLS_ALLOW_PRIVATE_URLS === "1";
  if (u.protocol !== "https:" && !(allowPrivate && u.protocol === "http:")) {
    throw new Error("only https URLs are allowed");
  }
  if (allowPrivate) return;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = net.isIP(host) ? [host] : (await dns.lookup(host, { all: true })).map((a) => a.address);
  if (addrs.length === 0 || addrs.some(isPrivateIp)) throw new Error("URL resolves to a private address");
}

// ---------- run log (shows in the SaaS tool logs screen, p18) ----------

const ULID_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
function ulidLower(): string {
  let t = Date.now();
  let time = "";
  for (let i = 0; i < 10; i++) {
    time = ULID_ALPHABET[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = crypto.randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += ULID_ALPHABET[rnd[i] % 32];
  return time + rand;
}

async function logToolRun(
  row: CustomToolRow,
  ctx: CallToolContext,
  req: { url: string; method: string; headers: Record<string, string>; body?: string },
  status: "ok" | "err" | "timeout",
  httpStatus: number | null,
  latencyMs: number,
  response: unknown,
  error: string | null
): Promise<void> {
  const headers = { ...req.headers };
  for (const k of Object.keys(headers)) {
    if (/^(authorization|x-api-key)$/i.test(k)) headers[k] = "[redacted]";
  }
  try {
    await pool.query(
      `INSERT INTO crm_tool_runs (public_id, company_id, crm_tool_id, call_id, status, status_code, latency_ms,
                                  request, response, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::json, $9::json, $10, NOW(), NOW())`,
      [
        ulidLower(),
        row.company_id,
        row.id,
        ctx.callId ? String(ctx.callId).slice(0, 64) : null,
        status,
        httpStatus,
        latencyMs,
        JSON.stringify({ url: req.url, method: req.method, headers, body: req.body ?? null, source: "live_call" }),
        JSON.stringify(response ?? null),
        error,
      ]
    );
  } catch (err) {
    ctx.log?.warn({ err: String(err) }, "crm-tools: failed to log tool run");
  }
}
