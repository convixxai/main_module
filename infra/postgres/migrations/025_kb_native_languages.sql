-- ============================================================
-- Migration 025 — native-language KB search (kb_native_languages)
-- Run via apps/api/scripts/run-sql-file.ts.
--
-- A multilingual tenant normally has every non-English question translated
-- to English by Sarvam before the KB search (~0.5 s per turn). A tenant that
-- stores its KB entries in kb_entries in several languages (e.g. English,
-- Marathi and Hindi) lists those languages here, as primary codes
-- ('mr', 'hi', ...). A question in a listed language is then searched as
-- spoken, with no translation call.
--
-- The engine only honours a listed language when the KB really holds
-- entries in it (source_language_code or the language's script), so setting
-- it before the entries are added changes nothing.
--
-- Additive only, the default keeps every existing tenant unchanged.
-- ============================================================

ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS kb_native_languages TEXT[] NOT NULL DEFAULT '{}';
