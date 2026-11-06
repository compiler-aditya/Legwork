'use client';

import { useState } from 'react';

/** Adds a shop to the directory the planner searches. Only numbers whose owners agreed to calls from an AI. */
export default function Shops() {
  const [form, setForm] = useState({ name: '', phone: '', address: '', lat: '37.7612', lon: '-122.4195', categories: 'hardware, plumbing', consent: false });
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const businessId = `biz_${form.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40)}`;
    const res = await fetch('/api/businesses', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessId,
        name: form.name,
        phone: form.phone,
        lat: Number(form.lat),
        lon: Number(form.lon),
        categories: form.categories.split(',').map((c) => c.trim()).filter(Boolean),
        ...(form.address ? { address: form.address } : {}),
      }),
    });
    const body = await res.json();
    setMessage(body.ok ? { ok: true, text: `Added ${form.name}. The planner can now choose it; calls still go only to numbers on the API's CALL_ALLOWLIST.` } : { ok: false, text: typeof body.error === 'string' ? body.error : 'Could not add the shop.' });
  }

  return (
    <div className="stack">
      <div>
        <h1>Shops Legwork may call</h1>
        <p className="muted">For the demo, add teammates or judges playing shops. Add only phone numbers whose owners agreed to a call from an AI.</p>
      </div>
      <form className="card stack" onSubmit={submit}>
        <div className="row">
          <label>
            Shop name
            <input required value={form.name} onChange={set('name')} placeholder="Hartley Hardware" />
          </label>
          <label>
            Phone
            <input required type="tel" value={form.phone} onChange={set('phone')} placeholder="+14155550123" pattern="\+[1-9][0-9]{6,14}" />
          </label>
        </div>
        <label>
          What it sells <span className="hint">comma separated</span>
          <input required value={form.categories} onChange={set('categories')} />
        </label>
        <div className="row">
          <label>
            Latitude
            <input required value={form.lat} onChange={set('lat')} inputMode="decimal" />
          </label>
          <label>
            Longitude
            <input required value={form.lon} onChange={set('lon')} inputMode="decimal" />
          </label>
          <label>
            Address <span className="hint">optional</span>
            <input value={form.address} onChange={set('address')} />
          </label>
        </div>
        <label style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', fontWeight: 400 }}>
          <input type="checkbox" required checked={form.consent} onChange={set('consent')} style={{ width: 'auto' }} />
          The owner of this number agreed to receive calls and texts from an AI assistant.
        </label>
        {message ? <div className={`callout ${message.ok ? 'good' : 'bad'}`}>{message.text}</div> : null}
        <div className="actions">
          <button className="button">Add the shop</button>
        </div>
      </form>
    </div>
  );
}
