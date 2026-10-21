# ECO nightly Drive runner

This is prepared operator code. Creating the files and passing offline tests does **not** activate a schedule, provision database credentials, authorize Google Drive or deploy the ECO signed-download endpoint. Activation needs a verified complete first unattended run and its private receipt.

## Execution and trust boundary

Use `nightly.mjs` from the trusted protected main branch on a standard GitHub-hosted Linux runner, triggered only by `schedule` or `workflow_dispatch`. The CLI rejects pull requests, forks, unprotected branches, debug logging and self-hosted runners. The workflow must independently pin its checkout/actions/tools, use environment `eco-backup`, give the job only `contents: read` and `id-token: write`, and serialize **all** backup workflows for this source with one fixed concurrency group and `cancel-in-progress: false`. A separate dedicated private runtime configuration supplies the intended Drive owner and folder; the actual account email, folder ID and recipient do not belong in public source.

The trusted wrapper imports the canonical `config/ecoConnections.ts` and passes it unchanged. `--canonical` and `--config` require absolute paths. The JSON configuration must be a new owner-only regular file (0600, single link, owned by the current user). No command line argument contains a secret. The CLI exports only a fixed success/failure status, not the database inventory, receipt, exception text or provider diagnostics.

```text
node /trusted/backup/nightly.mjs --canonical /trusted/config/ecoConnections.ts --config /private/runtime.json
```

The configuration has exactly these fields:

```text
schemaVersion: 1
expectedProjectRef: canonical ecoConnections.supabaseProjectRef
expectedSourceRole: eco_backup_reader
database:
  PGHOST: pinned direct ECO host or verified session-pooler host
  PGPORT: "5432"
  PGUSER: eco_backup_reader (direct) or eco_backup_reader.<canonical project ref> (pooler)
  PGDATABASE: "postgres"
  PGSSLMODE: "verify-full"
  PGSSLROOTCERT: absolute path to the separately verified CA certificate
pgBin: absolute directory containing verified PostgreSQL 17 native tools
ageBin: absolute path to the verified official age executable
recipient: the protected public age recipient; never the recovery identity
drive:
  expectedEmail: protected intended backup account email
  folderId: protected intended private folder ID
  applicationTag: eco-nightly-v1
  namePrefix: ECO-nightly
  propertyPrefix: ecoBackup
  keepNights: 5
  maxArchiveBytes: an explicitly reviewed integer limit
timeoutMs: integer from 60000 through 2700000 (45 minutes)
```

The canonical supplier report bucket is passed to capture explicitly. Do not substitute FCUNO/FCOS settings or credentials.

## Credentials

Each input below must be supplied by exactly one environment variable or an owner-only regular file named by its `_FILE` counterpart:

- `ECO_BACKUP_DB_PASSWORD`: dedicated ECO backup reader password.
- `ECO_DRIVE_CLIENT_ID`, `ECO_DRIVE_CLIENT_SECRET`, `ECO_DRIVE_REFRESH_TOKEN`: the dedicated Google OAuth app's approved unattended credential. The returned access-token scope must be exactly `https://www.googleapis.com/auth/drive.file`; missing or broader scopes fail closed. Google consent must be in a mode suitable for long-lived unattended use. OAuth app testing-mode expiry, revocation and account policy can stop future runs.
- `ECO_BACKUP_STORAGE_JSON`: **ephemeral job data**, not a long-lived application secret. The reviewed adapter accepts `oidcRequestUrl` and `oidcRequestToken`, assembled from this job's `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. The adapter obtains a short-lived token and sends it only to the canonical ECO backup endpoint. Use the exact GitHub-provided variable `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; do not print it. The provider module validates the canonical backup audience and endpoint pins.

The process rejects recovery-identity environment variables and the age private-key marker. Keep the decryption identity outside GitHub, Vercel, Drive and the runner. Encryption only needs the public recipient. Runtime data moves from supervisor to worker through stdin, never a command-line argument or plaintext GitHub artifact. Spawned PostgreSQL/age tools inherit only their necessary environment, not the full job environment.

Google's OAuth token request goes only to its fixed token endpoint; Drive bearer tokens go only to allowlisted Drive API/upload paths with redirects rejected. A failed upload body is not blindly replayed after a 401. The Drive module separately verifies the actual account, owner-only folder, permissions, file metadata and every downloaded ciphertext byte.

## Database privileges and consistency

The unattended source uses the explicitly approved full read-only ECO contract: `eco_backup_reader` with LOGIN, INHERIT and BYPASSRLS, exactly one membership in `pg_read_all_data`, and membership options ADMIN FALSE, INHERIT TRUE, SET FALSE. The role defaults to read-only transactions and cannot own objects, create persistent database/schema objects, grant read access onward, inherit additional roles or hold effective table/sequence write permissions. Executable SECURITY DEFINER routines outside system schemas also stop the runner. Normal TEMP privilege and the built-in `pg_settings` session-settings view are allowed; these do not authorize persistent application writes.

This is intentionally **full source read access**, including ECO authentication data, password hashes and readable PostgreSQL credential catalogs. It is not a narrowly scoped application-data account. `pg_read_all_data` also makes newly added source tables readable, preserving coverage across upgrades; BYPASSRLS is required for complete provider/authentication data. Keep the dedicated password in the protected backup environment's GitHub secrets. The worker's integrity audit checks catalog permissions without reading password values or connection strings; its role inventory omits role passwords. The encrypted database archive still contains authentication data stored in database tables. A secret exposure therefore requires promptly rotating the backup credential and assessing the affected source data.

Runtime checks include inherited and PUBLIC privileges, object ownership, full dump data coverage and unsafe definer execution, so future permission changes fail closed. Ordinary views are restored from definitions and do not need data-read coverage checks. Scope and effective permissions must be re-reviewed if the role, database version, application routines or hosting arrangement changes.

A session advisory lock spans the whole run. The Drive client checks that same session before every mutation/retry. GitHub's fixed workflow concurrency group is the primary cross-run serialization control; PostgreSQL liveness checks reduce the window after connection loss but do not turn Drive into an atomic transactional store. Do not start parallel manual runners or a second scheduler outside that group.

Capture holds its own repeatable-read, read-only exported PostgreSQL snapshot, checks the original keeper before/between/after the dump and object phases, and fails if that keeper changes or expires. The supplied native pg_dump must be compatible with the source major version. Storage object metadata is rechecked after download. Database and object storage are not one atomic transaction: size/hash/version checks cover the documented cases, and a detected object change requires a complete retry. The archive manifest includes all captured file lengths and SHA-256 hashes.

## Nightly order and retention

1. Validate the pinned target and runtime inputs, acquire the full-run lock and verify the Drive account/folder.
2. Look for this Hong Kong date's existing managed archive. A retry reuses it only after a fresh full ciphertext readback. This avoids conflicting randomized age ciphertext on the same night.
3. Otherwise capture the database and documents, build the integrity manifest and encrypt with official age. Remove the plaintext source directory before upload begins.
4. Upload only `.tar.gz.age`. Verify remote metadata, permissions, byte length and SHA-256 through a full readback before marking the copy complete.
5. Preserve the latest **five different Hong Kong dates**. Retention accepts only the original freshly minted receipt from this client instance. It verifies the retained copies before any removal and checks its lock before every write.
6. Older app-managed backups are moved to Drive trash, never permanently deleted by this code. Unrelated files and the separately created initial/manual backup are not managed. Trash remains recoverable and can continue using Drive quota until Google removes it or an operator empties it. Five visible nightly copies does not mean only five copies consume storage.

The date comes from the database snapshot. Crossing midnight during capture fails instead of silently relabelling a backup. A failed capture, encryption or verification does not authorize retention. Retention can complete partially if a later operation fails, but each removal already requires five newer verified nights.

## Cleanup, limits and recovery

The supervisor creates a private temporary run directory, starts a detached worker process group, limits output and execution duration, and handles SIGINT/SIGTERM by killing the whole group before removing its owned files. It also removes plaintext after worker failure and output overflow. The workflow runs a separate `always()` cleanup step with a two-minute limit and no source secrets or OIDC variables. It removes only this runner's owned, private directories matching the exact generated configuration/run names under `RUNNER_TEMP`, rejects foreign or unsafe directories and never follows symlinks. Credentials are passed through the job environment and stdin, not written into credential files. SIGKILL, runner destruction and power loss cannot execute cleanup handlers; use fresh ephemeral GitHub-hosted runners, avoid swap/core dumps where the environment permits, never cache or upload the work directory, and do not use persistent self-hosted machines.

A ciphertext readback proves that Drive retained the encrypted bytes; it is **not** a decryption/restore test. The receipt deliberately keeps `restorationVerified: false`. Perform periodic isolated native restore exercises using the independently held identity, and keep hosted Supabase restore, authentication/session reset, object re-upload and application validation procedures separate. The hosted application must not report a healthy current backup based on an old/manual receipt.

## Visibility and failure notifications

When `ECO_BACKUP_STORAGE_ENABLED` is exactly `true` in ECO, the existing administrator DATABASE BACKUP and DOCUMENT BACKUP checks read public GitHub Actions metadata independently of source/Drive credentials. The adapter is disabled by default. It pins the repository and owner IDs, main branch, workflow path, run attempt and exact successful capture step. Missing evidence, skipped steps/jobs, disabled workflows, provider errors, failed runs and incomplete runs never appear healthy. The metadata requests have a 3.5-second total deadline and a ten-minute cache; backup age is checked against the current time even while metadata is cached. A same-night retry may verify an earlier archive, so step time is not presented as snapshot time. Freshness is conservatively bounded from the start of that Hong Kong backup date and becomes unavailable after 36 hours, even when a late retry has a newer copy-verification time. No logs, encrypted archives or GitHub credentials are fetched by this check. The separate restore-test check remains unchanged.

This check runs when an administrator opens or refreshes System Health. It does not independently send a push notification when a scheduled run is missed or the scheduler is disabled. GitHub's built-in workflow failure notifications can provide standard failure alerts, subject to the account's notification settings; a disabled scheduler may create no failed run and therefore no notification. Public GitHub schedules can be delayed and may be disabled after repository inactivity, so they are not an exact-time or continuous-availability guarantee. Revisit unattended cadence, account quotas, OAuth validity, notification settings and recovery-key custody during platform upgrades.

## Verification

All fixtures use synthetic data and disposable test keys. Set `ECO_NATIVE_PG_BIN` to verified PostgreSQL 17 tools, `ECO_AGE_BIN` and `ECO_AGE_KEYGEN_BIN` to verified official age tools. The defaults target common Linux installation paths; test temporary roots use the operating system temporary directory. Native tests need local PostgreSQL process/shared-memory support and run a private Unix-socket cluster with TCP listening disabled. Tests neither need nor accept production credentials.

The runner suite covers workflow gates, target/TLS/role pins, secret-file permissions, manifest hashing, private-key rejection, successful and failed phase ordering, same-night retry, OAuth endpoint/scope handling, no replay of a 401 upload body, worker environment isolation, timeout/cancellation of descendants, and plaintext cleanup. Native privilege tests prove that PUBLIC write grants, callable PUBLIC application definers and unexpected writer-role membership are rejected. Offline tests do not prove the real OAuth grant, production backup-role grants, deployed OIDC endpoint, GitHub schedule, Drive quota, live restore or alerts are activated.

## Activation prerequisites

Provision and verify the dedicated role using the reviewed migration and separate protected credential activation. Verify the exact Google account, private app-accessible folder, OAuth grant, deployed OIDC endpoint, protected main branch, environment secrets and concurrency configuration. Keep the schedule disabled until a first unattended encrypted upload and full readback succeeds. Verify the administrator health result against that first run, review GitHub failure-notification settings, record the missing-run push-alert limitation and arrange independent recovery-key custody. Retain a private activation receipt. Source files and synthetic tests alone are not evidence that any live integration or schedule is active.
