-- Auth store for the temporary, per-customer KB admin web page (single active
-- session per user — a new login on another browser/window invalidates the
-- old one by overwriting session_token). Scoped to one customer per row;
-- the Ganeshotsav project page uses the row seeded for customer_id
-- 97752ef1-eb4f-4ebb-a77f-0613fe3a424b.
CREATE TABLE IF NOT EXISTS kb_admin_users (
  id                 UUID          PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        UUID          NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  username           TEXT          NOT NULL UNIQUE,
  password_hash      TEXT          NOT NULL,
  session_token      TEXT,
  session_created_at TIMESTAMPTZ,
  created_at         TIMESTAMPTZ   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_kb_admin_users_customer_id ON kb_admin_users(customer_id);
