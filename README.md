# Legwork

**An AI agent that gets real-world errands done with businesses that have no API, by phone, by their website or by text, while PayPal holds and moves every dollar.**

AI shopping agents can buy from any store that has plugged into them. Most local shops never will: the hardware store, the bakery, the tailor answer a phone. Legwork calls them for you, gets the order agreed in conversation, and pays them through PayPal with no setup on their side.

Built for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com/) (2026). Everything runs in the PayPal sandbox; no real money moves.

## How the money works

PayPal is the spine: every errand state change is a PayPal state change, confirmed by a verified webhook.

1. **Budget hold before any call.** The buyer approves one PayPal hold for their maximum (an `AUTHORIZE` order), so "the payment is already held by PayPal" is true on every call.
2. **Deposit when the shop confirms.** Part of the hold is captured (`final_capture: false`) and paid to the shop with Payouts, to the phone number Legwork dialled, an email or a Venmo handle.
3. **Balance at pickup.** When the shop reads back the pickup code, the agreed balance is captured with `final_capture: true` and the unused part of the hold is released.
4. **Pickup by code.** Only the buyer gets the 4-digit pickup code. At the counter they give it to the shop, and the shop texts it back to Legwork; a match captures the balance. The shop never learns the code any other way, so it cannot claim the balance unless the buyer was there, and five wrong codes lock the pickup for a person to look at.
5. **Cancellations unwind.** No deal voids the hold; a shop cancelling after the deposit refunds it and cancels an unclaimed payout.

Models never move money. Only the orchestrator calls PayPal, from an approved contract, and `assertCaptureAllowed` refuses any capture above the contract total.

On the phone, the agent can only say what the shop agreed to. Each call carries a signed token naming its errand, shop and dialled number; the agent's tools send it in a header the model cannot see or change. The API takes the errand and the payout number from the token, so a confused or manipulated agent cannot confirm a deal on another errand or redirect a payout. The pickup code goes to the buyer only; the agent never knows it.

## Status

| Part | State |
| --- | --- |
| `packages/core`: errand state machine, money rules, contracts, idempotency ids | Done, tested |
| `packages/paypal`: holds, saved PayPal, captures, voids, refunds, payouts, webhook verification | Done, tested against a fake PayPal |
| `packages/orchestrator`: the money service (hold, deposit, pickup, cancellations), driven by PayPal webhooks | Done, tested against a fake PayPal |
| `packages/outreach`: the call rounds (3 quote calls at once, the cheapest quote within the hold called back with a counter-offer, the next shop if it declines or cancels, the hold released if nobody can), retries and lost calls | Done, tested |
| `packages/messaging`: texts through Twilio (order summary to the shop, pickup code to the buyer, receipt), the shop texting the code back (signed webhook, 5 wrong codes lock it) | Done, tested |
| `packages/agents`: the contract extractor (Claude Opus 5.5, structured outputs, low effort, server-side refusal fallbacks): the confirmation call into terms tied to transcript lines; quotes checked against their lines, compared with what the agent's tool recorded | Done, tested with a fake Claude |
| `packages/db`: Postgres schema and migrations, the errand repo (append-only money rows, an advisory lock per errand across processes), the webhook event store, the outreach store | Done, tested on PGlite and Postgres 16 |
| `packages/voice`: the ElevenLabs caller (prompt with AI and recording disclosure, `record_quote` and `confirm_order` tools), per-call tokens, outbound calls, signed post-call transcripts | Done, tested against a fake ElevenLabs |
| `apps/api`: PayPal and ElevenLabs webhooks (verified, de-duplicated, retried if a handler fails), the voice agent's tools, errands over HTTP (create, PayPal return, status, timers), on Postgres when `DATABASE_URL` is set | Done; the hero errand runs from request to settled over HTTP in the tests |
| `scripts/day-one`: checks against the real sandbox and services | Ready to run once credentials are in `.env` |
| Planner agent (Claude), web app (Next.js, Bryntum, AG Studio), Offline Index (Elastic), Channel3, KERNEL, Render Workflows | Next |

## Repository

```
packages/core      errand lifecycle, money rules, contract schema (no I/O)
packages/paypal    PayPal REST client and calls
packages/orchestrator  the only code that moves money; errands advance on PayPal webhooks
packages/voice     the ElevenLabs caller, its tools, call tokens and transcripts
packages/outreach  the call rounds: quotes, the best quote, the confirmation call
packages/messaging texts: order, pickup code, the shop texting it back, receipts
packages/agents    Claude: the contract extractor (the planner comes next)
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

### Deploy to Vercel (development)

The development API is live at https://legwork-api-five.vercel.app (Vercel project `legwork-api`, Postgres on Neon through the Vercel Marketplace). Redeploy from a checkout with the Vercel CLI (the project is not connected to Git yet):

```bash
npx vercel deploy --prod
```

Register the deployment as the PayPal app's webhook, then set the printed `PAYPAL_WEBHOOK_ID` on the project and redeploy:

```bash
npm run paypal:webhook -- --url=https://legwork-api-five.vercel.app/webhooks/paypal
```

The API runs on Vercel as one Node.js function. `npm run build:vercel` bundles `apps/api/src/vercel.ts` with esbuild into `.vercel/output` (Build Output API); Vercel runs it as the build command. Work after a webhook reply runs under `waitUntil`, so it finishes before the function is frozen.

The API starts with whatever is configured and `GET /health` says what is on. Set these in the Vercel project (Settings, Environment Variables), then redeploy:

| Variable | Turns on |
| --- | --- |
| `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | PayPal calls |
| `PAYPAL_WEBHOOK_ID` | PayPal webhooks, after registering `<url>/webhooks/paypal` in the PayPal developer dashboard |
| `DATABASE_URL` (Neon from the Vercel Marketplace sets it, and `DATABASE_URL_UNPOOLED`, which is preferred) | Postgres; without it errands live in one function instance's memory |
| `ELEVENLABS_WEBHOOK_SECRET`, `CALL_TOKEN_SECRET` | voice tools and the post-call webhook |

`render.yaml` still describes a long-running deployment on Render.

Voice, once the API is deployed and `PUBLIC_API_URL` points at it: create or update the agent and its tools, then call your own phone.

```bash
npm run voice:setup
```

```bash
npm run voice:call -- --to=+14155550123
```

Start an errand over HTTP (needs `LEGWORK_ADMIN_TOKEN`; the shops' numbers must be in `CALL_ALLOWLIST`). The reply has PayPal's approve link; once the buyer approves, round 1 starts on PayPal's webhook:

```bash
curl -X POST "$PUBLIC_API_URL/errands" -H "Authorization: Bearer $LEGWORK_ADMIN_TOKEN" -H 'Content-Type: application/json' -d '{"userId":"usr_sam","userName":"Sam","request":{"kind":"item","text":"A Moen 1222 cartridge, today"},"budgetMaxCents":4000,"plan":{"item":"a Moen 1222 shower cartridge","quantity":1,"pickupWindow":"today after 3pm","buyerFirstName":"Sam","shops":[{"businessId":"biz_test","name":"Test Shop","phone":"+14155550123"}]}}'
```

Without Twilio, the shop's text with the pickup code can be played by hand: `POST /errands/<id>/pickup-code` with `{"code":"4821"}` and the admin token.

Only call numbers whose owners have agreed to a call from an AI. The agent says it is an AI and that the call is recorded in its first sentence, and never leaves voicemail.

## License

MIT, see [LICENSE](LICENSE).
