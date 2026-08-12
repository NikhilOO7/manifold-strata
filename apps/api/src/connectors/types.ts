/**
 * The connector contract.
 *
 * Manifold's pitch is that it is a knowledge substrate and that research papers
 * are one source among many — but until now papers were the *only* source, and
 * "universal" was an assertion with nothing behind it. A connector is how a new
 * kind of source becomes ingestible without touching the pipeline.
 *
 * The important distinction the contract draws is between two kinds of source:
 *
 *   unstructured   A PDF, a wiki page, a transcript. The connector produces text
 *                  and the extractor spends one LLM call per chunk to find the
 *                  entities and relationships in it.
 *
 *   structured     An OpenAPI document, a database schema, a dependency
 *                  manifest. The graph is *already there* — paths, operations,
 *                  tags, tables, foreign keys — and inferring it with a language
 *                  model would be slower, cost money, and hallucinate edges that
 *                  the file states exactly. These connectors emit the extraction
 *                  directly and the pipeline spends **zero** LLM calls.
 *
 * Both kinds converge on the same `ExtractorOutput`, so resolution, validation,
 * provenance, embedding, and retrieval are identical downstream. That is what
 * makes the substrate claim real rather than aspirational: nothing after this
 * boundary knows or cares where a fact came from.
 */

import type { ExtractorOutput } from '../agents/extractor';

/**
 * One unit of work for the pipeline: either text to extract from, or an
 * extraction that is already known.
 */
export interface IngestUnit {
  /** Where in the source this came from — carried into provenance. */
  section: string;
  /** Text to run the extractor over. Mutually exclusive with `extraction`. */
  text?: string;
  /** A pre-computed graph fragment. Set by structured connectors. */
  extraction?: ExtractorOutput;
}

/** A single ingestible artefact — a paper, an API, a repository, a page. */
export interface ConnectorDocument {
  title: string;
  /** Stable id within the source system (arXiv id, spec URL, repo path). */
  externalId?: string;
  url?: string;
  /** ISO date, if the source has one. */
  publishedAt?: string;
  summary?: string;
  /** Full text, for unstructured sources. */
  rawText?: string;
  /** Pre-built units, for structured sources. */
  units?: IngestUnit[];
}

export interface ConnectorContext {
  /** Domain the caller is ingesting into — connectors may use its ontology. */
  domainId: string;
}

/** Raised when the caller's input does not describe a source this connector can read. */
export class ConnectorInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConnectorInputError';
  }
}

/** Raised when the source could be identified but could not be read or parsed. */
export class ConnectorSourceError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectorSourceError';
  }
}

export interface Connector {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  /** Human-readable description of the accepted input, surfaced by the API. */
  readonly inputSchema: string;
  /**
   * Whether this connector produces its own extraction.
   *
   * Reported rather than inferred, because it is the difference between an
   * ingest that costs one model call per chunk and one that costs nothing — a
   * fact an operator planning a large import needs before starting it.
   */
  readonly structured: boolean;

  /** Read the source and return documents ready for the pipeline. */
  collect(input: Record<string, unknown>, ctx: ConnectorContext): Promise<ConnectorDocument[]>;
}
