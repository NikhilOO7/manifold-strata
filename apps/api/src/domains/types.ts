/**
 * A research domain's ontology + extraction guidance.
 *
 * Domains are CONFIG (code), not DB rows: version-controlled, type-safe, and
 * migration-free to add/remove. `entityTypes`/`relationshipTypes` are the domain's
 * well-known types — preferred but still OPEN (the extractor may discover new ones,
 * stored as text, scoped to this domain). Nodes/edges/propositions are stamped with
 * the domain id and entity resolution is scoped to the same domain, so domains stay
 * isolated (no cross-contamination).
 */
export interface DomainConfig {
  id: string;                 // 'gaussian-splatting', 'nlp', 'default'
  name: string;               // human-readable, also used in the extraction prompt
  description: string;

  entityTypes: string[];      // preferred entity types for this domain
  relationshipTypes: string[];// preferred relationship types

  domainContext: string;      // one sentence injected into the extraction system prompt
  entityExamples?: Record<string, string[]>;
  relationshipExamples?: Array<{ source: string; type: string; target: string }>;

  // Edge types treated as hierarchical for Poincaré (hyperbolic) training.
  hierarchicalEdgeTypes?: string[];
  // Curated arXiv ids for bootstrapping this domain.
  seedPaperIds?: string[];
}
