import { Hono, type Context } from 'hono';
import { db } from '../db';
import { nodes, edges, sources, papers } from '../db/schema';
import { eq, sql, ilike, and, or, inArray, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { resolveStoredDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { requireDomain } from '../middleware/auth';
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

    return c.json({
      node,
      domain: nodeDomain,
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
