/**
 * Connector registry.
 *
 * Adding a source is a new file plus a line here — deliberately the same shape
 * as the domain registry, and for the same reason: the extension point should be
 * obvious and boring. A DB-backed registry follows once tenants own their own
 * connector configuration.
 */

import type { Connector } from './types';
import { openApiConnector } from './openapi';

export * from './types';

const registry = new Map<string, Connector>([[openApiConnector.id, openApiConnector]]);

export function listConnectors(): Connector[] {
  return [...registry.values()];
}

/**
 * Strict lookup — an unknown connector id is an error naming the valid ones,
 * never a silent fallback. Same contract as domain resolution, for the same
 * reason: quietly doing something other than what the caller asked for is how
 * this system previously leaked data across boundaries.
 */
export function getConnector(id: string): Connector {
  const found = registry.get(id.trim().toLowerCase());
  if (!found) {
    throw new UnknownConnectorError(id, [...registry.keys()]);
  }
  return found;
}

export class UnknownConnectorError extends Error {
  readonly requested: string;
  readonly known: string[];

  constructor(requested: string, known: string[]) {
    super(`Unknown connector "${requested}". Available: ${known.join(', ')}.`);
    this.name = 'UnknownConnectorError';
    this.requested = requested;
    this.known = known;
  }
}
