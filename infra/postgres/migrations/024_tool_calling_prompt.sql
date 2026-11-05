-- ============================================================
-- Migration 024 — per-customer tool-calling instructions (mid-call CRM data)
-- Run via apps/api/scripts/run-sql-file.ts.
--
-- Live calls (Vodafone + Exotel) can fetch data mid-conversation through
-- OpenAI tool calling: the native Convixx CRM (crm_records & co., SaaS tables
-- on this same database) and the customer's own verified + active API tools
-- (crm_tools). See docs/CRM_TOOL_CALLING_PLAN_2026-11-05.md (goal 2).
--
-- tool_calling_prompt: optional free text appended to the model's
-- instructions, telling it WHEN to call tools (applies to native and custom
-- tools alike). NULL = built-in default rules only.
-- tool_calling_enabled: kill switch; tools are only offered when the tenant
-- actually has native CRM records or active custom tools.
--
-- Additive only, defaults keep every existing tenant unchanged.
-- ============================================================

ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS tool_calling_enabled BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS tool_calling_prompt TEXT;

COMMENT ON COLUMN customer_settings.tool_calling_prompt IS
  'Optional instructions telling the model when to call CRM tools (native + custom) during calls. Set via PUT /customers/:customerId/tool-calling.';
COMMENT ON COLUMN customer_settings.tool_calling_enabled IS
  'Kill switch for mid-call CRM tool calling. Tools are offered only when the tenant has native CRM records or verified+active crm_tools.';
