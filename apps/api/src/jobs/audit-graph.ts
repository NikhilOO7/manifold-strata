/**
 * Audit-lane handler: scan a domain for nodes that should not exist.
 *
 * Runs in the background and writes proposals; it never changes the graph. That
 * separation is the whole design — see `quality/audit.ts` for why a cleaner that
 * ran inside extraction would be asking resolution's question with resolution's
 * information and getting resolution's answer.
 */

import { auditDomain } from '../quality/audit';
import { resolveDomain, UnknownDomainError } from '../domains';
import { setJobStatus, PermanentJobError, type Job } from '../queue';

export async function runAuditJob(job: Job): Promise<void> {
  const meta = (job.metadata ?? {}) as { domain?: string };
  if (!meta.domain) {
    throw new PermanentJobError(`Audit job ${job.id} has no domain to scan.`);
  }

  let domainId: string;
  try {
    // Fail closed on an unregistered id, exactly as every other path does.
    domainId = resolveDomain(meta.domain).id;
  } catch (err) {
    if (err instanceof UnknownDomainError) {
      throw new PermanentJobError(err.message, { cause: err });
    }
    throw err;
  }

  await setJobStatus(job.id, { status: 'processing', progress: `Auditing "${domainId}"…` });

  const summary = await auditDomain(domainId);
  const parts = Object.entries(summary.byVerdict)
    .map(([verdict, n]) => `${n} ${verdict}`)
    .join(', ');

  await setJobStatus(job.id, {
    status: 'completed',
    progress:
      `Scanned ${summary.scanned} node(s) in "${domainId}": ` +
      `${summary.findings} finding(s)${parts ? ` (${parts})` : ''}. Nothing was changed.`,
  });
}
