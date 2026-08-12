/**
 * OpenAPI connector — turns an API description into a graph, with no LLM calls.
 *
 * This is the connector that makes the substrate claim demonstrable rather than
 * asserted, and it is also the one closest to what an agent platform needs.
 * When an agent can reach hundreds of connected systems, no context window holds
 * every tool schema; choosing the right endpoint is a *retrieval* problem over a
 * typed graph, which is exactly what this system does.
 *
 * Nothing here is inferred. A specification already states its operations, tags,
 * schemas, and security requirements; asking a language model to rediscover them
 * would be slower, cost money per import, and invent edges the file spells out.
 * So the extraction is derived structurally, and the human-written `summary` and
 * `description` fields become the evidence text that retrieval embeds — which is
 * why "which endpoint creates a user" finds `POST /users` even though the path
 * string never contains the word "create".
 *
 * Format: JSON only. YAML would need a parser dependency; specs are commonly
 * served as JSON and every YAML spec can be converted with one command. The
 * limitation is reported rather than silently mishandled.
 */

import { fetchWithTimeout, readBodyWithLimit, TIMEOUTS } from '../services/http';
import type { ExtractorOutput, EntityMention, Relationship } from '../agents/extractor';
import {
  type Connector,
  type ConnectorDocument,
  type IngestUnit,
  ConnectorInputError,
  ConnectorSourceError,
} from './types';

const MAX_SPEC_BYTES = 12 * 1024 * 1024;

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const;

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  security?: Array<Record<string, unknown>>;
  requestBody?: unknown;
  responses?: Record<string, unknown>;
  parameters?: Array<{ name?: string; in?: string; required?: boolean; description?: string }>;
}

function entity(mention: string, type: string, confidence = 1): EntityMention {
  // Structural facts, not guesses: spans are meaningless for a parsed document
  // and confidence is 1 because the specification states this outright.
  return { mention, type, spanStart: 0, spanEnd: 0, confidence };
}

function relation(
  subject: string,
  predicate: string,
  object: string,
  evidenceText: string
): Relationship {
  return { subject, predicate, object, evidenceText, confidence: 1 };
}

/** `#/components/schemas/User` → `User`. */
function schemaNameFromRef(ref: unknown): string | null {
  if (typeof ref !== 'string') return null;
  const match = ref.match(/#\/components\/schemas\/([A-Za-z0-9_.-]+)$/);
  return match ? match[1] : null;
}

/** Collect every `$ref`ed schema name inside an arbitrary sub-tree. */
function collectSchemaRefs(node: unknown, found = new Set<string>()): Set<string> {
  if (!node || typeof node !== 'object') return found;

  if (Array.isArray(node)) {
    for (const item of node) collectSchemaRefs(item, found);
    return found;
  }

  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === '$ref') {
      const name = schemaNameFromRef(value);
      if (name) found.add(name);
    } else {
      collectSchemaRefs(value, found);
    }
  }
  return found;
}

/**
 * A readable label for an operation.
 *
 * `operationId` when the author supplied one, otherwise `METHOD /path`. The
 * label is the node's identity, so it has to be stable across re-imports and
 * meaningful to a human reading a retrieval result.
 */
function operationLabel(method: string, path: string, op: OpenApiOperation): string {
  return op.operationId?.trim() || `${method.toUpperCase()} ${path}`;
}

export function buildUnitsFromSpec(spec: Record<string, unknown>): {
  apiName: string;
  summary?: string;
  units: IngestUnit[];
  operationCount: number;
} {
  const info = (spec.info ?? {}) as { title?: string; description?: string; version?: string };
  const apiName = (info.title?.trim() || 'Untitled API') + (info.version ? ` v${info.version}` : '');
  const paths = (spec.paths ?? {}) as Record<string, Record<string, unknown>>;

  const units: IngestUnit[] = [];
  let operationCount = 0;

  // The API node itself, plus its security schemes.
  const apiEntities: EntityMention[] = [entity(apiName, 'api')];
  const apiRelations: Relationship[] = [];

  const components = (spec.components ?? {}) as Record<string, unknown>;
  const securitySchemes = (components.securitySchemes ?? {}) as Record<string, { type?: string; description?: string }>;
  for (const [schemeName, scheme] of Object.entries(securitySchemes)) {
    apiEntities.push(entity(schemeName, 'auth'));
    apiRelations.push(
      relation(
        apiName,
        'requires',
        schemeName,
        `${apiName} supports the ${scheme?.type ?? 'unspecified'} authentication scheme "${schemeName}".` +
          (scheme?.description ? ` ${scheme.description}` : '')
      )
    );
  }

  if (apiEntities.length > 0) {
    units.push({
      section: 'api',
      extraction: { entities: apiEntities, relationships: apiRelations },
    });
  }

  for (const [path, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;

    for (const method of HTTP_METHODS) {
      const op = pathItem[method] as OpenApiOperation | undefined;
      if (!op || typeof op !== 'object') continue;

      operationCount++;
      const label = operationLabel(method, path, op);
      const entities: EntityMention[] = [entity(apiName, 'api'), entity(label, 'endpoint')];
      const relationships: Relationship[] = [];

      // The evidence text is what retrieval embeds. Composing it from the
      // author's own prose is what lets a natural-language question reach an
      // endpoint whose path shares none of its vocabulary.
      const described = [op.summary?.trim(), op.description?.trim()].filter(Boolean).join('. ');
      const evidence =
        `${label} (${method.toUpperCase()} ${path}) in ${apiName}` +
        (described ? `: ${described}` : '.') +
        (op.deprecated ? ' This operation is deprecated.' : '');

      relationships.push(relation(apiName, 'exposes', label, evidence));

      for (const tag of op.tags ?? []) {
        if (typeof tag !== 'string' || !tag.trim()) continue;
        entities.push(entity(tag, 'capability'));
        relationships.push(
          relation(label, 'belongs_to', tag, `${label} is part of the "${tag}" capability of ${apiName}.`)
        );
      }

      // Security stated on the operation overrides the document default; an
      // empty array is the spec's way of saying "explicitly public".
      for (const requirement of op.security ?? []) {
        for (const schemeName of Object.keys(requirement ?? {})) {
          entities.push(entity(schemeName, 'auth'));
          relationships.push(
            relation(label, 'requires', schemeName, `${label} requires the "${schemeName}" authentication scheme.`)
          );
        }
      }

      for (const schemaName of collectSchemaRefs(op.requestBody)) {
        entities.push(entity(schemaName, 'schema'));
        relationships.push(
          relation(label, 'accepts', schemaName, `${label} accepts a ${schemaName} request body.`)
        );
      }

      for (const schemaName of collectSchemaRefs(op.responses)) {
        entities.push(entity(schemaName, 'schema'));
        relationships.push(
          relation(label, 'returns', schemaName, `${label} returns a ${schemaName} in its response.`)
        );
      }

      units.push({
        section: `${method.toUpperCase()} ${path}`,
        extraction: dedupeExtraction({ entities, relationships }),
      });
    }
  }

  return { apiName, summary: info.description?.trim(), units, operationCount };
}

/** Collapse repeats so the pipeline is not handed the same fact twice. */
function dedupeExtraction(output: ExtractorOutput): ExtractorOutput {
  const seenEntities = new Set<string>();
  const entities = output.entities.filter((e) => {
    const key = `${e.type}::${e.mention.toLowerCase()}`;
    if (seenEntities.has(key)) return false;
    seenEntities.add(key);
    return true;
  });

  const seenRelations = new Set<string>();
  const relationships = output.relationships.filter((r) => {
    const key = `${r.subject.toLowerCase()}|${r.predicate}|${r.object.toLowerCase()}`;
    if (seenRelations.has(key)) return false;
    seenRelations.add(key);
    return true;
  });

  return { entities, relationships };
}

async function loadSpec(input: Record<string, unknown>): Promise<{ spec: Record<string, unknown>; url?: string }> {
  if (input.spec && typeof input.spec === 'object') {
    return { spec: input.spec as Record<string, unknown> };
  }

  const url = typeof input.url === 'string' ? input.url.trim() : '';
  if (!url) {
    throw new ConnectorInputError(
      'Provide either `url` (a JSON OpenAPI document) or `spec` (the parsed document inline).'
    );
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url);
  } catch {
    throw new ConnectorInputError(`"${url}" is not a valid URL.`);
  }
  if (parsedUrl.protocol !== 'https:' && parsedUrl.protocol !== 'http:') {
    throw new ConnectorInputError('Only http(s) URLs are supported.');
  }

  const response = await fetchWithTimeout(
    parsedUrl.toString(),
    { headers: { Accept: 'application/json' } },
    { timeoutMs: TIMEOUTS.metadata, label: 'OpenAPI document' }
  );
  if (!response.ok) {
    throw new ConnectorSourceError(`Fetching the OpenAPI document returned ${response.status}.`);
  }

  const body = await readBodyWithLimit(response, MAX_SPEC_BYTES, 'OpenAPI document');
  const text = body.toString('utf8');

  try {
    return { spec: JSON.parse(text) as Record<string, unknown>, url: parsedUrl.toString() };
  } catch (err) {
    const looksLikeYaml = /^\s*(openapi|swagger)\s*:/m.test(text);
    throw new ConnectorSourceError(
      looksLikeYaml
        ? 'This looks like a YAML document. Convert it to JSON first — this connector reads JSON only.'
        : 'The document is not valid JSON.',
      { cause: err }
    );
  }
}

export const openApiConnector: Connector = {
  id: 'openapi',
  name: 'OpenAPI',
  description:
    'Reads an OpenAPI/Swagger description and builds a graph of the API, its endpoints, ' +
    'capabilities, schemas and authentication schemes. Spends no LLM calls — the ' +
    'structure is stated by the document, not inferred from it.',
  inputSchema: '{ "url": "https://…/openapi.json" } or { "spec": { …parsed document… } }',
  structured: true,

  async collect(input) {
    const { spec, url } = await loadSpec(input);

    const version = spec.openapi ?? spec.swagger;
    if (!version) {
      throw new ConnectorSourceError(
        'Missing an "openapi" or "swagger" version field — this does not look like an API description.'
      );
    }
    if (!spec.paths || typeof spec.paths !== 'object') {
      throw new ConnectorSourceError('The document declares no paths, so there is nothing to ingest.');
    }

    const { apiName, summary, units, operationCount } = buildUnitsFromSpec(spec);

    if (operationCount === 0) {
      throw new ConnectorSourceError('The document declares no operations under its paths.');
    }

    const document: ConnectorDocument = {
      title: apiName,
      externalId: url ?? `openapi:${apiName}`,
      url,
      summary,
      units,
    };

    return [document];
  },
};
