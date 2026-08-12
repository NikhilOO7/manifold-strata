import { Hono } from 'hono';
import { db } from '../db';
import { papers, nodes, edges, propositions, communities } from '../db/schema';
import { isNull, sql } from 'drizzle-orm';
import { listDomains, isKnownDomain, getDomain } from '../domains';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import { routeError } from './errors';

export const domainsRouter = new Hono();

// List registered domains.
domainsRouter.get('/', (c) => {
  return c.json({
    domains: listDomains().map((d) => ({
      id: d.id,
      name: d.name,
      description: d.description,
      entityTypes: d.entityTypes,
      relationshipTypes: d.relationshipTypes,
      seedCount: d.seedPaperIds?.length ?? 0,
    })),
  });
});

// Full config for one domain.
domainsRouter.get('/:id', (c) => {
  const id = c.req.param('id');
  if (!isKnownDomain(id)) return c.json({ error: `Unknown domain: ${id}` }, 404);
  return c.json(getDomain(id));
});

/**
 * Adopt legacy (NULL-domain) data into a domain — a one-time migration helper.
 *
 * This is the most destructive endpoint in the API: it rewrites the domain of
 * every unstamped row across five tables in one shot, and there is no inverse
 * (once stamped, the rows are indistinguishable from natively-ingested ones).
 * Two guards therefore apply:
 *
 *  1. The target must be a *registered* domain. It previously accepted any
 *     string, so `{"domain":"nlpp"}` stamped the entire legacy corpus into a
 *     domain that no query can ever select — the default filter no longer
 *     matched those rows (they were no longer NULL) and nothing else did either.
 *  2. `dryRun` is available, and the response always reports per-table counts, so
 *     an operator can see the blast radius before committing.
 */
domainsRouter.post('/backfill', async (c) => {
  try {
    // Destructive and irreversible across five tables — admin only.
    requireScopeOn(c, 'admin', 'domains.backfill');

    const body = await c.req.json().catch(() => ({}));

    if (body?.domain === undefined || body?.domain === null || body?.domain === '') {
      return c.json(
        {
          error: 'domain is required (the domain id to assign legacy NULL-domain rows to)',
          knownDomains: listDomains().map((d) => d.id),
        },
        400
      );
    }

    const target = requireDomain(c, body.domain, 'domains.read').id;
    const dryRun = body?.dryRun === true;

    const countNulls = async (table: any, column: any) => {
      const [row] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(table)
        .where(isNull(column));
      return row?.count ?? 0;
    };

    if (dryRun) {
      return c.json({
        domain: target,
        dryRun: true,
        wouldStamp: {
          papers: await countNulls(papers, papers.domain),
          nodes: await countNulls(nodes, nodes.domain),
          edges: await countNulls(edges, edges.domain),
          propositions: await countNulls(propositions, propositions.domain),
          communities: await countNulls(communities, communities.domain),
        },
      });
    }

    // One transaction: a partial backfill would leave papers in a domain whose
    // nodes are still NULL, which is exactly the paper/entity domain split this
    // work exists to eliminate.
    const stamped = await db.transaction(async (tx) => ({
      papers: (
        await tx.update(papers).set({ domain: target }).where(isNull(papers.domain)).returning({ id: papers.id })
      ).length,
      nodes: (
        await tx.update(nodes).set({ domain: target }).where(isNull(nodes.domain)).returning({ id: nodes.id })
      ).length,
      edges: (
        await tx.update(edges).set({ domain: target }).where(isNull(edges.domain)).returning({ id: edges.id })
      ).length,
      propositions: (
        await tx
          .update(propositions)
          .set({ domain: target })
          .where(isNull(propositions.domain))
          .returning({ id: propositions.id })
      ).length,
      communities: (
        await tx
          .update(communities)
          .set({ domain: target })
          .where(isNull(communities.domain))
          .returning({ id: communities.id })
      ).length,
    }));

    return c.json({ domain: target, stamped });
  } catch (error) {
    return routeError(c, error, 'Backfill failed');
  }
});
