import type { ContractReview, Money } from '@legwork/core';
import type { Quote, TranscriptLine } from '@legwork/voice';

/** A shop the planner chose to call, in the order it prefers them. */
export interface Shop {
  businessId: string;
  name: string;
  /** E.164; also where the payout goes by default. */
  phone: string;
}

/** What the planner hands the outreach rounds for one errand. */
export interface OutreachPlan {
  errandId: string;
  /** Said on the call: "a Moen 1222 shower cartridge". */
  item: string;
  quantity: number;
  /** Said on the call: "today after 3pm or tomorrow morning". */
  pickupWindow: string;
  buyerFirstName: string;
  /** Where the buyer's pickup code and receipt are texted (E.164); without it the web app shows the code. */
  buyerPhone?: string;
  /** The best online price for the same item (Channel3); sets the counter-offer. */
  benchmark?: { price: Money; source: string; url?: string };
  shops: Shop[];
}

/** How one shop's call ended. */
export type OutreachResult =
  | 'quoted' // has it, gave a price
  | 'unavailable' // does not have it
  | 'no_quote' // talked, but no quote was recorded (voicemail, hung up)
  | 'opted_out' // asked not to be called by an AI
  | 'no_answer'
  | 'busy'
  | 'call_failed' // the call could not be placed
  | 'timed_out' // no report arrived
  | 'confirmed' // round 2: the order was confirmed
  | 'not_confirmed'; // round 2: it was not

export interface OutreachRow {
  id: string;
  errandId: string;
  businessId: string;
  round: 1 | 2;
  /** calling: a call is live; retry: waiting to call again; ended: final. */
  status: 'calling' | 'retry' | 'ended';
  attempt: number;
  conversationId?: string;
  quote?: Quote;
  result?: OutreachResult;
  /** Round 2: the price asked for and the shop's round-1 quote. */
  offer?: { ask: Money; quoted: Money };
  retryAt?: string;
  startedAt?: string;
  endedAt?: string;
  transcript?: TranscriptLine[];
  /** Round 2, once confirmed: the contract extractor's reading of the call. */
  review?: ContractReview;
  error?: string;
}

export const isFinal = (row: OutreachRow) => row.status === 'ended';
