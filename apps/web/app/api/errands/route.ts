import { randomBytes } from 'node:crypto';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { legwork } from '../../../lib/api';

export const maxDuration = 300; // planning can take a few model turns

interface NewErrand {
  text?: string;
  budgetDollars?: number;
  firstName?: string;
  phone?: string;
  pickupWindow?: string;
  photoUrl?: string;
  location?: { lat: number; lon: number; label?: string };
}

/** Starts an errand: Claude plans it, and PayPal's approve link comes back with the plan. */
export async function POST(request: Request) {
  const input = (await request.json().catch(() => ({}))) as NewErrand;
  const jar = await cookies();
  let userId = jar.get('lw_uid')?.value;
  if (!userId) {
    userId = `usr_${randomBytes(6).toString('hex')}`;
    jar.set('lw_uid', userId, { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 60 * 60 * 24 * 365, path: '/' });
  }
  const firstName = (input.firstName ?? '').trim();
  const { status, body } = await legwork('/errands', {
    method: 'POST',
    body: {
      userId,
      userName: firstName || 'Buyer',
      request: { kind: 'item', text: (input.text ?? '').trim() },
      budgetMaxCents: Math.round((input.budgetDollars ?? 0) * 100),
      buyer: { firstName, ...(input.phone?.trim() ? { phone: input.phone.trim() } : {}) },
      location: input.location,
      ...(input.pickupWindow?.trim() ? { pickupWindow: input.pickupWindow.trim() } : {}),
      ...(input.photoUrl?.trim() ? { photoUrl: input.photoUrl.trim() } : {}),
    },
  });
  return NextResponse.json(body, { status });
}
