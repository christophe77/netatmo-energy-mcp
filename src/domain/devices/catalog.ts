/**
 * Known Netatmo Energy module types (docs/api-capabilities.md §9).
 * `tested` records whether the type has been checked against a real installation;
 * it is only set to true after live validation.
 */
export type DeviceCategory = 'gateway' | 'thermostat' | 'valve' | 'other';

export interface DeviceTypeInfo {
  type: string;
  model: string;
  category: DeviceCategory;
  /** Also a gateway (bridges itself to the cloud). */
  selfBridged?: boolean;
  tested: boolean;
}

const KNOWN: Record<string, DeviceTypeInfo> = {
  NAPlug: { type: 'NAPlug', model: 'Netatmo Thermostat Relay', category: 'gateway', tested: false },
  OTH: { type: 'OTH', model: 'Netatmo OpenTherm Gateway', category: 'gateway', tested: false },
  NATherm1: {
    type: 'NATherm1',
    model: 'Netatmo Smart Thermostat',
    category: 'thermostat',
    tested: false,
  },
  OTM: {
    type: 'OTM',
    model: 'Netatmo OpenTherm Modulating Thermostat',
    category: 'thermostat',
    tested: false,
  },
  NRV: { type: 'NRV', model: 'Netatmo Smart Radiator Valve', category: 'valve', tested: false },
  BNS: {
    type: 'BNS',
    model: 'Smarther with Netatmo (BTicino)',
    category: 'thermostat',
    selfBridged: true,
    tested: false,
  },
};

export function deviceTypeInfo(type: string): DeviceTypeInfo {
  return (
    KNOWN[type] ?? {
      type,
      model: `Unknown device type (${type})`,
      category: 'other',
      tested: false,
    }
  );
}
