-- gpt-4.1-nano was retired by OpenAI (404 model_not_found). Moves tenants on it to gpt-5-mini
-- and makes gpt-5-mini the default for new tenants.
UPDATE customer_settings SET openai_model = 'gpt-5-mini' WHERE openai_model = 'gpt-4.1-nano';
ALTER TABLE customer_settings ALTER COLUMN openai_model SET DEFAULT 'gpt-5-mini';
