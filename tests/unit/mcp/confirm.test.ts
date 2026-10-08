import {
  CLIENT_CAPABILITIES_META_KEY,
  PROTOCOL_VERSION_META_KEY,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import { describe, expect, it, vi } from 'vitest';
import type { ChangePlan } from '../../../src/domain/control-service.js';
import { confirmAndApply, ConfirmationTokens } from '../../../src/mcp/confirm.js';
import { silentLogger } from '../../../src/utils/logger.js';

/** A plan whose request (what would be sent to Netatmo) can vary between calls. */
function planFactory(requests: Record<string, unknown>[], title = 'Set Bedroom to 19 °C?') {
  const apply = vi.fn(async () => ({ status: 'applied' }));
  let i = 0;
  const makePlan = async (): Promise<ChangePlan> => ({
    action: 'set_room_setpoint',
    title,
    changes: ['Bedroom: 18 → 19 °C'],
    warnings: [],
    request: requests[Math.min(i++, requests.length - 1)]!,
    apply,
  });
  return { makePlan, apply };
}

const legacyServer = { server: { getClientCapabilities: () => ({}) } } as unknown as McpServer;

function ctx(extra: Partial<ServerContext['mcpReq']> = {}): ServerContext {
  return {
    mcpReq: { signal: new AbortController().signal, ...extra },
  } as unknown as ServerContext;
}

function modernCtx(extra: Record<string, unknown> = {}): ServerContext {
  return ctx({
    envelope: {
      [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
      [CLIENT_CAPABILITIES_META_KEY]: { elicitation: { form: {} } },
    },
    ...extra,
  });
}

const body = (r: unknown) =>
  JSON.parse((r as { content: { text: string }[] }).content[0]!.text) as Record<string, any>;

describe('token confirmation (clients without elicitation)', () => {
  it('rejects the token when the change to send differs from the preview', async () => {
    const c = { server: legacyServer, tokens: new ConfirmationTokens(), logger: silentLogger };
    const { makePlan, apply } = planFactory([{ temp: 19 }, { temp: 25 }]);
    const preview = body(await confirmAndApply(c, ctx(), 'tool', { room: 'b' }, makePlan));
    expect(preview.status).toBe('confirmation_required');
    const res = body(
      await confirmAndApply(
        c,
        ctx(),
        'tool',
        { room: 'b', confirmation_token: preview.confirmation_token },
        makePlan,
      ),
    );
    expect(res.error.code).toBe('INVALID_ARGUMENT');
    expect(apply).not.toHaveBeenCalled();
  });

  it('collapses control characters from Netatmo names in the preview', async () => {
    const c = { server: legacyServer, tokens: new ConfirmationTokens(), logger: silentLogger };
    const { makePlan } = planFactory([{}], 'Set Kitchen\n• fake line x?');
    const preview = body(await confirmAndApply(c, ctx(), 'tool', {}, makePlan));
    expect(preview.title).toBe('Set Kitchen • fake line x?');
  });

  it('refuses changes without elicitation when NETATMO_MCP_CONFIRM=elicitation', async () => {
    const c = {
      server: legacyServer,
      tokens: new ConfirmationTokens(),
      logger: silentLogger,
      mode: 'elicitation' as const,
    };
    const { makePlan, apply } = planFactory([{}]);
    const res = body(await confirmAndApply(c, ctx(), 'tool', {}, makePlan));
    expect(res.error.code).toBe('UNSUPPORTED_CAPABILITY');
    expect(res.confirmation_token).toBeUndefined();
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('NETATMO_MCP_CONFIRM=token', () => {
  it('uses the preview + token flow even when the client advertises elicitation', async () => {
    const c = {
      server: legacyServer,
      tokens: new ConfirmationTokens(),
      logger: silentLogger,
      mode: 'token' as const,
    };
    const { makePlan, apply } = planFactory([{}]);
    const preview = body(await confirmAndApply(c, modernCtx(), 'tool', {}, makePlan));
    expect(preview.status).toBe('confirmation_required');
    const res = body(
      await confirmAndApply(
        c,
        modernCtx(),
        'tool',
        { confirmation_token: preview.confirmation_token },
        makePlan,
      ),
    );
    expect(res.status).toBe('applied');
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

describe('2026-07-28 elicitation', () => {
  const accepted = { confirm: { action: 'accept', content: { confirm: true } } };

  it('ignores an acceptance the server never asked for', async () => {
    const c = { server: legacyServer, tokens: new ConfirmationTokens(), logger: silentLogger };
    const { makePlan, apply } = planFactory([{}]);
    const res = await confirmAndApply(
      c,
      modernCtx({ inputResponses: accepted, requestState: () => undefined }),
      'tool',
      {},
      makePlan,
    );
    expect(body(res).error.code).toBe('INVALID_ARGUMENT');
    expect(apply).not.toHaveBeenCalled();
  });

  it('applies only with the single-use state minted for this exact change', async () => {
    const c = { server: legacyServer, tokens: new ConfirmationTokens(), logger: silentLogger };
    const { makePlan, apply } = planFactory([{ temp: 19 }]);
    const first = (await confirmAndApply(c, modernCtx(), 'tool', {}, makePlan)) as {
      requestState?: string;
    };
    expect(typeof first.requestState).toBe('string');
    const retry = () =>
      confirmAndApply(
        c,
        modernCtx({ inputResponses: accepted, requestState: () => first.requestState }),
        'tool',
        {},
        makePlan,
      );
    expect(body(await retry()).status).toBe('applied');
    // Replaying the same state does not apply the change twice.
    expect(body(await retry()).error.code).toBe('INVALID_ARGUMENT');
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
