-- Legwork schema v1. Postgres is the source of truth; Elastic keeps a search copy of businesses.
-- Money rows are append-only: a correction is a new row, never an UPDATE of an amount.

CREATE TABLE users (
  id                 TEXT PRIMARY KEY,
  name               TEXT NOT NULL,
  email              TEXT UNIQUE,
  phone              TEXT,
  -- PayPal's id for the saved PayPal account; no card or account data is stored.
  vault_token_id     TEXT,
  home_lat           DOUBLE PRECISION,
  home_lon           DOUBLE PRECISION,
  max_errand_cents   INTEGER NOT NULL DEFAULT 10000 CHECK (max_errand_cents > 0),
  approve_above_cents INTEGER NOT NULL DEFAULT 5000 CHECK (approve_above_cents >= 0),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE businesses (
  id               TEXT PRIMARY KEY,
  osm_id           TEXT UNIQUE,
  name             TEXT NOT NULL,
  phone            TEXT,
  website          TEXT,
  address          TEXT,
  lat              DOUBLE PRECISION,
  lon              DOUBLE PRECISION,
  hours            JSONB,
  -- Where payouts go: the dialled phone number by default.
  payout_type      TEXT CHECK (payout_type IN ('EMAIL', 'PHONE', 'USER_HANDLE')),
  payout_receiver  TEXT,
  prefers_text     BOOLEAN NOT NULL DEFAULT false,
  accepts_ai_calls BOOLEAN NOT NULL DEFAULT true,
  reliability      REAL NOT NULL DEFAULT 0.5,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE errands (
  id                   TEXT PRIMARY KEY,
  user_id              TEXT NOT NULL REFERENCES users(id),
  kind                 TEXT NOT NULL CHECK (kind IN ('item', 'custom_order')),
  request_text         TEXT NOT NULL,
  photo_url            TEXT,
  item_spec            JSONB NOT NULL DEFAULT '{}'::jsonb,
  budget_max_cents     INTEGER NOT NULL CHECK (budget_max_cents > 0),
  deadline             TIMESTAMPTZ,
  area_lat             DOUBLE PRECISION,
  area_lon             DOUBLE PRECISION,
  -- One of ERRAND_STATES in @legwork/core; moved only through nextState().
  state                TEXT NOT NULL DEFAULT 'requested',
  benchmark            JSONB, -- { price_cents, delivery_date, channel3_product_id, url }
  chosen_business_id   TEXT REFERENCES businesses(id),
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE errand_transitions (
  id          BIGSERIAL PRIMARY KEY,
  errand_id   TEXT NOT NULL REFERENCES errands(id),
  from_state  TEXT NOT NULL,
  event       TEXT NOT NULL,
  to_state    TEXT NOT NULL,
  cause       TEXT, -- webhook event id, outreach id or user action
  at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX errand_transitions_errand ON errand_transitions (errand_id, id);

CREATE TABLE outreach (
  id                 TEXT PRIMARY KEY,
  errand_id          TEXT NOT NULL REFERENCES errands(id),
  business_id        TEXT NOT NULL REFERENCES businesses(id),
  round              SMALLINT NOT NULL CHECK (round IN (1, 2)),
  channel            TEXT NOT NULL CHECK (channel IN ('voice', 'web', 'sms')),
  provider_ref       TEXT, -- ElevenLabs conversation id, KERNEL session id or Twilio SID
  status             TEXT NOT NULL DEFAULT 'queued',
  quote              JSONB, -- { price_cents, in_stock, ready_at, notes }
  transcript_url     TEXT,
  recording_consent  BOOLEAN,
  started_at         TIMESTAMPTZ,
  ended_at           TIMESTAMPTZ
);
CREATE INDEX outreach_errand ON outreach (errand_id);

CREATE TABLE contracts (
  id           TEXT PRIMARY KEY,
  errand_id    TEXT NOT NULL REFERENCES errands(id),
  business_id  TEXT NOT NULL REFERENCES businesses(id),
  outreach_id  TEXT NOT NULL REFERENCES outreach(id),
  item         TEXT NOT NULL,
  quantity     INTEGER NOT NULL CHECK (quantity > 0),
  total_cents  INTEGER NOT NULL CHECK (total_cents > 0),
  deposit_cents INTEGER NOT NULL CHECK (deposit_cents >= 0),
  pickup_at    TIMESTAMPTZ,
  pickup_code  TEXT NOT NULL,
  -- ContractTerms from @legwork/core: every field with the transcript line it came from.
  terms        JSONB NOT NULL,
  hash         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('proposed', 'approved', 'void')),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (deposit_cents <= total_cents)
);
CREATE INDEX contracts_errand ON contracts (errand_id);

CREATE TABLE money_steps (
  id             BIGSERIAL PRIMARY KEY,
  errand_id      TEXT NOT NULL REFERENCES errands(id),
  contract_id    TEXT REFERENCES contracts(id),
  kind           TEXT NOT NULL CHECK (kind IN (
                   'authorize', 'capture_deposit', 'payout_deposit', 'capture_balance',
                   'payout_balance', 'void', 'refund', 'reauthorize')),
  amount_cents   INTEGER NOT NULL CHECK (amount_cents >= 0),
  currency       TEXT NOT NULL DEFAULT 'USD',
  -- PayPal-Request-Id; the same step never runs twice.
  request_id     TEXT NOT NULL UNIQUE,
  paypal_order_id         TEXT,
  paypal_authorization_id TEXT,
  paypal_capture_id       TEXT,
  paypal_payout_batch_id  TEXT,
  paypal_payout_item_id   TEXT,
  -- requested -> sent -> confirmed (only from a verified webhook) | failed
  status         TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'sent', 'confirmed', 'failed')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at   TIMESTAMPTZ
);
CREATE INDEX money_steps_errand ON money_steps (errand_id, id);

-- Amounts and PayPal ids never change after insert; only status and confirmed_at move forward.
CREATE FUNCTION money_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money_steps rows are append-only';
  END IF;
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.errand_id IS DISTINCT FROM OLD.errand_id THEN
    RAISE EXCEPTION 'money_steps amounts and identities are immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER money_steps_append_only BEFORE UPDATE OR DELETE ON money_steps
  FOR EACH ROW EXECUTE FUNCTION money_steps_guard();

CREATE TABLE webhook_events (
  source        TEXT NOT NULL CHECK (source IN ('paypal', 'elevenlabs', 'twilio')),
  event_id      TEXT NOT NULL,
  event_type    TEXT NOT NULL,
  verified      BOOLEAN NOT NULL,
  payload       JSONB NOT NULL,
  received_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at  TIMESTAMPTZ,
  PRIMARY KEY (source, event_id)
);

CREATE TABLE evidence (
  id          TEXT PRIMARY KEY,
  errand_id   TEXT NOT NULL REFERENCES errands(id),
  kind        TEXT NOT NULL CHECK (kind IN ('contract_pdf', 'call_excerpt_pdf', 'browser_replay')),
  url         TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
