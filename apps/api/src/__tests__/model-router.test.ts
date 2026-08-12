/**
 * Per-role model routing.
 *
 * The failure modes here are quiet ones: a role silently served by the wrong
 * model, or a routing table that looks better than a uniform one while being
 * slower because the machine cannot hold both models resident.
 */

import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  routeFor,
  routingTable,
  routingAdvice,
  roleForOperation,
  parseModelSpec,
  LLM_ROLES,
} from '../services/model-router';

const ROLE_VARS = LLM_ROLES.map((r) => `MODEL_${r.toUpperCase()}`);
const saved = new Map<string, string | undefined>();
for (const key of [...ROLE_VARS, 'LLM_PROVIDER', 'OLLAMA_MODEL', 'OPENAI_MODEL']) {
  saved.set(key, process.env[key]);
}

afterEach(() => {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function clearRoles() {
  for (const key of ROLE_VARS) delete process.env[key];
}

describe('roleForOperation', () => {
  test('maps each call site to its role', () => {
    assert.equal(roleForOperation('extractor'), 'extract');
    assert.equal(roleForOperation('verbalize'), 'verbalize');
    assert.equal(roleForOperation('community-summary'), 'summarize');
    assert.equal(roleForOperation('resolver'), 'resolve');
    assert.equal(roleForOperation('validator'), 'validate');
  });

  test('an unknown operation is utility, not a crash', () => {
    // New call sites should route somewhere sensible before anyone remembers to
    // classify them.
    assert.equal(roleForOperation('something-new'), 'utility');
  });
});

describe('parseModelSpec', () => {
  test('reads an explicit provider prefix', () => {
    assert.deepEqual(parseModelSpec('openai:gpt-4o-mini', 'ollama'), {
      provider: 'openai',
      model: 'gpt-4o-mini',
    });
  });

  test('does not mistake an Ollama tag for a provider', () => {
    // `qwen2.5:7b` contains a colon but names no provider. Splitting naively
    // would route to a provider called "qwen2.5" and a model called "7b".
    assert.deepEqual(parseModelSpec('qwen2.5:7b', 'ollama'), {
      provider: 'ollama',
      model: 'qwen2.5:7b',
    });
  });

  test('a bare model name uses the default provider', () => {
    assert.deepEqual(parseModelSpec('llama3.2:3b', 'openai'), {
      provider: 'openai',
      model: 'llama3.2:3b',
    });
  });
});

describe('routeFor', () => {
  test('falls back to the global model when a role is unset', () => {
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'llama3.2:3b';

    const route = routeFor('extract');
    assert.equal(route.model, 'llama3.2:3b');
    assert.equal(route.source, 'default');
  });

  test('a role-specific setting wins, and says so', () => {
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'llama3.2:3b';
    process.env.MODEL_VERBALIZE = 'qwen2.5:7b';

    assert.equal(routeFor('extract').model, 'llama3.2:3b');
    const verbalize = routeFor('verbalize');
    assert.equal(verbalize.model, 'qwen2.5:7b');
    assert.equal(verbalize.source, 'role-specific');
  });

  test('roles can span providers', () => {
    // Cheap local extraction over the whole corpus, a hosted model for the one
    // call a human reads.
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';
    process.env.MODEL_VERBALIZE = 'openai:gpt-4o-mini';

    assert.equal(routeFor('extract').provider, 'ollama');
    assert.equal(routeFor('verbalize').provider, 'openai');
  });

  test('every role resolves to something', () => {
    clearRoles();
    for (const route of routingTable()) {
      assert.ok(route.model, `role ${route.role} resolved to no model`);
      assert.ok(['ollama', 'openai'].includes(route.provider));
    }
  });
});

describe('routingAdvice', () => {
  test('warns when several local models are configured', () => {
    // The non-obvious cost of per-role routing on one machine: models that
    // cannot all stay resident are reloaded on every switch, and the symptom is
    // latency with no error attached to it.
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.MODEL_EXTRACT = 'llama3.2:3b';
    process.env.MODEL_VERBALIZE = 'qwen2.5:7b';

    const advice = routingAdvice();
    assert.ok(advice.warnings.some((w) => /distinct local models/.test(w)));
    assert.ok(advice.approxResidentGb && advice.approxResidentGb > 6);
  });

  test('does not warn about swapping when one model serves everything', () => {
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';

    assert.ok(!routingAdvice().warnings.some((w) => /distinct local models/.test(w)));
  });

  test('suggests splitting roles when everything is on one default', () => {
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';

    assert.ok(routingAdvice().warnings.some((w) => /MODEL_EXTRACT/.test(w)));
  });

  test('reports the distinct models a configuration implies', () => {
    clearRoles();
    process.env.LLM_PROVIDER = 'ollama';
    process.env.OLLAMA_MODEL = 'qwen2.5:7b';
    process.env.MODEL_UTILITY = 'llama3.2:3b';

    const advice = routingAdvice();
    assert.equal(advice.distinctModels.length, 2);
    assert.ok(advice.distinctModels.includes('ollama:qwen2.5:7b'));
  });
});
