---
title: EXPLAIN (ANALYZE, BUFFERS) or it did not happen
date: 2026-08-14
updated: 2026-09-07
tags: [Postgres, Data, Performance]
category: Data
---

`EXPLAIN` alone shows the plan the planner *would* use, based on estimates.
The estimates are frequently wrong, and the plan they justify can be absurd.
`ANALYZE` executes the query and reports the real row counts, which is the part
that tells you whether the planner was fooled.

```sql
EXPLAIN (ANALYZE, BUFFERS)
SELECT id, title FROM content_index
WHERE status = 'published' AND type = 'post'
ORDER BY published_at DESC LIMIT 20;
```

## Reading it

The thing to look for is a **large gap between estimated and actual rows**. A
scan estimated at 10 rows and actual 400,000 means the planner chose a nested
loop for a job that needed a hash join, and it will do so every time until the
statistics improve.

```sql
ANALYZE content_index;
```

Autovacuum runs `ANALYZE` on its own schedule, and the schedule is based on how
much a table has *changed*. A table that is written to once a day but read
constantly can sit on stale statistics for a long time.

## BUFFERS

`BUFFERS` reports shared hits versus reads. **Hits are memory; reads are disk.**
A query with 2 buffers read and 400,000 hit is doing fine and does not need an
index — it needs a smaller `LIMIT`. A query with 90,000 reads is the one worth
optimising, and no amount of staring at the plan without `BUFFERS` would have
distinguished them.

## The trap

`ANALYZE` executes. On an `UPDATE` or `DELETE` it will really delete the rows.
Wrap it:

```sql
BEGIN;
EXPLAIN (ANALYZE, BUFFERS) DELETE FROM sessions WHERE expires_at < now();
ROLLBACK;
```

The large-table version of this problem shows up in [[transit-lake]], where the
query that needed the index was not the one that looked expensive.
