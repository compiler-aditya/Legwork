-- The outreach rounds: the planner's plan for each errand, and each call's progress.

CREATE TABLE errand_plans (
  errand_id   TEXT PRIMARY KEY REFERENCES errands(id),
  -- OutreachPlan from @legwork/outreach: item, quantity, pickup window, benchmark, shops in order.
  plan        JSONB NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- status: calling (a call is live) | retry (waiting to call again) | ended.
ALTER TABLE outreach
  ADD COLUMN attempt     SMALLINT NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  ADD COLUMN result      TEXT,
  ADD COLUMN offer       JSONB,       -- round 2: { ask, quoted }
  ADD COLUMN retry_at    TIMESTAMPTZ,
  ADD COLUMN transcript  JSONB,       -- numbered lines from the post-call webhook
  ADD COLUMN error       TEXT,
  ADD COLUMN updated_at  TIMESTAMPTZ NOT NULL DEFAULT now();

CREATE INDEX outreach_conversation ON outreach (provider_ref);
CREATE INDEX outreach_due ON outreach (retry_at) WHERE status = 'retry';
CREATE INDEX outreach_live ON outreach (started_at) WHERE status = 'calling';
