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

On the phone, the agent can only say what the shop agreed to. Each call carries a signed token naming its errand, shop and dialled number; the agent's tools send it in a header the model cannot see or change. The API takes the errand and the payout number from the token, so a confused or manipulated agent cannot confirm a deal on another errand or redirect a payout. The pickup code goes to the buyer only; the agent never knows it.

## Status

| Part | State |
| --- | --- |
| `packages/core`: errand state machine, money rules, contracts, idempotency ids | Done, tested |
| `packages/paypal`: holds, saved PayPal, captures, voids, refunds, payouts, webhook verification | Done, tested against a fake PayPal |
| `packages/orchestrator`: the money service (hold, deposit, pickup, cancellations), driven by PayPal webhooks | Done, tested against a fake PayPal |
| `packages/db`: Postgres schema and migrations, the errand repo (append-only money rows, an advisory lock per errand across processes), the webhook event store | Done, tested on PGlite and Postgres 16 |
| `packages/voice`: the ElevenLabs caller (prompt with AI and recording disclosure, `record_quote` and `confirm_order` tools), per-call tokens, outbound calls, signed post-call transcripts | Done, tested against a fake ElevenLabs |
| `apps/api`: PayPal and ElevenLabs webhooks (verified, de-duplicated, retried if a handler fails), the voice agent's tools, on Postgres when `DATABASE_URL` is set | Done, tested |
| `scripts/day-one`: checks against the real sandbox and services | Ready to run once credentials are in `.env` |
| Render Workflows (the outreach rounds), agents (Claude), web app (Next.js, Bryntum, AG Studio), Offline Index (Elastic), Channel3, KERNEL, texts (Twilio) | Next |

## Repository

```
packages/core      errand lifecycle, money rules, contract schema (no I/O)
packages/paypal    PayPal REST client and calls
packages/orchestrator  the only code that moves money; errands advance on PayPal webhooks
packages/voice     the ElevenLabs caller, its tools, call tokens and transcripts
packages/db        Postgres: migrations, errand repo, webhook event store
apps/api           Fastify API: webhooks and live updates
scripts/day-one    checks against the sandbox and sponsor services
scripts/voice      create the ElevenLabs agent from code; place a test call
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

Voice, once the API is deployed and `PUBLIC_API_URL` points at it: create or update the agent and its tools, then call your own phone.

```bash
npm run voice:setup
```

```bash
npm run voice:call -- --to=+14155550123
```

Only call numbers whose owners have agreed to a call from an AI. The agent says it is an AI and that the call is recorded in its first sentence, and never leaves voicemail.

## License

MIT, see [LICENSE](LICENSE).
