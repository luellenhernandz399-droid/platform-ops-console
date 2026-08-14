// 导出。对应 Spec 11.4，权限点 platform.*.export。
// 统一返回 { filename, csv }，由前端触发下载，路由层保持纯 JSON。

import type { Actor } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { getTenant } from './context.ts';
import { requirePermission } from '../domain/rbac.ts';
import { fail } from '../domain/errors.ts';
import { creditToUsd } from '../domain/money.ts';
import type { SeatService } from './seat.ts';
import type { QuotaService } from './quota.ts';
import type { AuditService } from './audit.ts';
import type { QueryService, TenantListFilter } from './query.ts';
import type { CorpOrderService } from './corpOrder.ts';
import type { CorpGrantType } from '../domain/types.ts';

/** 单次导出上限（Spec 11.4） */
export const EXPORT_ROW_LIMIT = 100_000;

export interface ExportResult {
  filename: string;
  rowCount: number;
  csv: string;
}

export type ExportKind =
  | 'tenants'
  | 'seat-assignments'
  | 'quota-ledger'
  | 'audit-logs'
  | 'corp_order_records'
  | 'corp_grant_details'
  | 'corp_order_detail';

export class ExportService {
  private ctx: Ctx;
  private seats: SeatService;
  private quota: QuotaService;
  private audit: AuditService;
  private query: QueryService;
  private corpOrders: CorpOrderService;

  constructor(
    ctx: Ctx,
    seats: SeatService,
    quota: QuotaService,
    audit: AuditService,
    query: QueryService,
    corpOrders: CorpOrderService,
  ) {
    this.ctx = ctx;
    this.seats = seats;
    this.quota = quota;
    this.audit = audit;
    this.query = query;
    this.corpOrders = corpOrders;
  }

  run(
    actor: Actor,
    kind: ExportKind,
    options: { tenantId?: string; orderId?: string; filter?: TenantListFilter } = {},
  ): ExportResult {
    switch (kind) {
      case 'tenants':
        return this.tenants(actor, options.filter ?? {});
      case 'seat-assignments':
        return this.seatAssignments(actor, this.mustTenant(options.tenantId));
      case 'quota-ledger':
        return this.quotaLedger(actor, this.mustTenant(options.tenantId));
      case 'audit-logs':
        return this.auditLogs(actor, options.tenantId ?? null);
      case 'corp_order_records':
        return this.corpOrderRecords(actor, this.mustTenant(options.tenantId));
      case 'corp_grant_details':
        return this.corpGrantDetails(actor, this.mustTenant(options.tenantId));
      case 'corp_order_detail':
        return this.corpOrderDetail(actor, this.mustOrderId(options.orderId));
      default:
        fail('VALIDATION_ERROR', `不支持的导出类型 ${String(kind)}`, { kind });
    }
  }

  private mustTenant(tenantId: string | undefined): string {
    if (!tenantId) fail('VALIDATION_ERROR', '该导出需要指定租户', {});
    getTenant(this.ctx, tenantId);
    return tenantId;
  }

  private mustOrderId(orderId: string | undefined): string {
    if (!orderId) fail('VALIDATION_ERROR', '该导出需要指定订单', {});
    return orderId;
  }

  private tenants(actor: Actor, filter: TenantListFilter): ExportResult {
    requirePermission(actor, 'platform.tenant.view');
    const rows = this.query.list(actor, filter);
    return build('租户总览', ['租户编码', '租户名称', '状态', '客户等级', '席位已占用', '席位总数', '占用率', '可用额度(USD)', '本月消耗(credit)', '已授权模型数', '到期时间', '归属销售'],
      rows.map((r) => [
        r.code, r.name, r.status, r.level ?? '', r.seatOccupied, r.seatTotal,
        pct(r.occupancyRate), r.availableUsd, r.monthConsumeCredit,
        r.grantedModelCount, r.expireAt ?? '', r.ownerSalesId ?? '',
      ]));
  }

  private seatAssignments(actor: Actor, tenantId: string): ExportResult {
    requirePermission(actor, 'platform.seat.export');
    const rows = this.seats.assignments(tenantId, true);
    return build('席位占用明细', ['成员标识', '姓名', '邮箱', '所属团队', '是否管理员', '绑定时间', '最后活跃', '成员状态', '释放时间', '释放原因'],
      rows.map((a) => [
        a.memberId, a.memberName, a.memberEmail, a.teamId ?? '', a.isAdmin ? '是' : '否',
        a.boundAt, a.lastActiveAt ?? '', a.memberStatus, a.releasedAt ?? '', a.releaseReason ?? '',
      ]));
  }

  private quotaLedger(actor: Actor, tenantId: string): ExportResult {
    requirePermission(actor, 'platform.quota.export');
    const rows = this.quota.ledger(tenantId);
    return build('额度流水', ['发生时间', '账期', '方向', '业务类型', '账本', '金额(credit)', '金额(USD)', '变动后余额(credit)', '授予单', '团队', '模型', '操作人', '工单号', '备注'],
      rows.map((e) => [
        e.occurredAt, e.period, e.direction, e.bizType, e.book, e.amountCredit,
        creditToUsd(e.amountCredit), e.balanceAfterCredit, e.grantId ?? '',
        e.teamId ?? '', e.modelCode ?? '', e.operatorId, e.ticketNo ?? '', e.remark ?? '',
      ]));
  }

  private auditLogs(actor: Actor, tenantId: string | null): ExportResult {
    requirePermission(actor, 'platform.audit.export');
    const rows = this.audit.query(tenantId ? { tenantId } : {});
    return build('平台审计日志', ['时间', '操作人', '角色', '租户', '对象类型', '对象', '操作', '变更摘要', '来源', '状态', '理由'],
      rows.map((l) => [
        l.at, l.actorId, l.actorRole, l.tenantId ?? '', l.objectType, l.objectId ?? '',
        l.action, l.summary, l.source, l.status, l.reason ?? '',
      ]));
  }

  private corpOrderRecords(actor: Actor, tenantId: string): ExportResult {
    requirePermission(actor, 'platform.corp_order.export');
    const rows = this.corpOrders.listOrders(tenantId);
    return build('对公权益订单记录', ['订单号', '创建时间', '销售', '席位行数', '是否含额度包', '订单金额(元)', '发放credit', '生效状态'],
      rows.map((o) => [
        o.orderNo, o.createdAt, o.salesActorId, o.seatLines.length,
        o.quotaPackages.length > 0 ? '是' : '否', (o.totalAmountFen / 100).toFixed(2),
        o.totalCreditIssued, lifecycleLabel(o.lifecycleStatus),
      ]));
  }

  private corpGrantDetails(actor: Actor, tenantId: string): ExportResult {
    requirePermission(actor, 'platform.corp_order.export');
    const rows = this.corpOrders.grantDetails(tenantId);
    return build('对公权益额度下发明细', ['订单', '发放类型', '归属', '来源行', 'credit数量', '生效时间', '到期时间', '关联席位单', '关联额度单'],
      rows.map((d) => [
        d.orderId, grantTypeLabel(d.grantType), d.owner === 'individual' ? '个人' : '共享池',
        d.sourceLineLabel, d.creditAmount, d.effectiveAt, d.expireAt,
        d.linkedSeatGrantId ?? '', d.linkedQuotaGrantId ?? '',
      ]));
  }

  private corpOrderDetail(actor: Actor, orderId: string): ExportResult {
    requirePermission(actor, 'platform.corp_order.export');
    const order = this.corpOrders.orderDetail(orderId);
    const rows: (string | number)[][] = order.seatLines.map((l, i) => [
      `席位第${i + 1}行`, l.name, l.unitPriceFen, l.monthlyCredit,
      l.seatCount, l.effectiveAt, l.expireAt, `${l.poolPercent}%`,
      (l.lineAmountFen / 100).toFixed(2),
    ]);
    order.quotaPackages.forEach((p, i) => {
      rows.push([
        `额度包第${i + 1}行`, p.name, p.unitPriceFen, p.creditAmount,
        p.count, p.effectiveAt, p.expireAt, '', (p.lineAmountFen / 100).toFixed(2),
      ]);
    });
    return build(
      `对公权益订单-${order.orderNo}`,
      ['行类型', '名称', '单价(分)', '月额度/credit数量', '席位数/个数', '生效时间', '到期时间', '池化系数', '行金额(元)'],
      rows,
    );
  }
}

function grantTypeLabel(type: CorpGrantType): string {
  switch (type) {
    case 'seat_bonus':
      return '席位附带额度';
    case 'seat_gift':
      return '赠送池化额度';
    case 'quota_package':
      return '额度包';
  }
}

function lifecycleLabel(status: 'not_started' | 'active' | 'expiring_soon' | 'expired'): string {
  switch (status) {
    case 'not_started':
      return '未开始';
    case 'active':
      return '生效中';
    case 'expiring_soon':
      return '即将到期';
    case 'expired':
      return '已过期';
  }
}

function pct(v: number): string {
  return `${Math.round(v * 1000) / 10}%`;
}

function build(name: string, header: string[], rows: (string | number)[][]): ExportResult {
  if (rows.length > EXPORT_ROW_LIMIT) {
    fail('VALIDATION_ERROR', `单次导出上限 ${EXPORT_ROW_LIMIT} 行，请缩小筛选范围`, {
      rowCount: rows.length,
      limit: EXPORT_ROW_LIMIT,
    });
  }
  const lines = [header, ...rows].map((r) => r.map(cell).join(','));
  // BOM 让 Excel 正确识别 UTF-8
  return {
    filename: `${name}-${new Date().toISOString().slice(0, 10)}.csv`,
    rowCount: rows.length,
    csv: `﻿${lines.join('\r\n')}`,
  };
}

function cell(value: string | number): string {
  const s = String(value ?? '');
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
