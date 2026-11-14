# Inkbranch (墨枝) v2 — Go Edition

Personal Knowledge System & Modern Publishing Platform powered by **Go** (single static binary + hybrid SEO shell + PostgreSQL 17) and **React 19** (`go:embed`), with Markdown files in `./content` as the single source of truth.

## Quick Commands

```bash
# Build embedded frontend
npm --prefix web install
npm --prefix web run build

# Run Go checks & start server
CGO_ENABLED=0 go test ./...
CGO_ENABLED=0 go run ./cmd/inkbranch serve
```
