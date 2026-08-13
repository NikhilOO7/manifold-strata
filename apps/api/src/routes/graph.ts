import { Hono, type Context } from 'hono';
import { db } from '../db';
import { nodes, edges, sources, papers, propositions, graphFindings } from '../db/schema';
import { eq, sql, ilike, and, or, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { resolveStoredDomain, DEFAULT_DOMAIN_ID } from '../domains';
import {
  ROLE_ORDER,
  roleForEdgeType,
  roleForIncomingEdgeType,
  invertPhrase,
  type LensRole,
} from '../knowledge-field/lens';
import { domainWhere } from '../domains/filter';
import { requireDomain, requireScopeOn } from '../middleware/auth';
import { createJob } from '../queue';
import { applyFinding, dismissFindings } from '../quality/audit';
import { routeError, isUuid } from './errors';

export const graphRouter = new Hono();

/**
 * Optional `?domain=` filter.
 *
 * Absent → no filter (span every domain), which is the documented behaviour for
 * the graph read endpoints. Present but unregistered → throws, so a typo can
 * never silently widen the scope to the default domain's data.
 */
function optionalDomainFilter(
  c: Context,
  rawDomain: string | undefined,
  column: Parameters<typeof domainWhere>[0]
): SQL | undefined {
  if (!rawDomain) return undefined;
  return domainWhere(column, requireDomain(c, rawDomain, 'graph.read').id);
}

/** Bounded, non-NaN pagination. `parseInt('abc')` is NaN, which Postgres rejects mid-query. */
function pageParams(c: { req: { query: (k: string) => string | undefined } }, maxLimit = 500) {
  const rawLimit = parseInt(c.req.query('limit') || '100', 10);
  const rawOffset = parseInt(c.req.query('offset') || '0', 10);
  const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), maxLimit) : 100;
  const offset = Number.isFinite(rawOffset) ? Math.max(rawOffset, 0) : 0;
  return { limit, offset };
}

graphRouter.get('/nodes', async (c) => {
  try {
    const type = c.req.query('type');
    const search = c.req.query('search');
    const { limit, offset } = pageParams(c);

    const conditions: SQL[] = [];
    if (type) conditions.push(eq(nodes.type, type));
    if (search) conditions.push(ilike(nodes.name, `%${search}%`));

    const domainFilter = optionalDomainFilter(c, c.req.query('domain'), nodes.domain);
    if (domainFilter) conditions.push(domainFilter);

    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const results = await db.select().from(nodes).where(where).limit(limit).offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nodes)
      .where(where);

    return c.json({
      nodes: results,
      pagination: { limit, offset, total: countResult[0]?.count || 0 },
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch nodes');
  }
});

graphRouter.get('/nodes/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const requestedDomain = c.req.query('domain');
    // Validate the scope before touching the database, so an unregistered domain
    // is reported as such rather than masked by whatever the query does first.
    const requestedScope = requestedDomain ? requireDomain(c, requestedDomain, 'graph.read').id : null;

    if (!isUuid(id)) return c.json({ error: 'Node not found' }, 404);

    const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) {
      return c.json({ error: 'Node not found' }, 404);
    }

    // When a scope is requested, a node outside it must be indistinguishable from
    // a node that does not exist — otherwise this endpoint confirms the presence
    // and identity of other domains' entities.
    if (requestedScope && resolveStoredDomain(node.domain, `node ${node.id}`).id !== requestedScope) {
      return c.json({ error: 'Node not found' }, 404);
    }

    // A node's relationships are always read within its own domain, and the
    // *endpoint node* is checked as well as the edge. Filtering on `edges.domain`
    // alone is not enough: an edge that crosses the boundary carries some single
    // domain stamp, so it passes an edge-only filter and drags the out-of-domain
    // node in with it. Domains have no bridge concept, so such an edge is corrupt
    // data and must not be surfaced from either side.
    const nodeDomain = resolveStoredDomain(node.domain, `node ${node.id}`).id;
    const edgeScope = domainWhere(edges.domain, nodeDomain);
    const peerScope = domainWhere(nodes.domain, nodeDomain);

    const outgoing = await db
      .select({ edge: edges, targetNode: nodes })
      .from(edges)
      .innerJoin(nodes, eq(edges.targetId, nodes.id))
      .where(and(eq(edges.sourceId, id), edgeScope, peerScope));

    const incoming = await db
      .select({ edge: edges, sourceNode: nodes })
      .from(edges)
      .innerJoin(nodes, eq(edges.sourceId, nodes.id))
      .where(and(eq(edges.targetId, id), edgeScope, peerScope));

    // The corpus's own words about this entity. For extracted nodes the
    // `description` column is usually empty, so the evidence sentences that
    // mention the node ARE its context — what it is, and how it is used, in the
    // language of the papers that talked about it. GIN-indexed containment.
    const mentions = await db
      .select({ text: propositions.text, section: propositions.section })
      .from(propositions)
      .where(
        and(
          domainWhere(propositions.domain, nodeDomain),
          sql`jsonb_exists(${propositions.nodeIds}, ${id})`
        )
      )
      .limit(6);

    return c.json({
      node,
      domain: nodeDomain,
      mentions,
      outgoingEdges: outgoing.map((o) => ({ ...o.edge, targetNode: o.targetNode })),
      incomingEdges: incoming.map((i) => ({ ...i.edge, sourceNode: i.sourceNode })),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch node');
  }
});

graphRouter.get('/edges', async (c) => {
  try {
    const type = c.req.query('type');
    const { limit, offset } = pageParams(c);

    const conds: SQL[] = [];
    if (type) conds.push(eq(edges.type, type));
    const domainFilter = optionalDomainFilter(c, c.req.query('domain'), edges.domain);
    if (domainFilter) conds.push(domainFilter);

    // Single query with two joins (source + target) instead of 1 + N target
    // lookups. `alias` lets us join the nodes table twice.
    const sourceNodes = alias(nodes, 'source_nodes');
    const targetNodes = alias(nodes, 'target_nodes');

    const results = await db
      .select({ edge: edges, sourceNode: sourceNodes, targetNode: targetNodes })
      .from(edges)
      .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
      .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
      .where(conds.length ? and(...conds) : undefined)
      .limit(limit)
      .offset(offset);

    return c.json({
      edges: results.map((r) => ({ ...r.edge, sourceNode: r.sourceNode, targetNode: r.targetNode })),
      pagination: { limit, offset },
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch edges');
  }
});

graphRouter.get('/subgraph', async (c) => {
  try {
    const nodeId = c.req.query('nodeId');
    const rawDepth = parseInt(c.req.query('depth') || '1', 10);
    const depth = Number.isFinite(rawDepth) ? Math.min(Math.max(rawDepth, 1), 3) : 1;

    if (!nodeId) {
      return c.json({ error: 'nodeId is required' }, 400);
    }

    // Scope first: an unregistered domain is a caller error regardless of whether
    // the node exists, and resolving it after the query let a database error
    // about a malformed id surface as a 500 instead.
    const requestedDomain = c.req.query('domain');
    const requestedScope = requestedDomain ? requireDomain(c, requestedDomain, 'graph.read').id : null;

    if (!isUuid(nodeId)) return c.json({ error: 'Node not found' }, 404);

    const [centerNode] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
    if (!centerNode) {
      return c.json({ error: 'Node not found' }, 404);
    }

    const centerDomain = resolveStoredDomain(centerNode.domain, `node ${centerNode.id}`).id;
    if (requestedScope && requestedScope !== centerDomain) {
      return c.json({ error: 'Node not found' }, 404);
    }

    // Traversal is pinned to the center node's domain, with or without an
    // explicit `?domain=`. An unscoped walk previously hopped through any edge it
    // found, so expanding a node two hops could pull in entities from a research
    // field the caller never asked about.
    const edgeScope = domainWhere(edges.domain, centerDomain);

    const visitedNodeIds = new Set<string>([nodeId]);
    const edgeById = new Map<string, typeof edges.$inferSelect>();
    let frontier = [nodeId];

    for (let d = 0; d < depth && frontier.length > 0; d++) {
      const rows = await db
        .select()
        .from(edges)
        .where(
          and(or(inArray(edges.sourceId, frontier), inArray(edges.targetId, frontier)), edgeScope)
        );
      if (rows.length === 0) break;

      // Verify both endpoints are in-domain before following an edge. The edge's
      // own domain stamp is not sufficient: a boundary-crossing edge carries one
      // side's stamp, so an edge-only filter still admits the far node and, from
      // there, its entire neighbourhood.
      const endpointIds = [...new Set(rows.flatMap((e) => [e.sourceId, e.targetId]))];
      const inDomain = new Set(
        (
          await db
            .select({ id: nodes.id })
            .from(nodes)
            .where(and(inArray(nodes.id, endpointIds), domainWhere(nodes.domain, centerDomain)))
        ).map((n) => n.id)
      );

      const newFrontier: string[] = [];
      for (const edge of rows) {
        if (!inDomain.has(edge.sourceId) || !inDomain.has(edge.targetId)) continue;
        edgeById.set(edge.id, edge);
        for (const nid of [edge.sourceId, edge.targetId]) {
          if (!visitedNodeIds.has(nid)) {
            visitedNodeIds.add(nid);
            newFrontier.push(nid);
          }
        }
      }
      frontier = newFrontier;
    }

    const subgraphNodes = await db
      .select()
      .from(nodes)
      .where(and(inArray(nodes.id, [...visitedNodeIds]), domainWhere(nodes.domain, centerDomain)));

    return c.json({
      nodes: subgraphNodes,
      edges: [...edgeById.values()],
      center: centerNode,
      domain: centerDomain,
      depth,
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch subgraph');
  }
});

graphRouter.get('/stats', async (c) => {
  try {
    const raw = c.req.query('domain');
    const ndw = optionalDomainFilter(c, raw, nodes.domain);
    const edw = optionalDomainFilter(c, raw, edges.domain);
    const pdw = optionalDomainFilter(c, raw, papers.domain);

    const nodeStats = await db
      .select({ type: nodes.type, count: sql<number>`count(*)::int` })
      .from(nodes)
      .where(ndw)
      .groupBy(nodes.type);

    const edgeStats = await db
      .select({ type: edges.type, count: sql<number>`count(*)::int` })
      .from(edges)
      .where(edw)
      .groupBy(edges.type);

    const paperStats = await db
      .select({
        total: sql<number>`count(*)::int`,
        processed: sql<number>`sum(case when processed then 1 else 0 end)::int`,
      })
      .from(papers)
      .where(pdw);

    return c.json({
      nodes: {
        total: nodeStats.reduce((sum, stat) => sum + stat.count, 0),
        byType: nodeStats,
      },
      edges: {
        total: edgeStats.reduce((sum, stat) => sum + stat.count, 0),
        byType: edgeStats,
      },
      papers: {
        total: paperStats[0]?.total || 0,
        processed: paperStats[0]?.processed || 0,
      },
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch stats');
  }
});

// Distinct node/edge types actually present in the graph. Lets the UI populate
// type filters dynamically instead of from a hardcoded list, so newly discovered
// types appear automatically.
/**
 * The most-connected entities in a domain — ranked by the database.
 *
 * The Explorer used to build this list itself: fetch up to 500 nodes and 500
 * edges, count degrees in JavaScript, show the top 14. That is wrong in two ways
 * that compound. The display cap hides entities, which is merely annoying. The
 * *sample* cap makes the ranking itself false — degree counted over an arbitrary
 * 500 edges is not degree, so past a few hundred edges the "most connected"
 * entities are simply whichever hubs happened to fall inside the window. It is
 * the same defect class as ranking over a candidate window instead of an index.
 *
 * Counting in SQL over the whole domain makes the answer true at any size, and
 * costs one indexed aggregate rather than shipping two full tables to the
 * browser to be re-counted there.
 */
/**
 * Every paper in a domain, as an entry point with enough signal to choose one.
 */
graphRouter.get('/papers', async (c) => {
  try {
    const raw = c.req.query('domain');
    const domainId = raw ? requireDomain(c, raw, 'graph.papers').id : null;
    const domainSql = domainId
      ? domainId === DEFAULT_DOMAIN_ID
        ? sql`and (n.domain = ${domainId} or n.domain is null)`
        : sql`and n.domain = ${domainId}`
      : sql``;

    // Only papers that are actually ingested documents.
    //
    // `type = 'paper'` alone is far too wide: the extractor creates a paper node
    // for every work a document *cites*, so seven ingested papers produced
    // eighty-five paper nodes — seventy-four of them citation targets like
    // "arXiv preprint arXiv:1601.06733", with no text of their own and nothing
    // to study. A lens whose whole purpose is "choose one of your documents"
    // must not offer them.
    //
    // The discriminator is exact rather than heuristic: `getOrCreatePaperNode`
    // stamps a document's own node with `paper_id` pointing at itself and
    // `normalized_name` equal to its title. A citation target carries the
    // *citing* paper's id, so it cannot satisfy both halves.
    const rows = (await db.execute(sql`
      select n.id, n.name, n.domain,
             count(*) filter (where e.type = 'mentions')::int as concepts,
             count(*) filter (where e.type <> 'mentions')::int as relationships
      from ${nodes} n
      left join ${edges} e on e.source_id = n.id
      where n.type = 'paper' ${domainSql}
        and exists (
          select 1 from ${papers} p
          where p.id = n.paper_id and lower(p.title) = n.normalized_name
        )
      group by n.id, n.name, n.domain
      order by count(*) desc, n.name
    `)) as unknown as Array<{
      id: string;
      name: string;
      domain: string | null;
      concepts: number;
      relationships: number;
    }>;

    return c.json({ papers: rows });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch papers');
  }
});

/**
 * One node read as an argument: its edges grouped by the question they answer.
 *
 * Both directions are included and inverted correctly — "A extends B" is part of
 * A's lineage and part of B's legacy, and filing an incoming `extends` under
 * "Builds on" would tell the reader the opposite of what happened.
 */
graphRouter.get('/lens/:id', async (c) => {
  try {
    const id = c.req.param('id');
    if (!isUuid(id)) return c.json({ error: 'Node not found' }, 404);

    const [node] = await db.select().from(nodes).where(eq(nodes.id, id)).limit(1);
    if (!node) return c.json({ error: 'Node not found' }, 404);

    // Traversal is pinned to the centre node's own domain (invariant 2).
    const nodeDomain = resolveStoredDomain(node.domain, `lens node ${node.id}`).id;
    const raw = c.req.query('domain');
    if (raw && requireDomain(c, raw, 'graph.lens').id !== nodeDomain) {
      return c.json({ error: 'Node not found' }, 404);
    }
    requireDomain(c, nodeDomain, 'graph.lens');

    const target = alias(nodes, 'target');
    const source = alias(nodes, 'source');

    const [outgoing, incoming] = await Promise.all([
      db
        .select({ edge: edges, other: target })
        .from(edges)
        .innerJoin(target, eq(edges.targetId, target.id))
        .where(and(eq(edges.sourceId, id), domainWhere(target.domain, nodeDomain))),
      db
        .select({ edge: edges, other: source })
        .from(edges)
        .innerJoin(source, eq(edges.sourceId, source.id))
        .where(and(eq(edges.targetId, id), domainWhere(source.domain, nodeDomain))),
    ]);

    interface Item {
      id: string;
      name: string;
      type: string;
      relation: string;
      direction: 'out' | 'in';
      evidence: string | null;
    }
    const buckets = new Map<LensRole, Item[]>();
    const push = (role: LensRole, item: Item) => {
      const list = buckets.get(role) ?? [];
      list.push(item);
      buckets.set(role, list);
    };

    // Evidence for every edge shown, in one query — the sentence is what turns
    // a claim into something a reader can check rather than take on faith.
    const edgeIds = [...outgoing, ...incoming].map((r) => r.edge.id);
    const evidenceByEdge = new Map<string, string>();
    if (edgeIds.length > 0) {
      const rows = await db
        .select({ edgeId: sources.edgeId, text: sources.extractedText })
        .from(sources)
        .where(inArray(sources.edgeId, edgeIds));
      for (const r of rows) {
        if (r.text && !evidenceByEdge.has(r.edgeId)) evidenceByEdge.set(r.edgeId, r.text);
      }
    }

    for (const row of outgoing) {
      push(roleForEdgeType(row.edge.type), {
        id: row.other.id,
        name: row.other.name,
        type: row.other.type,
        relation: row.edge.type.replace(/_/g, ' '),
        direction: 'out',
        evidence: evidenceByEdge.get(row.edge.id) ?? null,
      });
    }
    for (const row of incoming) {
      push(roleForIncomingEdgeType(row.edge.type), {
        id: row.other.id,
        name: row.other.name,
        type: row.other.type,
        relation: invertPhrase(row.edge.type),
        direction: 'in',
        evidence: evidenceByEdge.get(row.edge.id) ?? null,
      });
    }

    return c.json({
      node: { id: node.id, name: node.name, type: node.type, description: node.description },
      domain: nodeDomain,
      // Fixed order: the order the questions get asked, not by size.
      sections: ROLE_ORDER.filter((r) => (buckets.get(r.role) ?? []).length > 0).map((r) => ({
        ...r,
        items: buckets.get(r.role) ?? [],
      })),
      total: outgoing.length + incoming.length,
    });
  } catch (error) {
    return routeError(c, error, 'Failed to build lens');
  }
});

/**
 * What two papers share, and what only one of them has.
 *
 * This is the between-papers question, and it is answerable only because every
 * entity is attached to the paper that named it: the shared set is the
 * intersection of two papers' mention edges. Before that existed, two papers had
 * no path between them at all.
 */
graphRouter.get('/compare', async (c) => {
  try {
    const aId = c.req.query('a');
    const bId = c.req.query('b');
    if (!aId || !bId || !isUuid(aId) || !isUuid(bId)) {
      return c.json({ error: 'Provide two node ids as ?a= and ?b=' }, 400);
    }

    const both = await db.select().from(nodes).where(inArray(nodes.id, [aId, bId]));
    const a = both.find((n) => n.id === aId);
    const b = both.find((n) => n.id === bId);
    if (!a || !b) return c.json({ error: 'Node not found' }, 404);

    const domainA = resolveStoredDomain(a.domain, `compare node ${a.id}`).id;
    const domainB = resolveStoredDomain(b.domain, `compare node ${b.id}`).id;
    requireDomain(c, domainA, 'graph.compare');
    if (domainA !== domainB) {
      // Not an error the caller can act on by retrying — and saying "different
      // domains" is more useful than an empty intersection that looks like the
      // two papers happen to have nothing in common.
      return c.json(
        {
          error:
            'These papers are in different domains, so they share nothing by construction. ' +
            'Move one with POST /api/papers/:id/domain to compare them.',
        },
        409
      );
    }

    const neighbours = async (id: string) =>
      db
        .select({ id: nodes.id, name: nodes.name, type: nodes.type })
        .from(edges)
        .innerJoin(nodes, eq(edges.targetId, nodes.id))
        .where(and(eq(edges.sourceId, id), domainWhere(nodes.domain, domainA)));

    const [na, nb] = await Promise.all([neighbours(aId), neighbours(bId)]);
    const setB = new Map(nb.map((n) => [n.id, n]));
    const setA = new Map(na.map((n) => [n.id, n]));

    return c.json({
      a: { id: a.id, name: a.name },
      b: { id: b.id, name: b.name },
      shared: na.filter((n) => setB.has(n.id)),
      onlyA: na.filter((n) => !setB.has(n.id)),
      onlyB: nb.filter((n) => !setA.has(n.id)),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to compare');
  }
});

/**
 * Queue a graph-quality audit. Returns immediately; the work is a durable job.
 */
graphRouter.post('/audit', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}) as { domain?: string });
    const domain = requireDomain(c, body.domain, 'graph.audit');
    requireScopeOn(c, 'write', 'graph.audit');

    const jobId = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await createJob(jobId, 'audit', { metadata: { domain: domain.id } });

    return c.json(
      {
        message: `Audit queued for "${domain.id}". It writes proposals; nothing is changed.`,
        domain: domain.id,
        jobId,
        findingsUrl: `/api/graph/findings?domain=${domain.id}`,
      },
      202
    );
  } catch (error) {
    return routeError(c, error, 'Failed to queue audit');
  }
});

/** What the last audit proposed, worst first. */
graphRouter.get('/findings', async (c) => {
  try {
    const domain = requireDomain(c, c.req.query('domain'), 'graph.findings');
    const status = c.req.query('status') ?? 'proposed';

    const node = alias(nodes, 'subject');
    const related = alias(nodes, 'related');
    const rows = await db
      .select({
        id: graphFindings.id,
        detector: graphFindings.detector,
        verdict: graphFindings.verdict,
        reason: graphFindings.reason,
        confidence: graphFindings.confidence,
        status: graphFindings.status,
        node: { id: node.id, name: node.name, type: node.type },
        related: { id: related.id, name: related.name, type: related.type },
      })
      .from(graphFindings)
      .innerJoin(node, eq(graphFindings.nodeId, node.id))
      .leftJoin(related, eq(graphFindings.relatedNodeId, related.id))
      .where(and(eq(graphFindings.domain, domain.id), eq(graphFindings.status, status)))
      // Confidence first so the safest proposals are read first, and an operator
      // working top-down is not asked to adjudicate the hard cases while warming up.
      .orderBy(
        sql`case ${graphFindings.confidence} when 'high' then 0 when 'medium' then 1 else 2 end`,
        graphFindings.detector
      )
      .limit(500);

    const counts = (await db.execute(sql`
      select verdict, confidence, count(*)::int as n
      from ${graphFindings}
      where domain = ${domain.id} and status = 'proposed'
      group by 1, 2
    `)) as unknown as Array<{ verdict: string; confidence: string; n: number }>;

    return c.json({ domain: domain.id, findings: rows, summary: counts });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch findings');
  }
});

/** Carry out one proposal, or record that a human disagreed with several. */
graphRouter.post('/findings/apply', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      domain?: string;
      apply?: string[];
      dismiss?: string[];
    };
    const domain = requireDomain(c, body.domain, 'graph.findings.apply');
    requireScopeOn(c, 'write', 'graph.findings.apply');

    // Every id is checked to belong to this domain before it is touched — a
    // finding id is otherwise a way to delete a node in a domain you cannot read.
    const ids = [...(body.apply ?? []), ...(body.dismiss ?? [])];
    if (ids.length === 0) return c.json({ error: 'Nothing to do' }, 400);

    const owned = await db
      .select({ id: graphFindings.id })
      .from(graphFindings)
      .where(and(inArray(graphFindings.id, ids), eq(graphFindings.domain, domain.id)));
    const ownedIds = new Set(owned.map((r) => r.id));
    const foreign = ids.filter((id) => !ownedIds.has(id));
    if (foreign.length > 0) return c.json({ error: 'Finding not found' }, 404);

    const applied: string[] = [];
    const failed: Array<{ id: string; error: string }> = [];
    for (const id of body.apply ?? []) {
      try {
        await applyFinding(id);
        applied.push(id);
      } catch (err) {
        failed.push({ id, error: err instanceof Error ? err.message : String(err) });
      }
    }
    const dismissed = await dismissFindings(body.dismiss ?? []);

    return c.json({ applied: applied.length, dismissed, failed });
  } catch (error) {
    return routeError(c, error, 'Failed to resolve findings');
  }
});

graphRouter.get('/hubs', async (c) => {
  try {
    const raw = c.req.query('domain');
    const domainId = raw ? requireDomain(c, raw, 'graph.hubs').id : null;
    const type = c.req.query('type');
    const rawLimit = parseInt(c.req.query('limit') || '25', 10);
    const limit = Number.isFinite(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 25;

    const domainSql = domainId
      ? domainId === DEFAULT_DOMAIN_ID
        ? sql`and (n.domain = ${domainId} or n.domain is null)`
        : sql`and n.domain = ${domainId}`
      : sql``;
    const typeSql = type ? sql`and n.type = ${type}` : sql``;

    const rows = (await db.execute(sql`
      select n.id, n.name, n.type, n.domain,
             count(e.id)::int as degree
      from ${nodes} n
      left join ${edges} e on e.source_id = n.id or e.target_id = n.id
      where true ${domainSql} ${typeSql}
      group by n.id, n.name, n.type, n.domain
      having count(e.id) > 0
      order by count(e.id) desc, n.name asc
      limit ${limit}
    `)) as unknown as Array<{
      id: string;
      name: string;
      type: string;
      domain: string | null;
      degree: number;
    }>;

    return c.json({ hubs: rows, limit });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch most-connected entities');
  }
});

graphRouter.get('/types', async (c) => {
  try {
    const raw = c.req.query('domain');
    const nodeTypeRows = await db
      .selectDistinct({ type: nodes.type })
      .from(nodes)
      .where(optionalDomainFilter(c, raw, nodes.domain));
    const edgeTypeRows = await db
      .selectDistinct({ type: edges.type })
      .from(edges)
      .where(optionalDomainFilter(c, raw, edges.domain));

    return c.json({
      nodeTypes: nodeTypeRows.map((r) => r.type).filter(Boolean).sort(),
      edgeTypes: edgeTypeRows.map((r) => r.type).filter(Boolean).sort(),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch types');
  }
});

// --- Example domain queries ---------------------------------------------------
//
// These are demo queries over the seed corpus. They accept the same optional
// `?domain=` filter as the rest of the graph API; without it they span every
// domain, consistent with /nodes and /edges.

/** Shared shape for the "relationships pointing at a named target" demo queries. */
async function targetNameQuery(
  edgeType: string,
  namePatterns: string[],
  domainFilter: SQL | undefined
) {
  const sourceNodes = alias(nodes, 'source_nodes');
  const targetNodes = alias(nodes, 'target_nodes');

  const conds: SQL[] = [
    eq(edges.type, edgeType),
    or(...namePatterns.map((p) => ilike(targetNodes.name, p)))!,
  ];
  if (domainFilter) conds.push(domainFilter);

  return db
    .select({
      sourceName: sourceNodes.name,
      sourceType: sourceNodes.type,
      relationship: edges.type,
      confidence: edges.confidence,
      targetName: targetNodes.name,
    })
    .from(edges)
    .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
    .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
    .where(and(...conds));
}

graphRouter.get('/queries/improves-3dgs', async (c) => {
  try {
    const results = await targetNameQuery(
      'improves',
      ['%3D Gaussian Splatting%', '%3DGS%'],
      optionalDomainFilter(c, c.req.query('domain'), edges.domain)
    );
    return c.json({
      query: 'Which methods improve on 3D Gaussian Splatting?',
      results,
      count: results.length,
    });
  } catch (error) {
    return routeError(c, error, 'Query failed');
  }
});

graphRouter.get('/queries/extends-3dgs', async (c) => {
  try {
    const results = await targetNameQuery(
      'extends',
      ['%3D Gaussian Splatting%', '%3DGS%', '%Gaussian Splat%'],
      optionalDomainFilter(c, c.req.query('domain'), edges.domain)
    );
    return c.json({
      query: 'Which papers extend 3D Gaussian Splatting?',
      results,
      count: results.length,
    });
  } catch (error) {
    return routeError(c, error, 'Query failed');
  }
});

graphRouter.get('/queries/datasets', async (c) => {
  try {
    const methodNodes = alias(nodes, 'method_nodes');
    const datasetNodes = alias(nodes, 'dataset_nodes');

    const conds: SQL[] = [eq(edges.type, 'evaluates_on'), eq(datasetNodes.type, 'dataset')];
    const domainFilter = optionalDomainFilter(c, c.req.query('domain'), edges.domain);
    if (domainFilter) conds.push(domainFilter);

    const results = await db
      .select({
        dataset: datasetNodes.name,
        usedBy: methodNodes.name,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(methodNodes, eq(edges.sourceId, methodNodes.id))
      .innerJoin(datasetNodes, eq(edges.targetId, datasetNodes.id))
      .where(and(...conds));

    return c.json({
      query: 'Which datasets are used for evaluation?',
      results,
      count: results.length,
    });
  } catch (error) {
    return routeError(c, error, 'Query failed');
  }
});

graphRouter.get('/queries/method-relationships', async (c) => {
  try {
    const methodName = c.req.query('name');
    if (!methodName) {
      return c.json({ error: 'Method name is required (?name=...)' }, 400);
    }

    const nodeDomainFilter = optionalDomainFilter(c, c.req.query('domain'), nodes.domain);
    const edgeDomainFilter = optionalDomainFilter(c, c.req.query('domain'), edges.domain);

    const matchConds: SQL[] = [ilike(nodes.name, `%${methodName}%`)];
    if (nodeDomainFilter) matchConds.push(nodeDomainFilter);

    const methodNodes = await db
      .select()
      .from(nodes)
      .where(and(...matchConds))
      .limit(5);

    if (methodNodes.length === 0) {
      return c.json({
        query: `Find relationships for method: ${methodName}`,
        results: [],
        message: 'No matching methods found',
      });
    }

    const methodIds = methodNodes.map((n) => n.id);
    const sourceNodes = alias(nodes, 'source_nodes');
    const targetNodes = alias(nodes, 'target_nodes');

    const outConds: SQL[] = [inArray(edges.sourceId, methodIds)];
    const inConds: SQL[] = [inArray(edges.targetId, methodIds)];
    if (edgeDomainFilter) {
      outConds.push(edgeDomainFilter);
      inConds.push(edgeDomainFilter);
    }

    const outgoingRels = await db
      .select({
        methodName: sourceNodes.name,
        relationship: edges.type,
        targetName: targetNodes.name,
        targetType: targetNodes.type,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
      .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
      .where(and(...outConds));

    const incomingRels = await db
      .select({
        sourceName: sourceNodes.name,
        sourceType: sourceNodes.type,
        relationship: edges.type,
        methodName: targetNodes.name,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
      .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
      .where(and(...inConds));

    return c.json({
      query: `Find all relationships for method: ${methodName}`,
      methods: methodNodes,
      outgoing: outgoingRels,
      incoming: incomingRels,
    });
  } catch (error) {
    return routeError(c, error, 'Query failed');
  }
});

graphRouter.get('/queries/provenance/:edgeId', async (c) => {
  try {
    const edgeId = c.req.param('edgeId');
    const requestedDomain = c.req.query('domain');
    const requestedScope = requestedDomain ? requireDomain(c, requestedDomain, 'graph.read').id : null;

    if (!isUuid(edgeId)) return c.json({ error: 'Edge not found' }, 404);

    const [edgeData] = await db.select().from(edges).where(eq(edges.id, edgeId)).limit(1);
    if (!edgeData) {
      return c.json({ error: 'Edge not found' }, 404);
    }

    if (requestedScope && resolveStoredDomain(edgeData.domain, `edge ${edgeData.id}`).id !== requestedScope) {
      return c.json({ error: 'Edge not found' }, 404);
    }

    const sourceData = await db
      .select({ source: sources, paper: papers })
      .from(sources)
      .innerJoin(papers, eq(sources.paperId, papers.id))
      .where(eq(sources.edgeId, edgeId));

    const [sourceNode] = await db.select().from(nodes).where(eq(nodes.id, edgeData.sourceId)).limit(1);
    const [targetNode] = await db.select().from(nodes).where(eq(nodes.id, edgeData.targetId)).limit(1);

    return c.json({
      edge: edgeData,
      sourceNode,
      targetNode,
      provenance: sourceData.map((s) => ({
        paperTitle: s.paper.title,
        paperArxivId: s.paper.arxivId,
        section: s.source.section,
        extractedText: s.source.extractedText,
        spanStart: s.source.spanStart,
        spanEnd: s.source.spanEnd,
      })),
    });
  } catch (error) {
    return routeError(c, error, 'Failed to fetch provenance');
  }
});
