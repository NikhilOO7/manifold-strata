import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema';

const connectionString =
  process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5433/knowledge_graph';

const client = postgres(connectionString, {
  max: 10,
  idle_timeout: 20,
  connect_timeout: 10,
  /**
   * Recycle a connection after this many seconds.
   *
   * Pinned rather than left to the driver's default, which is a *random* 30–60
   * minutes per connection. Randomised lifetimes make recycling behaviour
   * unreproducible between runs, and a long-running process was emitting
   * `TimeoutNegativeWarning` from a multi-minute timer whose fractional
   * signature matches that computation. Node clamps a negative delay to 1 ms, so
   * nothing broke — but "harmless warning from a timer nobody can identify" is
   * exactly the noise that trains people to ignore their logs.
   *
   * Not conclusively traced to this timer; pinning it makes the behaviour
   * deterministic regardless, which is the point.
   */
  max_lifetime: 60 * 30,
});

export const db = drizzle(client, { schema });

/**
 * Drain the connection pool.
 *
 * Without this the process holds open sockets after its work is done: tests hang
 * instead of exiting, and on shutdown in-flight queries are cut at the socket
 * rather than allowed to finish. `{ timeout }` bounds how long we wait for
 * outstanding queries before closing anyway, so a stuck query can't block exit.
 */
export async function closeDb(timeoutSeconds = 5): Promise<void> {
  await client.end({ timeout: timeoutSeconds });
}
