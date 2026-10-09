/**
 * HTTP serving pieces for the remote server (ADR-0013/0014), re-exported from the core so the
 * Worker and the tools share one copy of the MCP SDK.
 */
export { createMcpHandler } from '@modelcontextprotocol/server';
export { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/server/validators/cf-worker';
