# ECO local staging

Local staging runs ECO against a separate Supabase stack bound to loopback. It uses the same ECO schema and authentication flow as the live application, with synthetic records and separate credentials. Developer Mode is available to the active staging owner administrator. It reveals Stage 2 and the TEST DATA control. The staging stack serves the Mac that runs it.

## Prepare the stack

1. Use a private local work directory. Copy the repository's Supabase configuration and email templates to it, select a distinct project name and set the auth site URL to the local ECO address.
2. Start the separate local Supabase stack. Apply the baseline to its empty database, then apply the repository's append-only migrations in filename order. Verify the database and HTTP API both resolve to loopback before provisioning.
3. Use Supabase Auth's local administrator API to create and confirm synthetic sign-ins. Activate their matching ECO directory records and assign the offices and flags below. Use distinct passwords. Enable the private test-workspace capability and policy for the staging administrator only.
4. Launch ECO on loopback with `ECO_LOCAL_STAGING=1`. Set `ECO_ORIGIN` and `ECO_SUPABASE_URL` to the distinct local HTTP origins. Use the local Supabase publishable and service credentials, a generated rate-limit secret and a separate initial-password value. Keep the process environment and credential file private.

The local application rejects production database URLs and Vercel deployments in this mode. The stage has no production mail, dispatch, backup or scheduled-refresh credentials. WhatsApp dispatch and scheduled official-table refresh have explicit staging gates.

## Test the roles

| Sign-in | Office | Flags |
| --- | --- | --- |
| Administrator | HONG KONG | ADMIN, SPC TRADER |
| Supplier trader | SINGAPORE | SPC TRADER |
| Buyer trader | HONG KONG | Ordinary trader |
| Manager | SINGAPORE | MANAGER |
| Credit | CREDIT | Ordinary trader |

Open the same local ECO URL in five separate browser profiles or test browser contexts. Sign in once in each and keep those profiles signed in. Use an ordinary trader's draft, the SPC workbench and assigned fixture work to check real permissions. Use VIEW AS in the staging administrator's profile for quick read-only comparisons.

Keep Developer Mode off during Stage 1 role tests. Turn it on for Stage 2 screens. TEST DATA is the optional owner workspace for fictional browser records. Authenticated staging sign-ins and their shared database records are available independently of TEST DATA.

Refresh the staging schema when the feature branch gains migrations. Keep credentials, screenshots containing synthetic records and session state outside public source.
