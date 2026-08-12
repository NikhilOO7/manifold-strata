import type { DomainConfig } from './types';

/**
 * APIs and the tools an agent can call.
 *
 * The domain that makes Manifold's positioning concrete: an agent with hundreds
 * of connected systems cannot hold every tool schema in context, so choosing the
 * right endpoint becomes a retrieval problem over a typed graph. Populated by the
 * OpenAPI connector at zero LLM cost.
 */
export const apiSurfaceDomain: DomainConfig = {
  id: 'api-surface',
  name: 'API Surface',
  description:
    'Connected systems, their endpoints, capabilities, payload schemas and authentication requirements.',

  entityTypes: ['api', 'endpoint', 'capability', 'schema', 'auth'],
  relationshipTypes: ['exposes', 'belongs_to', 'requires', 'accepts', 'returns'],

  domainContext:
    'Software APIs and the operations they expose, described the way an agent needs them: ' +
    'what each endpoint does, which capability it belongs to, what it accepts and returns, ' +
    'and what authentication it requires.',

  entityExamples: {
    api: ['Stripe API', 'GitHub REST API'],
    endpoint: ['createCustomer', 'POST /repos/{owner}/{repo}/issues'],
    capability: ['Billing', 'Issues', 'Webhooks'],
    schema: ['Customer', 'Issue'],
    auth: ['bearerAuth', 'oauth2'],
  },

  relationshipExamples: [
    { source: 'Stripe API', type: 'exposes', target: 'createCustomer' },
    { source: 'createCustomer', type: 'belongs_to', target: 'Billing' },
    { source: 'createCustomer', type: 'accepts', target: 'Customer' },
    { source: 'createCustomer', type: 'requires', target: 'bearerAuth' },
  ],

  // An endpoint belonging to a capability is the hierarchy that matters here.
  hierarchicalEdgeTypes: ['belongs_to', 'exposes'],
};
