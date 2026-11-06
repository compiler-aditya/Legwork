'use client';

import dynamic from 'next/dynamic';
import { useCallback, useEffect, useState } from 'react';
import CallsGrid from '../../../components/CallsGrid';
import { STEPS, confirmation, headline, moneyTrack, needsReview, stepIndex, timeline, usd, type ErrandView } from '../../../lib/view';

// Bryntum touches the DOM when it loads, so it renders in the browser only.
const CallTimeline = dynamic(() => import('../../../components/CallTimeline'), { ssr: false, loading: () => <div className="timeline" /> });

const FINAL = new Set(['settled', 'released', 'failed']);

export default function MissionControl({ id }: { id: string }) {
  const [view, setView] = useState<ErrandView>();
  const [error, setError] = useState<string>();
  const [now, setNow] = useState(() => new Date());
  const [approveUrl, setApproveUrl] = useState<string>();

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/errands/${id}`, { cache: 'no-store' });
      const body = await res.json();
      if (!body.ok) throw new Error(typeof body.error === 'string' ? body.error : 'Could not load the errand');
      setView(body as ErrandView);
      setError(undefined);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
    setNow(new Date());
  }, [id]);

  useEffect(() => {
    setApproveUrl(sessionStorage.getItem(`approve:${id}`) ?? undefined);
    void load();
  }, [id, load]);

  // Every 3 seconds until the errand is over.
  useEffect(() => {
    if (view && FINAL.has(view.errand.state)) return;
    const t = setInterval(() => void load(), 3000);
    return () => clearInterval(t);
  }, [view, load]);

  if (!view) return <div className="card">{error ? <div className="callout bad">{error}</div> : <span className="muted">Loading the errand…</span>}</div>;

  const { errand, outreach } = view;
  const h = headline(errand.state);
  const step = stepIndex(errand.state);
  const confirmed = confirmation(view);
  const shopName = (businessId?: string) => outreach.plan?.shops.find((s) => s.businessId === businessId)?.name ?? businessId ?? 'the shop';
  const contract = errand.contract;

  return (
    <div className="stack">
      <div>
        <span className={`badge ${h.tone}`}>
          <span className="dot" aria-hidden />
          {errand.state.replace(/_/g, ' ')}
        </span>
        <h1 style={{ marginTop: '0.5rem' }}>{h.title}</h1>
        <p className="muted">
          {outreach.plan ? `${outreach.plan.quantity > 1 ? `${outreach.plan.quantity} × ` : ''}${outreach.plan.item}, pickup ${outreach.plan.pickupWindow}` : errand.request.text}
        </p>
        <ol className="steps" aria-label="Progress">
          {STEPS.map((s, i) => (
            <li key={s} className={i < step ? 'done' : i === step ? 'now' : ''}>
              {s}
            </li>
          ))}
        </ol>
      </div>

      {error ? <div className="callout bad small">Lost touch with Legwork ({error}); retrying.</div> : null}
      {errand.attention ? <div className="callout warn">{errand.attention}</div> : null}
      {errand.state === 'hold_pending' && approveUrl ? (
        <div className="callout busy actions">
          <span>PayPal is waiting for you to approve the {usd(errand.budgetMax)} hold.</span>
          <a className="button" href={approveUrl}>
            Approve in PayPal
          </a>
        </div>
      ) : null}

      <div className="cols">
        <section className="card">
          <h2>The money</h2>
          <ul className="money">
            {moneyTrack(errand).map((m) => (
              <li key={m.label} className={m.status}>
                <span className="tick" aria-hidden>
                  ✓
                </span>
                <span>
                  <strong>{m.label}</strong>
                  <div className="small muted">{m.detail}</div>
                </span>
                <span className="amount">{m.amount}</span>
              </li>
            ))}
          </ul>
        </section>

        {contract ? (
          <section className="card">
            <h2>Your pickup</h2>
            <p className="small muted">
              {shopName(contract.businessId)}
              {contract.pickupAt ? `, ready ${contract.pickupAt}` : ''}. Give them this code at the counter; they text it back and PayPal pays the rest.
            </p>
            <div className="code" aria-label="Pickup code">
              {contract.pickupCode}
            </div>
            <p className="small muted">
              {contract.quantity} × {contract.item}, {usd(contract.total)} in all
            </p>
            {errand.state === 'awaiting_pickup' ? <DemoCode id={id} code={contract.pickupCode} onDone={load} /> : null}
          </section>
        ) : (
          <section className="card">
            <h2>Who Legwork is calling</h2>
            <ul className="shops">
              {(outreach.plan?.shops ?? []).map((s, i) => (
                <li key={s.businessId}>
                  <span>{s.name}</span>
                  <span className="small muted">{i < 3 ? 'first round' : 'reserve'}</span>
                </li>
              ))}
            </ul>
            {outreach.plan?.benchmark ? <p className="small muted" style={{ marginTop: '0.75rem' }}>Online: {usd(outreach.plan.benchmark.price)} at {outreach.plan.benchmark.source}</p> : null}
          </section>
        )}
      </div>

      <section className="card stack">
        <h2>The calls</h2>
        {outreach.rows.length ? (
          <>
            <CallTimeline data={timeline(view, now)} />
            <CallsGrid rows={outreach.rows} plan={outreach.plan} />
          </>
        ) : (
          <p className="muted small">The calls start as soon as PayPal confirms the hold.</p>
        )}
      </section>

      {confirmed?.review ? (
        <section className="card">
          <h2>What the shop agreed to, in their words</h2>
          {needsReview(confirmed.review) ? (
            <div className="callout warn small" style={{ marginBottom: '0.75rem' }}>
              Check this before pickup:{' '}
              {[
                ...confirmed.review.mismatches.map((m) => `the call says ${m.field === 'totalCents' ? usd({ cents: Number(m.fromTranscript), currency: 'USD' }) : m.fromTranscript} for ${m.field.replace('Cents', '')}, the order has ${m.field === 'totalCents' ? usd({ cents: Number(m.fromTools), currency: 'USD' }) : m.fromTools}`),
                ...confirmed.review.unverified.map((f) => `${f.replace('Cents', '')} is not quoted from the call`),
                ...(confirmed.review.agreed ? [] : ['the transcript does not show the shop agreeing']),
              ].join('; ')}
            </div>
          ) : (
            <div className="callout good small" style={{ marginBottom: '0.75rem' }}>
              Matches the order Legwork recorded on the call.
            </div>
          )}
          {confirmed.review.terms ? (
            <table className="terms">
              <tbody>
                {(
                  [
                    ['Item', confirmed.review.terms.item.value, confirmed.review.terms.item],
                    ['Quantity', String(confirmed.review.terms.quantity.value), confirmed.review.terms.quantity],
                    ['Total', usd({ cents: confirmed.review.terms.totalCents.value, currency: 'USD' }), confirmed.review.terms.totalCents],
                    ['Ready', confirmed.review.terms.readyAt.value, confirmed.review.terms.readyAt],
                  ] as const
                ).map(([label, value, t]) => (
                  <tr key={label}>
                    <th>{label}</th>
                    <td>
                      {value}
                      <div className="quote small">
                        “{t.quote}” at {t.at}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}

/** Demo only: the shop texting back the code, for runs without Twilio. */
function DemoCode({ id, code, onDone }: { id: string; code: string; onDone: () => Promise<void> }) {
  const [reply, setReply] = useState<string>();
  const [busy, setBusy] = useState(false);
  return (
    <div className="stack small" style={{ marginTop: '0.5rem' }}>
      <button
        className="button secondary"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          const res = await fetch(`/api/errands/${id}/pickup-code`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code }) });
          const body = await res.json();
          setReply(body.reply ?? body.error);
          setBusy(false);
          await onDone();
        }}
      >
        Demo: the shop texts back the code
      </button>
      {reply ? <div className="callout good">{reply}</div> : null}
    </div>
  );
}
