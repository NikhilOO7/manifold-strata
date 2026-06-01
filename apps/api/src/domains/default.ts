import type { DomainConfig } from './types';

/**
 * Generic, field-agnostic domain. Used when a paper has no domain set or an
 * unknown one. Keeps the system working out of the box and gives unscoped data a
 * stable home.
 */
export const defaultDomain: DomainConfig = {
  id: 'default',
  name: 'research papers',
  description: 'Generic, domain-agnostic research knowledge graph.',
  entityTypes: ['method', 'concept', 'dataset', 'metric', 'task', 'model'],
  relationshipTypes: [
    'extends',
    'improves',
    'uses',
    'introduces',
    'cites',
    'evaluates_on',
    'compares_to',
  ],
  domainContext: 'You analyze academic research papers across any field.',
  hierarchicalEdgeTypes: ['extends', 'improves', 'cites'],
};
