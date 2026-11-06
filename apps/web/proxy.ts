import { NextResponse, type NextRequest } from 'next/server';

/**
 * A passcode in front of the demo (WEB_PASSCODE): errands start real sandbox
 * PayPal holds and real calls to consenting numbers. Browsers ask once
 * (HTTP Basic, any user name) and remember it.
 */
export function proxy(request: NextRequest) {
  const passcode = process.env.WEB_PASSCODE;
  if (!passcode) return NextResponse.next();
  const header = request.headers.get('authorization') ?? '';
  const given = header.startsWith('Basic ') ? atob(header.slice(6)).split(':').slice(1).join(':') : '';
  if (given === passcode) return NextResponse.next();
  return new NextResponse('Legwork demo: enter the passcode (any user name).', {
    status: 401,
    headers: { 'WWW-Authenticate': 'Basic realm="Legwork demo", charset="UTF-8"' },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
};
