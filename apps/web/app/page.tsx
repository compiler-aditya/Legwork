'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { usd, type Money } from '../lib/view';

interface PlannedShop {
  businessId: string;
  name: string;
  phone: string;
}
interface PlanResponse {
  ok: true;
  errandId: string;
  approveUrl: string;
  reasoning?: string;
  plan: { item: string; quantity: number; pickupWindow: string; shops: PlannedShop[]; benchmark?: { price: Money; source: string; url?: string } };
}
type Outcome = { kind: 'plan'; data: PlanResponse } | { kind: 'question'; question: string } | { kind: 'error'; message: string };

const PROGRESS = ['Reading your request', 'Identifying the item', 'Finding shops near you', 'Choosing who to call'];
const MISSION = { lat: 37.7599, lon: -122.4148, label: 'Mission District, San Francisco' };

export default function NewErrand() {
  const [text, setText] = useState('');
  const [photoUrl, setPhotoUrl] = useState('');
  const [budget, setBudget] = useState('40');
  const [pickupWindow, setPickupWindow] = useState('today after 3pm');
  const [firstName, setFirstName] = useState('');
  const [phone, setPhone] = useState('');
  const [location, setLocation] = useState(MISSION);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [outcome, setOutcome] = useState<Outcome>();

  useEffect(() => {
    if (!busy) return;
    setProgress(0);
    const t = setInterval(() => setProgress((p) => Math.min(p + 1, PROGRESS.length - 1)), 6000);
    return () => clearInterval(t);
  }, [busy]);

  const here = () =>
    navigator.geolocation?.getCurrentPosition(
      (pos) => setLocation({ lat: pos.coords.latitude, lon: pos.coords.longitude, label: 'Your location' }),
      () => setOutcome({ kind: 'error', message: 'Could not get your location; the Mission District is used instead.' }),
    );

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setOutcome(undefined);
    try {
      const res = await fetch('/api/errands', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text, photoUrl, budgetDollars: Number(budget), pickupWindow, firstName, phone, location }),
      });
      const body = await res.json();
      if (body.ok) {
        sessionStorage.setItem(`approve:${body.errandId}`, body.approveUrl);
        setOutcome({ kind: 'plan', data: body });
      } else if (body.question) setOutcome({ kind: 'question', question: body.question });
      else setOutcome({ kind: 'error', message: typeof body.error === 'string' ? body.error : 'Something went wrong.' });
    } catch {
      setOutcome({ kind: 'error', message: 'Could not reach Legwork. Try again.' });
    } finally {
      setBusy(false);
    }
  }

  if (outcome?.kind === 'plan') return <PlanReady data={outcome.data} budget={Number(budget)} />;

  return (
    <div className="stack">
      <div>
        <h1>What do you need from a local shop?</h1>
        <p className="muted">
          Legwork phones nearby shops for you, gets quotes, and confirms the best one. PayPal holds your budget before any call and pays the
          shop only for what they agree to.
        </p>
      </div>

      <form className="card stack" onSubmit={submit}>
        <label>
          Your request
          <textarea required value={text} onChange={(e) => setText(e.target.value)} placeholder="My shower drips. It needs a Moen 1222 cartridge, today if possible." />
        </label>
        <label>
          Photo <span className="hint">optional: a public https link to a photo of the part or item</span>
          <input type="url" value={photoUrl} onChange={(e) => setPhotoUrl(e.target.value)} placeholder="https://…" />
        </label>
        <div className="row">
          <label>
            Most you will pay (USD)
            <input required type="number" min="1" max="10000" step="1" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </label>
          <label>
            When you can collect
            <input required value={pickupWindow} onChange={(e) => setPickupWindow(e.target.value)} />
          </label>
        </div>
        <div className="row">
          <label>
            Your first name <span className="hint">the shops hear only this</span>
            <input required value={firstName} onChange={(e) => setFirstName(e.target.value)} autoComplete="given-name" />
          </label>
          <label>
            Your phone <span className="hint">optional: for your pickup code by text</span>
            <input type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+14155550123" autoComplete="tel" />
          </label>
        </div>
        <div className="actions small">
          <span className="muted">Shops near: {location.label}</span>
          <button type="button" className="button secondary" onClick={here}>
            Use my location
          </button>
        </div>

        {outcome?.kind === 'question' && (
          <div className="callout warn">
            <strong>One question first:</strong> {outcome.question}
            <div className="small muted">Add the answer to your request and send it again.</div>
          </div>
        )}
        {outcome?.kind === 'error' && <div className="callout bad">{outcome.message}</div>}

        <div className="actions">
          <button className="button" disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : null}
            {busy ? `${PROGRESS[progress]}…` : 'Plan my errand'}
          </button>
          <span className="small muted">Nothing is held or called until you approve in PayPal.</span>
        </div>
      </form>
    </div>
  );
}

function PlanReady({ data, budget }: { data: PlanResponse; budget: number }) {
  const { plan } = data;
  const now = plan.shops.slice(0, 3);
  const reserve = plan.shops.slice(3);
  return (
    <div className="stack">
      <div>
        <h1>Here is the plan</h1>
        <p className="muted">Approve the hold in PayPal and Legwork starts calling. Nothing is charged until a shop agrees.</p>
      </div>
      <div className="card stack">
        <div>
          <div className="small muted">Legwork will ask for</div>
          <h2>
            {plan.quantity > 1 ? `${plan.quantity} × ` : ''}
            {plan.item}
          </h2>
          <div className="small muted">Pickup {plan.pickupWindow}</div>
        </div>
        {plan.benchmark ? (
          <div className="callout good small">
            Online it is {usd(plan.benchmark.price)} ({plan.benchmark.url ? <a href={plan.benchmark.url} target="_blank" rel="noreferrer">{plan.benchmark.source}</a> : plan.benchmark.source}). Legwork asks the shops to come close
            to it.
          </div>
        ) : null}
        <div>
          <div className="small muted">Calling at once</div>
          <ul className="shops">
            {now.map((s) => (
              <li key={s.businessId}>
                <span>{s.name}</span>
                <span className="muted small mono">{s.phone}</span>
              </li>
            ))}
          </ul>
          {reserve.length ? <p className="small muted">In reserve: {reserve.map((s) => s.name).join(', ')}</p> : null}
        </div>
        {data.reasoning ? <p className="small muted">{data.reasoning}</p> : null}
        <div className="actions">
          <a className="button" href={data.approveUrl}>
            Approve the ${budget.toFixed(0)} hold in PayPal
          </a>
          <Link className="button secondary" href={`/errands/${data.errandId}`}>
            Open mission control
          </Link>
        </div>
      </div>
    </div>
  );
}
