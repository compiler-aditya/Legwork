-- The contract extractor's reading of each confirmation call: terms tied to
-- transcript lines, their hash, and anything the buyer should review.
ALTER TABLE outreach ADD COLUMN review JSONB;
CREATE INDEX outreach_needs_review ON outreach (errand_id)
  WHERE review IS NOT NULL AND (review->>'agreed' = 'false' OR jsonb_array_length(review->'mismatches') > 0 OR jsonb_array_length(review->'unverified') > 0);
