// 内存存储。表结构对应 Spec 第 12 章数据模型。
// 生产实现替换为真实数据库时，只需保持这里的读写语义。

import type {
  AuditLog,
  BillingPeriod,
  CatalogModel,
  CorpOrder,
  CorpOrderGrantDetail,
  LifecycleEvent,
  ModelGroupFollow,
  Product,
  QuotaGrant,
  QuotaLedgerEntry,
  SeatAssignment,
  SeatGrant,
  TeamAllocation,
  Tenant,
  TenantModelGrant,
  TrialPlan,
} from '../domain/types.ts';

export class Table<T extends { id: string }> {
  private rows = new Map<string, T>();

  insert(row: T): T {
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): T | undefined {
    return this.rows.get(id);
  }

  update(id: string, patch: Partial<T>): T | undefined {
    const row = this.rows.get(id);
    if (!row) return undefined;
    const next = { ...row, ...patch };
    this.rows.set(id, next);
    return next;
  }

  delete(id: string): boolean {
    return this.rows.delete(id);
  }

  all(): T[] {
    return [...this.rows.values()];
  }

  find(predicate: (row: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  first(predicate: (row: T) => boolean): T | undefined {
    return this.all().find(predicate);
  }

  count(predicate?: (row: T) => boolean): number {
    return predicate ? this.find(predicate).length : this.rows.size;
  }

  deleteWhere(predicate: (row: T) => boolean): number {
    let n = 0;
    for (const row of this.all()) {
      if (predicate(row)) {
        this.rows.delete(row.id);
        n += 1;
      }
    }
    return n;
  }
}

/** 模型目录以 code 为主键，单独一张表 */
export class CatalogTable {
  private rows = new Map<string, CatalogModel>();

  insert(row: CatalogModel): CatalogModel {
    this.rows.set(row.code, row);
    return row;
  }

  get(code: string): CatalogModel | undefined {
    return this.rows.get(code);
  }

  update(code: string, patch: Partial<CatalogModel>): CatalogModel | undefined {
    const row = this.rows.get(code);
    if (!row) return undefined;
    const next = { ...row, ...patch };
    this.rows.set(code, next);
    return next;
  }

  all(): CatalogModel[] {
    return [...this.rows.values()];
  }

  find(predicate: (row: CatalogModel) => boolean): CatalogModel[] {
    return this.all().filter(predicate);
  }
}

export class Store {
  tenants = new Table<Tenant>();
  seatGrants = new Table<SeatGrant>();
  seatAssignments = new Table<SeatAssignment>();
  quotaGrants = new Table<QuotaGrant>();
  quotaLedger = new Table<QuotaLedgerEntry>();
  billingPeriods = new Table<BillingPeriod>();
  teamAllocations = new Table<TeamAllocation>();
  catalog = new CatalogTable();
  modelGrants = new Table<TenantModelGrant>();
  modelGroupFollows = new Table<ModelGroupFollow>();
  trialPlans = new Table<TrialPlan>();
  lifecycleEvents = new Table<LifecycleEvent>();
  auditLogs = new Table<AuditLog>();
  corpOrders = new Table<CorpOrder>();
  corpOrderGrantDetails = new Table<CorpOrderGrantDetail>();
  /** 商品目录（PRD-席位与额度包商品化），历史留痕数据，不随 purgeTenantBusinessData 清除 */
  products = new Table<Product>();

  /** 幂等键 → 已产生的结果标识（Spec 14.1） */
  idempotency = new Map<string, { at: string; resultId: string }>();

  /** 清除某租户的业务数据，保留凭证类数据（Spec 6.4 第 4 条） */
  purgeTenantBusinessData(tenantId: string): void {
    this.seatAssignments.deleteWhere((r) => r.tenantId === tenantId);
    this.teamAllocations.deleteWhere((r) => r.tenantId === tenantId);
    this.modelGrants.deleteWhere((r) => r.tenantId === tenantId);
    this.modelGroupFollows.deleteWhere((r) => r.tenantId === tenantId);
    // 保留：tenant 主记录、seatGrants、quotaGrants、quotaLedger、
    //       billingPeriods、lifecycleEvents、auditLogs
  }
}
