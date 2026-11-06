-- Pickups: a confirmed contract waiting for the shop to text back the buyer's code.
CREATE TABLE pickups (
  contract_id     TEXT PRIMARY KEY,
  errand_id       TEXT NOT NULL REFERENCES errands(id),
  -- The number Legwork called; only a text from it can confirm the pickup.
  shop_phone      TEXT NOT NULL,
  buyer_phone     TEXT,
  status          TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'confirmed', 'locked')),
  wrong_attempts  SMALLINT NOT NULL DEFAULT 0 CHECK (wrong_attempts >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pickups_open_by_shop ON pickups (shop_phone) WHERE status = 'open';
CREATE INDEX pickups_errand ON pickups (errand_id);
