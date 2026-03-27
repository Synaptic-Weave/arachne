/**
 * Analytics facade: thin re-exports that delegate to AnalyticsRepository.
 *
 * Callers (DashboardService, portal routes, admin routes) continue to import
 * standalone functions. Internally, each call creates a short-lived
 * AnalyticsRepository instance backed by the ORM's shared EntityManager.
 *
 * The previous implementation imported from src/db.js (the raw SQL shim).
 * That module is now removed; all raw SQL lives inside AnalyticsRepository.
 */
import { orm } from './orm.js';
import { AnalyticsRepository } from './domain/repositories/AnalyticsRepository.js';

// Re-export types so existing imports keep working
export type {
  RagMetrics,
  AnalyticsSummary,
  TimeseriesBucket,
  ModelBreakdown,
} from './domain/repositories/AnalyticsRepository.js';

function repo(): AnalyticsRepository {
  return new AnalyticsRepository(orm.em);
}

// ── Tenant-scoped ────────────────────────────────────────────────────────────

export async function getAnalyticsSummary(
  tenantId: string,
  windowHours = 24,
  rollup = false,
) {
  return repo().getSummary(tenantId, windowHours, rollup);
}

export async function getTimeseriesMetrics(
  tenantId: string,
  windowHours = 24,
  bucketMinutes = 60,
  rollup = false,
) {
  return repo().getTimeseries(tenantId, windowHours, bucketMinutes, rollup);
}

export async function getModelBreakdown(
  tenantId: string,
  windowHours = 24,
  limit = 10,
  rollup = false,
) {
  return repo().getModelBreakdown(tenantId, windowHours, limit, rollup);
}

// ── Admin (cross-tenant) ─────────────────────────────────────────────────────

export async function getAdminAnalyticsSummary(
  tenantId?: string,
  windowHours = 24,
) {
  return repo().getAdminSummary(tenantId, windowHours);
}

export async function getAdminTimeseriesMetrics(
  tenantId?: string,
  windowHours = 24,
  bucketMinutes = 60,
) {
  return repo().getAdminTimeseries(tenantId, windowHours, bucketMinutes);
}

export async function getAdminModelBreakdown(
  tenantId?: string,
  windowHours = 24,
  limit = 10,
) {
  return repo().getAdminModelBreakdown(tenantId, windowHours, limit);
}
