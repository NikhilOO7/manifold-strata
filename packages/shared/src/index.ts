// Entity and relationship types are open (free-form strings). The extractor may
// discover new ones and the DB stores them as text — these arrays are just the
// well-known defaults used for UI seeding/coloring and prompt guidance, NOT an
// enforced set.
export const KNOWN_NODE_TYPES = ['paper', 'method', 'concept', 'dataset', 'metric'] as const;

export const KNOWN_EDGE_TYPES = [
  'extends',
  'improves',
  'uses',
  'introduces',
  'cites',
  'evaluates_on',
  'compares_to',
  'authored_by',
] as const;

export type NodeType = string;
export type EdgeType = string;

export type ProcessingStatus =
  | 'pending'
  | 'downloading_pdf'
  | 'extracting_text'
  | 'chunking'
  | 'extracting_entities'
  | 'resolving_entities'
  | 'validating'
  | 'completed'
  | 'failed';

export interface Paper {
  id: string;
  title: string;
  abstract?: string;
  arxivId?: string;
  doi?: string;
  pdfUrl?: string;
  publicationDate?: string;
  venue?: string;
  rawText?: string;
  processed: boolean;
  processingStatus: ProcessingStatus;
  processingProgress?: number | null;
  processingError?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Node {
  id: string;
  type: NodeType;
  name: string;
  normalizedName?: string;
  description?: string;
  properties?: Record<string, any>;
  paperId?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Edge {
  id: string;
  sourceId: string;
  targetId: string;
  type: EdgeType;
  properties?: Record<string, any>;
  confidence?: string;
  createdAt: Date;
}

export interface GraphStats {
  nodes: {
    total: number;
    byType: Array<{ type: string; count: number }>;
  };
  edges: {
    total: number;
    byType: Array<{ type: string; count: number }>;
  };
}

export interface Subgraph {
  nodes: Node[];
  edges: Edge[];
  /** The node the neighbourhood was expanded from. */
  center?: Node;
  depth?: number;
  /** Domain the traversal was pinned to (never crosses it). */
  domain?: string;
}
