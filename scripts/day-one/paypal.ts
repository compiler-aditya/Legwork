import { usd } from '@legwork/core';
import {
  FINAL_BATCH_STATUSES,
  PayPalApiError,
  PayPalClient,
  approveLink,
  authorizationOf,
  authorizeOrder,
  cancelPayoutItem,
  captureAuthorization,
  createHoldOrder,
  createPayout,
  createVaultedHold,
  getAuthorization,
  getOrder,
  getPayoutBatch,
  vaultIdOf,
  voidAuthorization,
  type PayoutItem,
  type PayoutItemInput,
  type PayPalEnv,
  type RecipientWallet,
} from '@legwork/paypal';
import { Skip, env, needEnv, sleep, type Run } from './report';

const GROUP = 'PayPal';

export async function paypalChecks(run: Run): Promise<void> {
  let pp: PayPalClient;
  try {
    const e = needEnv('PAYPAL_CLIENT_ID', 'PAYPAL_CLIENT_SECRET');
    pp = new PayPalClient({
      clientId: e.PAYPAL_CLIENT_ID as string,
      clientSecret: e.PAYPAL_CLIENT_SECRET as string,
      env: (env('PAYPAL_ENV') as PayPalEnv | undefined) ?? 'sandbox',
    });
  } catch (err) {
    await run.check(GROUP, 'All PayPal checks', async () => {
      throw err;
    });
    return;
  }
  if (pp.baseUrl.includes('api-m.paypal.com')) {
    await run.check(GROUP, 'Sandbox only', async () => {
      throw new Error('PAYPAL_ENV is live. These checks move money; run them against the sandbox only.');
    });
    return;
  }

  const rid = (step: string) => `lw-check-${run.id}-${step}`;
  const state: { authId?: string; vaultId?: string } = {};

  await run.check(GROUP, 'Credentials work', async () => {
    await pp.accessToken();
    return `OAuth token issued by ${pp.baseUrl}`;
  });

  // First, because it needs nobody: its payout webhooks reach the deployment while the hold waits for approval.
  await run.check(GROUP, 'Cancel an unclaimed payout (shop cancelled after the deposit)', async () => {
    const receiver = `legwork-unclaimed-${run.id}@example.com`;
    const item = await payOne(pp, run, 'unclaimed', { recipientType: 'EMAIL', receiver, amount: usd(100), senderItemId: rid('payout-unclaimed') });
    if (item.transaction_status !== 'UNCLAIMED') {
      throw new Error(`Expected UNCLAIMED for an address with no account, got ${item.transaction_status ?? 'no status'}`);
    }
    // PayPal cancels an item only once its whole batch has finished processing.
    const batch = await waitForBatch(pp, item.batchId);
    const cancelled = await cancelPayoutItem(pp, item.payout_item_id);
    return `item ${item.payout_item_id} was UNCLAIMED; batch ${batch}; item now ${cancelled.transaction_status ?? 'cancelled'}`;
  });

  await run.check(GROUP, 'Budget hold that saves PayPal (one buyer approval)', async () => {
    const order = await createHoldOrder(
      pp,
      {
        amount: usd(4000),
        referenceId: `check-${run.id}`,
        description: 'Legwork day-one check: hold up to $40',
        returnUrl: 'https://example.com/legwork/approved',
        cancelUrl: 'https://example.com/legwork/cancelled',
        savePayPal: true,
      },
      rid('hold'),
    );
    const link = approveLink(order);
    if (!link) throw new Error(`No approve link on order ${order.id} (status ${order.status})`);
    await waitForApproval(pp, order.id, link);
    const authorized = await authorizeOrder(pp, order.id, rid('authorize'));
    const auth = authorizationOf(authorized);
    if (!auth) throw new Error(`Order ${order.id} authorized but no authorization came back (status ${authorized.status})`);
    state.authId = auth.id;
    state.vaultId = vaultIdOf(authorized) ?? vaultIdOf(await getOrder(pp, order.id));
    return `order ${order.id}, authorization ${auth.id} ${auth.status} for ${auth.amount?.value ?? '?'} USD, expires ${auth.expiration_time ?? '?'}`;
  });

  await run.check(GROUP, 'Saved PayPal returned (vault id)', async () => {
    if (!state.authId) throw new Skip('Needs the budget hold check to pass first');
    if (!state.vaultId) {
      throw new Error('No vault id on the authorized order. Turn on "Save payment methods" for the sandbox app and run again.');
    }
    return `vault id ${state.vaultId}`;
  });

  await run.check(GROUP, 'Deposit, then balance, from one hold (partial capture)', async () => {
    if (!state.authId) throw new Skip('Needs the budget hold check to pass first');
    const deposit = await captureAuthorization(pp, state.authId, { amount: usd(1000), finalCapture: false }, rid('capture-deposit'));
    const balance = await captureAuthorization(pp, state.authId, { amount: usd(2400), finalCapture: true }, rid('capture-balance'));
    const after = await getAuthorization(pp, state.authId);
    return `deposit $10.00 ${deposit.status} (${deposit.id}); balance $24.00 ${balance.status} (${balance.id}); the $40 hold is now ${after.status}, the unused $6 released`;
  });

  await run.check(GROUP, 'Hold from saved PayPal with no buyer present, then void', async () => {
    if (!state.vaultId) throw new Skip('Needs a vault id from the earlier check');
    let order = await createVaultedHold(
      pp,
      { vaultId: state.vaultId, amount: usd(5500), referenceId: `check-${run.id}-vaulted`, description: 'Legwork day-one check: saved PayPal hold' },
      rid('hold-vaulted'),
    );
    let auth = authorizationOf(order);
    if (!auth && order.status === 'APPROVED') {
      order = await authorizeOrder(pp, order.id, rid('authorize-vaulted'));
      auth = authorizationOf(order);
    }
    if (!auth) throw new Error(`No authorization from the saved PayPal (order ${order.id}, status ${order.status})`);
    await voidAuthorization(pp, auth.id, rid('void-vaulted'));
    const after = await getAuthorization(pp, auth.id);
    return `order ${order.id} ${order.status}; authorization ${auth.id} ${auth.status}, then ${after.status}`;
  });

  const payoutEmail = env('PAYPAL_TEST_PAYOUT_EMAIL');
  await run.check(GROUP, 'Payout to an email (a sandbox personal account)', async () => {
    if (!payoutEmail) throw new Skip('Set PAYPAL_TEST_PAYOUT_EMAIL to a sandbox personal account email');
    const item = await payOne(pp, run, 'email', { recipientType: 'EMAIL', receiver: payoutEmail, amount: usd(100), senderItemId: rid('payout-email') });
    return describeItem(item);
  });

  const phone = env('PAYPAL_TEST_PAYOUT_PHONE');
  await run.check(GROUP, 'Payout to a phone number on Venmo', async () => {
    if (!phone) throw new Skip('Optional: set PAYPAL_TEST_PAYOUT_PHONE to a US mobile number');
    return tryWallets(pp, run, 'phone', { recipientType: 'PHONE', receiver: phone, amount: usd(100), senderItemId: rid('payout-phone') });
  });

  const handle = env('PAYPAL_TEST_VENMO_HANDLE');
  await run.check(GROUP, 'Payout to a Venmo handle', async () => {
    if (!handle) throw new Skip('Optional: set PAYPAL_TEST_VENMO_HANDLE');
    return tryWallets(pp, run, 'handle', { recipientType: 'USER_HANDLE', receiver: handle, amount: usd(100), senderItemId: rid('payout-handle') });
  });

  run.manual(
    GROUP,
    'Webhook signatures verify on a real delivery',
    'The checks above send real webhook events to the URL registered with npm run paypal:webhook. Look in the deployed API log for "PayPal event" lines for this run (verified) rather than 400 signature replies. Simulated events cannot be signature-verified.',
  );
}

/** Polls the order until the buyer approves it, so the check runs without a terminal to press Enter in. */
async function waitForApproval(pp: PayPalClient, orderId: string, link: string, minutes = 30): Promise<void> {
  console.log(`\n>>> Open this link, sign in as your SANDBOX buyer (a personal test account) and approve.\n>>> Waiting up to ${minutes} minutes:\n    ${link}\n`);
  const deadline = Date.now() + minutes * 60_000;
  while (Date.now() < deadline) {
    const { status } = await getOrder(pp, orderId);
    if (status === 'APPROVED') return;
    if (status === 'VOIDED' || status === 'COMPLETED') throw new Error(`Order ${orderId} is ${status}, not waiting for approval`);
    await sleep(5000);
  }
  throw new Error(`Order ${orderId} was not approved within ${minutes} minutes`);
}

/** Waits for a payout batch to reach a final status (SUCCESS, DENIED, CANCELED); returns it. */
async function waitForBatch(pp: PayPalClient, batchId: string, seconds = 300): Promise<string> {
  const deadline = Date.now() + seconds * 1000;
  for (;;) {
    const status = (await getPayoutBatch(pp, batchId)).batch_header.batch_status;
    if (FINAL_BATCH_STATUSES.has(status)) return status;
    if (Date.now() > deadline) throw new Error(`Payout batch ${batchId} still ${status} after ${seconds} seconds`);
    await sleep(5000);
  }
}

async function payOne(pp: PayPalClient, run: Run, label: string, item: PayoutItemInput): Promise<PayoutItem & { batchId: string }> {
  const created = await createPayout(
    pp,
    {
      senderBatchId: `lw-check-${run.id}-${label}-${item.wallet ?? 'paypal'}`.slice(0, 127),
      emailSubject: 'Legwork day-one check',
      items: [item],
    },
    `lw-check-${run.id}-batch-${label}-${item.wallet ?? 'paypal'}`,
  );
  const batchId = created.batch_header.payout_batch_id;
  for (let i = 0; i < 18; i++) {
    const batch = await getPayoutBatch(pp, batchId);
    const first = batch.items?.[0];
    const itemStatus = first?.transaction_status;
    if (first && itemStatus && itemStatus !== 'PENDING' && itemStatus !== 'NEW') return { ...first, batchId };
    if (FINAL_BATCH_STATUSES.has(batch.batch_header.batch_status) && first) return { ...first, batchId };
    await sleep(5000);
  }
  throw new Error(`Payout batch ${batchId} still pending after 90 seconds`);
}

function describeItem(item: PayoutItem): string {
  const err = item.errors?.name ? ` (${item.errors.name}: ${item.errors.message ?? ''})` : '';
  return `item ${item.payout_item_id} ${item.transaction_status ?? 'no status'}${err}`;
}

/** The spec says "VENMO"; the Venmo payouts guide writes "Venmo". Report which the sandbox takes. */
async function tryWallets(pp: PayPalClient, run: Run, label: string, item: PayoutItemInput): Promise<string> {
  const attempts: string[] = [];
  for (const wallet of ['VENMO', 'Venmo'] as RecipientWallet[]) {
    try {
      const result = await payOne(pp, run, `${label}-${wallet}`, { ...item, wallet, senderItemId: `${item.senderItemId}-${wallet}` });
      if (result.transaction_status === 'FAILED' || result.transaction_status === 'DENIED') {
        attempts.push(`recipient_wallet "${wallet}": ${describeItem(result)}`);
        continue;
      }
      return `recipient_wallet "${wallet}" accepted: ${describeItem(result)}${attempts.length ? `; before that ${attempts.join('; ')}` : ''}`;
    } catch (err) {
      attempts.push(`recipient_wallet "${wallet}": ${err instanceof PayPalApiError ? err.message : String(err)}`);
    }
  }
  throw new Error(attempts.join('; '));
}
