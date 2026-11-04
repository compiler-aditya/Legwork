import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * A contract is what the shop agreed to on the call. Every term carries the
 * transcript line it came from, so the buyer sees the shop's own words before
 * paying and a dispute can quote them.
 */
const sourced = <T extends z.ZodType>(value: T) =>
  z.object({
    value,
    /** Zero-based index of the transcript turn that stated it. */
    line: z.number().int().nonnegative(),
    /** Offset into the call, "mm:ss". */
    at: z.string().regex(/^\d{1,3}:\d{2}$/),
    /** The words as spoken. */
    quote: z.string().min(1),
  });

export const ContractTermsSchema = z.object({
  item: sourced(z.string().min(1)),
  quantity: sourced(z.number().int().positive()),
  totalCents: sourced(z.number().int().positive()),
  readyAt: sourced(z.string().min(1)),
});

export type ContractTerms = z.infer<typeof ContractTermsSchema>;

/** What the voice agent's record_quote / confirm_order tools stored during the call. */
export interface RecordedDeal {
  item: string;
  quantity: number;
  totalCents: number;
}

export interface Mismatch {
  field: keyof RecordedDeal;
  fromTranscript: string | number;
  fromTools: string | number;
}

/**
 * Compares the extracted contract with what the tools recorded live. Any
 * difference goes to the buyer for review instead of being paid.
 */
export function mismatches(terms: ContractTerms, recorded: RecordedDeal): Mismatch[] {
  const out: Mismatch[] = [];
  if (normalise(terms.item.value) !== normalise(recorded.item)) {
    out.push({ field: 'item', fromTranscript: terms.item.value, fromTools: recorded.item });
  }
  if (terms.quantity.value !== recorded.quantity) {
    out.push({ field: 'quantity', fromTranscript: terms.quantity.value, fromTools: recorded.quantity });
  }
  if (terms.totalCents.value !== recorded.totalCents) {
    out.push({ field: 'totalCents', fromTranscript: terms.totalCents.value, fromTools: recorded.totalCents });
  }
  return out;
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Canonical JSON: object keys sorted at every level, so equal contracts hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** The hash printed on the receipt and sent with dispute evidence. */
export function contractHash(terms: ContractTerms, shopId: string, errandId: string): string {
  return createHash('sha256').update(canonicalJson({ errandId, shopId, terms })).digest('hex');
}
