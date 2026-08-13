import type { Paper, Node, Edge, GraphStats, Subgraph } from 'shared';

const API_URL = import.meta.env.VITE_API_URL || 'http://localhost:3000';

async function fetchAPI<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await fetch(`${API_URL}${endpoint}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const error = await response.json().catch(() => ({ error: 'Unknown error' }));
    throw new Error(error.error || `HTTP ${response.status}`);
  }

  return response.json();
}

export const api = {
  papers: {
    list: (limit = 20, offset = 0) =>
      fetchAPI<{ papers: Paper[]; pagination: { limit: number; offset: number } }>(
        `/api/papers?limit=${limit}&offset=${offset}`
      ),
    pause: (id: string) =>
      fetchAPI<{ message: string; status: string; stoppedImmediately: boolean }>(
        `/api/papers/${id}/pause`,
        { method: 'POST' }
      ),
    /** Resume or retry — the same operation, keeping completed chunks. */
    resume: (id: string, rebuild = false) =>
      fetchAPI<{ message: string; jobId: string; resumingFromChunk: number }>(
        `/api/papers/${id}/resume${rebuild ? '?rebuild=true' : ''}`,
        { method: 'POST' }
      ),
    chunks: (id: string) =>
      fetchAPI<{
        completed: number;
        chunks: Array<{ index: number; status: string; entities: number; error: string | null }>;
      }>(`/api/papers/${id}/chunks`),
    processing: () =>
      fetchAPI<{
        papers: Array<
          Paper & {
            /** Why this paper is where it is: claimed, waiting its turn, or unscheduled. */
            queue?: { state: 'running' | 'queued' | 'unscheduled'; position?: number };
          }
        >;
        workers?: { processConcurrency: number; running: number; queued: number };
      }>('/api/papers/processing'),
    get: (id: string) => fetchAPI<Paper>(`/api/papers/${id}`),
    create: (data: Partial<Paper>) =>
      fetchAPI<Paper>('/api/papers', {
        method: 'POST',
        body: JSON.stringify(data),
      }),
    process: (id: string) =>
      fetchAPI<{ message: string; paperId: string; status: string }>(
        `/api/papers/${id}/process`,
        { method: 'POST' }
      ),
  },

  graph: {
    nodes: (params?: { type?: string; search?: string; limit?: number; offset?: number; domain?: string }) => {
      const queryParams = new URLSearchParams();
      if (params?.type) queryParams.set('type', params.type);
      if (params?.search) queryParams.set('search', params.search);
      if (params?.limit) queryParams.set('limit', params.limit.toString());
      if (params?.offset) queryParams.set('offset', params.offset.toString());
      if (params?.domain) queryParams.set('domain', params.domain);

      return fetchAPI<{ nodes: Node[]; pagination: { limit: number; offset: number } }>(
        `/api/graph/nodes?${queryParams}`
      );
    },
    /** Papers as entry points, with how much each one contributes. */
    papers: (domain?: string) =>
      fetchAPI<{
        papers: Array<{
          id: string;
          name: string;
          domain: string | null;
          concepts: number;
          relationships: number;
        }>;
      }>(`/api/graph/papers${domain ? `?domain=${encodeURIComponent(domain)}` : ''}`),

    /** One node read as an argument: edges grouped by the question they answer. */
    lens: (id: string) =>
      fetchAPI<{
        node: { id: string; name: string; type: string; description: string | null };
        domain: string;
        total: number;
        sections: Array<{
          role: string;
          label: string;
          hint: string;
          items: Array<{
            id: string;
            name: string;
            type: string;
            relation: string;
            direction: 'out' | 'in';
            evidence: string | null;
          }>;
        }>;
      }>(`/api/graph/lens/${id}`),

    /** What two papers share, and what only one of them has. */
    compare: (a: string, b: string) =>
      fetchAPI<{
        a: { id: string; name: string };
        b: { id: string; name: string };
        shared: Array<{ id: string; name: string; type: string }>;
        onlyA: Array<{ id: string; name: string; type: string }>;
        onlyB: Array<{ id: string; name: string; type: string }>;
      }>(`/api/graph/compare?a=${a}&b=${b}`),

    /** Most-connected entities, ranked by the database over the whole domain. */
    hubs: (params?: { domain?: string; type?: string; limit?: number }) => {
      const q = new URLSearchParams();
      if (params?.domain) q.set('domain', params.domain);
      if (params?.type) q.set('type', params.type);
      if (params?.limit) q.set('limit', String(params.limit));
      const qs = q.toString();
      return fetchAPI<{
        hubs: Array<{ id: string; name: string; type: string; domain: string | null; degree: number }>;
      }>(`/api/graph/hubs${qs ? `?${qs}` : ''}`);
    },
    node: (id: string) =>
      fetchAPI<{
        node: Node;
        domain?: string;
        /** Evidence sentences from the corpus that mention this node. */
        mentions?: Array<{ text: string; section: string | null }>;
        outgoingEdges: Array<Edge & { targetNode?: Node }>;
        incomingEdges: Array<Edge & { sourceNode?: Node }>;
      }>(`/api/graph/nodes/${id}`),
    edges: (params?: { type?: string; limit?: number; offset?: number; domain?: string }) => {
      const queryParams = new URLSearchParams();
      if (params?.type) queryParams.set('type', params.type);
      if (params?.limit) queryParams.set('limit', params.limit.toString());
      if (params?.offset) queryParams.set('offset', params.offset.toString());
      if (params?.domain) queryParams.set('domain', params.domain);

      return fetchAPI<{ edges: Edge[]; pagination: { limit: number; offset: number } }>(
        `/api/graph/edges?${queryParams}`
      );
    },
    subgraph: (nodeId: string, depth = 1) =>
      fetchAPI<Subgraph>(`/api/graph/subgraph?nodeId=${nodeId}&depth=${depth}`),
    stats: (domain?: string) =>
      fetchAPI<GraphStats>(`/api/graph/stats${domain ? `?domain=${domain}` : ''}`),
    types: (domain?: string) =>
      fetchAPI<{ nodeTypes: string[]; edgeTypes: string[] }>(
        `/api/graph/types${domain ? `?domain=${domain}` : ''}`
      ),
  },

  domains: {
    list: () =>
      fetchAPI<{
        domains: Array<{
          id: string;
          name: string;
          description: string;
          entityTypes: string[];
          relationshipTypes: string[];
          seedCount: number;
        }>;
      }>('/api/domains'),
  },

  ingest: {
    arxiv: (arxivId: string, autoProcess = true, domain?: string) =>
      fetchAPI<{ jobId: string; status: string }>('/api/ingest/arxiv', {
        method: 'POST',
        body: JSON.stringify({ arxivId, autoProcess, domain }),
      }),
    status: (jobId: string) =>
      fetchAPI<{ status: string; paperId?: string; error?: string }>(
        `/api/ingest/status/${jobId}`
      ),
  },
};
