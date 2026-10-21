# Database bootstrap and migrations

`supabase/baseline/schema.sql` initializes a new empty ECO schema. It contains no company directory, commercial records, report files or enabled owner capability. Apply the baseline only to a new database, then apply the append-only files in `supabase/migrations/` in filename order. The baseline refuses an existing ECO schema.

Existing production databases already have the legacy migration history. Do not replay the baseline, rewrite that history, mark migrations complete without applying them, or run a bulk repair to reconcile it with this clean source repository. The original immutable migrations remain in the private source archive. Verify the current production migration head and apply only reviewed new migrations, individually, to the pinned ECO project.

The build fingerprint covers the baseline and append-only migrations. The reported migration count is the number of new migration files in this public repository; baseline metadata records the legacy boundary separately.

Tests use `tests/fixtures/migrations.mjs` to create a fresh isolated database from the baseline and current migrations. Fixture identities and business records are invented. Production credentials must never be passed to the public test workflow.
