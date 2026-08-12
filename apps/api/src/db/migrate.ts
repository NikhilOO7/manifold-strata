/**
 * Apply pending migrations.
 *
 * Replaces `drizzle-kit push` as the way schema reaches a database that holds
 * data anyone cares about. `push` diffs the live schema against the models and
 * applies whatever it infers — it is convenient during exploration and unsafe
 * afterwards, because the plan is never reviewed, never versioned, and can drop
 * a column it believes was renamed. Migrations are files: they get read in a pull
 * request, they run in the same order everywhere, and a failed one leaves a
 * record of how far it got.
 *
 *   pnpm --filter api db:migrate
 */

import 'dotenv/config';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/knowledge_graph';

async function main() {
  const redacted = connectionString.replace(/\/\/[^@]*@/, '//***@');
  console.log(`Applying migrations to ${redacted}`);

  // `max: 1` because migrations must run sequentially on one connection —
  // a pool would let two statements race and interleave DDL.
  const client = postgres(connectionString, { max: 1 });

  try {
    await migrate(drizzle(client), { migrationsFolder: './drizzle' });
    console.log('✓ Migrations applied');
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error('✗ Migration failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
