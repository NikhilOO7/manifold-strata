import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import ReactFlow, { Background, Controls, MiniMap } from 'reactflow';
import 'reactflow/dist/style.css';
import { api } from '../lib/api';
import { computeForceLayout } from '../lib/layout';

export default function Explorer() {
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [nodeTypeFilter, setNodeTypeFilter] = useState<string>('');
  const [minConfidence, setMinConfidence] = useState(0);
  const [nodeLimit, setNodeLimit] = useState(100);
  const [domainFilter, setDomainFilter] = useState('');

  const { data: domainsData } = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.domains.list(),
  });

  const { data: nodesData, isLoading } = useQuery({
    queryKey: ['nodes', nodeTypeFilter, searchTerm, nodeLimit, domainFilter],
    queryFn: () =>
      api.graph.nodes({
        type: nodeTypeFilter || undefined,
        search: searchTerm || undefined,
        limit: nodeLimit,
        domain: domainFilter || undefined,
      }),
  });

  const { data: edgesData } = useQuery({
    queryKey: ['edges', domainFilter],
    queryFn: () => api.graph.edges({ limit: 500, domain: domainFilter || undefined }),
  });

  // Node types present in the graph — drives the filter dropdown dynamically so
  // newly discovered types show up without code changes (scoped to the domain).
  const { data: typesData } = useQuery({
    queryKey: ['graph-types', domainFilter],
    queryFn: () => api.graph.types(domainFilter || undefined),
  });

  const { data: selectedNodeData } = useQuery({
    queryKey: ['node', selectedNodeId],
    queryFn: () => api.graph.node(selectedNodeId!),
    enabled: !!selectedNodeId,
  });

  // Stable colors for known types; any newly discovered type gets a deterministic
  // color from the palette (hashed by name) so it's consistent across renders.
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

  // Build flow nodes/edges: filter edges by confidence and to the currently
  // loaded node set, then run a force-directed layout so related nodes cluster.
  const { flowNodes, flowEdges, totalEdges } = useMemo(() => {
    const rawNodes = nodesData?.nodes ?? [];
    const rawEdges = edgesData?.edges ?? [];
    const visibleIds = new Set(rawNodes.map((n) => n.id));

    const keptEdges = rawEdges.filter(
      (e) =>
        visibleIds.has(e.sourceId) &&
        visibleIds.has(e.targetId) &&
        parseFloat(e.confidence ?? '0') >= minConfidence
    );

    const positions = computeForceLayout(
      rawNodes.map((n) => ({ id: n.id })),
      keptEdges.map((e) => ({ source: e.sourceId, target: e.targetId }))
    );

    const flowNodes = rawNodes.map((node) => ({
      id: node.id,
      data: { label: node.name },
      position: positions.get(node.id) ?? { x: 0, y: 0 },
      style: {
        background: getNodeColor(node.type),
        color: '#fff',
        padding: 10,
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 600,
        border: '2px solid rgba(255,255,255,0.2)',
        boxShadow: '0 4px 6px -1px rgba(0, 0, 0, 0.1)',
        minWidth: 120,
        textAlign: 'center' as const,
      },
    }));

    const flowEdges = keptEdges.map((edge) => ({
      id: edge.id,
      source: edge.sourceId,
      target: edge.targetId,
      label: edge.type,
      type: 'smoothstep',
      style: { stroke: '#9ca3af', strokeWidth: 2 },
      labelStyle: { fill: '#6b7280', fontWeight: 600, fontSize: 12 },
    }));

    return { flowNodes, flowEdges, totalEdges: rawEdges.length };
  }, [nodesData, edgesData, minConfidence]);

  return (
    <div className="space-y-6 animate-fadeIn">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
            Graph Explorer
          </h1>
          <p className="text-sm text-gray-500 mt-2 flex items-center space-x-2">
            <svg className="w-4 h-4 text-purple-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <span>Visualize and explore your knowledge graph relationships</span>
          </p>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex gap-6 h-[calc(100vh-12rem)]">
        {/* Graph Canvas */}
        <div className="flex-1 bg-white rounded-2xl border border-gray-200/60 shadow-lg overflow-hidden">
          {/* Toolbar */}
          <div className="p-5 border-b border-gray-200/60 bg-gradient-to-r from-white to-gray-50/50">
            <div className="flex gap-3">
              <div className="flex-1 relative">
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
                <input
                  type="text"
                  placeholder="Search nodes..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 text-gray-900 placeholder-gray-400"
                />
              </div>
              <select
                value={domainFilter}
                onChange={(e) => setDomainFilter(e.target.value)}
                className="px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 text-gray-700 font-medium bg-white"
              >
                <option value="">All Domains</option>
                {(domainsData?.domains ?? []).map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <select
                value={nodeTypeFilter}
                onChange={(e) => setNodeTypeFilter(e.target.value)}
                className="px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 text-gray-700 font-medium bg-white"
              >
                <option value="">All Types</option>
                {(typesData?.nodeTypes ?? []).map((t) => (
                  <option key={t} value={t}>
                    {t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ')}
                  </option>
                ))}
              </select>
            </div>

            {/* Filters: confidence threshold + node limit + live counts */}
            <div className="flex items-center gap-6 mt-3 flex-wrap">
              <div className="flex items-center gap-3">
                <label className="text-sm font-medium text-gray-600 whitespace-nowrap">
                  Min confidence
                </label>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={minConfidence}
                  onChange={(e) => setMinConfidence(parseFloat(e.target.value))}
                  className="w-40 accent-blue-600"
                />
                <span className="text-sm font-mono text-gray-700 w-10">
                  {minConfidence.toFixed(2)}
                </span>
              </div>

              <div className="flex items-center gap-2">
                <label className="text-sm font-medium text-gray-600 whitespace-nowrap">
                  Max nodes
                </label>
                <select
                  value={nodeLimit}
                  onChange={(e) => setNodeLimit(parseInt(e.target.value))}
                  className="px-3 py-2 border-2 border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-gray-700 font-medium bg-white text-sm"
                >
                  <option value={50}>50</option>
                  <option value={100}>100</option>
                  <option value={200}>200</option>
                  <option value={500}>500</option>
                </select>
              </div>

              <div className="text-sm text-gray-500 ml-auto">
                <span className="font-semibold text-gray-700">{flowNodes.length}</span> nodes ·{' '}
                <span className="font-semibold text-gray-700">{flowEdges.length}</span>
                {totalEdges > flowEdges.length ? ` of ${totalEdges}` : ''} edges
              </div>
            </div>
          </div>

          {/* Graph Display */}
          {isLoading ? (
            <div className="flex items-center justify-center h-full bg-gradient-to-br from-gray-50 to-blue-50/30">
              <div className="text-center">
                <div className="relative">
                  <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4"></div>
                  <div className="absolute inset-0 animate-ping rounded-full h-16 w-16 border-2 border-blue-400 opacity-20 mx-auto"></div>
                </div>
                <p className="text-gray-600 font-medium">Loading graph...</p>
                <p className="text-gray-400 text-sm mt-1">Building your knowledge network</p>
              </div>
            </div>
          ) : (
            <ReactFlow
              nodes={flowNodes}
              edges={flowEdges}
              onNodeClick={(_, node) => setSelectedNodeId(node.id)}
              fitView
            >
              <Background />
              <Controls />
              <MiniMap />
            </ReactFlow>
          )}
        </div>

        {/* Details Panel */}
        <div className="w-96 bg-white rounded-2xl border border-gray-200/60 shadow-lg p-6 overflow-y-auto">
          {selectedNodeData ? (
            <div className="space-y-6">
              {/* Header */}
              <div>
                <div className="flex items-center space-x-3 mb-4">
                  <div className="w-10 h-10 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <h3 className="text-xl font-bold text-gray-900">Node Details</h3>
                </div>
              </div>

              {/* Node Info */}
              <div className="space-y-4">
                <div className="p-4 bg-gradient-to-r from-blue-50 to-indigo-50/50 rounded-xl border border-blue-100">
                  <label className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Name</label>
                  <p className="text-lg font-bold text-gray-900 mt-1">{selectedNodeData.node.name}</p>
                </div>

                <div className="p-4 bg-gradient-to-r from-purple-50 to-pink-50/50 rounded-xl border border-purple-100">
                  <label className="text-xs font-semibold text-purple-700 uppercase tracking-wide">Type</label>
                  <p className="text-base font-semibold text-gray-900 mt-1 capitalize">
                    {selectedNodeData.node.type}
                  </p>
                </div>

                {selectedNodeData.node.description && (
                  <div className="p-4 bg-gradient-to-r from-gray-50 to-gray-100/50 rounded-xl border border-gray-200">
                    <label className="text-xs font-semibold text-gray-700 uppercase tracking-wide">Description</label>
                    <p className="text-sm text-gray-700 mt-2 leading-relaxed">{selectedNodeData.node.description}</p>
                  </div>
                )}
              </div>

              {/* Relationships */}
              {selectedNodeData.outgoingEdges.length > 0 && (
                <div>
                  <div className="flex items-center space-x-2 mb-3">
                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                    </svg>
                    <h4 className="text-sm font-bold text-gray-800">
                      Outgoing ({selectedNodeData.outgoingEdges.length})
                    </h4>
                  </div>
                  <div className="space-y-2">
                    {selectedNodeData.outgoingEdges.slice(0, 5).map((edge) => (
                      <div key={edge.id} className="p-3 bg-emerald-50 rounded-lg border border-emerald-200">
                        <span className="text-sm font-medium text-emerald-800 capitalize">
                          {edge.type.replace(/_/g, ' ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selectedNodeData.incomingEdges.length > 0 && (
                <div>
                  <div className="flex items-center space-x-2 mb-3">
                    <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 17l-5-5m0 0l5-5m-5 5h12" />
                    </svg>
                    <h4 className="text-sm font-bold text-gray-800">
                      Incoming ({selectedNodeData.incomingEdges.length})
                    </h4>
                  </div>
                  <div className="space-y-2">
                    {selectedNodeData.incomingEdges.slice(0, 5).map((edge) => (
                      <div key={edge.id} className="p-3 bg-orange-50 rounded-lg border border-orange-200">
                        <span className="text-sm font-medium text-orange-800 capitalize">
                          {edge.type.replace(/_/g, ' ')}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-center">
              <div className="w-20 h-20 bg-gradient-to-br from-gray-100 to-gray-200 rounded-2xl flex items-center justify-center mb-4">
                <svg className="w-10 h-10 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 15l-2 5L9 9l11 4-5 2zm0 0l5 5M7.188 2.239l.777 2.897M5.136 7.965l-2.898-.777M13.95 4.05l-2.122 2.122m-5.657 5.656l-2.12 2.122" />
                </svg>
              </div>
              <p className="text-gray-600 font-medium">Select a node</p>
              <p className="text-gray-400 text-sm mt-2 max-w-xs">
                Click on any node in the graph to view its details and relationships
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
