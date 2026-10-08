import {
  ProtocolError,
  ProtocolErrorCode,
  ResourceNotFoundError,
  ResourceTemplate,
  type McpServer,
  type ReadResourceResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { EnergyService } from '../domain/energy-service.js';
import { AppError, NotFoundError } from '../errors.js';
import { redactText } from '../utils/logger.js';

const JSON_MIME = 'application/json';

function json(uri: URL, data: unknown): ReadResourceResult {
  return { contents: [{ uri: uri.href, mimeType: JSON_MIME, text: JSON.stringify(data) }] };
}

/** Resource handlers report failures as JSON-RPC errors (unlike tools). */
async function read(uri: URL, load: () => Promise<unknown>): Promise<ReadResourceResult> {
  try {
    return json(uri, await load());
  } catch (error) {
    if (error instanceof NotFoundError) throw new ResourceNotFoundError(uri.href, error.message);
    if (error instanceof AppError) {
      const hint = error.hint ? ` ${error.hint}` : '';
      throw new ProtocolError(
        ProtocolErrorCode.InternalError,
        `${error.code}: ${redactText(error.message)}${hint}`,
      );
    }
    throw error;
  }
}

function variable(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Read-only JSON resources. Credentials and account data (email, location) are never exposed.
 */
export function registerResources(server: McpServer, service: EnergyService): void {
  const signal = (ctx: ServerContext) => ({ signal: ctx.mcpReq.signal });

  server.registerResource(
    'homes',
    'netatmo://homes',
    {
      title: 'Netatmo homes',
      description: 'Homes with Netatmo Energy devices, with room/device counts.',
      mimeType: JSON_MIME,
    },
    (uri, ctx) => read(uri, () => service.listHomes(signal(ctx))),
  );

  const perHome = (
    suffix: 'rooms' | 'devices' | 'status',
    title: string,
    description: string,
    load: (homeId: string, ctx: ServerContext) => Promise<unknown>,
  ) => {
    server.registerResource(
      `home-${suffix}`,
      new ResourceTemplate(`netatmo://homes/{homeId}/${suffix}`, {
        list: async (ctx) => {
          const { homes } = await service.listHomes(signal(ctx));
          return {
            resources: homes.map((h) => ({
              uri: `netatmo://homes/${encodeURIComponent(h.id)}/${suffix}`,
              name: `${h.name} – ${suffix}`,
              mimeType: JSON_MIME,
            })),
          };
        },
      }),
      { title, description, mimeType: JSON_MIME },
      (uri, variables, ctx) => {
        const homeId = variable(variables.homeId);
        if (!homeId) throw new ResourceNotFoundError(uri.href, 'Missing home ID.');
        return read(uri, () => load(decodeURIComponent(homeId), ctx));
      },
    );
  };

  perHome('rooms', 'Rooms of a home', 'Rooms with their IDs, types and devices.', (id, ctx) =>
    service.listRooms(id, signal(ctx)),
  );
  perHome(
    'devices',
    'Devices of a home',
    'Thermostats, valves and gateways with model, room and gateway.',
    (id, ctx) => service.listDevices(id, signal(ctx)),
  );
  perHome(
    'status',
    'Current status of a home',
    'Current temperatures, setpoints, heating demand, boiler state and alerts.',
    (id, ctx) => service.homeStatus(id, signal(ctx)),
  );
}
