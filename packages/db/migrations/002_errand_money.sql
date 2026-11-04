-- The orchestrator's money state for each errand, and the PayPal refund id on money steps.

-- The hold, the contract in play, captures, payouts and cancelled contracts, as
-- the orchestrator's Errand stores them. Every change to it also writes
-- errand_transitions and money_steps rows, which stay the audit trail.
ALTER TABLE errands ADD COLUMN money JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Set when an errand needs a person (a denied capture, a payout claimed after a cancellation).
ALTER TABLE errands ADD COLUMN attention TEXT;
CREATE INDEX errands_attention ON errands (updated_at) WHERE attention IS NOT NULL;

ALTER TABLE money_steps ADD COLUMN paypal_refund_id TEXT;

-- A money step's status only moves forward: requested -> sent -> confirmed | failed.
CREATE OR REPLACE FUNCTION money_steps_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'money_steps rows are append-only';
  END IF;
  IF NEW.amount_cents IS DISTINCT FROM OLD.amount_cents
     OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.request_id IS DISTINCT FROM OLD.request_id
     OR NEW.errand_id IS DISTINCT FROM OLD.errand_id THEN
    RAISE EXCEPTION 'money_steps amounts and identities are immutable';
  END IF;
  IF OLD.status IN ('confirmed', 'failed') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'money step % is already %', OLD.request_id, OLD.status;
  END IF;
  RETURN NEW;
END $$;
