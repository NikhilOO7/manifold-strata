/**
 * Retrieval strategies under comparison.
 *
 * Each returns proposition ids in rank order plus the context it would hand a
 * language model, so the scorecard can weigh quality against tokens rather than
 * reporting either alone. All arms read the same corpus, in the same domain,
 * through the same database.
 */

import { sql, and, isNotNull } from 'drizzle-orm';
import { db } from '../db';
import { propositions } from '../db/schema';
import { domainWhere } from '../domains/filter';
import { embedOne } from '../services/embeddings';
import { toVectorLiteral } from '../services/embedding-space';
import { retrieveField } from '../knowledge-field/retrieve';

export interface StrategyResult {
  propositionIds: string[];
  contextChars: number;
}

export interface Strategy {
  name: string;
  description: string;
  run: (question: string, domain: string, k: number) => Promise<StrategyResult>;
}

/**
 * Plain top-k vector search — the standard RAG baseline.
 *
 * No graph, no compression: embed the question, return the nearest propositions.
 * This is what the field pipeline has to beat to justify existing.
 */
const vectorOnly: Strategy = {
  name: 'vector',
  description: 'top-k ANN over propositions (standard RAG)',
  run: async (question, domain, k) => {
    const qvec = await embedOne(question, 'eval-query');
    const literal = toVectorLiteral(qvec);

    const rows = await db
      .select({ id: propositions.id, text: propositions.text })
      .from(propositions)
      .where(and(isNotNull(propositions.embeddingVec), domainWhere(propositions.domain, domain)))
      .orderBy(sql`${propositions.embeddingVec} <=> ${literal}::vector`)
      .limit(k);

    return {
      propositionIds: rows.map((r) => r.id),
      contextChars: rows.reduce((s, r) => s + r.text.length, 0),
    };
  },
};

/**
 * Keyword search via Postgres full-text ranking.
 *
 * Included because lexical search is a genuinely strong baseline that vector
 * pipelines are often quietly worse than, and because it fails differently:
 * where embeddings blur, BM25-style ranking is exact but brittle.
 */
const keyword: Strategy = {
  name: 'keyword',
  description: 'Postgres full-text ts_rank (BM25-like)',
  run: async (question, domain, k) => {
    const rows = await db
      .select({ id: propositions.id, text: propositions.text })
      .from(propositions)
      .where(
        and(
          domainWhere(propositions.domain, domain),
          sql`to_tsvector('english', ${propositions.text}) @@ plainto_tsquery('english', ${question})`
        )
      )
      .orderBy(
        sql`ts_rank(to_tsvector('english', ${propositions.text}), plainto_tsquery('english', ${question})) desc`
      )
      .limit(k);

    return {
      propositionIds: rows.map((r) => r.id),
      contextChars: rows.reduce((s, r) => s + r.text.length, 0),
    };
  },
};

/** The field pipeline: ANN seeds → bounded expansion → PPR → fusion → MMR. */
function field(
  overrides: Parameters<typeof retrieveField>[1] = {},
  name = 'field (hybrid)',
  description = 'graph + vector + lexical, fused by RRF, compressed by MMR'
): Strategy {
  return {
    name,
    description,
    run: async (question, domain, k) => {
      const result = await retrieveField(question, {
        domain,
        maxEvidence: k,
        // The default char budget is a production choice; for evaluation we let
        // the ranking be judged rather than the budget.
        maxChars: Number.MAX_SAFE_INTEGER,
        ...overrides,
      });

      // retrieveField returns evidence text, not ids. Map back by text so the
      // metric layer compares like with like.
      const texts = result.evidence.map((e) => e.text);
      if (texts.length === 0) return { propositionIds: [], contextChars: 0 };

      const rows = await db
        .select({ id: propositions.id, text: propositions.text })
        .from(propositions)
        .where(
          and(
            domainWhere(propositions.domain, domain),
            sql`${propositions.text} = ANY(ARRAY[${sql.join(
              texts.map((t) => sql`${t}`),
              sql`, `
            )}]::text[])`
          )
        );

      const idByText = new Map(rows.map((r) => [r.text, r.id]));
      return {
        propositionIds: texts.map((t) => idByText.get(t)).filter((id): id is string => Boolean(id)),
        contextChars: result.contextChars,
      };
    },
  };
}

/**
 * Graph signal only — the pipeline as it behaved before rank fusion.
 *
 * Kept as a permanent arm so the contribution of fusion stays attributable. If
 * a future change improves the headline number, this says whether the gain came
 * from the graph layer or from the lexical one riding alongside it.
 */
const fieldGraphOnly = field(
  { weights: { graph: 1, vector: 1, lexical: 0 } },
  'field (graph only)',
  'graph + vector, no lexical signal — the pre-fusion behaviour'
);

export const STRATEGIES: Strategy[] = [vectorOnly, keyword, fieldGraphOnly, field()];

/** Field pipeline with a specific PPR restart probability, for tuning sweeps. */
export function fieldWithAlpha(alpha: number): Strategy {
  return field({ pprAlpha: alpha }, `field(alpha=${alpha})`);
}

/** Field pipeline with specific fusion weights, for tuning sweeps. */
export function fieldWithWeights(graph: number, vector: number, lexical: number): Strategy {
  return field(
    { weights: { graph, vector, lexical } },
    `g${graph}/v${vector}/l${lexical}`,
    `fusion weights graph=${graph} vector=${vector} lexical=${lexical}`
  );
}
