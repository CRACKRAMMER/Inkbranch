---
title: Transit Lake
slug: transit-lake
description: Ten years of European rail departure data landed in Parquet, and what it takes to make that queryable by one person on a laptop.
date: 2026-07-02
started: 2025-09-14
updated: 2026-07-28
tags: [Data, Python, Parquet, Postgres]
category: Data
projectStatus: maintained
stack: [Python, DuckDB, Parquet, Postgres]
website: https://example.com/transit-lake
featured: true
---

Roughly 400 million departure records — scheduled time, actual time, platform,
delay, cancellation — pulled from open railway APIs over ten years. Small by
industry standards. Far too large to load into a CSV and open.

## Parquet, partitioned by month

```
data/departures/year=2024/month=03/part-0007.parquet
```

Columnar storage plus partition pruning means a query for one month of one year
reads one file instead of four hundred. The difference is not a constant factor:

```python
import duckdb

duckdb.sql("""
    SELECT station, avg(delay_seconds) AS mean_delay
    FROM 'data/departures/year=2024/month=*/part-*.parquet'
    WHERE delay_seconds IS NOT NULL
    GROUP BY station
    ORDER BY mean_delay DESC
    LIMIT 20
""")
```

DuckDB reads the Parquet directly — no load step, no server, no schema
declaration. On this dataset the full-ten-year aggregate takes about nine
seconds on a laptop, which is the entire reason the project exists in this
shape.

## The problems that are actually hard

**Nothing is a clean join key.** A station is a name string that changed
spelling in 2019, a code that was reused, and an ID that only exists after 2021.
Roughly 4% of departures are not resolvable to a station entity, and the honest
handling is to keep them in an `unresolved` partition and report the rate rather
than silently dropping them.

`delay_seconds` is not a single fact either — it is three different definitions
in the source data, and mixing them produces a chart that looks plausible and is
wrong.

**Cancellations.** A cancelled train has no arrival time. Treating that as a null
delay excludes cancellations from the average and makes every operator look
better than it is. They are counted separately and reported next to the delay
figure, never folded into it.

## Where it goes

The Parquet is the archive. Postgres holds the aggregates the site reads, so the
public pages never touch the lake — a page render should not depend on a
nine-second scan.
