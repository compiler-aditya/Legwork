import { NextResponse } from 'next/server';
import { legwork } from '../../../../lib/api';

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!/^err_[a-f0-9]{12}$/.test(id)) return NextResponse.json({ ok: false, error: 'not found' }, { status: 404 });
  const { status, body } = await legwork(`/errands/${id}`);
  return NextResponse.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
