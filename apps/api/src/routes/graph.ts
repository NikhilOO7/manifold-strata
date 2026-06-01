import { Hono } from 'hono';
import { db } from '../db';
import { nodes, edges, sources, papers } from '../db/schema';
import { eq, sql, ilike, and, or, inArray } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { getDomain } from '../domains';
import { domainWhere } from '../domains/filter';

export const graphRouter = new Hono();

graphRouter.get('/nodes', async (c) => {
  try {
    const type = c.req.query('type');
    const search = c.req.query('search');
    const domainParam = c.req.query('domain');
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');

    let conditions = [];

    if (type) {
      conditions.push(eq(nodes.type, type as any));
    }

    if (search) {
      conditions.push(ilike(nodes.name, `%${search}%`));
    }

    if (domainParam) {
      const dw = domainWhere(nodes.domain, getDomain(domainParam).id);
      if (dw) conditions.push(dw);
    }

    const query = conditions.length > 0
      ? db.select().from(nodes).where(and(...conditions))
      : db.select().from(nodes);

    const results = await query.limit(limit).offset(offset);

    const countResult = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(nodes)
      .where(conditions.length > 0 ? and(...conditions) : undefined);

    return c.json({
      nodes: results,
      pagination: { limit, offset, total: countResult[0]?.count || 0 },
    });
  } catch (error) {
    console.error('Error fetching nodes:', error);
    return c.json({ error: 'Failed to fetch nodes' }, 500);
  }
});

graphRouter.get('/nodes/:id', async (c) => {
  try {
    const id = c.req.param('id');

    const node = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, id))
      .limit(1);

    if (!node.length) {
      return c.json({ error: 'Node not found' }, 404);
    }

    const outgoing = await db
      .select({
        edge: edges,
        targetNode: nodes,
      })
      .from(edges)
      .innerJoin(nodes, eq(edges.targetId, nodes.id))
      .where(eq(edges.sourceId, id));

    const incoming = await db
      .select({
        edge: edges,
        sourceNode: nodes,
      })
      .from(edges)
      .innerJoin(nodes, eq(edges.sourceId, nodes.id))
      .where(eq(edges.targetId, id));

    return c.json({
      node: node[0],
      outgoingEdges: outgoing.map(o => ({
        ...o.edge,
        targetNode: o.targetNode,
      })),
      incomingEdges: incoming.map(i => ({
        ...i.edge,
        sourceNode: i.sourceNode,
      })),
    });
  } catch (error) {
    console.error('Error fetching node:', error);
    return c.json({ error: 'Failed to fetch node' }, 500);
  }
});

graphRouter.get('/edges', async (c) => {
  try {
    const type = c.req.query('type');
    const domainParam = c.req.query('domain');
    const limit = parseInt(c.req.query('limit') || '100');
    const offset = parseInt(c.req.query('offset') || '0');

    const conds = [];
    if (type) conds.push(eq(edges.type, type as any));
    if (domainParam) {
      const dw = domainWhere(edges.domain, getDomain(domainParam).id);
      if (dw) conds.push(dw);
    }

    // Single query with two joins (source + target) instead of 1 + N target
    // lookups. `alias` lets us join the nodes table twice.
    const sourceNodes = alias(nodes, 'source_nodes');
    const targetNodes = alias(nodes, 'target_nodes');

    const results = await db
      .select({
        edge: edges,
        sourceNode: sourceNodes,
        targetNode: targetNodes,
      })
      .from(edges)
      .innerJoin(sourceNodes, eq(edges.sourceId, sourceNodes.id))
      .innerJoin(targetNodes, eq(edges.targetId, targetNodes.id))
      .where(conds.length ? and(...conds) : undefined)
      .limit(limit)
      .offset(offset);

    const edgesWithNodes = results.map((r) => ({
      ...r.edge,
      sourceNode: r.sourceNode,
      targetNode: r.targetNode,
    }));

    return c.json({
      edges: edgesWithNodes,
      pagination: { limit, offset },
    });
  } catch (error) {
    console.error('Error fetching edges:', error);
    return c.json({ error: 'Failed to fetch edges' }, 500);
  }
});

graphRouter.get('/subgraph', async (c) => {
  try {
    const nodeId = c.req.query('nodeId');
    const depth = Math.min(parseInt(c.req.query('depth') || '1'), 3);

    if (!nodeId) {
      return c.json({ error: 'nodeId is required' }, 400);
    }

    const centerNode = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, nodeId))
      .limit(1);

    if (!centerNode.length) {
      return c.json({ error: 'Node not found' }, 404);
    }

    const visitedNodeIds = new Set<string>([nodeId]);
    const allEdges: any[] = [];
    let frontier = [nodeId];

    for (let d = 0; d < depth; d++) {
      if (frontier.length === 0) break;

      const outgoingEdges = await db
        .select()
        .from(edges)
        .where(inArray(edges.sourceId, frontier));

      const incomingEdges = await db
        .select()
        .from(edges)
        .where(inArray(edges.targetId, frontier));

      const newFrontier: string[] = [];

      for (const edge of [...outgoingEdges, ...incomingEdges]) {
        const edgeKey = `${edge.sourceId}-${edge.targetId}-${edge.type}`;
        if (!allEdges.some(e => `${e.sourceId}-${e.targetId}-${e.type}` === edgeKey)) {
          allEdges.push(edge);
        }

        if (!visitedNodeIds.has(edge.sourceId)) {
          visitedNodeIds.add(edge.sourceId);
          newFrontier.push(edge.sourceId);
        }
        if (!visitedNodeIds.has(edge.targetId)) {
          visitedNodeIds.add(edge.targetId);
          newFrontier.push(edge.targetId);
        }
      }

      frontier = newFrontier;
    }

    const subgraphNodes = visitedNodeIds.size > 0
      ? await db
          .select()
          .from(nodes)
          .where(inArray(nodes.id, Array.from(visitedNodeIds)))
      : [];

    return c.json({
      nodes: subgraphNodes,
      edges: allEdges,
      center: centerNode[0],
      depth,
    });
  } catch (error) {
    console.error('Error fetching subgraph:', error);
    return c.json({ error: 'Failed to fetch subgraph' }, 500);
  }
});

graphRouter.get('/stats', async (c) => {
  try {
    const domainParam = c.req.query('domain');
    const ndw = domainParam ? domainWhere(nodes.domain, getDomain(domainParam).id) : undefined;
    const edw = domainParam ? domainWhere(edges.domain, getDomain(domainParam).id) : undefined;
    const pdw = domainParam ? domainWhere(papers.domain, getDomain(domainParam).id) : undefined;

    const nodeStats = await db
      .select({
        type: nodes.type,
        count: sql<number>`count(*)::int`,
      })
      .from(nodes)
      .where(ndw)
      .groupBy(nodes.type);

    const edgeStats = await db
      .select({
        type: edges.type,
        count: sql<number>`count(*)::int`,
      })
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

    const totalNodes = nodeStats.reduce((sum, stat) => sum + stat.count, 0);
    const totalEdges = edgeStats.reduce((sum, stat) => sum + stat.count, 0);

    return c.json({
      nodes: {
        total: totalNodes,
        byType: nodeStats,
      },
      edges: {
        total: totalEdges,
        byType: edgeStats,
      },
      papers: {
        total: paperStats[0]?.total || 0,
        processed: paperStats[0]?.processed || 0,
      },
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    return c.json({ error: 'Failed to fetch stats' }, 500);
  }
});

// Distinct node/edge types actually present in the graph. Lets the UI populate
// type filters dynamically instead of from a hardcoded list, so newly discovered
// types appear automatically.
graphRouter.get('/types', async (c) => {
  try {
    const domainParam = c.req.query('domain');
    const ndw = domainParam ? domainWhere(nodes.domain, getDomain(domainParam).id) : undefined;
    const edw = domainParam ? domainWhere(edges.domain, getDomain(domainParam).id) : undefined;

    const nodeTypeRows = await db.selectDistinct({ type: nodes.type }).from(nodes).where(ndw);
    const edgeTypeRows = await db.selectDistinct({ type: edges.type }).from(edges).where(edw);

    return c.json({
      nodeTypes: nodeTypeRows.map((r) => r.type).filter(Boolean).sort(),
      edgeTypes: edgeTypeRows.map((r) => r.type).filter(Boolean).sort(),
    });
  } catch (error) {
    console.error('Error fetching types:', error);
    return c.json({ error: 'Failed to fetch types' }, 500);
  }
});

graphRouter.get('/queries/improves-3dgs', async (c) => {
  try {
    const results = await db
      .select({
        sourceName: sql<string>`source_nodes.name`,
        sourceType: sql<string>`source_nodes.type`,
        relationship: edges.type,
        confidence: edges.confidence,
        targetName: sql<string>`target_nodes.name`,
      })
      .from(edges)
      .innerJoin(
        sql`nodes as source_nodes`,
        sql`${edges.sourceId} = source_nodes.id`
      )
      .innerJoin(
        sql`nodes as target_nodes`,
        sql`${edges.targetId} = target_nodes.id`
      )
      .where(
        and(
          or(
            ilike(sql`target_nodes.name`, '%3D Gaussian Splatting%'),
            ilike(sql`target_nodes.name`, '%3DGS%')
          ),
          eq(edges.type, 'improves')
        )
      );

    return c.json({
      query: "Which methods improve on 3D Gaussian Splatting?",
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error running query:', error);
    return c.json({ error: 'Query failed' }, 500);
  }
});

graphRouter.get('/queries/extends-3dgs', async (c) => {
  try {
    const results = await db
      .select({
        sourceName: sql<string>`source_nodes.name`,
        sourceType: sql<string>`source_nodes.type`,
        relationship: edges.type,
        confidence: edges.confidence,
        targetName: sql<string>`target_nodes.name`,
      })
      .from(edges)
      .innerJoin(
        sql`nodes as source_nodes`,
        sql`${edges.sourceId} = source_nodes.id`
      )
      .innerJoin(
        sql`nodes as target_nodes`,
        sql`${edges.targetId} = target_nodes.id`
      )
      .where(
        and(
          or(
            ilike(sql`target_nodes.name`, '%3D Gaussian Splatting%'),
            ilike(sql`target_nodes.name`, '%3DGS%'),
            ilike(sql`target_nodes.name`, '%Gaussian Splat%')
          ),
          eq(edges.type, 'extends')
        )
      );

    return c.json({
      query: "Which papers extend 3D Gaussian Splatting?",
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error running query:', error);
    return c.json({ error: 'Query failed' }, 500);
  }
});

graphRouter.get('/queries/datasets', async (c) => {
  try {
    const results = await db
      .select({
        dataset: sql<string>`dataset_nodes.name`,
        usedBy: sql<string>`method_nodes.name`,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(
        sql`nodes as method_nodes`,
        sql`${edges.sourceId} = method_nodes.id`
      )
      .innerJoin(
        sql`nodes as dataset_nodes`,
        sql`${edges.targetId} = dataset_nodes.id`
      )
      .where(
        and(
          eq(edges.type, 'evaluates_on'),
          sql`dataset_nodes.type = 'dataset'`
        )
      );

    return c.json({
      query: "Which datasets are used for evaluation?",
      results,
      count: results.length,
    });
  } catch (error) {
    console.error('Error running query:', error);
    return c.json({ error: 'Query failed' }, 500);
  }
});

graphRouter.get('/queries/method-relationships', async (c) => {
  try {
    const methodName = c.req.query('name');
    
    if (!methodName) {
      return c.json({ error: 'Method name is required (?name=...)' }, 400);
    }

    const methodNodes = await db
      .select()
      .from(nodes)
      .where(ilike(nodes.name, `%${methodName}%`))
      .limit(5);

    if (methodNodes.length === 0) {
      return c.json({ 
        query: `Find relationships for method: ${methodName}`,
        results: [],
        message: 'No matching methods found'
      });
    }

    const methodIds = methodNodes.map(n => n.id);

    const outgoingRels = await db
      .select({
        methodName: sql<string>`source_nodes.name`,
        relationship: edges.type,
        targetName: sql<string>`target_nodes.name`,
        targetType: sql<string>`target_nodes.type`,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(sql`nodes as source_nodes`, sql`${edges.sourceId} = source_nodes.id`)
      .innerJoin(sql`nodes as target_nodes`, sql`${edges.targetId} = target_nodes.id`)
      .where(inArray(edges.sourceId, methodIds));

    const incomingRels = await db
      .select({
        sourceName: sql<string>`source_nodes.name`,
        sourceType: sql<string>`source_nodes.type`,
        relationship: edges.type,
        methodName: sql<string>`target_nodes.name`,
        confidence: edges.confidence,
      })
      .from(edges)
      .innerJoin(sql`nodes as source_nodes`, sql`${edges.sourceId} = source_nodes.id`)
      .innerJoin(sql`nodes as target_nodes`, sql`${edges.targetId} = target_nodes.id`)
      .where(inArray(edges.targetId, methodIds));

    return c.json({
      query: `Find all relationships for method: ${methodName}`,
      methods: methodNodes,
      outgoing: outgoingRels,
      incoming: incomingRels,
    });
  } catch (error) {
    console.error('Error running query:', error);
    return c.json({ error: 'Query failed' }, 500);
  }
});

graphRouter.get('/queries/provenance/:edgeId', async (c) => {
  try {
    const edgeId = c.req.param('edgeId');

    const edgeData = await db
      .select()
      .from(edges)
      .where(eq(edges.id, edgeId))
      .limit(1);

    if (!edgeData.length) {
      return c.json({ error: 'Edge not found' }, 404);
    }

    const sourceData = await db
      .select({
        source: sources,
        paper: papers,
      })
      .from(sources)
      .innerJoin(papers, eq(sources.paperId, papers.id))
      .where(eq(sources.edgeId, edgeId));

    const [sourceNode] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, edgeData[0].sourceId))
      .limit(1);

    const [targetNode] = await db
      .select()
      .from(nodes)
      .where(eq(nodes.id, edgeData[0].targetId))
      .limit(1);

    return c.json({
      edge: edgeData[0],
      sourceNode,
      targetNode,
      provenance: sourceData.map(s => ({
        paperTitle: s.paper.title,
        paperArxivId: s.paper.arxivId,
        section: s.source.section,
        extractedText: s.source.extractedText,
        spanStart: s.source.spanStart,
        spanEnd: s.source.spanEnd,
      })),
    });
  } catch (error) {
    console.error('Error fetching provenance:', error);
    return c.json({ error: 'Failed to fetch provenance' }, 500);
  }
});
