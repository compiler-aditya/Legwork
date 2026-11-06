# Day-one checks

The design relies on a handful of things nobody has run yet in this sandbox. `npm run check:day-one` runs them and writes the results to `.day-one/results-<run>.md`. A failure changes the plan, so these come before any feature work.

## Setup before the first run

1. **PayPal sandbox app** ([developer dashboard](https://developer.paypal.com/dashboard/applications/sandbox), Sandbox toggle on):
   - Create a Merchant app on a sandbox business account; copy its client id and secret into `.env`.
   - Under the app's features, turn on **Save payment methods** (vault) and **Payouts**.
   - On the sandbox business account, turn on **partial capture** (needed for deposit then balance).
   - Create a sandbox **personal** account in the same country. Its email goes in `PAYPAL_TEST_PAYOUT_EMAIL`; you sign in as it to approve the test hold.
   - Settings can take 10 to 15 minutes to apply.
2. **ElevenLabs**: create the voice agent, import a Twilio number, copy the agent id and phone number id. Turn on monitoring in the agent's advanced settings.
3. **Channel3**: sign up at trychannel3.com/developers and apply promo code `PAYPAL-HACKATHON-2026`.
4. **Elastic**: start the serverless trial (Search project), create an API key, copy the endpoint URL.
5. **KERNEL**: claim the $50 credits and create an API key.

Copy `.env.example` to `.env` and fill in what you have; checks whose keys are missing are skipped, not failed.

## Running

```bash
npm run check:day-one
```

```bash
npm run check:day-one -- --only=paypal
```

To place one real AI phone call (only to a number whose owner agreed):

```bash
npm run check:day-one -- --only=elevenlabs --call=+14155550100
```

The PayPal hold check prints a sandbox approval link and waits: open it, sign in as the sandbox personal account, approve, then press Enter.

## What each check proves

| Area | Check | Proves | If it fails |
| --- | --- | --- | --- |
| PayPal | Budget hold that saves PayPal | An `AUTHORIZE` order with `store_in_vault: ON_SUCCESS`, approved once, then authorized | Read the error's `debug_id`; check the app's features |
| PayPal | Saved PayPal returned | The authorized order carries a vault id | Turn on Save payment methods; without it, days-away orders need the buyer again |
| PayPal | Deposit, then balance | Two captures from one $40 hold ($10 with `final_capture: false`, then $24 final); the unused $6 is released | Turn on partial capture; fallback is one capture at pickup and no deposit |
| PayPal | Hold from saved PayPal, buyer not present | A single-call `AUTHORIZE` order from the vault id, then a void | Fallback: the buyer approves again the day before |
| PayPal | Payout to an email | Payouts is on and pays a sandbox account | Enable Payouts for the app |
| PayPal | Payout to a phone on Venmo | `recipient_type: PHONE` with the Venmo wallet works; reports whether the wallet value is `VENMO` or `Venmo` | Fallback: email payouts |
| PayPal | Payout to a Venmo handle | `recipient_type: USER_HANDLE` works | Fallback: phone or email |
| PayPal | Cancel an unclaimed payout | An address with no account goes UNCLAIMED and can be cancelled | Deposits to shops without PayPal become Legwork's risk |
| ElevenLabs | API key and voice agent | The agent exists | Check the key's scope |
| ElevenLabs | Outbound call | `POST /v1/convai/twilio/outbound-call` places a call with dynamic variables | Check the imported Twilio number |
| Channel3 | Text search and image search | The hero part is found with a price; a photo is matched | Ask the buyer for the model number |
| Elastic | semantic_text plus geo_distance | The Offline Index query returns only the nearby shop | Use a keyword match until the inference endpoint is ready |
| KERNEL | Cloud browser with live view | A browser starts and has an embeddable live view URL | Drop the web channel; calls still work |

Checks marked TODO in the output need a person (webhook signatures on a real delivery, call monitoring and latency, the web app trials, Render Workflows).

## Results so far

### PayPal sandbox, 6 November 2026

Run against the US business sandbox app, approved by a US-region sandbox **Personal** buyer, with webhooks delivered to the Vercel development deployment.

| Check | Result |
| --- | --- |
| Credentials | Pass |
| $40 budget hold that saves PayPal | Pass: authorization valid for 29 days; vault id returned |
| $10 deposit then $24 balance from one hold | Pass: the final capture closed the hold and released the unused $6 |
| Hold from saved PayPal with no buyer present, then void | Pass |
| Webhook signatures on real deliveries | Pass: `CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED` and `VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `VAULT.PAYMENT-TOKEN.CREATED`, `PAYMENT.PAYOUTS-ITEM.UNCLAIMED`, `PAYMENT.PAYOUTSBATCH.SUCCESS` all verified |
| Cancel an unclaimed payout | Fail: the sandbox answers `500 INTERNAL_SERVICE_ERROR` to every cancel, for any recipient domain, even after the batch is `SUCCESS` (debug ids `f3370450017be`, `ca563176a8918`, `f844468886dbe`) |
| Payouts to a sandbox email, a phone on Venmo, a Venmo handle | Not run yet: set `PAYPAL_TEST_PAYOUT_EMAIL`, `PAYPAL_TEST_PAYOUT_PHONE`, `PAYPAL_TEST_VENMO_HANDLE` |

What the runs taught us, now in the code:

- PayPal refuses any write without `Content-Type: application/json`, even one with no body (authorize, void, payout-item cancel): `415 UNSUPPORTED_MEDIA_TYPE`. The client always sends it now.
- A payout item can be cancelled only once its whole batch has finished (`BATCH_NOT_COMPLETED`). If a cancel fails, the orchestrator still completes the shop cancellation and flags the payout for a person; an unclaimed payout returns to the sender after 30 days on its own.
- `PAYMENT.PAYOUTS-ITEM.DENIED` is not a PayPal event; `FAILED` and `BLOCKED` are, and the webhook subscribes to them.
- The buyer must be a sandbox **Personal** account (`…@personal.example.com`). Signing in with the Business account that owns the API keys fails with "This PayPal account is associated with the merchant". Use a private window if the browser is already signed in to the sandbox as the business. A sandbox buyer's test card can show as expired; any future expiry and any CVV work.
- `--order=<id>` resumes an approved hold, so a failure after approval does not need a second approval.
