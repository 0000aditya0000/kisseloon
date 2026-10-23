# PricePe Backend

Backend service for food & grocery price comparison across Zomato, Swiggy, Blinkit, Zepto, and Instamart.

## Tech Stack

- **Node.js** — runtime
- **Express** — HTTP API framework
- **TypeScript** — type-safe development
- **PostgreSQL** — primary datastore (`pg` connection pool)
- **Playwright** — Chromium scrapers for public platform pages (Zomato first)
- **Winston** — structured logging
- **Helmet / CORS / rate-limit / compression** — production-ready middleware baseline

## Folder Structure

```
price-pe-backend/
├── src/
│   ├── controllers/     # Request handlers (route → service orchestration)
│   ├── services/
│   │   ├── mcp/         # MCP client adapters (Zomato, Swiggy, etc.)
│   │   ├── scrapers/    # Platform scrapers / fetchers when MCP is unavailable
│   │   └── database/    # Data access & persistence layer
│   ├── models/          # Domain models / schemas
│   ├── routes/          # Express route definitions
│   ├── middleware/      # Auth, validation, error handling, etc.
│   ├── utils/           # Shared helpers
│   ├── config/          # Env & app configuration
│   ├── types/           # Shared TypeScript types
│   └── index.ts         # Application entry point
├── tests/               # Unit & integration tests
├── scripts/             # One-off / ops scripts
├── logs/                # Runtime log files (gitignored contents)
├── package.json
├── tsconfig.json
├── .env.example
└── README.md
```

## Setup

### 1. PostgreSQL (local)

**Option A — Docker (recommended)**

```bash
docker compose up -d
```

This starts PostgreSQL 16 with user/password `postgres` / `postgres` and database `pricepe` on host port **`55432`** (mapped to container `5432` so it does not conflict with a local Postgres on `5432`).

App connection settings in `.env`:

```env
DB_HOST=localhost
DB_PORT=55432
DB_NAME=pricepe
DB_USER=postgres
DB_PASSWORD=postgres
```

**Option B — Native install**

```bash
# macOS (Homebrew)
brew install postgresql@16
brew services start postgresql@16

# Ubuntu / Debian
sudo apt update && sudo apt install postgresql postgresql-contrib
sudo systemctl start postgresql

# Windows
# Install from https://www.postgresql.org/download/windows/
# Or: winget install PostgreSQL.PostgreSQL.16
```

Create the `pricepe` database and confirm you can connect:

```bash
psql -U postgres -c "CREATE DATABASE pricepe;"
psql -U postgres -d pricepe -c "SELECT version();"
```

> Schema, indexes, triggers, and platform seeds run automatically on server start via `setupDatabase()`. You can also run `npm run db:setup` alone.

### 2. App

```bash
# Install dependencies
npm install

# Copy environment template and edit DB_* as needed
cp .env.example .env

# Start development server (hot reload) — migrates schema on boot
npm run dev
```

> On Windows PowerShell you can use: `Copy-Item .env.example .env`

## Scripts

| Script           | Description                                           |
|------------------|-------------------------------------------------------|
| `npm run dev`    | Start with `ts-node-dev` (respawn on changes)         |
| `npm run build`  | Compile TypeScript to `dist/` and copy `schema.sql`   |
| `npm start`      | Run compiled server (`node dist/index.js`)            |
| `npm run db:setup` | Run schema migration + platform seed only           |
| `npm run lint`   | ESLint over `src/**/*.ts`                             |
| `npm run format` | Prettier format for TypeScript sources                |
| `npm test`       | Placeholder — tests coming soon                       |

## Architecture Overview

1. Client hits PricePe API routes (`/api/v1/...`).
2. Routes call platform scrapers (starting with Zomato via Playwright).
3. Scrapers load public pages, extract restaurant/menu fields, and return normalized JSON.
4. Failure modes (CAPTCHA/blocks) are logged with screenshots under `logs/screenshots/` and return HTTP 503 — the process does not crash.

## Playwright scrapers (Zomato)

### Setup

```bash
npm install
npx playwright install chromium
```

### Configure

```env
SCRAPPER_HEADLESS=true
SCRAPPER_DEFAULT_LOCATION=bangalore
SCRAPPER_REQUEST_DELAY=2000
SCRAPPER_MAX_RETRIES=3
```

On startup, `scraperManager.initialize()` launches Chromium. If launch/navigation fails, the HTTP API still starts and Zomato routes return `503` until the scraper is healthy.

### Zomato API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/v1/zomato/status` | `{ platform, connected }` |
| GET | `/api/v1/zomato/search?q=&location=` | Scrape delivery search results |
| GET | `/api/v1/zomato/menu?url=` | Scrape a restaurant menu by URL |

### Troubleshooting

- **`connected: false`** — run `npx playwright install chromium` and restart.
- **503 on search/menu** — Zomato may have blocked/CAPTCHA’d the session; check `logs/screenshots/`.
- **Empty `data: []`** — selectors may need updating (see TODOs in `zomatoScraper.ts`); try `SCRAPPER_HEADLESS=false` to watch the browser.
- **Rate limits** — increase `SCRAPPER_REQUEST_DELAY` (ms between actions).

## Database

On startup the server:

1. Tests the PostgreSQL connection (`src/config/database.ts`)
2. Applies `src/models/schema.sql` (idempotent)
3. Seeds platforms: Zomato, Swiggy, Blinkit, Zepto, Instamart

Tables: `platforms`, `categories`, `products`, `platform_products`, `prices`, `search_cache`.

If PostgreSQL is unreachable, the process logs a clear error and exits without hanging.

## Environment Variables

See [`.env.example`](./.env.example) for the full list. Key groups:

- **Server** — `PORT`, `NODE_ENV`
- **Database** — `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (plus optional `DATABASE_URL`, `REDIS_URL`)
- **Scrapers** — `SCRAPPER_HEADLESS`, `SCRAPPER_DEFAULT_LOCATION`, `SCRAPPER_REQUEST_DELAY`, `SCRAPPER_MAX_RETRIES`
- **Logging** — `LOG_LEVEL`

## License

ISC
