import type { DomainConfig } from './types';
import { defaultDomain } from './default';
import { gaussianSplattingDomain } from './gaussian-splatting';
import { nlpDomain } from './nlp';
import { apiSurfaceDomain } from './api-surface';

export type { DomainConfig } from './types';

export const DEFAULT_DOMAIN_ID = defaultDomain.id;

const registry = new Map<string, DomainConfig>(
  [defaultDomain, gaussianSplattingDomain, nlpDomain, apiSurfaceDomain].map((d) => [d.id, d])
);

/**
 * Raised when a caller names a domain that isn't registered.
 *
 * This exists because the alternative — quietly substituting the default domain —
 * breaks isolation in both directions:
 *
 *  - On read, `?domain=nlpp` (a typo) returned the *default* domain's nodes with
 *    a 200 and no indication the scope was not honoured. Asking for one field's
 *    graph and silently receiving another's is the exact failure this product
 *    claims to prevent.
 *  - On write, ingesting with `domain: "nlpp"` stored that raw string on the
 *    paper while stamping every node/edge/proposition it produced as `default`.
 *    Those entities then merged with — and resolved against — unrelated fields'
 *    entities in the shared default bucket. Nothing recorded where they came
 *    from, so the contamination was permanent and unfilterable.
 *
 * Unknown domains therefore fail closed, loudly, at the edge.
 */
export class UnknownDomainError extends Error {
  readonly requested: string;
  readonly known: string[];

  constructor(requested: string) {
    const known = [...registry.keys()];
    super(`Unknown domain "${requested}". Registered domains: ${known.join(', ')}.`);
    this.name = 'UnknownDomainError';
    this.requested = requested;
    this.known = known;
  }
}

/**
 * Canonical form of a domain id. Ids are lowercase kebab-case, so `" NLP "` and
 * `"nlp"` name the same domain. Normalising at the edge — and persisting only
 * the normalised id — is what keeps `papers.domain` and `nodes.domain` from
 * drifting apart on nothing more than whitespace or capitalisation.
 */
export function normalizeDomainId(id: string): string {
  return id.trim().toLowerCase();
}

/**
 * Strict resolution for anything a caller supplied (HTTP query/body, MCP tool
 * argument, CLI flag).
 *
 * - `undefined` / `null` / `''` → the default domain (no domain was requested).
 * - a registered id (after normalisation) → that domain.
 * - anything else → throws {@link UnknownDomainError}.
 */
export function resolveDomain(id?: string | null): DomainConfig {
  if (id === undefined || id === null) return defaultDomain;

  const normalized = normalizeDomainId(String(id));
  if (normalized === '') return defaultDomain;

  const found = registry.get(normalized);
  if (!found) throw new UnknownDomainError(String(id));
  return found;
}

/**
 * Resolution for a domain id read back out of the database.
 *
 * `NULL` is legitimate — it marks rows created before domains existed, which the
 * default domain adopts. A *non-null but unregistered* value is not legitimate:
 * it means the row was written before ingress validation existed (or a domain
 * was deleted from the registry while its data remained). Processing it under
 * the default ontology is what caused contamination, so it throws too, and the
 * error names the row so an operator can fix or backfill it.
 */
export function resolveStoredDomain(id: string | null | undefined, context: string): DomainConfig {
  if (id === null || id === undefined || id === '') return defaultDomain;

  const normalized = normalizeDomainId(id);
  const found = registry.get(normalized);
  if (!found) {
    throw new UnknownDomainError(
      `${id}" stored on ${context} — register the domain in apps/api/src/domains/, or reassign the row with POST /api/domains/backfill. (raw value: "${id}`
    );
  }
  return found;
}

/**
 * Lenient resolution: unknown ids fall back to the default domain.
 *
 * Kept only for callers that need an ontology to *prompt with* and have no
 * isolation consequence (e.g. the extractor's default when no domain is passed).
 * Never use this to decide what to read, write, or filter — use
 * {@link resolveDomain} or {@link resolveStoredDomain} there.
 */
export function getDomain(id?: string | null): DomainConfig {
  if (id) {
    const found = registry.get(normalizeDomainId(id));
    if (found) return found;
  }
  return defaultDomain;
}

export function listDomains(): DomainConfig[] {
  return [...registry.values()];
}

export function isKnownDomain(id: string): boolean {
  return registry.has(normalizeDomainId(id));
}
