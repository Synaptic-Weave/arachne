---
title: Contributing
description: Contributing to Arachne development
order: 5
---


Thank you for your interest in contributing to Arachne. This guide covers the workflow, conventions, and setup you need to get started.

## Local Development Setup

### Prerequisites

- Node.js 25.2.1 or later
- Docker and Docker Compose (for PostgreSQL)
- Git

### Getting Started

```bash
# Clone the repository
git clone https://github.com/arachne-ai/arachne.git
cd arachne

# Install dependencies
npm install

# Start PostgreSQL
docker compose up -d postgres

# Configure environment
cp .env.example .env
# Generate an encryption key:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
# Add the key to .env as ENCRYPTION_MASTER_KEY

# Run database migrations
npm run migrate:up

# Start the development server
npm run dev
```

The server starts at `http://localhost:3000` with hot reload enabled.

### Building Frontends

```bash
# Build the portal (tenant UI)
cd portal && npm run build

# Build the dashboard (operator UI)
cd dashboard && npm run build

# Or build everything at once
npm run build:all
```

## Branching Strategy

Arachne uses a gitflow-inspired branching model:

- **`main`** — Stable, release-ready code. All pull requests target `main`.
- **Feature branches** — Branch from `main` with a descriptive name: `feat/add-anthropic-provider`, `fix/conversation-token-limit`, `docs/update-api-reference`.
- **Release branches** — Created from `main` when preparing a release: `release/1.2.0`.

### Branch Naming Conventions

| Prefix | Purpose | Example |
|--------|---------|---------|
| `feat/` | New feature | `feat/streaming-mcp-tools` |
| `fix/` | Bug fix | `fix/rag-similarity-threshold` |
| `refactor/` | Code improvement | `refactor/migrate-portal-to-orm` |
| `docs/` | Documentation | `docs/rag-inference-guide` |
| `test/` | Test additions | `test/provider-adapter-coverage` |

## Changesets Workflow

Arachne uses [Changesets](https://github.com/changesets/changesets) to manage versioning and changelogs.

### Adding a Changeset

When your PR includes user-facing changes, add a changeset:

```bash
npx changeset
```

Follow the prompts to:

1. Select the affected packages.
2. Choose the semver bump type (`patch`, `minor`, `major`).
3. Write a summary of the change.

This creates a markdown file in `.changeset/` that will be consumed during the next release.

### What Needs a Changeset

- New features, bug fixes, and breaking changes: **yes**.
- Internal refactors, test-only changes, and documentation: **no** (but you can add one if you want it in the changelog).

## Running Tests

### Unit and Integration Tests

```bash
# Run the full test suite
npm test

# Run tests in watch mode during development
npm run test:watch

# Run a specific test file
npx vitest run tests/auth.test.ts

# Run tests matching a pattern
npx vitest run -t "should resolve tenant context"

# Run with coverage
npm run test:coverage
```

### Smoke Tests

End-to-end tests run with Playwright against a live instance:

```bash
npm run test:smoke
```

### Testing Conventions

- **Unit tests** mock `EntityManager` and service dependencies to isolate the code under test.
- **Integration tests** use `DB_DRIVER=sqlite` for real ORM operations without requiring PostgreSQL.
- **Route tests** mock services to verify HTTP handler behavior.
- Place test files in the `tests/` directory with a `.test.ts` extension.

## Pull Request Guidelines

1. **Keep PRs focused.** One feature or fix per PR. Split large changes into reviewable pieces.
2. **Write tests.** New features need tests. Bug fixes need a regression test.
3. **Update documentation.** If your change affects user-facing behavior, update the relevant docs.
4. **Add a changeset** for user-facing changes.
5. **Describe your changes** in the PR body. Explain the problem, the approach, and any trade-offs.

## Code Style

- TypeScript strict mode is enabled.
- Use `EntitySchema` (not decorators) for MikroORM entity definitions.
- Prefer raw SQL via Knex for performance-critical paths (analytics, tracing).
- Keep gateway overhead under 20ms — avoid synchronous work in the request hot path.

## Architecture Notes

Before making changes, review the [Architecture](/developers/architecture) guide to understand the system design. A few things to keep in mind:

- **Two persistence patterns coexist.** Check whether a service uses MikroORM or raw SQL before modifying it.
- **Three auth domains.** Gateway, Portal, and Admin each have separate middleware and secrets.
- **Encryption is per-tenant.** All data at rest is encrypted with tenant-derived keys.

## Getting Help

- Open an issue on GitHub for bugs or feature requests.
- Start a discussion for questions about architecture or design decisions.
- Check existing issues and PRs before starting work to avoid duplication.
