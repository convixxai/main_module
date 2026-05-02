# STT Quality DB Changes

The following SQL queries add the required columns to the `customer_settings` table to support per-customer post-STT normalization dictionaries and dynamic industry context/tone injection.

```sql
-- Migration: Add stt_domain_words and industry_context to customer_settings
ALTER TABLE customer_settings
  ADD COLUMN IF NOT EXISTS stt_domain_words JSONB DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS industry_context JSONB DEFAULT '{}'::jsonb;

COMMENT ON COLUMN customer_settings.stt_domain_words IS
  'Per-customer STT post-processing dictionary. JSON object where keys are '
  'common STT misrecognitions (lowercase) and values are correct domain words. '
  'Example: {"xiaomi": "Chhavani", "shabani": "Chhavani", "chawani": "Chhavani"}';

COMMENT ON COLUMN customer_settings.industry_context IS
  'Per-customer industry/product facts and sentiment-aware tone guidelines. '
  'Example: {"domain_facts": ["Standard check-in is 2 PM"], "tone_guidelines": {"frustrated": "apologize"}}';
```

## Sample Data for Chhavani Resort

To update the `customer_settings` for the **Chhavani** resort tenant, execute the following query. Replace the customer ID (`<customer_id>`) with the actual customer ID from the database:

```sql
UPDATE customer_settings
SET 
  stt_domain_words = '{
    "xiaomi": "Chhavani",
    "shabani": "Chhavani",
    "chawani": "Chhavani",
    "chowani": "Chhavani",
    "chhavni": "Chhavani"
  }'::jsonb,
  industry_context = '{
    "brand": "Chhavani Resort",
    "brand_tone": "Warm, polite, luxury hospitality, professional",
    "industry_context": "We are a premium eco-resort in the countryside.",
    "competitor_fallback": "Acknowledge the competitor politely but pivot directly back to the unique eco-friendly luxury and bespoke experiences at Chhavani.",
    "sentiment_guidelines": {
      "frustrated": "Always validate the concern calmly, apologize immediately, and assure them that their comfort is the top priority.",
      "curious": "Be enthusiastic, share descriptive details about Chhavani''s scenic property, bespoke packages, and activities."
    }
  }'::jsonb
WHERE customer_id = '<customer_id>';
```

