import { Hono } from 'hono';
import { db } from '../db';
import { papers, nodes, edges, propositions, communities } from '../db/schema';
import { isNull } from 'drizzle-orm';
import { listDomains, getDomain, isKnownDomain } from '../domains';

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

// Adopt legacy (NULL-domain) data into a domain — one-time migration helper.
domainsRouter.post('/backfill', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const target: string | undefined = body?.domain;
  if (!target) {
    return c.json({ error: 'domain is required (the domain id to assign legacy NULL-domain rows to)' }, 400);
  }

  const stamped = {
    papers: (
      await db.update(papers).set({ domain: target }).where(isNull(papers.domain)).returning({ id: papers.id })
    ).length,
    nodes: (
      await db.update(nodes).set({ domain: target }).where(isNull(nodes.domain)).returning({ id: nodes.id })
    ).length,
    edges: (
      await db.update(edges).set({ domain: target }).where(isNull(edges.domain)).returning({ id: edges.id })
    ).length,
    propositions: (
      await db
        .update(propositions)
        .set({ domain: target })
        .where(isNull(propositions.domain))
        .returning({ id: propositions.id })
    ).length,
    communities: (
      await db
        .update(communities)
        .set({ domain: target })
        .where(isNull(communities.domain))
        .returning({ id: communities.id })
    ).length,
  };

  return c.json({ domain: target, stamped });
});
