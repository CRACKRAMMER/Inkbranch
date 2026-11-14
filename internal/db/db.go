package db

import (
	"context"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// NewPool creates a configured PostgreSQL 17 connection pool using pgx/v5.
func NewPool(ctx context.Context, databaseURL string, maxConns int32) (*pgxpool.Pool, error) {
	cfg, err := pgxpool.ParseConfig(databaseURL)
	if err != nil {
		return nil, fmt.Errorf("parse DATABASE_URL: %w", err)
	}
	if maxConns > 0 {
		cfg.MaxConns = maxConns
	}
	cfg.MaxConnLifetime = 30 * time.Minute
	cfg.MaxConnIdleTime = 5 * time.Minute
	cfg.HealthCheckPeriod = 30 * time.Second

	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		return nil, fmt.Errorf("create pgx pool: %w", err)
	}
	if err := pool.Ping(ctx); err != nil {
		pool.Close()
		return nil, fmt.Errorf("ping database: %w", err)
	}
	return pool, nil
}

// Ping measures round-trip database health latency in milliseconds.
func Ping(ctx context.Context, pool *pgxpool.Pool) (bool, int64, error) {
	if pool == nil {
		return false, 0, nil
	}
	start := time.Now()
	err := pool.Ping(ctx)
	ms := time.Since(start).Milliseconds()
	if ms == 0 && err == nil {
		ms = 1
	}
	return err == nil, ms, err
}
