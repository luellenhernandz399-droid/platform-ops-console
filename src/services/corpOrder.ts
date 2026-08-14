// 对公权益支付下发。对应 PRD-对公支付权益下单。
//
// 核心耦合：席位与额度的实际发放全部走既有 SeatService.grant() / QuotaService.grant() / .gift()，
// 不重新实现发放逻辑——下单产生的授予单和手工发放的授予单进入同一张表、同一套查询、同一套到期任务。
// 个人席位附带额度（seat_bonus）在现有额度引擎里没有对应概念（QuotaGrant 无 owner 字段），
// 因此只落 CorpOrderGrantDetail 作为信息展示，不产生真实 QuotaGrant；
// 赠送池化（seat_gift）与额度包（quota_package）是共享池资源，会调用真实的 QuotaService.gift()/.grant()。
//
// 席位行与额度包行结构一致：均为自由填写名称 + 个数 + 单价 + credit 数量的可重复行，
// 不再挂任何固定档位目录。

import type {
  Actor,
  CorpGrantOwner,
  CorpGrantType,
  CorpOrder,
  CorpOrderGrantDetail,
  CorpOrderQuotaPackageLine,
  CorpOrderSeatLine,
  Tenant,
} from '../domain/types.ts';
import { SYSTEM_ACTOR } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { assertGrantable, getTenant, withIdempotency } from './context.ts';
import { fail } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { addCalendarMonths, addDays } from '../domain/time.ts';
import type { SeatService } from './seat.ts';
import type { QuotaService } from './quota.ts';
import type { ProductService } from './product.ts';

/** 席位行数上限（PRD 待定项 104） */
const MAX_SEAT_LINES = 20;
/** 额度包行数上限，与席位行逻辑一致 */
const MAX_PACKAGE_LINES = 20;
/** 单期赠送/附带额度的固定有效期天数（PRD 76-80） */
const PERIOD_EXPIRE_DAYS = 31;
/** 额度包默认有效期(月) */
const DEFAULT_PACKAGE_TERM_MONTHS = 6;

export interface CreateOrderSeatLineInput {
  productId: string;
  seatCount: number;
  effectiveAt: string;
  termMonths: number;
  /** 0-100，赠送共享池化系数，未传视为 0 */
  poolPercent?: number;
}

export interface CreateOrderQuotaPackageLineInput {
  productId: string;
  count: number;
  effectiveAt?: string;
  termMonths?: number;
}

export interface CreateOrderInput {
  voucherFileName: string;
  voucherMime: string;
  voucherDataBase64: string;
  seatLines: CreateOrderSeatLineInput[];
  quotaPackages?: CreateOrderQuotaPackageLineInput[];
  idempotencyKey?: string | null;
}

export type CorpOrderLifecycleStatus = 'not_started' | 'active' | 'expiring_soon' | 'expired';

export interface CorpOrderListRow extends CorpOrder {
  lifecycleStatus: CorpOrderLifecycleStatus;
}

export interface CorpOrderDetail extends CorpOrder {
  grantDetails: CorpOrderGrantDetail[];
  lifecycleStatus: CorpOrderLifecycleStatus;
}

interface ResolvedSeatLine {
  productId: string;
  productNote: string;
  unitPriceFen: number;
  monthlyCredit: number;
  seatCount: number;
  effectiveAt: string;
  termMonths: number;
  expireAt: string;
  poolPercent: number;
  lineAmountFen: number;
}

interface ResolvedQuotaPackageLine {
  productId: string;
  productNote: string;
  count: number;
  unitPriceFen: number;
  creditAmount: number;
  effectiveAt: string;
  termMonths: number;
  expireAt: string;
  lineAmountFen: number;
}

export class CorpOrderService {
  private ctx: Ctx;
  private seats: SeatService;
  private quota: QuotaService;
  private products: ProductService;

  constructor(ctx: Ctx, seats: SeatService, quota: QuotaService, products: ProductService) {
    this.ctx = ctx;
    this.seats = seats;
    this.quota = quota;
    this.products = products;
  }

  // ── 创建订单 ──────────────────────────────────────────────────────────

  /**
   * 创建对公权益订单。校验（入参结构与业务规则）全部在任何写操作之前完成；
   * 校验之后用调用方传入的 idempotencyKey 包裹「订单落库 + 全部发放」这一整个过程——
   * 与订单唯一对应的幂等键才能让前端安全重试提交，而不必依赖某个天然唯一字段去查重。
   */
  createOrder(actor: Actor, tenantId: string, input: CreateOrderInput): CorpOrder {
    requirePermission(actor, 'platform.corp_order.create');
    const tenant = getTenant(this.ctx, tenantId);
    assertGrantable(tenant);
    if (tenant.status !== 'active') {
      fail('TENANT_STATE_INVALID', '只有正式客户才能下单对公权益', {
        tenantId,
        status: tenant.status,
      });
    }

    if (!input.voucherFileName?.trim() || !input.voucherDataBase64?.trim()) {
      fail('VALIDATION_ERROR', '必须上传付款凭证', {});
    }

    const seatLinesInput = input.seatLines ?? [];
    if (seatLinesInput.length > MAX_SEAT_LINES) {
      fail('VALIDATION_ERROR', `席位行数不能超过 ${MAX_SEAT_LINES} 行`, {
        count: seatLinesInput.length,
        max: MAX_SEAT_LINES,
      });
    }
    const packageLinesInput = input.quotaPackages ?? [];
    if (packageLinesInput.length > MAX_PACKAGE_LINES) {
      fail('VALIDATION_ERROR', `额度包行数不能超过 ${MAX_PACKAGE_LINES} 行`, {
        count: packageLinesInput.length,
        max: MAX_PACKAGE_LINES,
      });
    }
    if (seatLinesInput.length === 0 && packageLinesInput.length === 0) {
      fail('VALIDATION_ERROR', '至少需要一行席位权益，或至少一行额度包', {});
    }

    const resolvedLines = seatLinesInput.map((line, index) =>
      this.resolveSeatLine(tenant, line, index),
    );
    const resolvedPackages = packageLinesInput.map((line, index) =>
      this.resolveQuotaPackageLine(tenant, line, index),
    );

    const fingerprint = `corp_order:${tenantId}:${JSON.stringify(resolvedLines)}:${JSON.stringify(resolvedPackages)}:${input.voucherFileName}`;
    return withIdempotency(
      this.ctx,
      input.idempotencyKey,
      fingerprint,
      () => this.produceOrder(actor, tenant, input, resolvedLines, resolvedPackages),
      (id) => this.ctx.store.corpOrders.get(id),
    );
  }

  private produceOrder(
    actor: Actor,
    tenant: Tenant,
    input: CreateOrderInput,
    resolvedLines: ResolvedSeatLine[],
    resolvedPackages: ResolvedQuotaPackageLine[],
  ): CorpOrder {
    const now = this.ctx.clock.now();
    const orderId = this.ctx.ids.next('co');
    const grantDetails: CorpOrderGrantDetail[] = [];
    const seatLines: CorpOrderSeatLine[] = [];

    resolvedLines.forEach((line, index) => {
      const lineLabel = `${line.productNote?.trim() || '席位商品'} 第 ${index + 1} 行`;
      const seatGrant = this.seats.grant(SYSTEM_ACTOR, tenant.id, {
        seatCount: line.seatCount,
        source: 'contract',
        effectiveAt: line.effectiveAt,
        expireAt: line.expireAt,
        remark: `对公权益下单 ${lineLabel}`,
      });

      for (let m = 0; m < line.termMonths; m++) {
        const periodStart = addCalendarMonths(new Date(line.effectiveAt), m, tenant.timezone);
        const periodExpire = addDays(periodStart, PERIOD_EXPIRE_DAYS);

        grantDetails.push(
          this.buildGrantDetail(orderId, tenant.id, {
            grantType: 'seat_bonus',
            owner: 'individual',
            sourceLineIndex: index,
            sourceLineLabel: lineLabel,
            creditAmount: line.monthlyCredit * line.seatCount,
            effectiveAt: periodStart.toISOString(),
            expireAt: periodExpire.toISOString(),
            linkedSeatGrantId: seatGrant.id,
            linkedQuotaGrantId: null,
          }),
        );

        if (line.poolPercent > 0) {
          const giftAmount = Math.round(
            (line.monthlyCredit * line.seatCount * line.poolPercent) / 100,
          );
          if (giftAmount > 0) {
            const giftGrant = this.quota.gift(SYSTEM_ACTOR, tenant.id, {
              amountCredit: giftAmount,
              source: 'gift',
              effectiveAt: periodStart.toISOString(),
              expireAt: periodExpire.toISOString(),
              reason: `对公权益下单 ${lineLabel} 赠送池化`,
            });
            grantDetails.push(
              this.buildGrantDetail(orderId, tenant.id, {
                grantType: 'seat_gift',
                owner: 'shared_pool',
                sourceLineIndex: index,
                sourceLineLabel: lineLabel,
                creditAmount: giftAmount,
                effectiveAt: periodStart.toISOString(),
                expireAt: periodExpire.toISOString(),
                linkedSeatGrantId: seatGrant.id,
                linkedQuotaGrantId: giftGrant.id,
              }),
            );
          }
        }
      }

      seatLines.push({ ...line, seatGrantId: seatGrant.id });
    });

    const quotaPackages: CorpOrderQuotaPackageLine[] = [];
    resolvedPackages.forEach((line, index) => {
      const lineLabel = `${line.productNote?.trim() || '额度包商品'} 第 ${index + 1} 行`;
      const totalCredit = line.creditAmount * line.count;
      const pkgGrant = this.quota.grant(SYSTEM_ACTOR, tenant.id, {
        amountCredit: totalCredit,
        source: 'contract',
        effectiveAt: line.effectiveAt,
        expireAt: line.expireAt,
        reason: `对公权益下单 额度包 ${lineLabel}`,
      });
      grantDetails.push(
        this.buildGrantDetail(orderId, tenant.id, {
          grantType: 'quota_package',
          owner: 'shared_pool',
          sourceLineIndex: index,
          sourceLineLabel: lineLabel,
          creditAmount: totalCredit,
          effectiveAt: line.effectiveAt,
          expireAt: line.expireAt,
          linkedSeatGrantId: null,
          linkedQuotaGrantId: pkgGrant.id,
        }),
      );
      quotaPackages.push({ ...line, quotaGrantId: pkgGrant.id });
    });

    const totalAmountFen =
      seatLines.reduce((sum, l) => sum + l.lineAmountFen, 0) +
      quotaPackages.reduce((sum, p) => sum + p.lineAmountFen, 0);
    const totalCreditIssued = grantDetails.reduce((sum, d) => sum + d.creditAmount, 0);

    const order: CorpOrder = {
      id: orderId,
      orderNo: this.ctx.ids.corpOrderNo(),
      tenantId: tenant.id,
      salesActorId: actor.id,
      createdAt: now.toISOString(),
      voucherFileName: input.voucherFileName,
      voucherMime: input.voucherMime,
      voucherDataBase64: input.voucherDataBase64,
      voucherUploadedBy: actor.id,
      voucherUploadedAt: now.toISOString(),
      seatLines,
      quotaPackages,
      totalAmountFen,
      totalCreditIssued,
      grantDetailCount: grantDetails.length,
    };
    this.ctx.store.corpOrders.insert(order);
    for (const detail of grantDetails) {
      this.ctx.store.corpOrderGrantDetails.insert(detail);
    }
    for (const line of resolvedLines) {
      this.products.recordUsage(line.productId, now.toISOString());
    }
    for (const line of resolvedPackages) {
      this.products.recordUsage(line.productId, now.toISOString());
    }

    this.ctx.audit.record({
      actor,
      tenantId: tenant.id,
      objectType: 'corp_order',
      objectId: order.id,
      action: 'create',
      summary: `为 ${tenant.name} 创建对公权益订单 ${order.orderNo}，金额 ¥${(totalAmountFen / 100).toFixed(2)}，发放 ${grantDetails.length} 条明细`,
    });

    return order;
  }

  private buildGrantDetail(
    orderId: string,
    tenantId: string,
    fields: {
      grantType: CorpGrantType;
      owner: CorpGrantOwner;
      sourceLineIndex: number;
      sourceLineLabel: string;
      creditAmount: number;
      effectiveAt: string;
      expireAt: string;
      linkedSeatGrantId: string | null;
      linkedQuotaGrantId: string | null;
    },
  ): CorpOrderGrantDetail {
    return {
      id: this.ctx.ids.next('cgd'),
      orderId,
      tenantId,
      ...fields,
    };
  }

  private resolveSeatLine(
    tenant: Tenant,
    line: CreateOrderSeatLineInput,
    index: number,
  ): ResolvedSeatLine {
    if (!line.productId) {
      fail('VALIDATION_ERROR', `第 ${index + 1} 行未选择商品`, { index });
    }
    const product = this.products.mustActive(tenant.id, 'seat', line.productId);
    if (!Number.isInteger(line.seatCount) || line.seatCount <= 0) {
      fail('VALIDATION_ERROR', `第 ${index + 1} 行席位数量必须是正整数`, {
        index,
        seatCount: line.seatCount,
      });
    }
    if (!Number.isInteger(line.termMonths) || line.termMonths <= 0) {
      fail('VALIDATION_ERROR', `第 ${index + 1} 行有效期(月)必须是正整数`, {
        index,
        termMonths: line.termMonths,
      });
    }
    const poolPercent = line.poolPercent ?? 0;
    if (!Number.isFinite(poolPercent) || poolPercent < 0 || poolPercent > 100) {
      fail('VALIDATION_ERROR', `第 ${index + 1} 行赠送池化系数必须在 0~100 之间`, {
        index,
        poolPercent,
      });
    }
    if (!line.effectiveAt || Number.isNaN(new Date(line.effectiveAt).getTime())) {
      fail('VALIDATION_ERROR', `第 ${index + 1} 行生效日期无效`, {
        index,
        effectiveAt: line.effectiveAt,
      });
    }

    const expireAt = addCalendarMonths(
      new Date(line.effectiveAt),
      line.termMonths,
      tenant.timezone,
    ).toISOString();
    const lineAmountFen = product.unitPriceFen * line.seatCount * line.termMonths;

    return {
      productId: product.id,
      productNote: product.note,
      unitPriceFen: product.unitPriceFen,
      monthlyCredit: product.creditAmount,
      seatCount: line.seatCount,
      effectiveAt: line.effectiveAt,
      termMonths: line.termMonths,
      expireAt,
      poolPercent,
      lineAmountFen,
    };
  }

  private resolveQuotaPackageLine(
    tenant: Tenant,
    line: CreateOrderQuotaPackageLineInput,
    index: number,
  ): ResolvedQuotaPackageLine {
    if (!line.productId) {
      fail('VALIDATION_ERROR', `额度包第 ${index + 1} 行未选择商品`, { index });
    }
    const product = this.products.mustActive(tenant.id, 'package', line.productId);
    if (!Number.isInteger(line.count) || line.count <= 0) {
      fail('VALIDATION_ERROR', `额度包第 ${index + 1} 行个数必须是正整数`, {
        index,
        count: line.count,
      });
    }
    const effectiveAt = line.effectiveAt ?? this.ctx.clock.now().toISOString();
    if (Number.isNaN(new Date(effectiveAt).getTime())) {
      fail('VALIDATION_ERROR', `额度包第 ${index + 1} 行生效日期无效`, { index, effectiveAt });
    }
    const termMonths = line.termMonths ?? DEFAULT_PACKAGE_TERM_MONTHS;
    if (!Number.isInteger(termMonths) || termMonths <= 0) {
      fail('VALIDATION_ERROR', `额度包第 ${index + 1} 行有效期(月)必须是正整数`, {
        index,
        termMonths,
      });
    }
    const expireAt = addCalendarMonths(new Date(effectiveAt), termMonths, tenant.timezone).toISOString();
    const lineAmountFen = product.unitPriceFen * line.count;

    return {
      productId: product.id,
      productNote: product.note,
      count: line.count,
      unitPriceFen: product.unitPriceFen,
      creditAmount: product.creditAmount,
      effectiveAt,
      termMonths,
      expireAt,
      lineAmountFen,
    };
  }

  // ── 查询（历史订单 / 额度明细）───────────────────────────────────────

  listOrders(tenantId: string, filter: { q?: string } = {}): CorpOrderListRow[] {
    getTenant(this.ctx, tenantId);
    const now = this.ctx.clock.now();
    let orders = this.ctx.store.corpOrders.find((o) => o.tenantId === tenantId);
    const q = filter.q?.trim().toLowerCase();
    if (q) {
      orders = orders.filter((o) => o.orderNo.toLowerCase().includes(q));
    }
    return orders
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .map((o) => ({ ...o, lifecycleStatus: this.lifecycleStatusOf(o, now) }));
  }

  orderDetail(orderId: string): CorpOrderDetail {
    const order = this.mustOrder(orderId);
    const grantDetails = this.ctx.store.corpOrderGrantDetails
      .find((d) => d.orderId === orderId)
      .sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : 1));
    return {
      ...order,
      grantDetails,
      lifecycleStatus: this.lifecycleStatusOf(order, this.ctx.clock.now()),
    };
  }

  grantDetails(tenantId: string, filter: { q?: string } = {}): CorpOrderGrantDetail[] {
    getTenant(this.ctx, tenantId);
    let rows = this.ctx.store.corpOrderGrantDetails.find((d) => d.tenantId === tenantId);
    const q = filter.q?.trim().toLowerCase();
    if (q) {
      rows = rows.filter(
        (d) => d.sourceLineLabel.toLowerCase().includes(q) || d.grantType.toLowerCase().includes(q),
      );
    }
    return rows.sort((a, b) => (a.effectiveAt < b.effectiveAt ? -1 : 1));
  }

  private lifecycleStatusOf(order: CorpOrder, now: Date): CorpOrderLifecycleStatus {
    const starts = order.seatLines
      .map((l) => l.effectiveAt)
      .concat(order.quotaPackages.map((p) => p.effectiveAt));
    const ends = order.seatLines
      .map((l) => l.expireAt)
      .concat(order.quotaPackages.map((p) => p.expireAt));
    if (starts.length === 0) return 'expired';

    const effectiveAt = starts.reduce((min, s) => (s < min ? s : min));
    const expireAt = ends.reduce((max, e) => (e > max ? e : max));
    const nowTime = now.getTime();
    if (nowTime < new Date(effectiveAt).getTime()) return 'not_started';
    if (nowTime > new Date(expireAt).getTime()) return 'expired';
    const soon = addDays(now, 30);
    if (new Date(expireAt).getTime() <= soon.getTime()) return 'expiring_soon';
    return 'active';
  }

  private mustOrder(orderId: string): CorpOrder {
    const order = this.ctx.store.corpOrders.get(orderId);
    if (!order) {
      fail('CORP_ORDER_NOT_FOUND', `订单 ${orderId} 不存在`, { orderId });
    }
    return order;
  }
}
