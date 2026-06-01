/**
 * Community detection + cached summaries (GraphRAG-style).
 *
 * Cluster the graph (label propagation), then generate ONE LLM summary per
 * community and cache it. Broad questions can then read a single summary instead
 * of N propositions — the only place the field pipeline *adds* an LLM call, and
 * it's amortized: computed once, reused across every future query.
 */

import { db } from '../db';
import { nodes, edges, communities, propositions } from '../db/schema';
import { getDomain } from '../domains';
import { domainWhere } from '../domains/filter';
import { generateCompletion } from '../services/ollama';
import { embedOne } from '../services/embeddings';

/** Label propagation over the undirected graph. Returns nodeId -> communityLabel. */
function labelPropagation(
  nodeIds: string[],
  edgeList: Array<[string, string]>,
  iterations = 10
): Map<string, string> {
  const neighbors = new Map<string, string[]>();
  for (const id of nodeIds) neighbors.set(id, []);
  for (const [a, b] of edgeList) {
    if (!neighbors.has(a) || !neighbors.has(b)) continue;
    neighbors.get(a)!.push(b);
    neighbors.get(b)!.push(a);
  }

  const label = new Map<string, string>();
  nodeIds.forEach((id) => label.set(id, id));

  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    // Shuffle for asynchronous updates.
    const order = [...nodeIds].sort(() => Math.random() - 0.5);
    for (const id of order) {
      const nbrs = neighbors.get(id)!;
      if (nbrs.length === 0) continue;
      const counts = new Map<string, number>();
      for (const nb of nbrs) {
        const l = label.get(nb)!;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id)!;
      let bestCount = -1;
      for (const [l, c] of counts.entries()) {
        if (c > bestCount) {
          bestCount = c;
          best = l;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

export interface BuildCommunitiesResult {
  communities: number;
  summarized: number;
}

export async function buildCommunities(domainId?: string, minSize = 3): Promise<BuildCommunitiesResult> {
  const domain = getDomain(domainId).id;
  const allNodes = await db.select().from(nodes).where(domainWhere(nodes.domain, domain));
  const nameById = new Map(allNodes.map((n) => [n.id, n.name]));
  const edgeRows = await db
    .select({ sourceId: edges.sourceId, targetId: edges.targetId })
    .from(edges)
    .where(domainWhere(edges.domain, domain));

  const labels = labelPropagation(
    allNodes.map((n) => n.id),
    edgeRows.map((e) => [e.sourceId, e.targetId])
  );

  // Group nodes by community label.
  const groups = new Map<string, string[]>();
  for (const [nodeId, label] of labels.entries()) {
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(nodeId);
  }

  // Replace previous communities for this domain only.
  await db.delete(communities).where(domainWhere(communities.domain, domain));

  const allProps = await db.select().from(propositions).where(domainWhere(propositions.domain, domain));

  let communityCount = 0;
  let summarized = 0;

  for (const [, members] of groups.entries()) {
    if (members.length < minSize) continue;
    communityCount++;

    const memberSet = new Set(members);
    const memberNames = members.map((id) => nameById.get(id)).filter(Boolean) as string[];
    const sampleProps = allProps
      .filter((p) => ((p.nodeIds as string[] | null) ?? []).some((id) => memberSet.has(id)))
      .slice(0, 8)
      .map((p) => p.text);

    const label = memberNames.slice(0, 3).join(', ');

    let summary = `Cluster of: ${memberNames.slice(0, 12).join(', ')}`;
    try {
      const system =
        'Summarize this cluster of related research entities in 2-3 sentences, ' +
        'focusing on the shared theme and key relationships.';
      const user = `Entities: ${memberNames.join(', ')}\n\nEvidence:\n${sampleProps.join('\n')}`;
      const completion = await generateCompletion(system, user, 0.3, 'community-summary');
      if (completion.text.trim()) summary = completion.text.trim();
      summarized++;
    } catch (e) {
      console.warn('Community summary failed, using fallback:', e);
    }

    let embedding: number[] | null = null;
    try {
      embedding = await embedOne(summary, 'community');
    } catch {
      // leave null
    }

    await db.insert(communities).values({
      label,
      domain,
      nodeIds: members,
      summary,
      embedding: embedding as any,
    });
  }

  return { communities: communityCount, summarized };
}
