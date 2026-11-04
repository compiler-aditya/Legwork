/**
 * Creates or updates the Legwork caller in your ElevenLabs workspace: the
 * record_quote and confirm_order tools (pointed at PUBLIC_API_URL) and the
 * agent that uses them. Safe to run again after changing the prompt.
 *
 *   npm run voice:setup             create or update
 *   npm run voice:setup -- --dry-run  print what would be sent
 *
 * Needs ELEVENLABS_API_KEY and PUBLIC_API_URL. Set ELEVENLABS_AGENT_ID to
 * update an existing agent; without it a new agent is created and its id printed.
 */
import { ElevenLabsClient, agentBody, confirmOrderTool, recordQuoteTool } from '@legwork/voice';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: use the environment as it is
}

const dryRun = process.argv.includes('--dry-run');
const apiUrl = (process.env.PUBLIC_API_URL ?? '').replace(/\/$/, '');
if (!/^https:\/\//.test(apiUrl)) {
  console.error('Set PUBLIC_API_URL to the https address of the Legwork API (ElevenLabs calls the tools there).');
  process.exit(1);
}
const tools = [recordQuoteTool(apiUrl), confirmOrderTool(apiUrl)];

if (dryRun) {
  console.log(JSON.stringify({ tools, agent: agentBody({ toolIds: ['<record_quote id>', '<confirm_order id>'] }) }, null, 2));
  process.exit(0);
}

const apiKey = process.env.ELEVENLABS_API_KEY;
if (!apiKey) {
  console.error('Set ELEVENLABS_API_KEY.');
  process.exit(1);
}
const client = new ElevenLabsClient({ apiKey });

const existing = await client.listTools();
const toolIds: string[] = [];
for (const tool of tools) {
  const name = String(tool.name);
  const found = existing.find((t) => t.tool_config.name === name && t.tool_config.type === 'webhook');
  if (found) {
    await client.updateTool(found.id, tool);
    console.log(`updated tool ${name} (${found.id})`);
    toolIds.push(found.id);
  } else {
    const id = await client.createTool(tool);
    console.log(`created tool ${name} (${id})`);
    toolIds.push(id);
  }
}

const body = agentBody({
  toolIds,
  ...(process.env.ELEVENLABS_LLM ? { llm: process.env.ELEVENLABS_LLM } : {}),
  ...(process.env.ELEVENLABS_VOICE_ID ? { voiceId: process.env.ELEVENLABS_VOICE_ID } : {}),
});
const agentId = process.env.ELEVENLABS_AGENT_ID;
if (agentId) {
  await client.updateAgent(agentId, body);
  console.log(`updated agent ${agentId}`);
} else {
  const id = await client.createAgent(body);
  console.log(`created agent ${id}\nAdd to .env: ELEVENLABS_AGENT_ID=${id}`);
}
console.log(`\nNext, in ElevenLabs (Agents > Settings > Post-call webhook), point the webhook at ${apiUrl}/webhooks/elevenlabs and put its secret in ELEVENLABS_WEBHOOK_SECRET.`);
