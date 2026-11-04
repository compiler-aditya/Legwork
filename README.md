# Legwork

**An AI agent that gets real-world errands done with businesses that have no API, by phone, by their website or by text, while PayPal holds and moves every dollar.**

AI shopping agents can buy from any store that has plugged into them. Most local shops never will: the hardware store, the bakery, the tailor answer a phone. Legwork calls them for you, gets the order agreed in conversation, and pays them through PayPal with no setup on their side.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). Everything runs in the PayPal sandbox; no real money moves.

## How the money works

PayPal is the spine: every errand state change is a PayPal state change, confirmed by a verified webhook.

1. **Budget hold before any call.** The buyer approves one PayPal hold for their maximum (an `AUTHORIZE` order), so "the payment is already held by PayPal" is true on every call.
2. **Deposit when the shop confirms.** Part of the hold is captured (`final_capture: false`) and paid to the shop with Payouts, to the phone number Legwork dialled, an email or a Venmo handle.
3. **Balance at pickup.** When the shop reads back the pickup code, the agreed balance is captured with `final_capture: true` and the unused part of the hold is released.
4. **Cancellations unwind.** No deal voids the hold; a shop cancelling after the deposit refunds it and cancels an unclaimed payout.

Models never move money. Only the orchestrator calls PayPal, from an approved contract, and `assertCaptureAllowed` refuses any capture above the contract total.

## Status

| Part | State |
| --- | --- |
| `packages/core`: errand state machine, money rules, contracts, idempotency ids | Done, tested |
| `packages/paypal`: holds, saved PayPal, captures, voids, refunds, payouts, webhook verification | Done, tested against a fake PayPal |
| `packages/orchestrator`: the money service (hold, deposit, pickup, cancellations), driven by PayPal webhooks | Done, tested against a fake PayPal |
| `packages/db`: Postgres schema and migrations, the errand repo (append-only money rows, an advisory lock per errand across processes), the webhook event store | Done, tested on PGlite and Postgres 16 |
| `apps/api`: PayPal webhook endpoint (verified, de-duplicated, retried if a handler fails) feeding the orchestrator, on Postgres when `DATABASE_URL` is set | Done, tested |
| `scripts/day-one`: checks against the real sandbox and services | Ready to run once credentials are in `.env` |
| Render Workflows wrapper, voice calls (ElevenLabs), agents (Claude), web app (Next.js, Bryntum, AG Studio), Offline Index (Elastic), Channel3, KERNEL | Next |

## Repository

```
packages/core      errand lifecycle, money rules, contract schema (no I/O)
packages/paypal    PayPal REST client and calls
packages/orchestrator  the only code that moves money; errands advance on PayPal webhooks
packages/db        Postgres: migrations, errand repo, webhook event store
apps/api           Fastify API: webhooks and live updates
scripts/day-one    checks against the sandbox and sponsor services
docs/              day-one checks guide
```

## Run it

Requires Node 22.

```bash
npm install
```

```bash
npm test
```

```bash
npm run typecheck
```

The database tests run on PGlite by default. To run them on a real Postgres as well (each run uses a throwaway schema):

```bash
TEST_DATABASE_URL=postgresql://user@localhost:5432/postgres npm test
```

Day-one checks (copy `.env.example` to `.env` first; see [docs/day-one-checks.md](docs/day-one-checks.md)):

```bash
npm run check:day-one
```

## License

MIT, see [LICENSE](LICENSE).
