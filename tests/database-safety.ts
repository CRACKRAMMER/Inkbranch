/** Refuse test runs that could reconcile or clear a real application's database. */
function databaseIdentity(value: string): string {
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) {
    throw new Error('Test databases require a PostgreSQL URL with a host and database name.')
  }
  // Credentials and query options do not identify a database. In particular,
  // changing the role must not bypass the protection of the same database.
  const host = url.hostname === 'localhost' || url.hostname === '[::1]' ? '127.0.0.1' : url.hostname
  return `${host}:${url.port || '5432'}/${decodeURIComponent(url.pathname.slice(1))}`
}

export function assertSeparateTestDatabase(testUrl: string, applicationUrl?: string): void {
  const test = databaseIdentity(testUrl)
  if (applicationUrl && test === databaseIdentity(applicationUrl)) {
    throw new Error('Refusing destructive tests: the test database is the same as DATABASE_URL. Configure a separate disposable database.')
  }
}
