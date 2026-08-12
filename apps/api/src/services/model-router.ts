/**
 * Per-role model routing.
 *
 * Every LLM call in this system used one globally-configured model. That is the
 * wrong shape, because the roles are not alike:
 *
 *   extract     One call per chunk — the cost-dominant path by an order of
 *               magnitude. Needs reliable structured JSON and nothing else. A
 *               larger model here multiplies the bill across the whole corpus
 *               while adding little: the task is recognition, not reasoning.
 *
 *   verbalize   One call per *query*, and the only output a human ever reads.
 *               Faithfulness to the retrieved evidence is the entire job. This is
 *               where spending more is justified, and where a weak model is
 *               immediately visible.
 *
 *   summarize   Once per community, amortised across every future query. Quality
 *               matters and volume does not.
 *
 *   resolve /   Legacy-pipeline structured output. Same profile as extract.
 *   validate
 *
 * So one dial cannot be right. Setting the extractor by the needs of the
 * verbaliser overpays on every chunk; setting the verbaliser by the needs of the
 * extractor degrades the only text anyone reads.
 *
 * ## The constraint that makes this non-obvious
 *
 * On a single machine with unified memory, distinct models are not free to mix.
 * Ollama holds a limited set resident and evicts the rest, so alternating between
 * two 7B models between calls can cost seconds of reload per switch — enough to
 * make a "better" routing table slower end-to-end than a uniform one. The router
 * therefore reports how many distinct models a configuration implies and warns
 * when that likely exceeds what will stay resident. Choosing one model for
 * everything is a legitimate answer; choosing it *unknowingly* is not.
 */

export type LLMRole = 'extract' | 'resolve' | 'validate' | 'verbalize' | 'summarize' | 'utility';

export const LLM_ROLES: LLMRole[] = [
  'extract',
  'resolve',
  'validate',
  'verbalize',
  'summarize',
  'utility',
];

/** Operation names threaded through the call sites, mapped to their role. */
const OPERATION_ROLES: Record<string, LLMRole> = {
  extractor: 'extract',
  resolver: 'resolve',
  validator: 'validate',
  verbalize: 'verbalize',
  'community-summary': 'summarize',
  warmup: 'utility',
};

export function roleForOperation(operation: string): LLMRole {
  return OPERATION_ROLES[operation] ?? 'utility';
}

export interface RoleRoute {
  role: LLMRole;
  provider: 'ollama' | 'openai';
  model: string;
  /** Where this came from — so an operator can see why a role resolved as it did. */
  source: 'role-specific' | 'default';
}

/** Rough resident size, used only to warn about swap thrash. */
const APPROX_MODEL_GB: Record<string, number> = {
  'qwen2.5:7b': 4.7,
  'qwen2.5:14b': 9,
  'llama3.1:8b': 4.9,
  'llama3.2:3b': 2,
  'llama3.2:1b': 1.3,
  'mistral:7b': 4.1,
  'phi3:mini': 2.3,
};

function envRole(role: LLMRole): string | undefined {
  return process.env[`MODEL_${role.toUpperCase()}`]?.trim() || undefined;
}

/**
 * Parse `provider:model`, `model`, or an Ollama tag like `qwen2.5:7b`.
 *
 * The ambiguity is real — `qwen2.5:7b` contains a colon but names no provider —
 * so a leading segment counts as a provider only when it is one we support.
 */
export function parseModelSpec(
  spec: string,
  fallbackProvider: 'ollama' | 'openai'
): { provider: 'ollama' | 'openai'; model: string } {
  const trimmed = spec.trim();
  const colon = trimmed.indexOf(':');

  if (colon > 0) {
    const head = trimmed.slice(0, colon).toLowerCase();
    if (head === 'ollama' || head === 'openai') {
      return { provider: head, model: trimmed.slice(colon + 1).trim() };
    }
  }

  return { provider: fallbackProvider, model: trimmed };
}

export function defaultProvider(): 'ollama' | 'openai' {
  return (process.env.LLM_PROVIDER || 'ollama') === 'openai' ? 'openai' : 'ollama';
}

function defaultModel(provider: 'ollama' | 'openai'): string {
  return provider === 'openai'
    ? process.env.OPENAI_MODEL || 'gpt-4o-mini'
    : process.env.OLLAMA_MODEL || 'llama3.2:3b';
}

/** Resolve the route for one role. */
export function routeFor(role: LLMRole): RoleRoute {
  const provider = defaultProvider();
  const specific = envRole(role);

  if (specific) {
    const parsed = parseModelSpec(specific, provider);
    return { role, ...parsed, source: 'role-specific' };
  }

  return { role, provider, model: defaultModel(provider), source: 'default' };
}

export function routingTable(): RoleRoute[] {
  return LLM_ROLES.map(routeFor);
}

export interface RoutingAdvice {
  distinctModels: string[];
  /** Approximate resident memory if every configured model stayed loaded. */
  approxResidentGb: number | null;
  warnings: string[];
}

/**
 * Report the consequences of a routing table.
 *
 * Not a validator — a configuration with three models is legitimate on hardware
 * that can hold them. The point is that the trade-off should be visible: the
 * failure mode of per-role routing on a small box is silent latency, not an
 * error, and silent latency is the kind of thing that gets blamed on the wrong
 * component for a week.
 */
export function routingAdvice(table: RoleRoute[] = routingTable()): RoutingAdvice {
  const warnings: string[] = [];

  const ollamaModels = [
    ...new Set(table.filter((r) => r.provider === 'ollama').map((r) => r.model)),
  ];
  const distinctModels = [...new Set(table.map((r) => `${r.provider}:${r.model}`))];

  const sizes = ollamaModels.map((m) => APPROX_MODEL_GB[m] ?? null);
  const known = sizes.filter((s): s is number => s !== null);
  const approxResidentGb = known.length === ollamaModels.length && known.length > 0
    ? Number(known.reduce((a, b) => a + b, 0).toFixed(1))
    : null;

  const maxLoaded = parseInt(process.env.OLLAMA_MAX_LOADED_MODELS || '', 10);

  if (ollamaModels.length > 1) {
    warnings.push(
      `${ollamaModels.length} distinct local models are configured (${ollamaModels.join(', ')}). ` +
        `Ollama evicts models it cannot keep resident, so alternating roles may pay a reload of ` +
        `several seconds per switch. ` +
        (approxResidentGb
          ? `Holding all of them needs roughly ${approxResidentGb} GB. `
          : '') +
        (Number.isFinite(maxLoaded)
          ? `OLLAMA_MAX_LOADED_MODELS=${maxLoaded}.`
          : 'Set OLLAMA_MAX_LOADED_MODELS to keep more than one resident.')
    );
  }

  const extract = table.find((r) => r.role === 'extract')!;
  const verbalize = table.find((r) => r.role === 'verbalize')!;
  if (
    extract.source === 'default' &&
    verbalize.source === 'default' &&
    extract.model === verbalize.model
  ) {
    warnings.push(
      'Every role uses one model. That is a reasonable default, but extraction runs once per ' +
        'chunk while verbalization runs once per query — MODEL_EXTRACT and MODEL_VERBALIZE let ' +
        'you spend where it is read and economise where it is repeated.'
    );
  }

  return { distinctModels, approxResidentGb, warnings };
}
