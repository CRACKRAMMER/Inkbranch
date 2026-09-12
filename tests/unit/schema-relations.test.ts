import {
  One,
  Table,
  createTableRelationsHelpers,
  extractTablesRelationalConfig,
  is,
  type Relation,
} from 'drizzle-orm'
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'

import * as schema from '@/lib/db/schema'

/**
 * The declared relationships, checked against the declared foreign keys.
 *
 * Every query in `src/` is an explicit `select` with its own joins, so nothing
 * in the product reads the `relations()` blocks in `@/lib/db/schema` — they are
 * read by drizzle's tooling, `pnpm db:studio` among it. A declaration with no
 * caller in the product is a declaration no caller can catch being wrong, and
 * four foreign keys had already gone undeclared: `content_links.asset_id`,
 * `assets.uploaded_by`, and both analytics tables' `content_id`. Nothing
 * anywhere noticed, because nothing reads these.
 *
 * So the schema is checked against itself. Both halves are already written
 * down — the foreign keys by `.references()`, the relationships by `relations()`
 * — and this asserts they say the same thing:
 *
 *   - every foreign key has a `one()` relation on the table that holds it,
 *     naming the same columns in the same order, and
 *   - every `one()` relation is backed by a foreign key, so a relation cannot
 *     invent a relationship the database does not enforce.
 *
 * `many()` relations are the other direction and are optional — drizzle infers
 * their fields from the `one()` on the far table — so they are not required to
 * exist. When one does exist, the foreign key it claims has to be there.
 *
 * The state is read through drizzle's own `extractTablesRelationalConfig`,
 * which is what builds the relational query API's view of this file. That call
 * also throws when a relation names a table the schema does not export, so a
 * typo'd reference fails here rather than in whoever reads these next.
 */

/** The database name of a table, whether or not it is the object we imported. */
function tableName(table: PgTable): string {
  return getTableConfig(table).name
}

/** `local.column -> foreign.column`, one entry per column of the key. */
function foreignKeysOf(table: PgTable): string[] {
  return getTableConfig(table)
    .foreignKeys.flatMap((key) => {
      const { columns, foreignColumns, foreignTable } = key.reference()
      const foreign = tableName(foreignTable)
      return columns.map((column, index) => {
        const target = foreignColumns[index]
        return `${column.name} -> ${foreign}.${target?.name ?? '?'}`
      })
    })
    .sort()
}

/** The same spelling, for the `one()` relations a table declares. */
function oneRelationsOf(relations: Record<string, Relation>): string[] {
  return Object.values(relations)
    .filter((relation): relation is One => is(relation, One))
    .flatMap((relation) =>
      (relation.config?.fields ?? []).map((field, index) => {
        const target = relation.config?.references[index]
        return `${field.name} -> ${target ? tableName(target.table) : '?'}.${target?.name ?? '?'}`
      }),
    )
    .sort()
}

const { tables } = extractTablesRelationalConfig(schema, createTableRelationsHelpers)

/**
 * Every table the schema exports, by the name TypeScript knows it by.
 *
 * The cast is the narrowing `is` cannot do here: the module also exports enums
 * and the `Relations` objects themselves, and `Table` is the base class rather
 * than `PgTable`. The `is` check is what decides, and the assertion only says
 * which of the two overlapping types this side of it is.
 */
const exported: { tsName: string; table: PgTable }[] = []
for (const [tsName, value] of Object.entries(schema)) {
  if (is(value, Table)) exported.push({ tsName, table: value as PgTable })
}

describe('the relational model in @/lib/db/schema', () => {
  it('declares a relation for every foreign key, and no relation without one', () => {
    const disagreed = exported
      .map(({ tsName, table }) => ({
        table: tsName,
        foreignKeys: foreignKeysOf(table),
        relations: oneRelationsOf(tables[tsName]?.relations ?? {}),
      }))
      .filter((entry) => entry.relations.join('\n') !== entry.foreignKeys.join('\n'))

    // Reported as the tables that disagree, with both lists attached, because
    // the fix is always "add or remove one line on this table".
    expect(disagreed).toEqual([])
  })

  it('backs every many() with a foreign key pointing back', () => {
    const unbacked: string[] = []

    for (const { tsName, table } of exported) {
      const own = tableName(table)

      for (const [field, relation] of Object.entries(tables[tsName]?.relations ?? {})) {
        if (is(relation, One)) continue

        const back = foreignKeysOf(relation.referencedTable).some((key) =>
          key.includes(` -> ${own}.`),
        )
        if (!back) unbacked.push(`${tsName}.${field}`)
      }
    }

    // A `many()` with nothing pointing back is a relationship the database does
    // not have: drizzle would happily join through it and return nothing.
    expect(unbacked).toEqual([])
  })

  it('reads every exported table, so the checks above cover the whole schema', () => {
    // The two lists are built from the same file, so a table in one and not the
    // other would mean the first test was checking a subset without saying so.
    expect(exported.map((entry) => entry.tsName).sort()).toEqual(
      Object.keys(tables).sort(),
    )
  })
})
