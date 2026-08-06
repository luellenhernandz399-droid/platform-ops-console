// 查询与看板。对应 Spec 第 11 章，支撑父需求「租户席位/额度/模型查询」。

import type { Actor, Tenant, TenantLevel, TenantStatus } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { getTenant } from './context.ts';
import { requirePermission } from '../domain/rbac.ts';
import { creditToUsd } from '../domain/money.ts';
import { addDays, periodOf } from '../domain/time.ts';
import type { SeatService } from './seat.ts';
import type { QuotaService } from './quota.ts';
import type { ModelService } from './model.ts';
import { capabilitiesOf } from './tenant.ts';

export interface TenantListFilter {
  status?: TenantStatus[];
  level?: TenantLevel[];
  ownerSalesId?: string;
  industry?: string;
  tags?: string[];
  trialOnly?: boolean;
  keyword?: string;
  createdFrom?: string;
  createdTo?: string;
  expiringWithinDays?: number;
}

export type SortKey =
  | 'lastActiveAt'
  | 'availableCredit'
  | 'consumeRate'
  | 'occupancyRate'
  | 'expireAt';

export interface TenantListRow {
  tenantId: string;
  code: string;
  name: string;
  status: TenantStatus;
  suspendReason: string | null;
  level: TenantLevel | null;
  seatOccupied: number;
  seatTotal: number;
  occupancyRate: number;
  oversold: boolean;
  availableCredit: number;
  availableUsd: string;
  monthConsumeCredit: number;
  consumeRate: number;
  grantedModelCount: number;
  expireAt: string | null;
  ownerSalesId: string | null;
  lastActiveAt: string | null;
}

export type RiskView =
  | 'quota_alert'
  | 'seat_oversell'
  | 'expiring_soon'
  | 'inactive'
  | 'trial_expiring';

export interface Dashboard {
  tenantCount: { total: number; active: number; trialing: number; suspended: number };
  seats: { granted: number; occupied: number; occupancyRate: number };
  quota: { grantedCredit: number; consumedCredit: number; outstandingCredit: number };
  monthNewTenants: number;
  monthConverted: number;
  conversionRate: number;
  risks: Record<RiskView, TenantListRow[]>;
  modelUsage: { modelCode: string; tenantCount: number; consumedCredit: number }[];
}

/** 席位与额度口径只对存活态成立；注销后占用关系是恢复快照 */
const LIVE_STATUSES = new Set<TenantStatus>(['pending', 'trialing', 'active', 'suspended']);

export class QueryService {
  private ctx: Ctx;
  private seats: SeatService;
  private quota: QuotaService;
  private models: ModelService;

  constructor(ctx: Ctx, seats: SeatService, quota: QuotaService, models: ModelService) {
    this.ctx = ctx;
    this.seats = seats;
    this.quota = quota;
    this.models = models;
  }

  // ── 租户总览（Spec 11.1）────────────────────────────────────────────

  row(tenant: Tenant, at?: Date): TenantListRow {
    const now = at ?? this.ctx.clock.now();
    const overview = this.seats.overview(tenant.id, now);
    const balance = this.quota.balance(tenant.id, now);
    const period = periodOf(now, tenant.timezone);

    const monthConsume = this.quota
      .ledger(tenant.id, { period })
      .filter((e) => e.bizType === 'consume')
      .reduce((sum, e) => sum + e.amountCredit, 0);

    const granted = this.quota
      .activeGrants(tenant.id, now)
      .reduce((sum, g) => sum + g.amountCredit - g.revokedCredit, 0);

    const lastActive = this.seats
      .assignments(tenant.id)
      .map((a) => a.lastActiveAt)
      .filter((v): v is string => v !== null)
      .sort()
      .pop() ?? null;

    return {
      tenantId: tenant.id,
      code: tenant.code,
      name: tenant.name,
      status: tenant.status,
      suspendReason: tenant.suspendReason,
      level: tenant.level,
      seatOccupied: overview.occupied,
      seatTotal: overview.seatTotal,
      occupancyRate: overview.occupancyRate,
      oversold: overview.oversold,
      availableCredit: balance.availableCredit,
      availableUsd: creditToUsd(balance.availableCredit),
      monthConsumeCredit: monthConsume,
      consumeRate: granted === 0 ? 0 : monthConsume / granted,
      grantedModelCount: this.models.activeGrants(tenant.id).length,
      expireAt: tenant.trialExpireAt ?? tenant.contractEndAt,
      ownerSalesId: tenant.ownerSalesId,
      lastActiveAt: lastActive,
    };
  }

  list(
    actor: Actor,
    filter: TenantListFilter = {},
    sort: SortKey = 'lastActiveAt',
    at?: Date,
  ): TenantListRow[] {
    requirePermission(actor, 'platform.tenant.view');
    const now = at ?? this.ctx.clock.now();

    const rows = this.ctx.store.tenants
      .all()
      .filter((t) => {
        if (filter.status && !filter.status.includes(t.status)) return false;
        if (filter.level && (t.level === null || !filter.level.includes(t.level))) return false;
        if (filter.ownerSalesId && t.ownerSalesId !== filter.ownerSalesId) return false;
        if (filter.industry && t.industry !== filter.industry) return false;
        if (filter.tags && !filter.tags.every((tag) => t.tags.includes(tag))) return false;
        if (filter.trialOnly && t.status !== 'trialing') return false;
        if (filter.createdFrom && t.createdAt < filter.createdFrom) return false;
        if (filter.createdTo && t.createdAt > filter.createdTo) return false;
        if (filter.keyword) {
          const k = filter.keyword.toLowerCase();
          const hay = `${t.name} ${t.code} ${t.contactName}`.toLowerCase();
          if (!hay.includes(k)) return false;
        }
        if (filter.expiringWithinDays !== undefined) {
          const expire = t.trialExpireAt ?? t.contractEndAt;
          if (expire === null) return false;
          const limit = addDays(now, filter.expiringWithinDays);
          if (new Date(expire).getTime() > limit.getTime()) return false;
        }
        return true;
      })
      .map((t) => this.row(t, now));

    return this.sortRows(rows, sort);
  }

  private sortRows(rows: TenantListRow[], sort: SortKey): TenantListRow[] {
    const copy = [...rows];
    switch (sort) {
      case 'availableCredit':
        return copy.sort((a, b) => a.availableCredit - b.availableCredit);
      case 'consumeRate':
        return copy.sort((a, b) => b.consumeRate - a.consumeRate);
      case 'occupancyRate':
        return copy.sort((a, b) => b.occupancyRate - a.occupancyRate);
      case 'expireAt':
        return copy.sort((a, b) => {
          const av = a.expireAt ?? '9999';
          const bv = b.expireAt ?? '9999';
          return av < bv ? -1 : av > bv ? 1 : 0;
        });
      case 'lastActiveAt':
      default:
        // 默认按最后活跃时间倒序，从未活跃的排最后
        return copy.sort((a, b) => {
          const av = a.lastActiveAt ?? '';
          const bv = b.lastActiveAt ?? '';
          return av < bv ? 1 : av > bv ? -1 : 0;
        });
    }
  }

  // ── 风险视图（Spec 11.1）────────────────────────────────────────────

  riskView(actor: Actor, view: RiskView, at?: Date): TenantListRow[] {
    requirePermission(actor, 'platform.tenant.view');
    const now = at ?? this.ctx.clock.now();
    const rows = this.ctx.store.tenants
      .all()
      .filter((t) => t.status !== 'deregistered')
      .map((t) => ({ tenant: t, row: this.row(t, now) }));

    switch (view) {
      case 'quota_alert':
        return rows
          .filter(({ tenant, row }) => {
            const base = this.quota
              .activeGrants(tenant.id, now)
              .reduce((sum, g) => sum + g.amountCredit - g.revokedCredit, 0);
            if (base <= 0) return false;
            const threshold = tenant.quotaWarnThresholds.alert ?? 0.05;
            return row.availableCredit / base <= threshold;
          })
          .map((r) => r.row);

      case 'seat_oversell':
        // 注销中/已注销的占用行是恢复快照（Spec 6.4），不计入超卖
        return rows
          .filter(({ tenant, row }) => LIVE_STATUSES.has(tenant.status) && row.oversold)
          .map((r) => r.row);

      case 'expiring_soon': {
        const limit = addDays(now, 30);
        return rows
          .filter(({ row }) => {
            if (row.expireAt === null) return false;
            return new Date(row.expireAt).getTime() <= limit.getTime();
          })
          .map((r) => r.row);
      }

      case 'inactive': {
        const cutoff = addDays(now, -30);
        return rows
          .filter(({ row }) => {
            if (row.lastActiveAt === null) return true;
            return new Date(row.lastActiveAt).getTime() < cutoff.getTime();
          })
          .map((r) => r.row);
      }

      case 'trial_expiring': {
        const limit = addDays(now, 7);
        return rows
          .filter(({ tenant }) => {
            if (tenant.status !== 'trialing' || tenant.trialExpireAt === null) return false;
            return new Date(tenant.trialExpireAt).getTime() <= limit.getTime();
          })
          .map((r) => r.row);
      }
    }
  }

  // ── 单租户详情（Spec 11.2）──────────────────────────────────────────

  detail(actor: Actor, tenantId: string, at?: Date) {
    requirePermission(actor, 'platform.tenant.view');
    const tenant = getTenant(this.ctx, tenantId);
    const now = at ?? this.ctx.clock.now();

    return {
      tenant,
      capabilities: capabilitiesOf(tenant),
      summary: this.row(tenant, now),
      seat: {
        overview: this.seats.overview(tenantId, now),
        grants: this.seats.grants(tenantId),
        assignments: this.seats.assignments(tenantId),
      },
      quota: {
        balance: this.quota.balance(tenantId, now),
        grants: this.quota.grants(tenantId),
        ledger: this.quota.ledger(tenantId),
        totalAllocated: this.quota.totalAllocated(tenantId),
      },
      model: {
        grants: this.models.activeGrants(tenantId),
        followedGroups: this.models.followedGroups(tenantId),
        defaultModel: this.models.defaultModel(tenantId)?.modelCode ?? null,
        allowSelfHostedChannel: tenant.allowSelfHostedChannel,
      },
      lifecycle: this.ctx.store.lifecycleEvents
        .find((e) => e.tenantId === tenantId)
        .sort((a, b) => (a.at < b.at ? -1 : 1)),
    };
  }

  // ── 平台看板（Spec 11.3）────────────────────────────────────────────

  dashboard(actor: Actor, at?: Date): Dashboard {
    requirePermission(actor, 'platform.dashboard.view');
    const now = at ?? this.ctx.clock.now();
    const tenants = this.ctx.store.tenants.all();
    const rows = tenants.map((t) => this.row(t, now));

    let seatGranted = 0;
    let seatOccupied = 0;
    for (const row of rows) {
      seatGranted += row.seatTotal;
      seatOccupied += row.seatOccupied;
    }

    let grantedCredit = 0;
    let consumedCredit = 0;
    let outstanding = 0;
    for (const t of tenants) {
      for (const g of this.quota.grants(t.id)) {
        if (g.status === 'active' || g.status === 'expired') {
          grantedCredit += g.amountCredit;
          consumedCredit += g.consumedCredit;
        }
      }
      outstanding += this.quota.balance(t.id, now).availableCredit;
    }

    // 本月新增与转化
    const monthStart = periodOf(now, 'Asia/Shanghai');
    const monthNew = tenants.filter(
      (t) => periodOf(new Date(t.createdAt), 'Asia/Shanghai') === monthStart,
    ).length;
    const converted = this.ctx.store.lifecycleEvents.find(
      (e) =>
        e.fromStatus === 'trialing' &&
        e.toStatus === 'active' &&
        periodOf(new Date(e.at), 'Asia/Shanghai') === monthStart,
    ).length;
    const trialsStarted = this.ctx.store.lifecycleEvents.find(
      (e) =>
        e.toStatus === 'trialing' &&
        periodOf(new Date(e.at), 'Asia/Shanghai') === monthStart,
    ).length;

    // 模型消耗分布
    const usage = new Map<string, { tenants: Set<string>; credit: number }>();
    for (const entry of this.ctx.store.quotaLedger.all()) {
      if (entry.bizType !== 'consume' || entry.modelCode === null) continue;
      const bucket = usage.get(entry.modelCode) ?? { tenants: new Set<string>(), credit: 0 };
      bucket.tenants.add(entry.tenantId);
      bucket.credit += entry.amountCredit;
      usage.set(entry.modelCode, bucket);
    }

    return {
      tenantCount: {
        total: tenants.length,
        active: tenants.filter((t) => t.status === 'active').length,
        trialing: tenants.filter((t) => t.status === 'trialing').length,
        suspended: tenants.filter((t) => t.status === 'suspended').length,
      },
      seats: {
        granted: seatGranted,
        occupied: seatOccupied,
        occupancyRate: seatGranted === 0 ? 0 : seatOccupied / seatGranted,
      },
      quota: {
        grantedCredit,
        consumedCredit,
        outstandingCredit: outstanding,
      },
      monthNewTenants: monthNew,
      monthConverted: converted,
      conversionRate: trialsStarted === 0 ? 0 : converted / trialsStarted,
      risks: {
        quota_alert: this.riskView(actor, 'quota_alert', now).slice(0, 10),
        seat_oversell: this.riskView(actor, 'seat_oversell', now).slice(0, 10),
        expiring_soon: this.riskView(actor, 'expiring_soon', now).slice(0, 10),
        inactive: this.riskView(actor, 'inactive', now).slice(0, 10),
        trial_expiring: this.riskView(actor, 'trial_expiring', now).slice(0, 10),
      },
      modelUsage: [...usage.entries()]
        .map(([modelCode, v]) => ({
          modelCode,
          tenantCount: v.tenants.size,
          consumedCredit: v.credit,
        }))
        .sort((a, b) => b.consumedCredit - a.consumedCredit),
    };
  }
}
