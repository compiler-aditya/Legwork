import { NextResponse } from 'next/server';
import { legwork } from '../../../lib/api';

/** Adds a shop that agreed to calls from an AI to the directory the planner searches. */
export async function POST(request: Request) {
  const input = await request.json().catch(() => ({}));
  const { status, body } = await legwork('/businesses', { method: 'POST', body: input });
  return NextResponse.json(body, { status });
}
