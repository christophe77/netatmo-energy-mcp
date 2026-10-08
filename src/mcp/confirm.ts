/**
 * User confirmation for heating changes (ADR-0012).
 *
 * 1. Clients that support elicitation are asked directly:
 *    - protocol 2026-07-28: multi-round-trip `inputRequired` (the client asks the user and retries),
 *    - 2025-era sessions: `elicitInput` during the call.
 * 2. Other clients get a two-step flow: the first call returns a preview and a single-use
 *    confirmation token bound to the exact arguments (5 minutes); the change is applied only when
 *    the tool is called again with that token, which the assistant must do only after the user
 *    explicitly agreed.
 */
import { randomBytes } from 'node:crypto';
import {
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  inputRequired,
  PROTOCOL_VERSION_META_KEY,
  type CallToolResult,
  type InputRequiredResult,
  type McpServer,
  type ServerContext,
} from '@modelcontextprotocol/server';
import * as z from 'zod';
import type { ChangePlan } from '../domain/control-service.js';
import { InvalidArgumentError } from '../errors.js';
import type { Logger } from '../utils/logger.js';
import { ok, toolError } from './results.js';

export const CONFIRMATION_TTL_MS = 5 * 60_000;

const confirmationSchema = z.object({
  confirm: z.boolean().describe('Apply this change to the heating?'),
});

/** In-memory, single-use tokens bound to (tool, arguments). */
export class ConfirmationTokens {
  private readonly tokens = new Map<string, { key: string; expires: number }>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(key: string): string {
    this.prune();
    const token = randomBytes(18).toString('base64url');
    this.tokens.set(token, { key, expires: this.now() + CONFIRMATION_TTL_MS });
    return token;
  }

  /** True if the token exists, is unexpired and was issued for exactly this key. Single use. */
  consume(token: string, key: string): boolean {
    const entry = this.tokens.get(token);
    this.tokens.delete(token);
    return entry !== undefined && entry.key === key && entry.expires > this.now();
  }

  private prune(): void {
    const now = this.now();
    for (const [t, e] of this.tokens) if (e.expires <= now) this.tokens.delete(t);
  }
}

/** Stable key for a tool call's arguments, ignoring the confirmation token itself. */
export function confirmationKey(tool: string, args: Record<string, unknown>): string {
  const canonical = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonical);
    if (v !== null && typeof v === 'object') {
      return Object.fromEntries(
        Object.keys(v)
          .filter((k) => k !== 'confirmation_token')
          .sort()
          .map((k) => [k, canonical((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return `${tool}:${JSON.stringify(canonical(args))}`;
}

function question(plan: ChangePlan): string {
  return [
    plan.title,
    '',
    ...plan.changes.map((c) => `• ${c}`),
    ...plan.warnings.map((w) => `⚠ ${w}`),
  ].join('\n');
}

function cancelled(plan: ChangePlan): CallToolResult {
  return ok({
    status: 'cancelled',
    action: plan.action,
    message: 'The user did not confirm the change. Nothing was modified.',
  });
}

export interface ConfirmContext {
  server: McpServer;
  tokens: ConfirmationTokens;
  logger: Logger;
}

/**
 * Ask for confirmation using the best mechanism the client supports, then apply the plan.
 * `makePlan` is called on every round so the preview reflects the current state.
 */
export async function confirmAndApply(
  c: ConfirmContext,
  ctx: ServerContext,
  tool: string,
  args: Record<string, unknown> & { confirmation_token?: string | undefined },
  makePlan: () => Promise<ChangePlan>,
): Promise<CallToolResult | InputRequiredResult> {
  try {
    const plan = await makePlan();
    const signal = ctx.mcpReq.signal;
    const applyPlan = async () => ok(await plan.apply({ signal }));
    const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
    const modern = envelope?.[PROTOCOL_VERSION_META_KEY] !== undefined;
    const caps = (
      modern
        ? envelope[CLIENT_CAPABILITIES_META_KEY]
        : // 2025-era sessions only expose capabilities from `initialize`.
          // eslint-disable-next-line @typescript-eslint/no-deprecated
          c.server.server.getClientCapabilities()
    ) as { elicitation?: unknown } | undefined;

    if (caps?.elicitation !== undefined && args.confirmation_token === undefined) {
      if (modern) {
        const responses = ctx.mcpReq.inputResponses;
        if (responses && 'confirm' in responses) {
          const answer = acceptedContent(responses, 'confirm', confirmationSchema);
          return answer?.confirm === true ? await applyPlan() : cancelled(plan);
        }
        return inputRequired({
          inputRequests: {
            confirm: inputRequired.elicit({
              message: question(plan),
              requestedSchema: confirmationSchema,
            }),
          },
        });
      }
      // 2025-era clients (most clients today) only support push-style elicitation.
      // eslint-disable-next-line @typescript-eslint/no-deprecated
      const result = await ctx.mcpReq.elicitInput({
        message: question(plan),
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Apply this change to the heating?' } },
          required: ['confirm'],
        },
      });
      const content = result.content as { confirm?: unknown } | undefined;
      return result.action === 'accept' && content?.confirm === true
        ? await applyPlan()
        : cancelled(plan);
    }

    const key = confirmationKey(tool, args);
    if (args.confirmation_token !== undefined) {
      if (!c.tokens.consume(args.confirmation_token, key)) {
        throw new InvalidArgumentError(
          'The confirmation token is invalid, expired, already used, or the arguments changed.',
          { hint: 'Call the tool again without confirmation_token to get a fresh preview.' },
        );
      }
      return await applyPlan();
    }
    return ok({
      status: 'confirmation_required',
      action: plan.action,
      title: plan.title,
      changes: plan.changes,
      warnings: plan.warnings,
      confirmation_token: c.tokens.issue(key),
      expires_in_seconds: CONFIRMATION_TTL_MS / 1000,
      instructions:
        'Nothing has been changed yet. Show these changes to the user and ask for explicit confirmation. Only if the user clearly agrees, call this tool again with exactly the same arguments plus confirmation_token.',
    });
  } catch (error) {
    return toolError(error, c.logger);
  }
}
