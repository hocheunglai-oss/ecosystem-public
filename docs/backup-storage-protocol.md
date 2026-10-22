# Backup document downloads

`POST /api/backup/storage-downloads` is a machine-only, read-only backup route.
It is disabled unless `ECO_BACKUP_STORAGE_ENABLED=true`. This route creates no
staff identity, changes no document, and never returns a Supabase API key.

The caller obtains a GitHub Actions OIDC token with an audience equal to ECO's
production origin plus this route path. Authorization pins the numeric owner
and repository IDs, repository name, default branch, workflow path, environment,
hosted runner, and schedule/manual event types in `config/ecoConnections.ts`.
Both documented GitHub subject formats are checked exactly; the numeric identity
claims remain mandatory with either format. RSA signatures are verified against
the fixed GitHub JWKS endpoint with bounded retrieval and caching. Unknown or
missing claims fail closed. Reusable workflows are not implicitly trusted.

The request is JSON containing only `objects`, with one to twenty entries:

```json
{
  "objects": [
    {
      "id": "11111111-1111-4111-8111-111111111111",
      "bucketId": "eco-supplier-reports",
      "path": "22222222-2222-4222-8222-222222222222/33333333-3333-4333-8333-333333333333/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.pdf",
      "size": 100,
      "version": "object-version-from-storage-inventory"
    }
  ]
}
```

The caller obtains this inventory from its consistent database snapshot. The
server verifies object ID, bucket, full path, current version, size, and MIME
type using Storage's metadata API. It accepts the configured report bucket
with its immutable PDF path, and the protected general-attachment bucket with
its immutable UUID/UUID path. Published attachments must match their verified
metadata digest; pending bytes are captured as recovery evidence without
claiming they are published. Unexpected buckets or object types
require a reviewed protocol update; the caller must not silently omit them.

A successful response contains `schemaVersion: 1`, `projectRef`, and exactly the
requested objects with `sha256`, `url`, and `expiresAt` added. Each URL permits
downloading that exact object and expires in five minutes. Responses are private
and never cacheable. Neither tokens nor signed URLs belong in Actions logs,
artifacts, or public job summaries. The capture adapter validates the destination,
size, MIME type, and content hash and removes partial output when a capture fails.

Existing archives restore without this route. New capture depends on the route,
GitHub's OIDC issuer and Supabase being available. The runner must report failed
or stale backups and leave the last verified backup intact. Do not substitute a
service-role key or project JWT signing key when this route is unavailable.

References: [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc),
[Supabase signed downloads](https://supabase.com/docs/reference/javascript/storage-from-createsignedurls).
