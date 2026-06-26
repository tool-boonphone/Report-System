# Local dev on Mac (Apple Silicon M1/M2/M3)

Setup Report System on your Mac with Docker PostgreSQL and optional production dump restore.

## 1. Install prerequisites

Install [Homebrew](https://brew.sh) if needed, then:

```bash
brew install git node pnpm
brew install --cask docker
```

Open **Docker Desktop** once and wait until it says **Docker is running**.

Optional (only if you will restore `.dump` files yourself):

```bash
brew install libpq
echo 'export PATH="/opt/homebrew/opt/libpq/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

## 2. Clone project

```bash
mkdir -p ~/Projects
cd ~/Projects
git clone https://github.com/tool-boonphone/Report-System.git
cd Report-System
git checkout cursor/docker-local-db-1208
```

If `cursor/docker-local-db-1208` is already merged into `main`, use `main` instead.

## 3. Environment file

```bash
cp .env.docker.example .env
```

Edit `.env` and set at least:

- `JWT_SECRET` — any long random string for local use
- `VITE_APP_ID` — e.g. `your_app_id`

## 4. Database setup (choose one)

### Option A — Full data from production dump (recommended)

Place dump files in `dumps/` (not in git):

```text
dumps/boonphone_db_2026-06-25.dump   (~9 MB)
dumps/fastfone_db_2026-06-25.dump    (~47 MB)
```

Export from Render PostgreSQL shell, or copy from a machine that already has them.

Then:

```bash
pnpm install
pnpm db:local:setup
```

This runs `docker compose up -d` and `./scripts/restore-local-dbs.sh`.

### Option B — Empty schema + test seed (no dump files)

```bash
pnpm install
docker compose up -d
```

Add to `.env`:

```bash
ALLOW_NON_STAGING_DATABASE=true
```

Temporarily point staging URLs at local DB in `.env`:

```bash
BOONPHONE_DATABASE_URL=postgresql://report:report@127.0.0.1:5432/boonphone_db?sslmode=disable
FASTFONE_DATABASE_URL=postgresql://report:report@127.0.0.1:5432/fastfone_db?sslmode=disable
```

Then:

```bash
pnpm db:staging:setup
```

## 5. Run dev server

```bash
pnpm dev
```

Open: http://localhost:3000

Default login (from seed / restored DB):

- Username: `Sadmin`
- Password: `Aa123456+`

## 6. Daily commands

```bash
docker compose up -d    # start DB
pnpm dev                # start app
docker compose down     # stop DB (data kept in Docker volume)
```

## Troubleshooting (Mac M1)

| Problem | Fix |
|--------|-----|
| `docker: command not found` | Open Docker Desktop; add CLI to PATH in Docker settings |
| Port 5432 in use | Stop local Postgres: `brew services stop postgresql@16` or change port in `docker-compose.yml` |
| Port 3000 in use | `lsof -i :3000` then stop the other process, or set `PORT=3001` in `.env` |
| `permission denied` on docker.sock | Ensure Docker Desktop is running; retry after app restart |
| Restore fails | Use `pnpm db:local:restore` again; dumps must be custom format from `pg_dump -Fc` |

## Export dumps from Render (if you need fresh copies)

```bash
pg_dump "$BOONPHONE_DATABASE_URL" -Fc --no-owner --no-acl -f dumps/boonphone_db.dump
pg_dump "$FASTFONE_DATABASE_URL" -Fc --no-owner --no-acl -f dumps/fastfone_db.dump
```

Use PostgreSQL 18 client if Render reports a version mismatch.
