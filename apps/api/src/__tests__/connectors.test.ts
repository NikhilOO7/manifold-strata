/**
 * The OpenAPI connector.
 *
 * Everything here is derived structurally from the document, so the tests assert
 * exact graph shape rather than "roughly right" — if a specification states that
 * `addPet` requires `bearerAuth`, there is no reason for the edge to be missing,
 * approximate, or of a different type.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildUnitsFromSpec, openApiConnector } from '../connectors/openapi';
import { getConnector, listConnectors, UnknownConnectorError, ConnectorSourceError, ConnectorInputError } from '../connectors';

const spec = {
  openapi: '3.0.0',
  info: { title: 'Petstore', version: '1.0.0', description: 'A sample store.' },
  components: {
    securitySchemes: { bearerAuth: { type: 'http', description: 'Bearer token.' } },
    schemas: { Pet: { type: 'object' }, Order: { type: 'object' } },
  },
  paths: {
    '/pets': {
      get: {
        operationId: 'listPets',
        summary: 'Return every animal currently available',
        tags: ['Pets'],
        responses: { '200': { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } } },
      },
      post: {
        operationId: 'addPet',
        summary: 'Register a new animal',
        tags: ['Pets'],
        security: [{ bearerAuth: [] }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } },
        responses: { '201': {} },
      },
    },
    '/orders': {
      post: {
        summary: 'Place an order',
        tags: ['Store'],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Order' } } } },
        responses: { '200': {} },
      },
    },
  },
};

/** Flatten every relationship across every unit. */
function allRelations(built: ReturnType<typeof buildUnitsFromSpec>) {
  return built.units.flatMap((u) => u.extraction?.relationships ?? []);
}
function allEntities(built: ReturnType<typeof buildUnitsFromSpec>) {
  return built.units.flatMap((u) => u.extraction?.entities ?? []);
}

describe('buildUnitsFromSpec', () => {
  const built = buildUnitsFromSpec(spec as never);

  test('every unit carries a pre-built extraction and no text', () => {
    // This is what makes the ingest cost zero LLM calls. A unit that fell back to
    // `text` would quietly reintroduce a per-operation model bill.
    assert.ok(built.units.length > 0);
    for (const unit of built.units) {
      assert.ok(unit.extraction, `unit "${unit.section}" has no extraction`);
      assert.equal(unit.text, undefined);
    }
  });

  test('finds every operation across every path', () => {
    assert.equal(built.operationCount, 3);
  });

  test('names the API from info.title and version', () => {
    assert.equal(built.apiName, 'Petstore v1.0.0');
  });

  test('uses operationId as the label when present, method+path otherwise', () => {
    const names = allEntities(built).filter((e) => e.type === 'endpoint').map((e) => e.mention);
    assert.ok(names.includes('listPets'));
    assert.ok(names.includes('addPet'));
    assert.ok(names.includes('POST /orders'), 'an operation without an operationId falls back');
  });

  test('emits the domain-specific entity types, not a generic one', () => {
    const types = new Set(allEntities(built).map((e) => e.type));
    for (const expected of ['api', 'endpoint', 'capability', 'schema', 'auth']) {
      assert.ok(types.has(expected), `missing entity type "${expected}"`);
    }
  });

  test('emits the domain-specific relationship types', () => {
    const types = new Set(allRelations(built).map((r) => r.predicate));
    for (const expected of ['exposes', 'belongs_to', 'requires', 'accepts', 'returns']) {
      assert.ok(types.has(expected), `missing relationship "${expected}"`);
    }
  });

  test('links each endpoint to its API', () => {
    const exposes = allRelations(built).filter((r) => r.predicate === 'exposes');
    assert.equal(exposes.length, 3);
    for (const r of exposes) assert.equal(r.subject, 'Petstore v1.0.0');
  });

  test('links an endpoint to its tag', () => {
    const belongs = allRelations(built).filter((r) => r.predicate === 'belongs_to');
    assert.ok(belongs.some((r) => r.subject === 'listPets' && r.object === 'Pets'));
    assert.ok(belongs.some((r) => r.subject === 'POST /orders' && r.object === 'Store'));
  });

  test('records operation-level security', () => {
    const requires = allRelations(built).filter((r) => r.predicate === 'requires');
    assert.ok(requires.some((r) => r.subject === 'addPet' && r.object === 'bearerAuth'));
    assert.ok(
      !requires.some((r) => r.subject === 'listPets'),
      'an operation with no security requirement must not gain one'
    );
  });

  test('resolves $ref schemas in request bodies and responses', () => {
    const rel = allRelations(built);
    assert.ok(rel.some((r) => r.predicate === 'accepts' && r.subject === 'addPet' && r.object === 'Pet'));
    assert.ok(rel.some((r) => r.predicate === 'returns' && r.subject === 'listPets' && r.object === 'Pet'));
  });

  test('evidence text carries the human-written summary', () => {
    // The reason a natural-language question can reach an endpoint whose path
    // shares none of its words: the author's prose is what gets embedded.
    const exposes = allRelations(built).find((r) => r.object === 'listPets')!;
    assert.match(exposes.evidenceText, /Return every animal currently available/);
    assert.match(exposes.evidenceText, /GET \/pets/);
  });

  test('marks deprecated operations in their evidence', () => {
    const withDeprecated = buildUnitsFromSpec({
      openapi: '3.0.0',
      info: { title: 'X' },
      paths: { '/old': { get: { operationId: 'oldOp', deprecated: true, responses: {} } } },
    } as never);
    const rel = allRelations(withDeprecated).find((r) => r.object === 'oldOp')!;
    assert.match(rel.evidenceText, /deprecated/i);
  });

  test('confidence is 1 — these are stated facts, not inferences', () => {
    for (const r of allRelations(built)) assert.equal(r.confidence, 1);
    for (const e of allEntities(built)) assert.equal(e.confidence, 1);
  });

  test('does not duplicate a fact within a unit', () => {
    for (const unit of built.units) {
      const keys = (unit.extraction?.relationships ?? []).map(
        (r) => `${r.subject}|${r.predicate}|${r.object}`
      );
      assert.equal(new Set(keys).size, keys.length, `duplicates in "${unit.section}"`);
    }
  });

  test('a spec with no components or tags still produces a graph', () => {
    const minimal = buildUnitsFromSpec({
      openapi: '3.0.0',
      info: { title: 'Bare' },
      paths: { '/ping': { get: { responses: { '200': {} } } } },
    } as never);
    assert.equal(minimal.operationCount, 1);
    assert.ok(allRelations(minimal).some((r) => r.predicate === 'exposes'));
  });
});

describe('openApiConnector.collect', () => {
  test('declares itself structured, which is what promises zero LLM calls', () => {
    assert.equal(openApiConnector.structured, true);
  });

  test('accepts an inline spec', async () => {
    const [doc] = await openApiConnector.collect({ spec }, { domainId: 'api-surface' });
    assert.equal(doc.title, 'Petstore v1.0.0');
    assert.ok((doc.units?.length ?? 0) > 0);
    assert.equal(doc.rawText, undefined, 'a structured source produces no text to extract');
  });

  test('rejects input naming no source', async () => {
    await assert.rejects(
      () => openApiConnector.collect({}, { domainId: 'api-surface' }),
      ConnectorInputError
    );
  });

  test('rejects a non-http URL', async () => {
    await assert.rejects(
      () => openApiConnector.collect({ url: 'file:///etc/passwd' }, { domainId: 'api-surface' }),
      ConnectorInputError
    );
  });

  test('rejects a document that is not an API description', async () => {
    await assert.rejects(
      () => openApiConnector.collect({ spec: { hello: 'world' } }, { domainId: 'api-surface' }),
      ConnectorSourceError
    );
  });

  test('rejects a spec declaring no operations', async () => {
    await assert.rejects(
      () => openApiConnector.collect({ spec: { openapi: '3.0.0', paths: {} } }, { domainId: 'api-surface' }),
      ConnectorSourceError
    );
  });
});

describe('connector registry', () => {
  test('lists the registered connectors', () => {
    assert.ok(listConnectors().some((c) => c.id === 'openapi'));
  });

  test('lookup is case-insensitive', () => {
    assert.equal(getConnector('OpenAPI').id, 'openapi');
  });

  test('an unknown connector throws and names the alternatives', () => {
    // Same contract as domain resolution: never a silent fallback.
    try {
      getConnector('nonexistent');
      assert.fail('expected a throw');
    } catch (err) {
      assert.ok(err instanceof UnknownConnectorError);
      assert.ok(err.known.includes('openapi'));
    }
  });
});
