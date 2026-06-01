import { eq, isNull, or, type Column, type SQL } from 'drizzle-orm';
import { DEFAULT_DOMAIN_ID } from './index';

/**
 * WHERE clause that scopes a query to a domain. The `default` domain also matches
 * legacy rows with a NULL domain (data created before domains existed), so the
 * system stays backward-compatible without a forced backfill. Specific domains
 * match only their own rows — that's the isolation guarantee.
 */
export function domainWhere(column: Column, domainId: string): SQL | undefined {
  if (domainId === DEFAULT_DOMAIN_ID) {
    return or(eq(column, domainId), isNull(column));
  }
  return eq(column, domainId);
}
