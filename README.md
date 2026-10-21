# ECO

ECO is a trading workspace with supplier and location profiles, enquiry intake and review, and administrator operations. Follow [the development roadmap](docs/development-roadmap.md), [the design system](docs/ui-design-system.md) and `AGENTS.md` when changing it.

## Local development

Use Node.js 24 and the pnpm version pinned in `package.json`. Install with `pnpm install --frozen-lockfile`, then run `pnpm dev`. The local interface runs at `http://127.0.0.1:4173`. Configure server-only services from `.env.example`; never commit credentials or private records. A signed-out interface is expected without a configured backend.

## Checks

- `pnpm test` checks application and permission behaviour.
- `pnpm build` checks TypeScript and produces the application with current build metadata.
- `pnpm security:build` inspects generated assets and performance limits.
- `pnpm security:source` checks the public source boundary.
- `.github/workflows/quality.yml` runs the complete application, isolated database and desktop/mobile browser checks. Public checks use invented records and do not receive production credentials.

## Data and deployment

Business records, staff provisioning, source reports and operational history are private. Supplier intelligence is loaded from an authenticated service, with an unavailable state if data has not been provisioned. TEST data is separate and available only to a privately configured owner account.

This repository starts from a reviewed clean snapshot. Earlier development history remains in the original private repository. For a fresh database, see [database bootstrap](docs/database-bootstrap.md); never replay that bootstrap on an existing deployment.

Production releases use the pinned targets in `config/ecoConnections.ts`, all required checks, a staged production deployment, and verification of that exact deployment before promotion. Source publication does not make production data, user accounts or report storage public.
