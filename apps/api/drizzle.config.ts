import type { Config } from 'drizzle-kit';

export default {
  schema: './src/db/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  dbCredentials: {
    // Must match the default in src/db/index.ts and the port docker-compose
    // publishes (5433). These disagreed — the app talked to 5433 while
    // `db:push` targeted 5432 — so a setup with no .env migrated one database
    // and ran against another.
    url: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/knowledge_graph',
  },
} satisfies Config;
