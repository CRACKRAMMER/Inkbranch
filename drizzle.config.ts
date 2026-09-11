import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL
if (!url) {
  throw new Error(
    'DATABASE_URL is not set. Copy .env.example to .env.local and fill it in.',
  )
}

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './src/lib/db/migrations',
  dialect: 'postgresql',
  dbCredentials: { url },
  casing: 'snake_case',
  verbose: true,
  strict: true,
})
