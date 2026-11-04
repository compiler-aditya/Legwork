/**
 * ElevenLabs post-call webhooks, reduced to what Legwork keeps: who said what
 * and when (numbered, so a contract term can cite its line), the tool calls,
 * and the ids we passed in at the start of the call.
 */

export interface TranscriptLine {
  /** Zero-based; contract terms cite this. */
  line: number;
  /** Offset into the call, "mm:ss". */
  at: string;
  seconds: number;
  speaker: 'agent' | 'shop';
  text: string;
}

export interface ToolCallRecord {
  name: string;
  params: unknown;
  at: string;
  /** The transcript line spoken just before the call. */
  afterLine: number;
}

export type CallReport =
  | {
      kind: 'transcript';
      conversationId: string;
      agentId: string;
      status: string;
      errandId?: string;
      outreachId?: string;
      round?: 1 | 2;
      lines: TranscriptLine[];
      toolCalls: ToolCallRecord[];
      durationSecs?: number;
      summary?: string;
      /** ElevenLabs' own verdict: "success", "failure" or "unknown". */
      callSuccessful?: string;
    }
  | {
      kind: 'not_connected';
      conversationId: string;
      agentId: string;
      reason: 'busy' | 'no-answer' | 'unknown';
      errandId?: string;
      outreachId?: string;
    }
  | { kind: 'ignored'; type: string; conversationId?: string };

export class PostCallPayloadError extends Error {}

/** A stable id for de-duplicating retried deliveries. */
export function postCallEventId(payload: { type?: unknown; data?: { conversation_id?: unknown } }): string {
  return `${String(payload.type)}:${String(payload.data?.conversation_id ?? '')}`;
}

export function parsePostCall(rawBody: string): CallReport {
  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new PostCallPayloadError('post-call webhook body is not JSON');
  }
  const type = String(payload?.type ?? '');
  const data = payload?.data;
  if (!data || typeof data.conversation_id !== 'string') throw new PostCallPayloadError('post-call webhook has no conversation_id');
  const vars = (data.conversation_initiation_client_data?.dynamic_variables ?? {}) as Record<string, unknown>;
  const ids = idsFrom(vars);

  if (type === 'call_initiation_failure') {
    const reason = data.failure_reason === 'busy' || data.failure_reason === 'no-answer' ? data.failure_reason : 'unknown';
    return { kind: 'not_connected', conversationId: data.conversation_id, agentId: String(data.agent_id ?? ''), reason, ...ids };
  }
  if (type !== 'post_call_transcription') return { kind: 'ignored', type, conversationId: data.conversation_id };

  const lines: TranscriptLine[] = [];
  const toolCalls: ToolCallRecord[] = [];
  for (const turn of Array.isArray(data.transcript) ? data.transcript : []) {
    const seconds = Number(turn?.time_in_call_secs ?? 0);
    const text = typeof turn?.message === 'string' ? turn.message.trim() : '';
    if (text) {
      lines.push({ line: lines.length, at: mmss(seconds), seconds, speaker: turn.role === 'agent' ? 'agent' : 'shop', text });
    }
    for (const call of Array.isArray(turn?.tool_calls) ? turn.tool_calls : []) {
      let params: unknown = call?.params_as_json;
      try {
        params = JSON.parse(String(call?.params_as_json ?? 'null'));
      } catch {
        // keep the raw string
      }
      toolCalls.push({ name: String(call?.tool_name ?? ''), params, at: mmss(seconds), afterLine: Math.max(0, lines.length - 1) });
    }
  }

  const report: CallReport = {
    kind: 'transcript',
    conversationId: data.conversation_id,
    agentId: String(data.agent_id ?? ''),
    status: String(data.status ?? ''),
    ...ids,
    lines,
    toolCalls,
  };
  const duration = Number(data.metadata?.call_duration_secs);
  if (Number.isFinite(duration)) report.durationSecs = duration;
  if (typeof data.analysis?.transcript_summary === 'string') report.summary = data.analysis.transcript_summary;
  if (typeof data.analysis?.call_successful === 'string') report.callSuccessful = data.analysis.call_successful;
  return report;
}

/** The transcript as numbered lines, for the contract extractor's prompt and the receipt. */
export function transcriptText(lines: TranscriptLine[]): string {
  return lines.map((l) => `[${l.line}] ${l.at} ${l.speaker === 'agent' ? 'Legwork' : 'Shop'}: ${l.text}`).join('\n');
}

function idsFrom(vars: Record<string, unknown>): { errandId?: string; outreachId?: string; round?: 1 | 2 } {
  const out: { errandId?: string; outreachId?: string; round?: 1 | 2 } = {};
  if (typeof vars.errand_id === 'string' && vars.errand_id) out.errandId = vars.errand_id;
  if (typeof vars.outreach_id === 'string' && vars.outreach_id) out.outreachId = vars.outreach_id;
  if (String(vars.round) === '1' || String(vars.round) === '2') out.round = Number(vars.round) as 1 | 2;
  return out;
}

function mmss(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
