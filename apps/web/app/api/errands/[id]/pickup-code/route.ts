import { NextResponse } from 'next/server';
import { legwork } from '../../../../../lib/api';

/** Demo only: plays the shop texting back the pickup code, for runs without Twilio. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^err_[a-f0-9]{12}$/.test(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const { code } = (await request.json().catch(() => ({}))) as { code?: string };
  const { status, body } = await legwork(`/errands/${id}/pickup-code`, { method: 'POST', body: { code } });
  return NextResponse.json(body, { status });
}
