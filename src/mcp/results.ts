import type { CallToolResult } from '@modelcontextprotocol/server';
import { AppError } from '../errors.js';
import { redactText, type Logger } from '../utils/logger.js';

/** Successful tool result: structured content plus the same JSON as text (spec SHOULD). */
export function ok(data: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export interface ToolErrorPayload {
  code: string;
  message: string;
  hint?: string;
}

/**
 * Tool execution errors are returned as results (isError) so the assistant can react
 * (ADR-0008). Messages never include tokens; unexpected errors are not echoed verbatim.
 */
export function toolError(error: unknown, logger: Logger): CallToolResult {
  let payload: ToolErrorPayload;
  if (error instanceof AppError) {
    payload = {
      code: error.code,
      message: redactText(error.message),
      ...(error.hint && { hint: error.hint }),
    };
  } else if (error instanceof Error && error.name === 'AbortError') {
    payload = { code: 'CANCELLED', message: 'The request was cancelled.' };
  } else {
    logger.error('Unexpected tool error', { error });
    payload = {
      code: 'INTERNAL_ERROR',
      message:
        'An unexpected error occurred in netatmo-energy-mcp. Details were written to its log.',
    };
  }
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: payload }) }],
  };
}

export async function runTool(logger: Logger, fn: () => Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    return toolError(error, logger);
  }
}
