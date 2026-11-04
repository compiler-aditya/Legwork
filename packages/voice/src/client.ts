/**
 * The ElevenLabs Agents endpoints Legwork uses, over fetch. Bodies are the
 * REST wire format (snake_case), as in ElevenLabs' API reference.
 */
export interface ElevenLabsOptions {
  apiKey: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export class ElevenLabsApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: unknown,
    message: string,
  ) {
    super(message);
    this.name = 'ElevenLabsApiError';
  }
}

export interface OutboundCallInput {
  agentId: string;
  agentPhoneNumberId: string;
  /** E.164, e.g. +14155550123. */
  toNumber: string;
  /** Values for the agent's {{placeholders}} and tool fields bound to them. All strings. */
  dynamicVariables: Record<string, string | number | boolean>;
  recording?: boolean;
}

export interface OutboundCallResult {
  conversationId: string;
  callSid?: string;
}

export class ElevenLabsClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetch: typeof fetch;

  constructor(opts: ElevenLabsOptions) {
    this.apiKey = opts.apiKey;
    this.baseUrl = (opts.baseUrl ?? 'https://api.elevenlabs.io').replace(/\/$/, '');
    this.fetch = opts.fetch ?? globalThis.fetch;
  }

  /** Places a call through the Twilio number imported into ElevenLabs. */
  async outboundCall(input: OutboundCallInput): Promise<OutboundCallResult> {
    if (!/^\+[1-9]\d{6,14}$/.test(input.toNumber)) throw new Error(`Not an E.164 number: ${input.toNumber}`);
    const res = await this.request<{ success: boolean; message?: string; conversation_id?: string | null; callSid?: string | null }>(
      'POST',
      '/v1/convai/twilio/outbound-call',
      {
        agent_id: input.agentId,
        agent_phone_number_id: input.agentPhoneNumberId,
        to_number: input.toNumber,
        conversation_initiation_client_data: { dynamic_variables: input.dynamicVariables },
        ...(input.recording === undefined ? {} : { call_recording_enabled: input.recording }),
      },
    );
    if (!res.success || !res.conversation_id) {
      throw new ElevenLabsApiError(200, res, `ElevenLabs did not place the call: ${res.message ?? 'no conversation id'}`);
    }
    return { conversationId: res.conversation_id, ...(res.callSid ? { callSid: res.callSid } : {}) };
  }

  getConversation(conversationId: string): Promise<Record<string, unknown>> {
    return this.request('GET', `/v1/convai/conversations/${encodeURIComponent(conversationId)}`);
  }

  getAgent(agentId: string): Promise<{ agent_id: string; name: string } & Record<string, unknown>> {
    return this.request('GET', `/v1/convai/agents/${encodeURIComponent(agentId)}`);
  }

  async createAgent(body: Record<string, unknown>): Promise<string> {
    const res = await this.request<{ agent_id: string }>('POST', '/v1/convai/agents/create', body);
    return res.agent_id;
  }

  async updateAgent(agentId: string, body: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/v1/convai/agents/${encodeURIComponent(agentId)}`, body);
  }

  async listTools(): Promise<Array<{ id: string; tool_config: { name: string; type: string } }>> {
    const res = await this.request<{ tools: Array<{ id: string; tool_config: { name: string; type: string } }> }>('GET', '/v1/convai/tools');
    return res.tools;
  }

  async createTool(toolConfig: Record<string, unknown>): Promise<string> {
    const res = await this.request<{ id: string }>('POST', '/v1/convai/tools', { tool_config: toolConfig });
    return res.id;
  }

  async updateTool(toolId: string, toolConfig: Record<string, unknown>): Promise<void> {
    await this.request('PATCH', `/v1/convai/tools/${encodeURIComponent(toolId)}`, { tool_config: toolConfig });
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'xi-api-key': this.apiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    let parsed: unknown = undefined;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (!res.ok) {
      const detail = (parsed as { detail?: unknown } | undefined)?.detail ?? parsed;
      const message = typeof detail === 'string' ? detail : JSON.stringify(detail);
      throw new ElevenLabsApiError(res.status, detail, `ElevenLabs ${method} ${path} failed with ${res.status}: ${message}`);
    }
    return parsed as T;
  }
}
