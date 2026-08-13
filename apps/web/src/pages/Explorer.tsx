import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactFlow, { Background, Controls, MarkerType } from 'reactflow';
import 'reactflow/dist/style.css';
import type { Node as GraphNode } from 'shared';
import { api } from '../lib/api';
import { computeEgoLayout } from '../lib/layout';

/**
 * The Explorer is a navigation surface, not a map.
 *
 * Two rounds of tuning the force-directed overview proved the idea itself was
 * wrong: 60+ boxes in one simulation is unreadable no matter how it is styled,
 * because a global layout answers a question nobody is asking. The question
 * people actually ask of a knowledge graph is local — "what relates to THIS,
 * and how?" — so the page is built around that:
 *
 *   pick an entity (search, or the most-connected list)
 *     → see only its neighbourhood, radially: outgoing right, incoming left,
 *       grouped by relationship type, every label readable
 *     → click any neighbour to make it the new centre; breadcrumbs remember
 *       the path
 *
 * Every screen shows five to thirty nodes. The hairball is gone because it was
 * never information.
 */

interface Crumb {
  id: string;
  name: string;
}

export default function Explorer() {
  const [centerId, setCenterId] = useState<string | null>(null);
  const [trail, setTrail] = useState<Crumb[]>([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [domainFilter, setDomainFilter] = useState('');
  const [depth, setDepth] = useState<1 | 2>(1);

  const { data: domainsData } = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.domains.list(),
  });

  // One modest fetch powers the "most connected" entry points; this is a list,
  // not a rendered graph, so its size costs nothing visually.
  const { data: nodesData } = useQuery({
    queryKey: ['explorer-nodes', domainFilter],
    queryFn: () => api.graph.nodes({ limit: 500, domain: domainFilter || undefined }),
  });
  const { data: edgesData } = useQuery({
    queryKey: ['explorer-edges', domainFilter],
    queryFn: () => api.graph.edges({ limit: 500, domain: domainFilter || undefined }),
  });

  const { data: searchData, isFetching: searching } = useQuery({
    queryKey: ['explorer-search', searchTerm, domainFilter],
    queryFn: () =>
      api.graph.nodes({ search: searchTerm, limit: 20, domain: domainFilter || undefined }),
    enabled: searchTerm.trim().length > 1,
  });

  const { data: ego, isLoading: egoLoading } = useQuery({
    queryKey: ['ego', centerId, depth],
    queryFn: () => api.graph.subgraph(centerId!, depth),
    enabled: !!centerId,
  });

  // Rich context for the centre: description, corpus mentions, typed neighbours.
  const { data: centerDetail } = useQuery({
    queryKey: ['node-detail', centerId],
    queryFn: () => api.graph.node(centerId!),
    enabled: !!centerId,
  });

  const getNodeColor = (type: string): string => {
    const known: Record<string, string> = {
      paper: '#3b82f6',
      method: '#10b981',
      concept: '#f59e0b',
      dataset: '#8b5cf6',
      metric: '#ef4444',
    };
    if (known[type]) return known[type];
    const palette = ['#06b6d4', '#ec4899', '#84cc16', '#f97316', '#6366f1', '#14b8a6', '#a855f7', '#eab308'];
    let h = 0;
    for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
    return palette[h % palette.length];
  };

  /** Ranked entry points: the entities with the most relationships. */
  const hubs = useMemo(() => {
    const nodes = nodesData?.nodes ?? [];
    const edges = edgesData?.edges ?? [];
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.sourceId, (degree.get(e.sourceId) ?? 0) + 1);
      degree.set(e.targetId, (degree.get(e.targetId) ?? 0) + 1);
    }
    return nodes
      .map((n) => ({ node: n, degree: degree.get(n.id) ?? 0 }))
      .filter((h) => h.degree > 0)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 14);
  }, [nodesData, edgesData]);

  const navigateTo = (node: Pick<GraphNode, 'id' | 'name'>) => {
    setCenterId(node.id);
    setTrail((prev) => {
      const existing = prev.findIndex((c) => c.id === node.id);
      // Revisiting a crumb truncates the path back to it, like a file browser.
      if (existing !== -1) return prev.slice(0, existing + 1);
      return [...prev, { id: node.id, name: node.name }];
    });
    setSearchTerm('');
  };

  const centerNode = useMemo(
    () => ego?.nodes.find((n) => n.id === centerId) ?? ego?.center,
    [ego, centerId]
  );

  // Radial layout: positions from relationships, styling from ring + type.
  const { flowNodes, flowEdges } = useMemo(() => {
    if (!ego || !centerId) return { flowNodes: [], flowEdges: [] };

    const positions = computeEgoLayout(
      centerId,
      ego.edges.map((e) => ({ source: e.sourceId, target: e.targetId, type: e.type }))
    );

    const neighbourIds = new Set<string>();
    for (const e of ego.edges) {
      if (e.sourceId === centerId) neighbourIds.add(e.targetId);
      if (e.targetId === centerId) neighbourIds.add(e.sourceId);
    }

    const flowNodes = ego.nodes
      .filter((n) => positions.has(n.id))
      .map((node) => {
        const isCenter = node.id === centerId;
        const isRingOne = neighbourIds.has(node.id);
        const label = node.name.length > 46 ? `${node.name.slice(0, 45)}…` : node.name;
        return {
          id: node.id,
          data: { label },
          position: positions.get(node.id)!,
          style: isCenter
            ? {
                background: '#0f172a',
                color: '#fff',
                padding: 14,
                borderRadius: 14,
                fontSize: 15,
                fontWeight: 700,
                border: `3px solid ${getNodeColor(node.type)}`,
                boxShadow: '0 8px 24px -6px rgba(15,23,42,0.45)',
                maxWidth: 260,
                textAlign: 'center' as const,
              }
            : {
                background: getNodeColor(node.type),
                color: '#fff',
                padding: isRingOne ? 10 : 7,
                borderRadius: 10,
                fontSize: isRingOne ? 12 : 10,
                fontWeight: 600,
                border: '1px solid rgba(255,255,255,0.3)',
                opacity: isRingOne ? 1 : 0.75,
                maxWidth: isRingOne ? 210 : 170,
                textAlign: 'center' as const,
              },
        };
      });

    const flowEdges = ego.edges.map((edge) => {
      const touchesCenter = edge.sourceId === centerId || edge.targetId === centerId;
      return {
        id: edge.id,
        source: edge.sourceId,
        target: edge.targetId,
        // Sparse view — the relationship type is always legible, which is the
        // point: the edge label IS the knowledge.
        label: edge.type.replace(/_/g, ' '),
        type: 'straight',
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#94a3b8' },
        style: {
          stroke: touchesCenter ? '#64748b' : '#cbd5e1',
          strokeWidth: touchesCenter ? 1.8 : 1,
        },
        labelStyle: { fill: touchesCenter ? '#475569' : '#94a3b8', fontWeight: 600, fontSize: 11 },
        labelBgStyle: { fill: '#ffffff', fillOpacity: 0.9 },
        labelBgPadding: [4, 2] as [number, number],
      };
    });

    return { flowNodes, flowEdges };
  }, [ego, centerId]);

  const sidebarList =
    searchTerm.trim().length > 1
      ? (searchData?.nodes ?? []).map((n) => ({ node: n, degree: null as number | null }))
      : hubs;

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
          Knowledge Explorer
        </h1>
        <p className="text-sm text-gray-500 mt-2">
          Pick an entity, see everything related to it, follow the connections.
        </p>
      </div>

      <div className="flex gap-6 h-[calc(100vh-12rem)]">
        {/* Entry points: search + most connected */}
        <div className="w-80 flex flex-col bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-hidden">
          <div className="p-4 border-b border-gray-200/60 space-y-3">
            <select
              value={domainFilter}
              onChange={(e) => {
                setDomainFilter(e.target.value);
                setCenterId(null);
                setTrail([]);
              }}
              className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-gray-700 font-medium bg-white"
            >
              <option value="">All domains</option>
              {(domainsData?.domains ?? []).map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="Search entities…"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full px-3 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm text-gray-900 placeholder-gray-400"
            />
          </div>

          <div className="px-4 pt-3 pb-1 text-xs font-semibold text-gray-500 uppercase tracking-wide">
            {searchTerm.trim().length > 1
              ? searching
                ? 'Searching…'
                : `Results (${sidebarList.length})`
              : 'Most connected'}
          </div>

          <div className="flex-1 overflow-y-auto px-2 pb-2">
            {sidebarList.length === 0 && (
              <p className="text-sm text-gray-400 px-2 py-4">
                {searchTerm.trim().length > 1 ? 'Nothing matches.' : 'No connected entities yet.'}
              </p>
            )}
            {sidebarList.map(({ node, degree }) => (
              <button
                key={node.id}
                onClick={() => navigateTo(node)}
                className={`w-full text-left px-3 py-2.5 rounded-lg mb-1 transition-colors ${
                  node.id === centerId ? 'bg-blue-50 border border-blue-200' : 'hover:bg-gray-50'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="w-2.5 h-2.5 rounded-full flex-shrink-0"
                    style={{ background: getNodeColor(node.type) }}
                  />
                  <span className="text-sm font-medium text-gray-800 truncate flex-1">
                    {node.name}
                  </span>
                  {degree !== null && (
                    <span className="text-xs font-mono text-gray-400 flex-shrink-0">{degree}</span>
                  )}
                </div>
                <div className="text-xs text-gray-400 ml-4.5 mt-0.5 capitalize pl-4">
                  {node.type.replace(/_/g, ' ')}
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Neighbourhood canvas */}
        <div className="flex-1 flex flex-col bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-hidden">
          {/* Breadcrumb trail + depth */}
          <div className="px-5 py-3 border-b border-gray-200/60 flex items-center gap-3 flex-wrap min-h-[3.25rem]">
            <div className="flex items-center gap-1.5 flex-wrap flex-1 text-sm">
              {trail.length === 0 && <span className="text-gray-400">No entity selected</span>}
              {trail.map((crumb, i) => (
                <span key={crumb.id} className="flex items-center gap-1.5">
                  {i > 0 && <span className="text-gray-300">→</span>}
                  <button
                    onClick={() => navigateTo(crumb)}
                    className={`px-2 py-1 rounded-md max-w-[14rem] truncate ${
                      crumb.id === centerId
                        ? 'bg-slate-800 text-white font-semibold'
                        : 'text-blue-600 hover:bg-blue-50'
                    }`}
                    title={crumb.name}
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>
            {centerId && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500">Hops</span>
                {([1, 2] as const).map((d) => (
                  <button
                    key={d}
                    onClick={() => setDepth(d)}
                    className={`w-8 h-8 rounded-lg font-semibold ${
                      depth === d
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {d}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Centre summary */}
          {centerNode && (
            <div className="px-5 py-3 border-b border-gray-200/60 bg-gradient-to-r from-slate-50 to-white flex items-start gap-3">
              <span
                className="mt-1 w-3 h-3 rounded-full flex-shrink-0"
                style={{ background: getNodeColor(centerNode.type) }}
              />
              <div className="min-w-0">
                <div className="font-bold text-gray-900 truncate" title={centerNode.name}>
                  {centerNode.name}
                </div>
                <div className="text-xs text-gray-500 capitalize">
                  {centerNode.type.replace(/_/g, ' ')} ·{' '}
                  {flowNodes.length > 0 ? flowNodes.length - 1 : 0} related · click a neighbour to
                  travel
                </div>
                {centerNode.description && (
                  <p className="text-sm text-gray-600 mt-1 line-clamp-2">{centerNode.description}</p>
                )}
              </div>
            </div>
          )}

          {!centerId ? (
            <div className="flex-1 flex items-center justify-center bg-gradient-to-br from-gray-50 to-blue-50/30">
              <div className="text-center max-w-sm">
                <div className="w-16 h-16 mx-auto mb-4 bg-white rounded-2xl border border-gray-200 shadow-sm flex items-center justify-center">
                  <svg className="w-8 h-8 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <p className="text-gray-700 font-semibold">Start from an entity</p>
                <p className="text-gray-400 text-sm mt-1.5">
                  Choose one of the most-connected entities on the left, or search for something
                  specific. Its relationships will fan out here.
                </p>
              </div>
            </div>
          ) : egoLoading ? (
            <div className="flex-1 flex items-center justify-center">
              <div className="animate-spin rounded-full h-12 w-12 border-b-4 border-blue-600" />
            </div>
          ) : (
            <div className="flex-1">
              <ReactFlow
                key={`${centerId}-${depth}`}
                nodes={flowNodes}
                edges={flowEdges}
                onNodeClick={(_, node) => {
                  if (node.id === centerId) return;
                  const target = ego?.nodes.find((n) => n.id === node.id);
                  if (target) navigateTo(target);
                }}
                fitView
                fitViewOptions={{ padding: 0.15 }}
                nodesDraggable={false}
                nodesConnectable={false}
              >
                <Background gap={24} />
                <Controls showInteractive={false} />
              </ReactFlow>
            </div>
          )}
        </div>

        {/* Context: what is this thing, in the corpus's own words */}
        {centerId && centerDetail && (
          <div className="w-80 flex flex-col bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-hidden">
            <div className="p-4 border-b border-gray-200/60">
              <div className="flex items-center gap-2">
                <span
                  className="w-3 h-3 rounded-full flex-shrink-0"
                  style={{ background: getNodeColor(centerDetail.node.type) }}
                />
                <h3 className="font-bold text-gray-900 truncate" title={centerDetail.node.name}>
                  {centerDetail.node.name}
                </h3>
              </div>
              <p className="text-xs text-gray-500 mt-1 capitalize">
                {centerDetail.node.type.replace(/_/g, ' ')}
                {centerDetail.domain ? ` · ${centerDetail.domain}` : ''}
              </p>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-5 text-sm">
              <div>
                <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">
                  About
                </h4>
                {centerDetail.node.description ? (
                  <p className="text-gray-700 leading-relaxed">{centerDetail.node.description}</p>
                ) : (
                  <p className="text-gray-400">
                    No stored description — the mentions below are what the corpus says about it.
                  </p>
                )}
              </div>

              {(centerDetail.mentions?.length ?? 0) > 0 && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Mentions in the corpus ({centerDetail.mentions!.length})
                  </h4>
                  <div className="space-y-2">
                    {centerDetail.mentions!.map((m, i) => (
                      <blockquote
                        key={i}
                        className="border-l-2 border-blue-200 bg-blue-50/40 pl-3 pr-2 py-2 rounded-r-lg"
                      >
                        <p className="text-gray-700 text-xs leading-relaxed">“{m.text}”</p>
                        {m.section && (
                          <span className="inline-block mt-1 text-[10px] font-mono uppercase tracking-wide text-blue-500">
                            {m.section.replace(/_/g, ' ')}
                          </span>
                        )}
                      </blockquote>
                    ))}
                  </div>
                </div>
              )}

              {(centerDetail.outgoingEdges.length > 0 || centerDetail.incomingEdges.length > 0) && (
                <div>
                  <h4 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                    Relationships
                  </h4>
                  <div className="space-y-1.5">
                    {centerDetail.outgoingEdges.slice(0, 6).map((e) => (
                      <div key={e.id} className="flex items-baseline gap-1.5 text-xs">
                        <span className="text-emerald-700 font-semibold whitespace-nowrap">
                          {e.type.replace(/_/g, ' ')} →
                        </span>
                        <span className="text-gray-600 truncate">{e.targetNode?.name ?? '…'}</span>
                      </div>
                    ))}
                    {centerDetail.incomingEdges.slice(0, 6).map((e) => (
                      <div key={e.id} className="flex items-baseline gap-1.5 text-xs">
                        <span className="text-orange-700 font-semibold whitespace-nowrap">
                          ← {e.type.replace(/_/g, ' ')}
                        </span>
                        <span className="text-gray-600 truncate">{e.sourceNode?.name ?? '…'}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
