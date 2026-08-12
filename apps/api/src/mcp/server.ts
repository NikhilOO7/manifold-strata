/**
 * Manifold MCP server.
 *
 * Exposes the geometric knowledge field as Model Context Protocol tools so any
 * MCP client (Claude Desktop, Claude Code, a larger agent) can pull grounded,
 * compressed evidence from the graph. The retrieval tools run entirely in
 * vector/graph space — `search_knowledge`, `find_entity`, and `get_subgraph`
 * make ZERO LLM calls; the *calling* agent does the reasoning. `query_field`
 * optionally spends one verbalization call.
 *
 * Transport is stdio (the standard for desktop/CLI clients). Run with:
 *   pnpm --filter api mcp
 *
 * It imports the same field functions and DB layer the HTTP API uses — no
 * duplicated logic, no network hop.
 */

// Reserve stdout for the JSON-RPC protocol: route any stray library logging to
// stderr so it can never corrupt the transport.
console.log = (...args: unknown[]) => console.error(...args);

import 'dotenv/config';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { ilike, or, inArray, and, eq, type SQL } from 'drizzle-orm';
import { db } from '../db';
import { nodes, edges } from '../db/schema';
import { retrieveField, fieldQuery } from '../knowledge-field/retrieve';
import { resolveDomain, resolveStoredDomain, listDomains } from '../domains';
import { requireDomainAccess, ANONYMOUS_PRINCIPAL, type Principal } from '../auth/principal';
import { domainWhere } from '../domains/filter';

const server = new Server(
  { name: 'manifold', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

/**
 * The identity this MCP process acts as.
 *
 * The server talks to the database directly, so it cannot inherit an HTTP
 * principal. `MCP_DOMAINS` names the domains it may read (comma-separated, or
 * `*`); unset means every domain, matching the historical behaviour and the fact
 * that whoever can launch this process already holds the database credentials.
 * Restricting it is how an operator hands an agent a narrower view than their
 * own.
 */
const MCP_PRINCIPAL: Principal = (() => {
  const raw = process.env.MCP_DOMAINS?.trim();
  if (!raw) return ANONYMOUS_PRINCIPAL;
  return {
    ...ANONYMOUS_PRINCIPAL,
    name: `mcp (domains: ${raw})`,
    domains: raw.split(',').map((d) => d.trim()).filter(Boolean),
  };
})();

/** Resolve a requested domain and check this process is allowed to read it. */
function mcpDomain(raw: string | undefined): string {
  const domain = resolveDomain(raw).id;
  requireDomainAccess(MCP_PRINCIPAL, domain);
  return domain;
}

// --- Tool catalog (JSON Schema — no zod coupling) ---------------------------

const TOOLS = [
  {
    name: 'search_knowledge',
    description:
      'Search the Manifold knowledge field for a natural-language query and return ' +
      'ranked, MMR-compressed evidence plus the top graph nodes. Uses embeddings + ' +
      'Personalized PageRank only — NO LLM call. Use this to ground your reasoning ' +
      'in the paper corpus.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language question or topic.' },
        maxEvidence: {
          type: 'number',
          description: 'Max evidence snippets to return (default 10).',
        },
        domain: {
          type: 'string',
          description: 'Scope the search to one domain (e.g. "gaussian-splatting", "nlp"). Omit for the default domain.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_entity',
    description:
      'Find graph entities (methods, concepts, datasets, metrics, …) by name. ' +
      'Returns matching node ids/types so you can then expand them with get_subgraph. NO LLM call.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Entity name or partial name to match.' },
        limit: { type: 'number', description: 'Max results (default 10).' },
        domain: {
          type: 'string',
          description:
            'Scope the search to one domain (e.g. "gaussian-splatting", "nlp"). Omit to search every domain — results carry a "domain" field either way.',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_subgraph',
    description:
      'Return the N-hop neighborhood (nodes + typed, confidence-scored edges) around ' +
      'a node id. Use after find_entity to explore how an entity relates to others. ' +
      'Traversal never crosses a domain boundary. NO LLM call.',
    inputSchema: {
      type: 'object',
      properties: {
        nodeId: { type: 'string', description: 'Center node id (uuid) from find_entity.' },
        depth: { type: 'number', description: 'Hops to expand, 1–3 (default 1).' },
      },
      required: ['nodeId'],
    },
  },
  {
    name: 'list_domains',
    description:
      'List the research domains this Manifold instance hosts. Domains are isolated: ' +
      'entities never resolve or link across them. Call this first if you intend to ' +
      'scope a search — an unregistered domain name is an error, not a silent fallback.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'query_field',
    description:
      'Full field query: retrieve compressed evidence and optionally synthesize a ' +
      'short answer. Set verbalize=true to spend ONE LLM call for a written answer; ' +
      'leave it false (default) to get just the evidence and reason over it yourself.',
    inputSchema: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to answer.' },
        verbalize: {
          type: 'boolean',
          description: 'If true, use one LLM call to write an answer (default false).',
        },
        domain: {
          type: 'string',
          description: 'Scope the query to one domain (e.g. "gaussian-splatting", "nlp"). Omit for the default domain.',
        },
      },
      required: ['question'],
    },
  },
] as const;

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// --- Tool implementations ----------------------------------------------------

function asText(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

/**
 * Name search. The `domain` field is always returned so a calling agent can see
 * which field each match belongs to rather than assuming they share one.
 */
async function findEntity(name: string, limit: number, domainId?: string) {
  const conds: SQL[] = [
    or(ilike(nodes.name, `%${name}%`), ilike(nodes.normalizedName, `%${name.toLowerCase()}%`))!,
  ];
  if (domainId) conds.push(domainWhere(nodes.domain, domainId)!);

  return db
    .select({
      id: nodes.id,
      name: nodes.name,
      type: nodes.type,
      domain: nodes.domain,
      description: nodes.description,
    })
    .from(nodes)
    .where(and(...conds))
    .limit(limit);
}

/**
 * N-hop neighbourhood, pinned to the center node's domain.
 *
 * This traversal was previously unscoped, which quietly broke the isolation
 * guarantee for exactly the caller that most depends on it: an agent that
 * scoped `search_knowledge` to one domain, then expanded a returned node, walked
 * straight into other domains' entities and presented them as related work.
 */
async function getSubgraph(nodeId: string, depth: number) {
  const [center] = await db.select().from(nodes).where(eq(nodes.id, nodeId)).limit(1);
  if (!center) {
    throw new Error(`No node with id ${nodeId}. Use find_entity to get a valid id.`);
  }

  const domainId = resolveStoredDomain(center.domain, `node ${center.id}`).id;
  // A node id is caller-supplied; without this check `get_subgraph` would read
  // any domain regardless of the grant that scoped `search_knowledge`.
  requireDomainAccess(MCP_PRINCIPAL, domainId);
  const edgeScope = domainWhere(edges.domain, domainId);

  const visited = new Set<string>([nodeId]);
  let frontier = [nodeId];
  const edgeById = new Map<string, typeof edges.$inferSelect>();

  for (let d = 0; d < depth && frontier.length > 0; d++) {
    const rows = await db
      .select()
      .from(edges)
      .where(and(or(inArray(edges.sourceId, frontier), inArray(edges.targetId, frontier)), edgeScope));
    if (rows.length === 0) break;

    // Both endpoints must be in-domain — an edge's own domain stamp does not
    // prove where the node on the other end lives.
    const endpointIds = [...new Set(rows.flatMap((e) => [e.sourceId, e.targetId]))];
    const inDomain = new Set(
      (
        await db
          .select({ id: nodes.id })
          .from(nodes)
          .where(and(inArray(nodes.id, endpointIds), domainWhere(nodes.domain, domainId)))
      ).map((n) => n.id)
    );

    const next: string[] = [];
    for (const e of rows) {
      if (!inDomain.has(e.sourceId) || !inDomain.has(e.targetId)) continue;
      edgeById.set(e.id, e);
      for (const nid of [e.sourceId, e.targetId]) {
        if (!visited.has(nid)) {
          visited.add(nid);
          next.push(nid);
        }
      }
    }
    frontier = next;
  }

  const nodeRows = await db
    .select()
    .from(nodes)
    .where(and(inArray(nodes.id, [...visited]), domainWhere(nodes.domain, domainId)));

  return { domain: domainId, center, nodes: nodeRows, edges: [...edgeById.values()] };
}

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = (req.params.arguments ?? {}) as Record<string, any>;

  try {
    switch (name) {
      case 'search_knowledge': {
        if (!args.query) throw new Error('query is required');
        // resolveDomain throws on an unregistered id; the catch below turns that
        // into a tool error naming the valid domains, so an agent is told its
        // scope was rejected instead of silently receiving another field's graph.
        const domain = mcpDomain(args.domain ? String(args.domain) : undefined);
        const result = await retrieveField(String(args.query), {
          maxEvidence: typeof args.maxEvidence === 'number' ? args.maxEvidence : undefined,
          domain,
        });
        return asText({
          query: args.query,
          domain,
          evidenceCount: result.evidence.length,
          contextChars: result.contextChars,
          topNodes: result.rankedNodes.slice(0, 10),
          evidence: result.evidence,
        });
      }

      case 'find_entity': {
        if (!args.name) throw new Error('name is required');
        const limit = Math.min(Math.max(parseInt(args.limit) || 10, 1), 50);
        const domain = args.domain ? mcpDomain(String(args.domain)) : undefined;
        return asText({
          domain: domain ?? 'all',
          matches: await findEntity(String(args.name), limit, domain),
        });
      }

      case 'get_subgraph': {
        if (!args.nodeId) throw new Error('nodeId is required');
        const depth = Math.min(Math.max(parseInt(args.depth) || 1, 1), 3);
        return asText(await getSubgraph(String(args.nodeId), depth));
      }

      case 'list_domains': {
        return asText({
          granted: MCP_PRINCIPAL.domains,
          domains: listDomains().map((d) => ({
            id: d.id,
            name: d.name,
            description: d.description,
          })),
          note: 'Domains are isolated: entities never resolve or link across them.',
        });
      }

      case 'query_field': {
        if (!args.question) throw new Error('question is required');
        const domain = mcpDomain(args.domain ? String(args.domain) : undefined);
        const result = await fieldQuery(String(args.question), {
          verbalize: args.verbalize === true,
          domain,
        });
        return asText({
          question: args.question,
          domain,
          answer: result.answer,
          llmCalls: result.llmCalls,
          evidenceCount: result.evidence.length,
          evidence: result.evidence,
        });
      }

      default:
        return { content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }], isError: true };
    }
  } catch (err) {
    return {
      content: [{ type: 'text' as const, text: `Error: ${err instanceof Error ? err.message : String(err)}` }],
      isError: true,
    };
  }
});

// --- Boot --------------------------------------------------------------------

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[manifold-mcp] ready on stdio');
}

main().catch((err) => {
  console.error('[manifold-mcp] fatal:', err);
  process.exit(1);
});
