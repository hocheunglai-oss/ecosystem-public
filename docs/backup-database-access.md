# Backup database access

The approved cloud-runner design uses a dedicated `eco_backup_reader` database
login for complete-source recovery. It has `pg_read_all_data` and `BYPASSRLS`.
That access includes application authentication data and PostgreSQL credential
catalogs, including password hashes. It is deliberately broader than access to
application business tables. The export code does not log those values or query
role passwords, and the credential belongs only in the protected backup
environment's secrets. It is never a browser, staff or application credential.

This scope is necessary for the selected design because the Supabase customer
database principal cannot delegate `SELECT` on provider-owned Auth and Storage
tables or become their owner. A smaller custom grant set would need provider
assistance and ongoing grants for managed schema changes. The approved complete
read role also covers new tables and schemas without silently omitting them.

The migration stages the role with `NOLOGIN` and no password. Private activation
is a separate operator step. The exact membership is `pg_read_all_data` with
`ADMIN FALSE`, `INHERIT TRUE` and `SET FALSE`; no additional memberships are
allowed. The role has no superuser, database-creation, role-administration or
replication privilege, owns no application objects, and cannot execute any
non-system `SECURITY DEFINER` routine. Both staging and each backup check
effective privileges, including privileges inherited from `PUBLIC`.

Application table writes, sequence changes, permanent object creation and
administrative operations are rejected by database ACLs. Tests verify these
restrictions both with the default read-only setting and inside an explicitly
`READ WRITE` transaction. The read-only default alone is not treated as a security
boundary. This is not an immutable database server: PostgreSQL may still permit
ordinary login capabilities such as changing the login's own password, temporary
objects or built-in large-object operations. A provider-enforced read-only
endpoint would be a different design.

A changed role, additional write grant, executable definer routine, missing
coverage, unsupported stored object or inconsistent snapshot fails the backup.
The operator must review the changed privilege or source schema and repair it;
the worker must never grant itself additional authority or omit inaccessible
records to obtain a successful result. Logs report only sanitized outcome codes.

Database files and stored documents are encrypted before cloud upload. The
runner holds only the public recovery recipient, never the recovery identity.
Upload verification and retention remain separate from an actual restore test.
The ordinary PostgreSQL dump includes application authentication rows but does
not export the cluster-wide role-password catalog as a recovery artifact.
