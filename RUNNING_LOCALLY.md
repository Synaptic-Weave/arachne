# Running Arachne Locally

Two ways to run Arachne locally: **Docker Compose** (recommended — everything included) or **Node.js** (for active development).

## Option 1: Docker Compose (Recommended)

### Prerequisites

- Docker Desktop (or Docker Engine + Compose plugin)

### Quick Start

1. **Clone and navigate to the repo:**
   ```bash
   cd /path/to/loom
   ```

2. **Start all services:**
   ```bash
   docker compose up -d --build
   ```

3. **Pull Ollama models** (required on first start):
   ```bash
   docker compose exec ollama ollama pull llama3.2
   docker compose exec ollama ollama pull nomic-embed-text
   ```

4. **Run migrations:**
   ```bash
   docker compose exec gateway npm run migrate:up
   ```

5. **Open the portal:**
   - Visit `http://localhost:5174` in your browser
   - Create an account or log in

### Services

| Service | URL | Notes |
|---------|-----|-------|
| **PostgreSQL** | `localhost:5432` | Database: `loom`, user: `loom`; uses `pgvector/pgvector:pg16` (includes pgvector extension for embeddings) |
| **Ollama** | `localhost:11434` | Local LLM; pull models after first start |
| **Gateway** | `http://localhost:3000` | Arachne API (OpenAI-compatible) |
| **Portal** | `http://localhost:5174` | Web UI (proxies `/v1` to gateway) |

### Configuring Ollama as Your Provider

After logging into the portal:

1. Navigate to **Settings** → **Providers**
2. Add a new provider with:
   - **Provider:** `ollama`
   - **Base URL:** `http://ollama:11434` (use the Docker service name, not `localhost`)
   - **API Key:** `ollama` (any non-empty value)
   - **Model:** `llama3.2` (or any model you've pulled)

### Stopping Services

```bash
docker compose down
```

To remove volumes (clean slate):
```bash
docker compose down -v
```

### Production Notes

The `docker-compose.yml` uses placeholder secrets for development. For production:

- **ENCRYPTION_MASTER_KEY:** Generate with:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- **ADMIN_JWT_SECRET** and **PORTAL_JWT_SECRET:** Use strong random strings (min 32 chars)
- **SYSTEM_EMBEDDER_PROVIDER & MODEL:** Use real credentials if using OpenAI instead of Ollama

---

## Option 2: Node.js Development

For active development on the gateway or portal, run Node.js in development mode with only PostgreSQL in Docker.

### Prerequisites

- Node.js >= 25.2.1
- Docker (for PostgreSQL only)

### Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Start PostgreSQL only:**
   ```bash
   docker compose up -d postgres
   ```

3. **Set up environment:**
   ```bash
   cp .env.example .env
   # Edit .env if needed (default values work for local dev)
   ```

4. **Run migrations:**
   ```bash
   npm run migrate:up
   ```

5. **Start development server:**
   ```bash
   npm run dev
   ```

The server will start on `http://localhost:3000`.

### Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build TypeScript to JavaScript
- `npm run start` - Start production server
- `npm run migrate:up` - Run pending migrations
- `npm run migrate:down` - Rollback last migration
- `npm run migrate:create <name>` - Create new migration
- `npm test` - Run tests
- `npm run test:watch` - Run tests in watch mode
- `npm run test:coverage` - Run tests with coverage

### Development Notes

- The project uses TypeScript with strict mode enabled
- The database uses PostgreSQL with native partitioning for the traces table
- Framework: Fastify (HTTP server)
- HTTP Client: undici (upstream provider requests)
- Migrations: node-pg-migrate

---

## System Embedder (for RAG Features)

The gateway automatically creates a `system-embedder` agent for each tenant on startup. Configure it via environment variables:

### Local Development with Ollama

```bash
SYSTEM_EMBEDDER_PROVIDER=ollama
SYSTEM_EMBEDDER_MODEL=nomic-embed-text
SYSTEM_EMBEDDER_API_KEY=ollama
```

When running with Docker Compose, Ollama is already available at the correct endpoint.

### Production with OpenAI

```bash
SYSTEM_EMBEDDER_PROVIDER=openai
SYSTEM_EMBEDDER_MODEL=text-embedding-3-small
SYSTEM_EMBEDDER_API_KEY=sk-...
```

Replace `sk-...` with a valid OpenAI API key.
