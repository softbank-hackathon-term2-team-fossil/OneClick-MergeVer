# SBSB (OneClick-MergeVer)

SBSB turns a customer repository into a versioned container image without requiring
the customer to understand Docker or GitHub Actions, then deploys that one image to an
on-premises server, AWS EC2, Azure VM, or Google Cloud Run.

## About this repository

This is the merged version of the team's separate implementations for SoftBank Hackathon 2026.
The git history starts fresh here; the work comes from these repositories:

| From | What it contributes |
| --- | --- |
| `sbsb` (Minchan Kim) | GitHub App onboarding, AI Dockerfile, GitHub Actions build, Docker Hub publishing, on-premises zero-downtime deployment (nginx blue/green) with a Cloudflare Tunnel |
| `Hyoyeon-deploy` (koryeon) | AWS EC2 and Azure VM deployment, ZIP upload, image version selection |
| `OneClick` (imjh990614) | Data model and rules: Postgres + Prisma, deployment history, one deployment at a time, restart cleanup, rollback |
| `sangheon-deploy` (ikellllllll) | Google Cloud Run deployment, AI failure analysis, selectable LLM provider (OpenAI or Gemini) |

Choices made while merging: one registry (Docker Hub) for every target, nginx for zero-downtime
replacement, GitHub App installation as the owner of a project, and cloud VMs reading the Docker Hub
token from their cloud's secret store. The reasoning is in [docs/sbsb-context.md](docs/sbsb-context.md).

**Verification status:** type check, unit tests, real-Postgres tests, and the production build pass.
Real deployments to AWS, Azure, and Cloud Run, and the on-screen history, rollback, and AI analysis
flows have not been exercised end to end yet, because they need the team's cloud accounts and
GitHub App configuration.

The "MVP flow" below describes the original on-premises path.

## MVP flow

1. The customer installs the SBSB GitHub App for selected repositories.
2. The customer selects one repository and one deployment branch.
3. SBSB reads a small allowlist of build manifests and entry points.
4. OpenAI generates a Dockerfile from that limited context.
5. SBSB adds its reviewed GitHub Actions template and opens a setup pull request.
6. SBSB registers its Docker Hub publisher credentials as encrypted Actions secrets.
   After merge, every push publishes customer-scoped commit-SHA and `latest` tags
   to the SBSB-owned private Docker Hub repository.
7. SBSB shows the GitHub Actions result and the immutable image reference.
8. The customer enters an existing Ubuntu/Debian VM's SSH credentials and ports.
9. The SBSB backend connects to the VM over SSH, temporarily signs in to Docker Hub,
   pulls the selected image, and replaces the running container.
10. After a successful first deployment, SBSB encrypts the VM connection locally.
    Future releases can be installed with the `Update to latest image` button.

The current on-premises MVP targets an existing SSH-accessible VM. It does not
create or reformat customer infrastructure.

## Run locally

Requirements: Node.js 22.12 or newer, pnpm, and Docker (for SBSB's own Postgres).

```bash
cp .env.example .env.local
pnpm install      # also generates the Prisma client
pnpm db:up        # start Postgres on localhost:5434
pnpm db:deploy    # create or update the tables
pnpm dev
```

SBSB stores projects, saved servers, and deployment history in Postgres. After changing
`prisma/schema.prisma`, run `pnpm db:migrate` to create a migration and `pnpm db:generate`
to regenerate the client.

Open `http://localhost:3000`.

## GitHub App permissions

- Repository contents: read and write
- Pull requests: read and write
- Actions: read
- Workflows: write
- Metadata: read
- Secrets: write

Set the GitHub App setup URL to `http://localhost:3000/api/github/callback` while
developing. SBSB verifies the installation redirect with a signed state value and
stores the installation ID in an HTTP-only cookie; it is never trusted from browser
input.

For local development, use `GITHUB_PRIVATE_KEY_PATH` to point to the downloaded
PEM file instead of copying the private key into `.env.local`.

SBSB uses GitHub's repository public key and sealed-box encryption to register its
Docker Hub credentials as Actions Secrets. The Docker Hub repository is created once
by the SBSB operator; customer images are separated by deterministic tag prefixes.
SSH credentials are sent only to the SBSB backend for
the active deployment request and are not stored in GitHub. Saved VM credentials are
encrypted with `SBSB_CREDENTIAL_ENCRYPTION_KEY`; only non-secret target metadata is
returned to the browser.

## Verification

```bash
pnpm typecheck
pnpm test
pnpm build
```

`pnpm test` needs no database. To also run the tests that use a real Postgres, create a
database you can wipe and point `SBSB_TEST_DATABASE_URL` at it:

```bash
docker exec sbsb_postgres createdb -U sbsb sbsb_test
DATABASE_URL="postgresql://sbsb:sbsb@localhost:5434/sbsb_test?schema=public" pnpm db:deploy
SBSB_TEST_DATABASE_URL="postgresql://sbsb:sbsb@localhost:5434/sbsb_test?schema=public" pnpm test
```

Do not point it at the database a running server uses: one test marks every unfinished
deployment as failed.

The Dockerfile is AI-generated and validated before it is offered in a pull
request. The workflow is never AI-generated; it comes from the tested template in
`lib/workflow-template.ts`.
