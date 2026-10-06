import { describe, expect, it } from 'vitest'

import { assertSeparateTestDatabase } from '../database-safety'

describe('test database isolation', () => {
  it.each([
    ['postgresql://app:a@localhost/blog', 'postgres://test:b@127.0.0.1:5432/blog?application_name=test'],
    ['postgres://app:a@[::1]/blog', 'postgresql://test:b@localhost/blog'],
    ['postgres://app:a@db/blog', 'postgresql://test:b@db/%62log'],
  ])('rejects the same database despite role, protocol, or loopback aliases', (app, test) => {
    expect(() => assertSeparateTestDatabase(test, app)).toThrow('same as DATABASE_URL')
  })

  it('allows a separate disposable database on the same server', () => {
    expect(() => assertSeparateTestDatabase('postgres://test:b@db/blog_test', 'postgres://app:a@db/blog')).not.toThrow()
  })

  it.each(['https://db/test', 'postgres://db', 'invalid'])('rejects a malformed test URL', (test) => {
    expect(() => assertSeparateTestDatabase(test)).toThrow()
  })
})
