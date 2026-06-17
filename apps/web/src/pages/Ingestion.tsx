import { useCallback, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { useEventStream, type FieldEvent } from '../hooks/useEventStream';

export default function Ingestion() {
  const [arxivId, setArxivId] = useState('');
  const [bulkIds, setBulkIds] = useState('');
  const [currentJobId, setCurrentJobId] = useState<string | null>(null);
  const [showSuccess, setShowSuccess] = useState(false);
  const [selectedDomain, setSelectedDomain] = useState('default');
  const queryClient = useQueryClient();

  // Push: refresh the relevant queries the moment the server reports a change,
  // instead of waiting for the next poll tick.
  const onStreamEvent = useCallback(
    (event: FieldEvent) => {
      if (event.type === 'job') {
        queryClient.invalidateQueries({ queryKey: ['job-status', event.jobId] });
      }
      queryClient.invalidateQueries({ queryKey: ['papers'] });
      queryClient.invalidateQueries({ queryKey: ['papers', 'processing'] });
    },
    [queryClient]
  );
  useEventStream(onStreamEvent);

  const { data: domainsData } = useQuery({
    queryKey: ['domains'],
    queryFn: () => api.domains.list(),
  });

  const ingestMutation = useMutation({
    mutationFn: (id: string) => api.ingest.arxiv(id, true, selectedDomain || undefined),
    onSuccess: (data) => {
      setCurrentJobId(data.jobId);
      setArxivId('');
      setShowSuccess(true);
      setTimeout(() => setShowSuccess(false), 3000);
    },
  });

  const { data: jobStatus } = useQuery({
    queryKey: ['job-status', currentJobId],
    queryFn: () => api.ingest.status(currentJobId!),
    enabled: !!currentJobId,
    refetchInterval: (query) => {
      const data = query.state.data;
      if (data?.status === 'processing' || data?.status === 'queued') {
        return 2000;
      }
      return false;
    },
  });

  const handleSingleIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (arxivId.trim()) {
      ingestMutation.mutate(arxivId.trim());
    }
  };

  const handleBulkIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    const ids = bulkIds
      .split(/[\n,]/)
      .map((id) => id.trim())
      .filter(Boolean);

    for (const id of ids) {
      await ingestMutation.mutateAsync(id);
    }
    setBulkIds('');
  };

  return (
    <div className="space-y-8 animate-fadeIn">
      {/* Header Section */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-3xl font-bold bg-gradient-to-r from-gray-900 to-gray-700 bg-clip-text text-transparent">
            Add Papers
          </h1>
          <p className="text-sm text-gray-500 mt-2 flex items-center space-x-2">
            <svg className="w-4 h-4 text-blue-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>Import research papers from arXiv to build your knowledge graph</span>
          </p>
        </div>
      </div>

      {/* Domain selector — applies to both single and bulk ingestion */}
      <div className="bg-white rounded-2xl border border-gray-200/60 p-5 shadow-sm flex flex-wrap items-center gap-4">
        <label htmlFor="domain" className="text-sm font-semibold text-gray-700 whitespace-nowrap">
          Domain
        </label>
        <select
          id="domain"
          value={selectedDomain}
          onChange={(e) => setSelectedDomain(e.target.value)}
          className="px-4 py-2.5 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 text-gray-700 font-medium bg-white"
        >
          {(domainsData?.domains ?? []).map((d) => (
            <option key={d.id} value={d.id}>
              {d.name}
            </option>
          ))}
        </select>
        <p className="text-xs text-gray-500">
          Papers are extracted and kept isolated within the selected domain.
        </p>
      </div>

      {/* Success Toast */}
      {showSuccess && (
        <div className="fixed top-20 right-4 bg-emerald-500 text-white px-6 py-4 rounded-xl shadow-2xl shadow-emerald-500/30 flex items-center space-x-3 animate-slideIn z-50">
          <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <span className="font-medium">Paper added successfully!</span>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Single Paper Card */}
        <div className="group bg-white rounded-2xl border border-gray-200/60 p-8 hover:shadow-xl hover:shadow-blue-100/50 hover:border-blue-300/50 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-blue-500/10 to-transparent rounded-full -mr-20 -mt-20"></div>
          <div className="relative">
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-12 h-12 bg-gradient-to-br from-blue-500 to-blue-600 rounded-xl flex items-center justify-center shadow-lg shadow-blue-500/30">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Single Paper</h2>
                <p className="text-sm text-gray-500">Add one paper at a time</p>
              </div>
            </div>

            <form onSubmit={handleSingleIngest} className="space-y-5">
              <div>
                <label htmlFor="arxiv-id" className="block text-sm font-semibold text-gray-700 mb-2">
                  arXiv ID
                </label>
                <div className="relative">
                  <input
                    type="text"
                    id="arxiv-id"
                    value={arxivId}
                    onChange={(e) => setArxivId(e.target.value)}
                    placeholder="e.g., 2308.04079"
                    className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 transition-all duration-200 text-gray-900 placeholder-gray-400"
                  />
                  <div className="absolute inset-y-0 right-0 flex items-center pr-3 pointer-events-none">
                    <svg className="w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                    </svg>
                  </div>
                </div>
                <p className="mt-2 text-xs text-gray-500 flex items-center space-x-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>Enter the arXiv ID without the 'arXiv:' prefix</span>
                </p>
              </div>

              <button
                type="submit"
                disabled={ingestMutation.isPending || !arxivId.trim()}
                className="w-full bg-gradient-to-r from-blue-600 to-blue-700 hover:from-blue-700 hover:to-blue-800 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3.5 px-6 rounded-xl shadow-lg shadow-blue-500/30 hover:shadow-xl hover:shadow-blue-500/40 disabled:shadow-none transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500"
              >
                {ingestMutation.isPending ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </span>
                ) : (
                  <span className="flex items-center justify-center">
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" />
                    </svg>
                    Add Paper
                  </span>
                )}
              </button>

              {ingestMutation.isError && (
                <div className="p-4 bg-red-50 border-2 border-red-200 rounded-xl">
                  <div className="flex items-center space-x-2">
                    <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <p className="text-sm text-red-800 font-medium">
                      {(ingestMutation.error as Error).message}
                    </p>
                  </div>
                </div>
              )}
            </form>
          </div>
        </div>

        {/* Bulk Import Card */}
        <div className="group bg-white rounded-2xl border border-gray-200/60 p-8 hover:shadow-xl hover:shadow-purple-100/50 hover:border-purple-300/50 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-purple-500/10 to-transparent rounded-full -mr-20 -mt-20"></div>
          <div className="relative">
            <div className="flex items-center space-x-3 mb-6">
              <div className="w-12 h-12 bg-gradient-to-br from-purple-500 to-purple-600 rounded-xl flex items-center justify-center shadow-lg shadow-purple-500/30">
                <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
                </svg>
              </div>
              <div>
                <h2 className="text-xl font-bold text-gray-900">Bulk Import</h2>
                <p className="text-sm text-gray-500">Add multiple papers at once</p>
              </div>
            </div>

            <form onSubmit={handleBulkIngest} className="space-y-5">
              <div>
                <label htmlFor="bulk-ids" className="block text-sm font-semibold text-gray-700 mb-2">
                  arXiv IDs
                </label>
                <textarea
                  id="bulk-ids"
                  rows={6}
                  value={bulkIds}
                  onChange={(e) => setBulkIds(e.target.value)}
                  placeholder="2308.04079&#10;2311.18840&#10;2312.01337"
                  className="w-full px-4 py-3 border-2 border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-purple-500 focus:border-purple-500 transition-all duration-200 font-mono text-sm resize-none text-gray-900 placeholder-gray-400"
                />
                <p className="mt-2 text-xs text-gray-500 flex items-center space-x-1">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>One ID per line or comma-separated</span>
                </p>
              </div>

              <button
                type="submit"
                disabled={ingestMutation.isPending || !bulkIds.trim()}
                className="w-full bg-gradient-to-r from-purple-600 to-purple-700 hover:from-purple-700 hover:to-purple-800 disabled:from-gray-300 disabled:to-gray-300 disabled:cursor-not-allowed text-white font-semibold py-3.5 px-6 rounded-xl shadow-lg shadow-purple-500/30 hover:shadow-xl hover:shadow-purple-500/40 disabled:shadow-none transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500"
              >
                {ingestMutation.isPending ? (
                  <span className="flex items-center justify-center">
                    <svg className="animate-spin -ml-1 mr-3 h-5 w-5" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Processing...
                  </span>
                ) : (
                  <span className="flex items-center justify-center">
                    <svg className="w-5 h-5 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                    </svg>
                    Import Papers
                  </span>
                )}
              </button>
            </form>
          </div>
        </div>
      </div>

      {/* Job Status Section */}
      {currentJobId && jobStatus && (
        <div className="bg-white rounded-2xl border border-gray-200/60 p-8 shadow-lg">
          <div className="flex items-center space-x-3 mb-6">
            <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-lg shadow-emerald-500/30">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div>
              <h2 className="text-xl font-bold text-gray-900">Processing Status</h2>
              <p className="text-sm text-gray-500">Track your import progress</p>
            </div>
          </div>

          <div className="space-y-4">
            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-gray-100/50 rounded-xl">
              <span className="text-sm font-semibold text-gray-600">Job ID</span>
              <span className="text-sm font-mono text-gray-900 bg-white px-3 py-1 rounded-lg border border-gray-200">{currentJobId}</span>
            </div>

            <div className="flex items-center justify-between p-4 bg-gradient-to-r from-gray-50 to-gray-100/50 rounded-xl">
              <span className="text-sm font-semibold text-gray-600">Status</span>
              <span
                className={`inline-flex items-center px-4 py-1.5 rounded-lg text-xs font-bold ${
                  jobStatus.status === 'completed'
                    ? 'bg-emerald-100 text-emerald-800 border-2 border-emerald-200'
                    : jobStatus.status === 'failed'
                    ? 'bg-red-100 text-red-800 border-2 border-red-200'
                    : 'bg-yellow-100 text-yellow-800 border-2 border-yellow-200'
                }`}
              >
                {jobStatus.status.charAt(0).toUpperCase() + jobStatus.status.slice(1)}
              </span>
            </div>

            {jobStatus.paperId && (
              <div className="flex items-center justify-between p-4 bg-gradient-to-r from-emerald-50 to-emerald-100/50 rounded-xl border-2 border-emerald-200">
                <span className="text-sm font-semibold text-emerald-700">Paper ID</span>
                <span className="text-sm font-mono text-emerald-900 bg-white px-3 py-1 rounded-lg">{jobStatus.paperId}</span>
              </div>
            )}

            {jobStatus.error && (
              <div className="p-4 bg-red-50 border-2 border-red-200 rounded-xl">
                <div className="flex items-center space-x-2">
                  <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <p className="text-sm text-red-800 font-medium">{jobStatus.error}</p>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
