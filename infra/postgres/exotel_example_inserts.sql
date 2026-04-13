-- Example: store or update all Exotel details for one Convixx customer (tenant).
-- Run AFTER: infra/postgres/migrations/002_exotel_voicebot_tables.sql
-- Replace placeholders: :customer_id, and all Exotel field values.

-- ---------------------------------------------------------------------------
-- Insert (first time for this customer)
-- ---------------------------------------------------------------------------
/*
INSERT INTO customer_exotel_settings (
  customer_id,
  exotel_account_sid,
  exotel_app_id,
  exotel_subdomain,
  exotel_api_key,
  exotel_api_token,
  inbound_phone_number,
  default_outbound_caller_id,
  webhook_secret,
  voicebot_wss_url,
  voicebot_bootstrap_https_url,
  is_enabled,
  use_sandbox
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,  -- customers.id
  'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'your-exotel-app-id',
  'api.exotel.com',                               -- or regional subdomain Exotel gives you
  'your-exotel-api-key',
  'your-exotel-api-token',
  '+9111xxxxxxxx',                                -- DID mapped to this tenant
  '+9111xxxxxxxx',                                -- outbound CLI if applicable
  'random-long-secret-for-webhook-verification',
  'wss://api.yourdomain.com/exotel/voicebot/00000000-0000-0000-0000-000000000001',
  'https://api.yourdomain.com/exotel/voicebot/bootstrap/00000000-0000-0000-0000-000000000001',
  TRUE,
  FALSE
);
*/

-- ---------------------------------------------------------------------------
-- Upsert (insert or replace Exotel details for this customer — one row per customer)
-- Uncomment and set real values; customer_id must exist in customers.
-- ---------------------------------------------------------------------------
/*
INSERT INTO customer_exotel_settings (
  customer_id,
  exotel_account_sid,
  exotel_app_id,
  exotel_subdomain,
  exotel_api_key,
  exotel_api_token,
  inbound_phone_number,
  default_outbound_caller_id,
  webhook_secret,
  voicebot_wss_url,
  voicebot_bootstrap_https_url,
  is_enabled,
  use_sandbox
) VALUES (
  '00000000-0000-0000-0000-000000000001'::uuid,
  'ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
  'your-exotel-app-id',
  'api.exotel.com',
  'your-exotel-api-key',
  'your-exotel-api-token',
  '+9111xxxxxxxx',
  '+9111xxxxxxxx',
  'random-long-secret-for-webhook-verification',
  'wss://api.yourdomain.com/exotel/voicebot/00000000-0000-0000-0000-000000000001',
  'https://api.yourdomain.com/exotel/voicebot/bootstrap/00000000-0000-0000-0000-000000000001',
  TRUE,
  FALSE
)
ON CONFLICT (customer_id) DO UPDATE SET
  exotel_account_sid = EXCLUDED.exotel_account_sid,
  exotel_app_id = EXCLUDED.exotel_app_id,
  exotel_subdomain = EXCLUDED.exotel_subdomain,
  exotel_api_key = EXCLUDED.exotel_api_key,
  exotel_api_token = EXCLUDED.exotel_api_token,
  inbound_phone_number = EXCLUDED.inbound_phone_number,
  default_outbound_caller_id = EXCLUDED.default_outbound_caller_id,
  webhook_secret = EXCLUDED.webhook_secret,
  voicebot_wss_url = EXCLUDED.voicebot_wss_url,
  voicebot_bootstrap_https_url = EXCLUDED.voicebot_bootstrap_https_url,
  is_enabled = EXCLUDED.is_enabled,
  use_sandbox = EXCLUDED.use_sandbox,
  updated_at = NOW();
*/

-- ---------------------------------------------------------------------------
-- Verify
-- ---------------------------------------------------------------------------
-- SELECT * FROM customer_exotel_settings WHERE customer_id = '...'::uuid;
