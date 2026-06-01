import type { DomainConfig } from './types';

/**
 * Example second domain — proves the isolation works: "attention" here is a
 * separate node from any vision-domain "attention".
 */
export const nlpDomain: DomainConfig = {
  id: 'nlp',
  name: 'Natural Language Processing',
  description: 'Research on NLP, transformers, and large language models.',
  entityTypes: ['model', 'technique', 'dataset', 'metric', 'task', 'paper_reference'],
  relationshipTypes: [
    'extends',
    'improves',
    'uses',
    'introduces',
    'cites',
    'evaluates_on',
    'outperforms',
    'fine_tunes',
  ],
  domainContext:
    'You specialize in natural language processing, transformers, large language models, and NLP benchmarks.',
  entityExamples: {
    model: ['BERT', 'GPT-4', 'T5', 'LLaMA', 'Transformer'],
    technique: ['attention', 'self-supervision', 'RLHF', 'LoRA', 'chain-of-thought'],
    dataset: ['GLUE', 'SQuAD', 'MMLU', 'HumanEval'],
    metric: ['BLEU', 'ROUGE', 'perplexity', 'F1'],
    task: ['machine translation', 'summarization', 'question answering'],
  },
  relationshipExamples: [
    { source: 'GPT-4', type: 'extends', target: 'GPT-3' },
    { source: 'BERT', type: 'evaluates_on', target: 'GLUE' },
  ],
  hierarchicalEdgeTypes: ['extends', 'improves', 'cites'],
  seedPaperIds: ['1706.03762', '1810.04805', '2005.14165'],
};
