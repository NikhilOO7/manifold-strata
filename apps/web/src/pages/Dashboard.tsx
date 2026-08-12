import { useQuery, useMutation, useQueryClient, useIsFetching } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useState } from 'react';

export default function Dashboard() {
  const queryClient = useQueryClient();
  const [processingPaperId, setProcessingPaperId] = useState<string | null>(null);
  // Any query on this page currently hitting the network — drives the refresh
  // button's spinner so feedback lasts exactly as long as the work does.
  const isRefreshing = useIsFetching() > 0;

  const { data: stats, isLoading } = useQuery({
    queryKey: ['graph-stats'],
    queryFn: () => api.graph.stats(),
  });

  const { data: papersData } = useQuery({
    queryKey: ['papers', 10, 0],
    queryFn: () => api.papers.list(10, 0),
  });

  const { data: processingPapers } = useQuery({
    queryKey: ['processing-papers'],
    queryFn: () => api.papers.processing(),
    /**
     * Poll fast only while something is actually processing.
     *
     * This was a flat 2s regardless of state, so an open dashboard sent roughly
     * 43,000 requests a day asking whether a usually-empty list had changed. The
     * cost is not just noise in the log: it is a query against the papers table
     * every two seconds forever, and on the API side those requests share a rate
     * limit with real work.
     *
     * Idle still polls, just slowly — a paper can start processing from the
     * ingestion page or another client, and the dashboard should notice within a
     * reasonable time rather than needing a refresh.
     */
    refetchInterval: (query) =>
      (query.state.data?.papers?.length ?? 0) > 0 ? 2000 : 30000,
  });

  const processMutation = useMutation({
    mutationFn: (paperId: string) => api.papers.process(paperId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['processing-papers'] });
      queryClient.invalidateQueries({ queryKey: ['papers'] });
      setProcessingPaperId(null);
    },
    onError: (error) => {
      console.error('Error processing paper:', error);
      setProcessingPaperId(null);
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-center">
          <div className="relative">
            <div className="animate-spin rounded-full h-16 w-16 border-b-4 border-blue-600 mx-auto mb-4"></div>
            <div className="absolute inset-0 animate-ping rounded-full h-16 w-16 border-2 border-blue-400 opacity-20 mx-auto"></div>
          </div>
          <p className="text-gray-600 font-medium">Loading dashboard...</p>
          <p className="text-gray-400 text-sm mt-1">Fetching your knowledge graph data</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
            Dashboard
          </h1>
          <p className="text-sm text-gray-500 mt-2 flex items-center space-x-2">
            <span className="w-2 h-2 bg-emerald-500 rounded-full animate-pulse"></span>
            <span>Monitor your knowledge graph metrics and recent activity</span>
          </p>
        </div>
        <div className="flex items-center space-x-3">
          <button
            onClick={() => {
              // The button always "worked" — invalidation does refetch — but a
              // fast refetch is indistinguishable from a dead button without
              // feedback. The spinner below is driven by the real in-flight
              // state, so it shows exactly as long as the network does.
              queryClient.invalidateQueries({ queryKey: ['graph-stats'] });
              queryClient.invalidateQueries({ queryKey: ['papers'] });
              queryClient.invalidateQueries({ queryKey: ['processing-papers'] });
            }}
            disabled={isRefreshing}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-200 rounded-lg hover:bg-gray-50 hover:border-gray-300 transition-all duration-200 flex items-center space-x-2 disabled:opacity-60 disabled:cursor-wait"
          >
            <svg
              className={`w-4 h-4 ${isRefreshing ? 'animate-spin text-blue-600' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
            <span>{isRefreshing ? 'Refreshing…' : 'Refresh'}</span>
          </button>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="group bg-white rounded-2xl border border-gray-200/60 p-6 hover:shadow-xl hover:shadow-blue-100/50 hover:border-blue-300/50 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-blue-500/10 to-transparent rounded-full -mr-16 -mt-16"></div>
          <div className="relative">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30 group-hover:scale-110 transition-transform duration-300">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                </svg>
              </div>
              <span className="text-xs font-semibold text-blue-600 bg-blue-50 px-3 py-1 rounded-full">Active</span>
            </div>
            <p className="text-sm font-medium text-gray-500 mb-1">Total Nodes</p>
            <p className="text-4xl font-bold bg-gradient-to-r from-blue-600 to-blue-700 bg-clip-text text-transparent">
              {stats?.nodes.total || 0}
            </p>
            <p className="text-xs text-gray-400 mt-2">Entities in your graph</p>
          </div>
        </div>

        <div className="group bg-white rounded-2xl border border-gray-200/60 p-6 hover:shadow-xl hover:shadow-purple-100/50 hover:border-purple-300/50 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-purple-500/10 to-transparent rounded-full -mr-16 -mt-16"></div>
          <div className="relative">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/30 group-hover:scale-110 transition-transform duration-300">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
                </svg>
              </div>
              <span className="text-xs font-semibold text-purple-600 bg-purple-50 px-3 py-1 rounded-full">Connected</span>
            </div>
            <p className="text-sm font-medium text-gray-500 mb-1">Total Edges</p>
            <p className="text-4xl font-bold bg-gradient-to-r from-purple-600 to-purple-700 bg-clip-text text-transparent">
              {stats?.edges.total || 0}
            </p>
            <p className="text-xs text-gray-400 mt-2">Relationships mapped</p>
          </div>
        </div>

        <div className="group bg-white rounded-2xl border border-gray-200/60 p-6 hover:shadow-xl hover:shadow-emerald-100/50 hover:border-emerald-300/50 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-32 h-32 bg-gradient-to-br from-emerald-500/10 to-transparent rounded-full -mr-16 -mt-16"></div>
          <div className="relative">
            <div className="flex items-center justify-between mb-4">
              <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/30 group-hover:scale-110 transition-transform duration-300">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <span className="text-xs font-semibold text-emerald-600 bg-emerald-50 px-3 py-1 rounded-full">Growing</span>
            </div>
            <p className="text-sm font-medium text-gray-500 mb-1">Total Papers</p>
            <p className="text-4xl font-bold bg-gradient-to-r from-emerald-600 to-emerald-700 bg-clip-text text-transparent">
              {papersData?.papers.length || 0}
            </p>
            <p className="text-xs text-gray-400 mt-2">Research papers indexed</p>
          </div>
        </div>
      </div>

      {/* Processing Papers Section */}
      {processingPapers && processingPapers.papers.length > 0 && (
        <div className="bg-gradient-to-br from-orange-50 to-amber-50 rounded-2xl border-2 border-orange-200/60 p-6 shadow-lg">
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-12 h-12 bg-gradient-to-br from-orange-500 to-amber-500 rounded-xl flex items-center justify-center shadow-lg shadow-orange-500/30">
              <svg className="w-6 h-6 text-white animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Processing Papers</h2>
              <p className="text-sm text-gray-600">{processingPapers.papers.length} paper{processingPapers.papers.length !== 1 ? 's' : ''} currently being processed</p>
            </div>
          </div>

          <div className="space-y-4">
            {processingPapers.papers.map((paper) => {
              const statusConfig: Record<string, { color: string; label: string; progress: number; icon: string }> = {
                pending: { color: 'gray', label: 'Pending', progress: 0, icon: '⏳' },
                downloading_pdf: { color: 'blue', label: 'Downloading PDF', progress: 15, icon: '⬇️' },
                extracting_text: { color: 'indigo', label: 'Extracting Text', progress: 30, icon: '📄' },
                chunking: { color: 'purple', label: 'Chunking', progress: 45, icon: '✂️' },
                extracting_entities: { color: 'pink', label: 'Extracting Entities', progress: 60, icon: '🔍' },
                resolving_entities: { color: 'rose', label: 'Resolving Entities', progress: 75, icon: '🔗' },
                validating: { color: 'orange', label: 'Validating', progress: 90, icon: '✅' },
                completed: { color: 'green', label: 'Completed', progress: 100, icon: '✓' },
                failed: { color: 'red', label: 'Failed', progress: 0, icon: '✗' }
              };

              const status = statusConfig[paper.processingStatus] || statusConfig.pending;

              const isPending = paper.processingStatus === 'pending';
              const isProcessing = processingPaperId === paper.id;

              return (
                <div key={paper.id} className="bg-white rounded-xl border border-orange-200/60 p-5 hover:shadow-md transition-all duration-200">
                  <div className="flex items-start justify-between mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-gray-900 text-sm mb-1 truncate">{paper.title}</h3>
                      {paper.arxivId && (
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800">
                          arXiv: {paper.arxivId}
                        </span>
                      )}
                    </div>
                    <div className="flex items-center space-x-2 ml-3 flex-shrink-0">
                      {isPending && (
                        <button
                          onClick={() => {
                            setProcessingPaperId(paper.id);
                            processMutation.mutate(paper.id);
                          }}
                          disabled={isProcessing}
                          className="px-3 py-1.5 bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-300 disabled:to-gray-400 text-white text-xs font-bold rounded-lg shadow-sm hover:shadow-md transition-all duration-200 flex items-center space-x-1"
                        >
                          {isProcessing ? (
                            <>
                              <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                              </svg>
                              <span>Processing...</span>
                            </>
                          ) : (
                            <>
                              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                              </svg>
                              <span>Process Now</span>
                            </>
                          )}
                        </button>
                      )}
                      <div className={`flex items-center space-x-2 px-3 py-1.5 rounded-lg text-xs font-bold bg-${status.color}-100 text-${status.color}-800 border-2 border-${status.color}-200`}>
                        <span>{status.icon}</span>
                        <span>{status.label}</span>
                      </div>
                    </div>
                  </div>

                  <div className="space-y-2">
                    <div className="flex items-center justify-between text-xs">
                      <span className="text-gray-600 font-medium">Progress</span>
                      <span className="text-gray-900 font-bold">{paper.processingProgress || status.progress}%</span>
                    </div>
                    <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                      <div
                        className={`h-2.5 rounded-full transition-all duration-500 ease-out bg-gradient-to-r from-${status.color}-500 to-${status.color}-600`}
                        style={{ width: `${paper.processingProgress || status.progress}%` }}
                      >
                        <div className="h-full w-full bg-gradient-to-r from-transparent via-white/30 to-transparent animate-pulse"></div>
                      </div>
                    </div>
                  </div>

                  {paper.processingError && (
                    <div className="mt-3 p-3 bg-red-50 border border-red-200 rounded-lg">
                      <p className="text-xs text-red-800 font-medium flex items-center space-x-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        <span>{paper.processingError}</span>
                      </p>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {stats?.nodes.byType && stats.nodes.byType.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Node Distribution</h2>
            <div className="space-y-3">
              {stats.nodes.byType.map((item) => {
                const percentage = ((item.count / (stats.nodes.total || 1)) * 100).toFixed(1);
                return (
                  <div key={item.type} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-gray-700 capitalize">{item.type}</span>
                      <span className="text-gray-600">{item.count} ({percentage}%)</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all duration-500"
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {stats?.edges.byType && stats.edges.byType.length > 0 && (
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <h2 className="text-lg font-semibold text-gray-900 mb-4">Edge Distribution</h2>
            <div className="space-y-3">
              {stats.edges.byType.map((item) => {
                const percentage = ((item.count / (stats.edges.total || 1)) * 100).toFixed(1);
                return (
                  <div key={item.type} className="space-y-2">
                    <div className="flex items-center justify-between text-sm">
                      <span className="font-medium text-gray-700 capitalize">{item.type.replace(/_/g, ' ')}</span>
                      <span className="text-gray-600">{item.count} ({percentage}%)</span>
                    </div>
                    <div className="w-full bg-gray-100 rounded-full h-2">
                      <div
                        className="bg-purple-600 h-2 rounded-full transition-all duration-500"
                        style={{ width: `${percentage}%` }}
                      ></div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {papersData?.papers && papersData.papers.length > 0 && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Recent Papers</h2>
          <div className="space-y-3">
            {papersData.papers.map((paper) => (
              <div
                key={paper.id}
                className="p-4 bg-gray-50 rounded-lg border border-gray-200 hover:border-blue-300 hover:bg-blue-50 transition-all"
              >
                <h3 className="font-medium text-gray-900 text-sm mb-2">{paper.title}</h3>
                <div className="flex items-center gap-3 flex-wrap">
                  {paper.arxivId && (
                    <span className="inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium bg-blue-100 text-blue-800">
                      arXiv: {paper.arxivId}
                    </span>
                  )}
                  <span
                    className={`inline-flex items-center px-2.5 py-0.5 rounded-md text-xs font-medium ${
                      paper.processed
                        ? 'bg-green-100 text-green-800'
                        : 'bg-yellow-100 text-yellow-800'
                    }`}
                  >
                    {paper.processed ? '✓ Processed' : '⏳ Pending'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
