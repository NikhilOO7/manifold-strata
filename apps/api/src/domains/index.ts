import type { DomainConfig } from './types';
import { defaultDomain } from './default';
import { gaussianSplattingDomain } from './gaussian-splatting';
import { nlpDomain } from './nlp';

export type { DomainConfig } from './types';

export const DEFAULT_DOMAIN_ID = defaultDomain.id;

const registry = new Map<string, DomainConfig>(
  [defaultDomain, gaussianSplattingDomain, nlpDomain].map((d) => [d.id, d])
);

/** Resolve a domain id to its config, falling back to the default domain. */
export function getDomain(id?: string | null): DomainConfig {
  if (id && registry.has(id)) return registry.get(id)!;
  return defaultDomain;
}

export function listDomains(): DomainConfig[] {
  return [...registry.values()];
}

export function isKnownDomain(id: string): boolean {
  return registry.has(id);
}
