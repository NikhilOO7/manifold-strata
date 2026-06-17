/**
 * Evaluation harness — `pnpm --filter api eval`.
 *
 * Turns the project's quality claims into numbers. Three layers:
 *
 *   1. Extraction   (offline) — run the extractor on gold passages; score entity
 *                               recall and relation precision/recall/F1.
 *   2. Resolution   (offline) — feed known aliases past the embedding resolver and
 *                               check they collapse to one canonical node (and that
 *                               distractors do NOT).
 *   3. Retrieval +  (needs DB) — run field queries against the live graph; score
 *      faithfulness              evidence hit-rate and answer faithfulness (LLM judge).
 *
 * Layers 1–2 need only a model/embedding provider. Layer 3 is skipped with a clear
 * message when the graph is empty or the database is unreachable.
 */

import 'dotenv/config';
import { checkOllamaConnection, generateCompletion } from '../services/ollama';
import { embed } from '../services/embeddings';
import { extractEntitiesAndRelationships } from '../agents/extractor';
import { resolveEntitiesEmbed, type ExistingNode } from '../knowledge-field/resolve-embed';
import { getDomain } from '../domains';
import * as metrics from '../services/metrics';
import {
  EXTRACTION_CASES,
  RESOLUTION_CASES,
  QA_CASES,
  DOMAIN_ID,
} from './gold';
import {
  prf,
  microAverage,
  matchesGroup,
  mapEdgeType,
  pct,
  type PRF,
} from './metrics';

function line(): void {
  console.log('─'.repeat(64));
}

async function evalExtraction(): Promise<void> {
  console.log('\n## 1. Extraction (entity recall + relation P/R/F1)\n');
  const domain = getDomain(DOMAIN_ID);
  const entityParts: PRF[] = [];
  const relationParts: PRF[] = [];

  for (const c of EXTRACTION_CASES) {
    const out = await extractEntitiesAndRelationships({
      paperId: 'eval',
      chunkIndex: 0,
      text: c.text,
      section: c.section,
      domain,
    });

    // Entity recall: a gold entity is found if any extracted mention matches its
    // alias set. Precision against a non-exhaustive gold would be unfair, so we
    // report recall as the headline and surface the extra-extraction count.
    let eHit = 0;
    for (const group of c.goldEntities) {
      if (out.entities.some((e) => matchesGroup(e.mention, group))) eHit++;
    }
    const extras = out.entities.filter(
      (e) => !c.goldEntities.some((g) => matchesGroup(e.mention, g))
    ).length;
    const eRecall = prf(eHit, 0, c.goldEntities.length - eHit);
    entityParts.push(eRecall);

    // Relation scoring. Recall over gold relations; precision over in-scope
    // extracted relations (both endpoints match SOME gold entity), so relations
    // touching entities outside our gold list don't count against precision.
    const goldMatched = new Set<number>();
    let inScope = 0;
    let inScopeCorrect = 0;
    const allGoldEntities = c.goldEntities;
    for (const r of out.relationships) {
      const subjInScope = allGoldEntities.some((g) => matchesGroup(r.subject, g));
      const objInScope = allGoldEntities.some((g) => matchesGroup(r.object, g));
      if (!subjInScope || !objInScope) continue;
      inScope++;
      const etype = mapEdgeType(r.predicate);
      const gi = c.goldRelations.findIndex(
        (gr) =>
          matchesGroup(r.subject, gr.subject) &&
          matchesGroup(r.object, gr.object) &&
          gr.type === etype
      );
      if (gi >= 0) {
        goldMatched.add(gi);
        inScopeCorrect++;
      }
    }
    const rTp = goldMatched.size;
    const rFn = c.goldRelations.length - rTp;
    const rFp = inScope - inScopeCorrect;
    relationParts.push(prf(rTp, rFp, rFn));

    console.log(
      `  ${c.id.padEnd(22)} entities ${eHit}/${c.goldEntities.length} recall ` +
        `(${extras} extra)  |  relations TP ${rTp} FP ${rFp} FN ${rFn}`
    );
  }

  const eAgg = microAverage(entityParts);
  const rAgg = microAverage(relationParts);
  line();
  console.log(`  ENTITY    recall ${pct(eAgg.recall)}  (${eAgg.tp}/${eAgg.tp + eAgg.fn})`);
  console.log(
    `  RELATION  P ${pct(rAgg.precision)}  R ${pct(rAgg.recall)}  F1 ${pct(rAgg.f1)}`
  );
}

async function evalResolution(): Promise<void> {
  console.log('\n## 2. Resolution (alias collapse + distractor rejection)\n');
  let correct = 0;
  let total = 0;

  for (const c of RESOLUTION_CASES) {
    // Seed the graph with the canonical node and its embedding.
    const [canonVec] = await embed([c.canonical], 'eval-resolve');
    const seedId = `seed-${c.id}`;
    const existing: ExistingNode[] = [
      { id: seedId, type: c.type, name: c.canonical, normalizedName: c.canonical.toLowerCase() },
    ];
    const nodeVectors = new Map<string, number[]>([[seedId, canonVec]]);

    const mentions = [...c.aliases, ...c.distractors];
    const extracted = {
      entities: mentions.map((m) => ({
        mention: m,
        type: c.type === 'paper' ? 'paper_reference' : c.type,
        spanStart: 0,
        spanEnd: 0,
        confidence: 1,
      })),
      relationships: [],
    };

    const resolved = await resolveEntitiesEmbed(extracted as any, existing, nodeVectors);
    const byMention = new Map(resolved.resolvedEntities.map((r) => [r.mention.toLowerCase(), r]));

    for (const alias of c.aliases) {
      total++;
      const r = byMention.get(alias.toLowerCase());
      const ok = !!r && !r.isNew && r.canonicalId === seedId;
      if (ok) correct++;
      console.log(`  ${ok ? '✓' : '✗'} "${alias}" → ${r?.canonicalName ?? '—'}${r?.isNew ? ' (NEW)' : ''}`);
    }
    for (const d of c.distractors) {
      total++;
      const r = byMention.get(d.toLowerCase());
      const ok = !!r && (r.isNew || r.canonicalId !== seedId); // should NOT merge into canonical
      if (ok) correct++;
      console.log(`  ${ok ? '✓' : '✗'} "${d}" stays distinct → ${r?.isNew ? 'new node' : r?.canonicalName}`);
    }
  }

  line();
  console.log(`  RESOLUTION accuracy ${pct(total ? correct / total : 1)}  (${correct}/${total})`);
}

async function evalRetrieval(): Promise<void> {
  console.log('\n## 3. Retrieval + faithfulness (live graph)\n');
  let db: any;
  let nodes: any;
  let fieldQuery: any;
  let domainWhere: any;
  try {
    ({ db } = await import('../db'));
    ({ nodes } = await import('../db/schema'));
    ({ fieldQuery } = await import('../knowledge-field/retrieve'));
    ({ domainWhere } = await import('../domains/filter'));
  } catch (e) {
    console.log('  Skipped — could not load DB modules.');
    return;
  }

  let count = 0;
  try {
    const rows = await db
      .select({ id: nodes.id })
      .from(nodes)
      .where(domainWhere(nodes.domain, DOMAIN_ID))
      .limit(1);
    count = rows.length;
  } catch (e) {
    console.log(`  Skipped — database unreachable (${e instanceof Error ? e.message : e}).`);
    console.log('  Ingest the gaussian-splatting seed papers, then re-run for retrieval scores.');
    return;
  }

  if (count === 0) {
    console.log('  Skipped — no gaussian-splatting nodes in the graph yet.');
    console.log('  Ingest a few seed papers (e.g. arXiv 2308.04079) and re-run.');
    return;
  }

  let hits = 0;
  let faithful = 0;
  for (const c of QA_CASES) {
    const res = await fieldQuery(c.question, { domain: DOMAIN_ID, verbalize: true });
    const evidenceText = res.evidence.map((e: any) => e.text).join(' ') + ' ' + (res.answer || '');
    const hit = c.mustMention.every((group) => group.some((g) => evidenceText.toLowerCase().includes(g.toLowerCase())));
    if (hit) hits++;

    // Faithfulness: is the answer entailed by the retrieved evidence?
    let verdict = 'n/a';
    if (res.answer && res.evidence.length > 0) {
      const judgeCtx = res.evidence.map((e: any, i: number) => `[${i + 1}] ${e.text}`).join('\n');
      const judge = await generateCompletion(
        'You are a strict grader. Reply with exactly YES or NO.',
        `Evidence:\n${judgeCtx}\n\nAnswer: ${res.answer}\n\n` +
          'Is every claim in the Answer supported by the Evidence above? Reply YES or NO.',
        0,
        'eval-judge'
      );
      verdict = judge.text.trim().toUpperCase().startsWith('YES') ? 'faithful' : 'unsupported';
      if (verdict === 'faithful') faithful++;
    }

    console.log(`  ${hit ? '✓' : '✗'} ${c.id.padEnd(20)} evidence-hit | answer: ${verdict}`);
  }

  line();
  console.log(`  EVIDENCE hit-rate ${pct(hits / QA_CASES.length)}  (${hits}/${QA_CASES.length})`);
  console.log(`  FAITHFULNESS      ${pct(faithful / QA_CASES.length)}  (${faithful}/${QA_CASES.length})`);
}

async function main(): Promise<void> {
  console.log('Manifold-Strata — evaluation harness');
  line();

  const connected = await checkOllamaConnection();
  if (!connected) {
    console.error(
      '\nNo model/embedding provider available. Set OPENAI_API_KEY (or run Ollama) and retry.'
    );
    process.exit(1);
  }

  metrics.reset();
  metrics.setMode('eval');

  await evalExtraction().catch((e) => console.error('Extraction eval failed:', e));
  await evalResolution().catch((e) => console.error('Resolution eval failed:', e));
  await evalRetrieval().catch((e) => console.error('Retrieval eval failed:', e));

  // Cost accounting for the whole run.
  const snap = metrics.snapshot('eval');
  console.log('\n## Cost\n');
  line();
  console.log(
    `  LLM calls ${snap.totals.llmCalls}  |  tokens ${
      snap.totals.promptTokens + snap.totals.completionTokens
    }  |  embed calls ${snap.totals.embedCalls}`
  );

  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
