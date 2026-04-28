-- OPTIONAL — Per-tenant Exotel REST cluster (Singapore vs Mumbai hosts).
-- Not required for outbound calling: the API uses env vars instead:
--   EXOTEL_REST_API_BASE_URL   (full override, e.g. https://api.in.exotel.com)
--   EXOTEL_REST_CLUSTER        `mumbai` (default) or `singapore`
--
-- Apply this ONLY if you later extend `getExotelSettings` / application code to read
-- `exotel_rest_cluster` per customer. Until then, leaving this column unused is harmless.

ALTER TABLE customer_exotel_settings
  ADD COLUMN IF NOT EXISTS exotel_rest_cluster TEXT;

COMMENT ON COLUMN customer_exotel_settings.exotel_rest_cluster IS
  'Optional: singapore -> api.exotel.com; mumbai/india -> api.in.exotel.com. Unused until app reads it.';

-- Example constraint (uncomment after backfilling existing rows if needed):
-- ALTER TABLE customer_exotel_settings
--   ADD CONSTRAINT customer_exotel_settings_rest_cluster_chk
--   CHECK (exotel_rest_cluster IS NULL OR exotel_rest_cluster IN ('singapore', 'mumbai'));
