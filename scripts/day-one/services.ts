import { Channel3 } from '@channel3/sdk';
import Kernel from '@onkernel/sdk';
import { Skip, env, needEnv, type Run } from './report';

/** ElevenLabs Agents: the key and agent exist; with --call, one real outbound call to a number that agreed to it. */
export async function elevenLabsChecks(run: Run, callTo: string | undefined): Promise<void> {
  const G = 'ElevenLabs';
  await run.check(G, 'API key and voice agent', async () => {
    const e = needEnv('ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID');
    const res = await fetch(`https://api.elevenlabs.io/v1/convai/agents/${encodeURIComponent(e.ELEVENLABS_AGENT_ID as string)}`, {
      headers: { 'xi-api-key': e.ELEVENLABS_API_KEY as string },
    });
    if (!res.ok) throw new Error(`GET agent returned ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const agent = (await res.json()) as { name?: string; agent_id?: string };
    return `agent "${agent.name ?? '?'}" (${agent.agent_id ?? e.ELEVENLABS_AGENT_ID}) found`;
  });

  await run.check(G, 'Outbound call from the Twilio number', async () => {
    if (!callTo) throw new Skip('Run with --call=+1XXXXXXXXXX (a number whose owner agreed to an AI test call)');
    if (!/^\+\d{8,15}$/.test(callTo)) throw new Error(`--call must be E.164, like +14155550100; got ${callTo}`);
    const e = needEnv('ELEVENLABS_API_KEY', 'ELEVENLABS_AGENT_ID', 'ELEVENLABS_PHONE_NUMBER_ID');
    const res = await fetch('https://api.elevenlabs.io/v1/convai/twilio/outbound-call', {
      method: 'POST',
      headers: { 'xi-api-key': e.ELEVENLABS_API_KEY as string, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agent_id: e.ELEVENLABS_AGENT_ID,
        agent_phone_number_id: e.ELEVENLABS_PHONE_NUMBER_ID,
        to_number: callTo,
        conversation_initiation_client_data: {
          dynamic_variables: {
            shop_name: 'Day-one test shop',
            item: 'a Moen 1222 faucet cartridge',
            quantity: 1,
            buyer_first_name: 'Sam',
            round: 1,
          },
        },
      }),
    });
    const body = (await res.json().catch(() => ({}))) as { success?: boolean; message?: string; conversation_id?: string | null; callSid?: string | null };
    if (!res.ok || !body.success) throw new Error(`Outbound call failed (${res.status}): ${body.message ?? 'no message'}`);
    return `call placed: conversation ${body.conversation_id ?? '?'}, Twilio call ${body.callSid ?? '?'}`;
  });

  run.manual(
    G,
    'Live monitoring, steering, webhook tools, post-call webhook, latency',
    'During the test call: watch the monitoring WebSocket for transcript events, send one contextual_update, confirm record_quote reaches the API, check the post-call webhook arrives, and note time to first word and turn latency with Claude Opus 5.5 as the agent model.',
  );
}

/** Channel3: product identification by text and by photo. */
export async function channel3Checks(run: Run): Promise<void> {
  const G = 'Channel3';
  let client: Channel3 | undefined;
  try {
    client = new Channel3({ apiKey: needEnv('CHANNEL3_API_KEY').CHANNEL3_API_KEY as string });
  } catch (err) {
    await run.check(G, 'All Channel3 checks', async () => {
      throw err;
    });
    return;
  }
  const c3 = client;

  await run.check(G, 'Text search finds the hero part with a price', async () => {
    const page = await c3.products.search({ query: 'Moen 1222 faucet cartridge' });
    if (!page.data.length) throw new Error('No products returned');
    return page.data
      .slice(0, 3)
      .map((p) => {
        const offer = p.offers?.[0];
        return `${p.title}${offer ? ` (${offer.price.price} ${offer.price.currency} at ${offer.domain})` : ''}`;
      })
      .join('; ');
  });

  await run.check(G, 'Image search identifies a product from a photo', async () => {
    const imageUrl = env('CHANNEL3_TEST_IMAGE_URL');
    if (!imageUrl) throw new Skip('Optional: set CHANNEL3_TEST_IMAGE_URL to a public photo of a product (ideally a phone photo of the cartridge)');
    const page = await c3.products.searchByImage({ image_url: imageUrl });
    if (!page.data.length) throw new Error('No products matched the image');
    return `top match: ${page.data[0]?.title ?? '?'}; ${page.data.length} results`;
  });
}

/** Elastic: the Offline Index query shape (semantic match on offerings, filtered by distance). */
export async function elasticChecks(run: Run): Promise<void> {
  await run.check('Elastic', 'semantic_text plus geo_distance on serverless', async () => {
    const e = needEnv('ELASTIC_URL', 'ELASTIC_API_KEY');
    const base = (e.ELASTIC_URL as string).replace(/\/+$/, '');
    const index = `legwork-check-${run.id}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { Authorization: `ApiKey ${e.ELASTIC_API_KEY}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) throw new Error(`${method} ${path} returned ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
      return json;
    };
    try {
      await call('PUT', `/${index}`, {
        mappings: { properties: { name: { type: 'text' }, location: { type: 'geo_point' }, offerings: { type: 'semantic_text' } } },
      });
      await call('POST', `/${index}/_doc?refresh=wait_for`, {
        name: 'Hartley Hardware',
        location: { lat: 37.776, lon: -122.418 },
        offerings: 'Plumbing parts, Moen and Delta faucet cartridges, keys cut, paint',
      });
      await call('POST', `/${index}/_doc?refresh=wait_for`, {
        name: 'Far Away Plumbing',
        location: { lat: 34.05, lon: -118.24 },
        offerings: 'Plumbing parts and faucet cartridges',
      });
      const found = (await call('POST', `/${index}/_search`, {
        query: {
          bool: {
            must: [{ semantic: { field: 'offerings', query: 'tap cartridge for a leaking Moen faucet' } }],
            filter: [{ geo_distance: { distance: '5km', location: { lat: 37.7749, lon: -122.4194 } } }],
          },
        },
      })) as { hits?: { hits?: Array<{ _source?: { name?: string } }> } };
      const names = (found.hits?.hits ?? []).map((h) => h._source?.name);
      if (names.length !== 1 || names[0] !== 'Hartley Hardware') {
        throw new Error(`Expected only Hartley Hardware within 5 km, got ${JSON.stringify(names)}`);
      }
      return 'semantic match plus a 5 km filter returned only the nearby shop';
    } finally {
      await call('DELETE', `/${index}`).catch(() => undefined);
    }
  });
}

/** KERNEL: a cloud browser starts and has a live view URL to embed. */
export async function kernelChecks(run: Run): Promise<void> {
  await run.check('KERNEL', 'Cloud browser with a live view URL', async () => {
    const apiKey = needEnv('KERNEL_API_KEY').KERNEL_API_KEY as string;
    const kernel = new Kernel({ apiKey });
    const browser = await kernel.browsers.create({});
    try {
      if (!browser.browser_live_view_url) throw new Error(`Browser ${browser.session_id} has no live view URL`);
      const live = new URL(browser.browser_live_view_url);
      live.searchParams.set('readOnly', 'true');
      return `session ${browser.session_id}; read-only live view ${live.origin}/... (check it loads inside an iframe on our page)`;
    } finally {
      await kernel.browsers.deleteByID(browser.session_id).catch(() => undefined);
    }
  });
}

export function manualChecks(run: Run): void {
  run.manual('Web app', 'Bryntum Scheduler Pro and AG Studio trials render in Next.js', 'Covered when the web app lands: check the trial watermark on video.');
  run.manual('Render', 'Workflows enabled and $50 credits applied', 'Render dashboard: claim credits at credits-portal-mmdm.onrender.com/claim/paypal-ai-hackathon, then create a Workflow service.');
}
