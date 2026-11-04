# ECO nightly encrypted backup runner

This is prepared operator code. Creating the files and passing offline tests does **not** activate a schedule, provision database credentials, authorize Google Drive or deploy the ECO signed-download endpoint. Activation needs a verified complete first unattended run and its private receipt.

## Execution and trust boundary

Use `nightly.mjs` from the trusted protected main branch on a standard GitHub-hosted Linux runner, triggered only by `schedule` or `workflow_dispatch`. The CLI rejects pull requests, forks, unprotected branches, debug logging and self-hosted runners. The workflow must independently pin its checkout/actions/tools, use environment `eco-backup`, give the job only `contents: read` and `id-token: write`, and serialize **all** backup workflows for this source with one fixed concurrency group and `cancel-in-progress: false`. A separate dedicated private runtime configuration supplies the intended Drive owner and folder; the actual account email, folder ID and recipient do not belong in public source.

The trusted wrapper imports the canonical `config/ecoConnections.ts` and passes it unchanged. `--canonical` and `--config` require absolute paths. The JSON configuration must be a new owner-only regular file (0600, single link, owned by the current user). No command line argument contains a secret. The CLI exports fixed allowlisted status, phase and code values with integer elapsed-time diagnostics. It does not export the database inventory, receipt, exception text or provider responses.

```text
node /trusted/backup/nightly.mjs --canonical /trusted/config/ecoConnections.ts --config /private/runtime.json
```

The legacy Drive-only configuration has exactly these fields:

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

An optional `nextcloud` field enables a second encrypted destination. Omit this
field entirely to retain the legacy Drive-only path. Its exact keys are `origin`
(the privately verified HTTPS Storage Share origin), `expectedUser` (a dedicated
nonadmin `eco-backup` or `eco-backup-<suffix>` account), `folder` (one ASCII path
segment in that account's personal files), and `maxArchiveBytes` (reviewed positive
integer, at most 8 GiB). No hostname, account, password or actual folder identity
is committed to source. The private GitHub `ECO_BACKUP_CONFIGURATION` object accepts
this same optional field alongside its existing four fields; it does not accept
extra database credentials or an alternate source project.

The canonical supplier report bucket is passed to capture explicitly. Do not substitute FCUNO/FCOS settings or credentials.

## Credentials

Each input below must be supplied by exactly one environment variable or an owner-only regular file named by its `_FILE` counterpart:

- `ECO_BACKUP_DB_PASSWORD`: dedicated ECO backup reader password.
- `ECO_DRIVE_CLIENT_ID`, `ECO_DRIVE_CLIENT_SECRET`, `ECO_DRIVE_REFRESH_TOKEN`: the dedicated Google OAuth app's approved unattended credential. The returned access-token scope must be exactly `https://www.googleapis.com/auth/drive.file`; missing or broader scopes fail closed. Google consent must be in a mode suitable for long-lived unattended use. OAuth app testing-mode expiry, revocation and account policy can stop future runs.
- `ECO_BACKUP_STORAGE_JSON`: **ephemeral job data**, not a long-lived application secret. The reviewed adapter accepts `oidcRequestUrl` and `oidcRequestToken`, assembled from this job's `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN`. The adapter obtains a short-lived token and sends it only to the canonical ECO backup endpoint. Use the exact GitHub-provided variable `ACTIONS_ID_TOKEN_REQUEST_TOKEN`; do not print it. The provider module validates the canonical backup audience and endpoint pins.
- `ECO_NEXTCLOUD_APP_PASSWORD`: required only with the optional `nextcloud` destination, from its separate protected secret. Never reuse an administrator, contacts/phonebook writer or another application's credential. The trusted GitHub wrapper accepts the environment secret only; the lower-level CLI also supports its private `_FILE` counterpart. Supplying the credential without the matching destination configuration fails closed.

The process rejects recovery-identity environment variables and the age private-key marker. Keep the decryption identity outside GitHub, Vercel, Drive and the runner. Encryption only needs the public recipient. Runtime data moves from supervisor to worker through stdin, never a command-line argument or plaintext GitHub artifact. Spawned PostgreSQL/age tools inherit only their necessary environment, not the full job environment.

Google's OAuth token request goes only to its fixed token endpoint; Drive bearer tokens go only to allowlisted Drive API/upload paths with redirects rejected. A failed upload body is not blindly replayed after a 401. The Drive module separately verifies the actual account, owner-only folder, permissions, file metadata and every downloaded ciphertext byte.

## Database privileges and consistency

The unattended source uses the explicitly approved full read-only ECO contract: `eco_backup_reader` with LOGIN, INHERIT and BYPASSRLS, exactly one membership in `pg_read_all_data`, and membership options ADMIN FALSE, INHERIT TRUE, SET FALSE. The role defaults to read-only transactions and cannot own objects, create persistent database/schema objects, grant read access onward, inherit additional roles or hold effective table/sequence write permissions. Executable SECURITY DEFINER routines outside system schemas also stop the runner. Normal TEMP privilege and the built-in `pg_settings` session-settings view are allowed; these do not authorize persistent application writes.

This is intentionally **full source read access**, including ECO authentication data, password hashes and readable PostgreSQL credential catalogs. It is not a narrowly scoped application-data account. `pg_read_all_data` also makes newly added source tables readable, preserving coverage across upgrades; BYPASSRLS is required for complete provider/authentication data. Keep the dedicated password in the protected backup environment's GitHub secrets. The worker's integrity audit checks catalog permissions without reading password values or connection strings; its role inventory omits role passwords. The encrypted database archive still contains authentication data stored in database tables. A secret exposure therefore requires promptly rotating the backup credential and assessing the affected source data.

Runtime checks include inherited and PUBLIC privileges, object ownership, full dump data coverage and unsafe definer execution, so future permission changes fail closed. Ordinary views are restored from definitions and do not need data-read coverage checks. Scope and effective permissions must be re-reviewed if the role, database version, application routines or hosting arrangement changes.

A session advisory lock spans the whole run. The Drive client checks that same session before every mutation/retry. GitHub's fixed workflow concurrency group is the primary cross-run serialization control; PostgreSQL liveness checks reduce the window after connection loss but do not turn Drive into an atomic transactional store. Do not start parallel manual runners or a second scheduler outside that group.

Capture holds its own repeatable-read, read-only exported PostgreSQL snapshot, checks the original keeper before/between/after the dump and object phases, and fails if that keeper changes or expires. The supplied native pg_dump must be compatible with the source major version. Storage object metadata is rechecked after download. Database and object storage are not one atomic transaction: size/hash/version checks cover the documented cases, and a detected object change requires a complete retry. The archive manifest includes all captured file lengths and SHA-256 hashes.

## Nightly order and retention

### Legacy single-destination behavior

The following five-date policy applies when only Drive is configured.

1. Validate the pinned target and runtime inputs, acquire the full-run lock and verify the Drive account/folder.
2. Look for this Hong Kong date's existing managed archive. A retry reuses it only after a fresh full ciphertext readback. This avoids conflicting randomized age ciphertext on the same night.
3. Otherwise capture the database and documents, build the integrity manifest and encrypt with official age. Remove the plaintext source directory before upload begins.
4. Upload only `.tar.gz.age`. Verify remote metadata, permissions, byte length and SHA-256 through a full readback before marking the copy complete.
5. Preserve the latest **five different Hong Kong dates**. Retention accepts only the original freshly minted receipt from this client instance. It verifies the retained copies before any removal and checks its lock before every write.
6. Older app-managed backups are moved to Drive trash, never permanently deleted by this code. Unrelated files and the separately created initial/manual backup are not managed. Trash remains recoverable and can continue using Drive quota until Google removes it or an operator empties it. Five visible nightly copies does not mean only five copies consume storage.

The date comes from the database snapshot. Crossing midnight during capture fails instead of silently relabelling a backup. A failed capture, encryption or verification does not authorize retention. Retention can complete partially if a later operation fails, but each removal already requires five newer verified nights.

### Optional second destination

With `nextcloud` configured, the runner captures and seals once and attempts the
two destinations independently. Upload/readback operations start concurrently,
with the shared PostgreSQL lock checks serialized. A failed configured destination
makes the entire run fail; the successful remote copy is preserved. When
`maintenance` is omitted, neither destination is pruned, even after both succeed.
The optional reviewed maintenance policy below adds retention only with its
private activation, quota, restore and recoverable-trash evidence gates.

A same-night Drive archive, including a pending upload recovered by full readback,
is downloaded into a new private ciphertext file and mirrored exactly. It does
not silently bypass the second copy. Drive's preliminary lookup/recovery has a
five-minute cancellation budget so an unavailable provider cannot consume the
whole job before a fresh capture is attempted. If that recovery fails, a fresh
sealed snapshot is attempted at both destinations; Drive's existing collision
protection may reject a different same-night ciphertext while the second
destination still preserves its new copy. That partial outcome remains a failure.

The secondary adapter verifies its exact authenticated account with no group or
subadmin memberships, no outgoing or local incoming shares, a private owned local
personal root/folder, and private owned non-mounted archive metadata. Incoming
federated shares are not all enumerated by the local share endpoint; explicit
ownership and mount checks on the destination itself remain mandatory. These
are point-in-time checks, not immutable access controls. Configure a real finite
account quota; unknown/unlimited quota reporting is rejected.

Only already sealed age bytes are accepted. HTTPS credentials go only to the
configured exact origin and finite OCS/WebDAV paths; redirects are rejected.
The filename contains its Hong Kong snapshot date and full ciphertext hash.
Conditional `If-None-Match: *` PUT creates without overwriting. Existing names and
uncertain upload outcomes are accepted only after full independent readback.
The adapter streams every byte through SHA-256, enforces size, pins ETag during
readback, then rechecks unchanged metadata and privacy. Corrupt or partial remote
objects are preserved for operator review. Upload never deletes or moves another
object. No public link or server-side checksum substitutes for readback. The
separately gated maintenance operations below use only ordinary recoverable trash.

Requests use at most three attempts with a two-minute timeout per attempt;
authentication, privacy and checksum failures are not blindly retried. The outer
worker deadline still bounds the complete run. XML metadata is capped at 64 KiB,
parsed by isolated system Python using its standard library, and rejects DTDs,
entities, alternate encodings, duplicate properties and ambiguous resources.
There is no npm install or third-party XML parser in the credentialed job.

The private result contains separate verified receipts for each destination with
snapshot time, ciphertext hash, size and readback time. A private temporary
`destination-receipts.json` also records partial outcomes, but the supervisor
deliberately removes it during cleanup; it is not a durable receipt store. Public
logs contain only fixed destination phase/completion/error codes. Actual archive
existence is never reported as a completed verification or restore.

## Optional retention and capacity maintenance

Omitting private `maintenance` configuration preserves existing behavior. Its exact
fields are `mode` (`plan` or `enabled`), `restore` and `trashCanary` (each with
`sha256` and ISO `verifiedAt`), and `protectedHashes`. Only dual-destination runs
may opt in. First run in `plan` mode, review the exact private plan and quota
forecast, and complete the explicit synthetic Nextcloud trash/restore canary.
An operator must pin that real canary proof and an isolated restoration proof
before enabling cleanup. Neither source tests nor a successful upload establish
those prerequisites. Both proofs must be no more than thirty days old.

After both current full ciphertext readbacks, the runner persists create-only
pair receipts and maintenance plans in the verified private secondary folder.
Receipt identity binds snapshot time, hash, size and both objects. A same-night
retry preserves the first receipt and original source provenance. Pre-ledger
ciphertext with unknown capture provenance remains explicitly protected. Legacy,
manual, source-bundle, unknown and partial objects never become managed merely
because their filenames resemble a backup. The restored hash is always protected.

Drive keeps fourteen distinct Hong Kong backup dates. The secondary keeps their
union with the latest complete point in each of the previous eight completed
calendar weeks and twelve completed calendar months. Missing periods and
conflicting same-night captures remain explicit; missing history is not invented.
Long-term secondary points intentionally outlive the active Drive tier. Once such
a point expires from the union it may enter ordinary recoverable trash, provided
the current pair and retained basis are freshly verified and the restored point
remains protected. It need not retain an active Drive twin forever.

Cleanup mints authority from new full readbacks, rechecks private scope and stable
identity immediately before each operation, and writes a durable intent first.
Drive is retired first while its secondary twin is still active. The Nextcloud
trash endpoint, assigned quota and headroom are checked before each ordinary file
DELETE; the exact resulting trash entry is streamed and hashed. Permanent-delete
and trash-empty endpoints are unavailable. Provider automatic trash expiry remains
possible. An uncertain operation leaves its intent for operator review and is not
blindly replayed. Completion receipts make subsequent runs idempotent. At most
eight points per provider are retired per run; excess copies remain until a later
run. Pair receipts are partitioned by Hong Kong calendar year, with event records
in separate year/month folders. Each run reads only the current and previous two
years, at most 512 pair receipts per year, with four bounded concurrent readbacks.
This window covers ordinary twelve-month tier expiration without a lifetime file
limit. Older interrupted, unknown or protected holdings remain untouched and still
consume measured quota; no space reclamation is inferred from excluding them.
The restored hash stays separately protected. An over-limit or incomplete partition
stops for review, never silent truncation or shortened retention.

Capacity uses actual quota observations, the larger of the latest archive and
the last thirty distinct captures' p95, two further uploads, provider-trash costs
and reserved secondary headroom. It warns at projected 70% and urgently at 85%,
insufficient headroom, unknown quota, archive size approaching the unchanged
512 MiB cap, or a run approaching its deadline. Physical host-wide trash/version
overhead is not inferred from a user quota. Warnings do not prevent a possible
good copy; they are evaluated after successful readback.

`Check verified backup capacity` is a separate exact workflow step. It reads only
a private, bounded, finite-code status file. A maintenance or quota warning fails
that step while the copy-verification step remains successful. Absent maintenance
configuration remains unknown rather than producing a false healthy signal. Public health then
reports verified copies requiring capacity/retention attention, rather than
misreporting a capture failure or claiming healthy maintenance. Missing/invalid
status is unknown. The independent alert service must recognize the same exact
step name; deployed source alone is not proof of external email delivery.

## Cleanup, limits and recovery

The supervisor creates a private temporary run directory, starts a detached worker process group, limits output and execution duration, and handles SIGINT/SIGTERM by killing the whole group before removing its owned files. It also removes plaintext after worker failure and output overflow. The workflow runs a separate `always()` cleanup step with a two-minute limit and no source secrets or OIDC variables. It removes only this runner's owned, private directories matching the exact generated configuration/run names under `RUNNER_TEMP`, rejects foreign or unsafe directories and never follows symlinks. Credentials are passed through the job environment and stdin, not written into credential files. SIGKILL, runner destruction and power loss cannot execute cleanup handlers; use fresh ephemeral GitHub-hosted runners, avoid swap/core dumps where the environment permits, never cache or upload the work directory, and do not use persistent self-hosted machines.

A ciphertext readback proves that Drive retained the encrypted bytes; it is **not** a decryption/restore test. The receipt deliberately keeps `restorationVerified: false`. Perform periodic isolated native restore exercises using the independently held identity, and keep hosted Supabase restore, authentication/session reset, object re-upload and application validation procedures separate. The hosted application must not report a healthy current backup based on an old/manual receipt.

## Visibility and failure notifications

The owner's 4 November 2026 notification policy is failure-only. The ECO
notification panel shows only current authenticated `unavailable` backup checks.
Capacity/retention advisories, pending runs, unknown or stale evidence and
successful checks do not produce panel notices. All of these states remain
visible, unchanged, in administrator System Health; suppressing a notice does
not assert recovery. Independent email and follow-up monitors must likewise
notify only actual failed or missed backups, without success, recovery or
storage-advisory messages. Deployment and delivery evidence remain separate.

When `ECO_BACKUP_STORAGE_ENABLED` is exactly `true` in ECO, the existing administrator DATABASE BACKUP and DOCUMENT BACKUP checks read public GitHub Actions metadata independently of source/Drive credentials. The adapter is disabled by default. It pins the repository and owner IDs, main branch, workflow path, run attempt and exact successful capture step. Missing evidence, skipped steps/jobs, disabled workflows, provider errors, failed runs and incomplete runs never appear healthy. The metadata requests have a 3.5-second total deadline and a ten-minute cache; backup age is checked against the current time even while metadata is cached. A same-night retry may verify an earlier archive, so step time is not presented as snapshot time. Freshness is conservatively bounded from the start of that Hong Kong backup date and becomes unavailable after 36 hours, even when a late retry has a newer copy-verification time. No logs, encrypted archives or GitHub credentials are fetched by this check. The separate restore-test check remains unchanged.

This check runs when an administrator opens or refreshes System Health. It does not independently send a push notification when a scheduled run is missed or the scheduler is disabled. GitHub's built-in workflow failure notifications can provide standard failure alerts, subject to the account's notification settings; a disabled scheduler may create no failed run and therefore no notification. Public GitHub schedules can be delayed and may be disabled after repository inactivity, so they are not an exact-time or continuous-availability guarantee. Revisit unattended cadence, account quotas, OAuth validity, notification settings and recovery-key custody during platform upgrades.

## Verification

All fixtures use synthetic data and disposable test keys. Set `ECO_NATIVE_PG_BIN` to verified PostgreSQL 17 tools, `ECO_AGE_BIN` and `ECO_AGE_KEYGEN_BIN` to verified official age tools. The defaults target common Linux installation paths; test temporary roots use the operating system temporary directory. Native tests need local PostgreSQL process/shared-memory support and run a private Unix-socket cluster with TCP listening disabled. Tests neither need nor accept production credentials.

The runner suite covers workflow gates, target/TLS/role pins, secret-file permissions, manifest hashing, private-key rejection, successful and failed phase ordering, same-night retry, OAuth endpoint/scope handling, no replay of a 401 upload body, worker environment isolation, timeout/cancellation of descendants, and plaintext cleanup. Native privilege tests prove that PUBLIC write grants, callable PUBLIC application definers and unexpected writer-role membership are rejected. Offline tests do not prove the real OAuth grant, production backup-role grants, deployed OIDC endpoint, GitHub schedule, Drive quota, live restore or alerts are activated.

## Activation prerequisites

An authorized operator can dispatch one manual run from protected main while `ECO_NIGHTLY_BACKUP_ENABLED` is absent or false. This does not enable scheduled runs and retains every repository, workflow, environment and credential restriction. Set the variable to `true` only after that first run is verified; clearing it pauses future scheduled runs while preserving explicit manual recovery checks.

Provision and verify the dedicated role using the reviewed migration and separate protected credential activation. Verify the exact Google account, private app-accessible folder, OAuth grant, deployed OIDC endpoint, protected main branch, environment secrets and concurrency configuration. Keep the schedule disabled until a first unattended encrypted upload and full readback succeeds. Verify the administrator health result against that first run, review GitHub failure-notification settings, record the missing-run push-alert limitation and arrange independent recovery-key custody. Retain a private activation receipt. Source files and synthetic tests alone are not evidence that any live integration or schedule is active.

The optional secondary destination is **inactive until separately provisioned and
verified**. Before adding its private configuration/secret, establish a dedicated
nonadmin ECO account and app password, finite quota, the intended local private
folder, and no outgoing shares. Verify the hosted server's actual API and
conditional-create behavior in that account. Then require a complete protected
run with full readback from both destinations, followed by an isolated restore
from the downloaded encrypted copy using the independently held recovery identity.
Record evidence privately and verify that the failure/missed-run alert reaches
the approved recipient. Keep the recovery identity outside both destinations and
all unattended runners. This supplementary Storage Share copy does not replace
the live database, the existing Drive copy, or whole-application recovery planning.

Nextcloud trash metadata does not provide the strong ETag
used for ordinary archives. Trash verification binds the exact file identity,
original location, deletion time and size to a complete SHA-256 readback and
stable before/after metadata. HEAD may expose an empty underlying tag while GET
and the listing expose a deletion-time preview tag. The bounded opaque HEAD
tag and exact listing are checked independently and never treated as content
validators. Trash GET/restore use `If-Match: *` only as an
existence check. Restore refuses an existing original and verifies its complete
bytes afterward; a lost or conflicting restore is never retried automatically.
The provider does not expose a strong content validator for an atomic trash
restore. Ordinary archive deletion retains its original strong `If-Match`.

Nextcloud's virtual restore endpoint requires `Overwrite: T` because its
pseudochild does not raise a missing-node exception; `F` is rejected before
restoration. This flag is permitted only on the exact trash-to-restore route,
never on archive uploads or other moves. The provider normally selects a unique
restored filename for a collision. ECO checks the actual original is absent
beforehand and requires its exact private bytes afterward; renamed/conflicting
results fail without replay. This is not an atomic no-replace guarantee.
