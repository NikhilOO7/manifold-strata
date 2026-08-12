/**
 * Issue the first admin credential.
 *
 *   pnpm --filter api auth:bootstrap -- --tenant "Acme Research"
 *
 * Every credential system has a bootstrap problem: `/api/admin/*` requires the
 * admin scope, and on a fresh database nobody holds it. The two usual answers are
 * to leave the admin routes open until the first key exists, or to accept a
 * long-lived credential from an environment variable. Both leave a permanent
 * hole for the sake of a one-time action.
 *
 * This does it out of band instead. Running the command requires database
 * credentials, which is a strictly higher bar than reaching the HTTP port, and
 * the authority it grants is a normal principal row with no special status — it
 * can be revoked like any other. Nothing about the running server needs to be
 * weakened for it to work.
 */

import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { db, closeDb } from '../db';
import { tenants, principals } from '../db/schema';
import { issueKey } from './keys';

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

async function main() {
  const tenantName = arg('tenant', 'Default Tenant')!;
  const principalName = arg('name', 'bootstrap-admin')!;
  const slug = slugify(arg('slug', tenantName)!);

  if (!slug) {
    throw new Error('Could not derive a slug from the tenant name — pass --slug explicitly.');
  }

  const existing = await db.select().from(tenants).where(eq(tenants.slug, slug)).limit(1);
  const tenant =
    existing[0] ??
    (await db.insert(tenants).values({ name: tenantName.trim(), slug }).returning())[0];

  const issued = issueKey();
  const [principal] = await db
    .insert(principals)
    .values({
      tenantId: tenant.id,
      name: principalName,
      kind: 'user',
      keyPrefix: issued.prefix,
      keyHash: issued.hash,
      scopes: ['admin'] as never,
      domains: ['*'] as never,
    })
    .returning();

  console.log('');
  console.log('  Tenant     ', `${tenant.name} (${tenant.slug})`);
  console.log('  Principal  ', `${principal.name} — scopes: admin, domains: *`);
  console.log('');
  console.log('  API key    ', issued.key);
  console.log('');
  console.log('  This key is shown once and is not recoverable — only its hash is stored.');
  console.log('  Start the API with AUTH_MODE=required, then:');
  console.log('');
  console.log(`    curl -H "Authorization: Bearer ${issued.key.slice(0, 20)}…" \\`);
  console.log('         http://localhost:3000/api/admin/principals');
  console.log('');

  await closeDb();
}

main().catch(async (err) => {
  console.error('Bootstrap failed:', err instanceof Error ? err.message : err);
  await closeDb().catch(() => {});
  process.exit(1);
});
