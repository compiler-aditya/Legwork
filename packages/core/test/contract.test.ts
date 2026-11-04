import { describe, expect, it } from 'vitest';
import { ContractTermsSchema, canonicalJson, contractHash, mismatches, type ContractTerms } from '../src/contract';
import { newPickupCode, requestIdFor, senderItemIdFor } from '../src/ids';

const terms: ContractTerms = {
  item: { value: 'Moen 1222 cartridge', line: 7, at: '01:12', quote: 'Yeah, we have the Moen 1222 cartridge.' },
  quantity: { value: 1, line: 7, at: '01:12', quote: 'one of them' },
  totalCents: { value: 3400, line: 11, at: '01:40', quote: 'Thirty-four, sure, for pickup at four.' },
  readyAt: { value: '2026-11-08T16:00:00-08:00', line: 11, at: '01:40', quote: 'pickup at four' },
};

describe('contract', () => {
  it('validates sourced terms', () => {
    expect(ContractTermsSchema.parse(terms)).toEqual(terms);
    expect(() => ContractTermsSchema.parse({ ...terms, totalCents: { ...terms.totalCents, value: -1 } })).toThrow();
    expect(() => ContractTermsSchema.parse({ ...terms, item: { ...terms.item, at: '1m12s' } })).toThrow();
  });

  it('flags any difference from what the call tools recorded', () => {
    expect(mismatches(terms, { item: 'moen 1222  Cartridge', quantity: 1, totalCents: 3400 })).toEqual([]);
    expect(mismatches(terms, { item: 'Moen 1222 cartridge', quantity: 1, totalCents: 3600 })).toEqual([
      { field: 'totalCents', fromTranscript: 3400, fromTools: 3600 },
    ]);
  });

  it('hashes the same contract the same way regardless of key order', () => {
    const reordered = JSON.parse(canonicalJson(terms)) as ContractTerms;
    expect(contractHash(reordered, 'shop_1', 'err_1')).toBe(contractHash(terms, 'shop_1', 'err_1'));
    expect(contractHash(terms, 'shop_2', 'err_1')).not.toBe(contractHash(terms, 'shop_1', 'err_1'));
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
});

describe('ids', () => {
  it('derives stable PayPal request ids from the errand and step', () => {
    expect(requestIdFor('err_123', 'capture-deposit')).toBe('lw-err_123-capture-deposit');
    expect(requestIdFor('err_123', 'capture-deposit')).toBe(requestIdFor('err_123', 'capture-deposit'));
    expect(requestIdFor('err 1/2', 'void', 2)).toBe('lw-err12-void-2');
    expect(senderItemIdFor('err_123', 'payout-deposit')).toBe('lw-err_123-payout-deposit');
  });

  it('makes four-digit pickup codes', () => {
    for (let i = 0; i < 50; i++) expect(newPickupCode()).toMatch(/^\d{4}$/);
  });
});
