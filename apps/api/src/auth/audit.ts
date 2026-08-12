/**
 * The audit trail.
 *
 * "Monitor every action" is a requirement of the category, and after an incident
 * the question is never "did anything succeed" — it is "what did this credential
 * see, and what did it try to see". So denials are recorded as carefully as
 * successes, and the actor label is denormalised onto the row: a principal that
 * is later deleted must not take its history with it.
 *
 * Writes never block or fail a request. An audit system that can take the API
 * down converts a logging outage into a service outage; one that silently drops
 * records is worse than none at all. So failures are loud in the process log and
 * invisible to the caller.
 */

import { db } from '../db';
import { auditLog } from '../db/schema';
import type { Principal } from './principal';

export type AuditOutcome = 'allowed' | 'denied' | 'error';

export interface AuditEntry {
  principal?: Principal | null;
  action: string;
  domain?: string | null;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Record an action. Fire-and-forget by design — callers must not await it in the
 * request path.
 */
export function recordAudit(entry: AuditEntry): void {
  const principal = entry.principal ?? null;
  // The anonymous principal has no row in `principals`; storing its synthetic id
  // would violate the foreign key, so it is attributed by label only.
  const isRealPrincipal = principal !== null && principal.id !== NIL_UUID;

  void db
    .insert(auditLog)
    .values({
      principalId: isRealPrincipal ? principal!.id : null,
      tenantId: isRealPrincipal ? principal!.tenantId : null,
      actor: principal?.name ?? 'unauthenticated',
      action: entry.action,
      domain: entry.domain ?? null,
      outcome: entry.outcome,
      detail: (entry.detail ?? null) as never,
    })
    .catch((err) => {
      console.error(
        `[audit] failed to record ${entry.action}/${entry.outcome}:`,
        err instanceof Error ? err.message : err
      );
    });
}

/** Truncate free text before it reaches the audit row. */
export function auditText(value: unknown, max = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
