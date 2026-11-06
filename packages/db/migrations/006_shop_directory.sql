-- The shop directory the planner searches: what each business sells.
ALTER TABLE businesses
  ADD COLUMN categories  TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN description TEXT;
CREATE INDEX businesses_location ON businesses (lat, lon) WHERE lat IS NOT NULL AND lon IS NOT NULL;
