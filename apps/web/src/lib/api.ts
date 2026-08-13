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
    processing: () =>
      fetchAPI<{ papers: Paper[] }>('/api/papers/processing'),
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
