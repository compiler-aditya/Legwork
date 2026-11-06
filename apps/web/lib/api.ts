import 'server-only';

/**
 * Calls the Legwork API from the web server. The admin token never reaches
 * the browser: route handlers in app/api call these and pass results on.
 */
export async function legwork(path: string, init: { method?: 'GET' | 'POST'; body?: unknown } = {}): Promise<{ status: number; body: unknown }> {
  const base = process.env.LEGWORK_API_URL;
  const token = process.env.LEGWORK_ADMIN_TOKEN;
  if (!base || !token) return { status: 503, body: { ok: false, error: 'The web app is not connected to the API (LEGWORK_API_URL, LEGWORK_ADMIN_TOKEN)' } };
  const res = await fetch(`${base.replace(/\/$/, '')}${path}`, {
    method: init.method ?? 'GET',
    headers: { authorization: `Bearer ${token}`, ...(init.body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    cache: 'no-store',
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    // keep text
  }
  return { status: res.status, body };
}
