// 额度分发与账本。对应 Spec 第 8 章。
//
// 沿用租户侧既有语义：1 credit = $0.01，购买额度不清零、赠送额度按月清零，两类分开记账。

import type {
  Actor,
  BillingPeriod,
  QuotaBook,
  QuotaGrant,
  QuotaGrantSource,
  QuotaLedgerEntry,
  TeamAllocation,
  Tenant,
} from '../domain/types.ts';
import { SYSTEM_ACTOR } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { assertGrantable, getTenant, withIdempotency } from './context.ts';
import { fail, requireReason } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { assertPositiveCredit, ceilCredit } from '../domain/money.ts';
import {
  endOfMonthFor,
  endOfPeriod,
  isExpired,
  periodOf,
  prevPeriod,
  startOfPeriod,
} from '../domain/time.ts';
import type { TenantService } from './tenant.ts';

/** degrade 策略下仍可调用的分组（Spec 8.4） */
export const BASIC_MODEL_GROUP = '基础模型集';

export interface Balance {
  purchasedCredit: number;
  giftCredit: number;
  availableCredit: number;
}

export interface GrantQuotaInput {
  amountCredit: number;
  source?: QuotaGrantSource;
  effectiveAt?: string;
  expireAt?: string | null;
  contractNo?: string | null;
  reason?: string | null;
  /** true 时落 pending（合同已签、款未到），确认到账后才计入余额 */
  pending?: boolean;
  idempotencyKey?: string | null;
}

export interface ConsumeInput {
  amountCredit: number;
  modelCode?: string | null;
  teamId?: string | null;
  occurredAt?: Date;
  remark?: string | null;
}

export interface ConsumeResult {
  consumedCredit: number;
  fromGift: number;
  fromPurchased: number;
  balanceAfter: Balance;
  entries: QuotaLedgerEntry[];
}

export interface ReconcileResult {
  period: string;
  ok: boolean;
  checks: {
    name: string;
    platform: number;
    ledger: number;
    diff: number;
    ok: boolean;
  }[];
}

export class QuotaService {
  private ctx: Ctx;
  private tenants: TenantService;

  constructor(ctx: Ctx, tenants: TenantService) {
    this.ctx = ctx;
    this.tenants = tenants;
  }

  // ── 余额（Spec 8.1）───────────────────────────────────────────────────

  private remainingOf(grant: QuotaGrant): number {
    return (
      grant.amountCredit -
      grant.consumedCredit -
      grant.revokedCredit -
      grant.expiredCredit
    );
  }

  activeGrants(tenantId: string, at?: Date): QuotaGrant[] {
    const now = at ?? this.ctx.clock.now();
    return this.ctx.store.quotaGrants.find(
      (g) =>
        g.tenantId === tenantId &&
        g.status === 'active' &&
        new Date(g.effectiveAt).getTime() <= now.getTime() &&
        !isExpired(g.expireAt, now),
    );
  }

  balance(tenantId: string, at?: Date): Balance {
    const grants = this.activeGrants(tenantId, at);
    let purchased = 0;
    let gift = 0;
    for (const g of grants) {
      const remaining = this.remainingOf(g);
      if (g.book === 'purchased') purchased += remaining;
      else gift += remaining;
    }
    // 透支部分记在租户上，使 overdraft 策略下的可用余额能真实为负
    const overdraft = this.ctx.store.tenants.get(tenantId)?.overdraftUsedCredit ?? 0;
    return {
      purchasedCredit: purchased,
      giftCredit: gift,
      availableCredit: purchased + gift - overdraft,
    };
  }

  /** 预警分母：累计发放且未被回收的总额 */
  private warnBase(tenantId: string, at?: Date): number {
    return this.activeGrants(tenantId, at).reduce(
      (sum, g) => sum + g.amountCredit - g.revokedCredit,
      0,
    );
  }

  // ── 发放（Spec 8.2）───────────────────────────────────────────────────

  grant(actor: Actor, tenantId: string, input: GrantQuotaInput): QuotaGrant {
    requirePermission(actor, 'platform.quota.grant');
    return this.createGrant(actor, tenantId, 'purchased', input);
  }

  gift(actor: Actor, tenantId: string, input: GrantQuotaInput): QuotaGrant {
    requirePermission(actor, 'platform.quota.gift');
    return this.createGrant(actor, tenantId, 'gift', input);
  }

  private createGrant(
    actor: Actor,
    tenantId: string,
    book: QuotaBook,
    input: GrantQuotaInput,
  ): QuotaGrant {
    const tenant = getTenant(this.ctx, tenantId);
    assertGrantable(tenant);

    // 试用期默认不允许充值（Spec 10.3）。赠送与试用来源不受此限。
    if (
      book === 'purchased' &&
      tenant.status === 'trialing' &&
      !tenant.allowRecharge &&
      input.source !== 'trial'
    ) {
      fail('RECHARGE_NOT_ALLOWED', '该试用套餐不支持充值，如需扩容请先转正式', {
        tenantId,
      });
    }

    const amount = assertPositiveCredit(input.amountCredit, '发放额度');
    const now = this.ctx.clock.now();
    const effectiveAt = input.effectiveAt ?? now.toISOString();

    // 赠送额度强制当月月末到期（Spec 8.1）
    const expireAt =
      book === 'gift'
        ? (input.expireAt ?? endOfMonthFor(new Date(effectiveAt), tenant.timezone).toISOString())
        : (input.expireAt ?? null);

    const fingerprint = `quota.${book}:${tenantId}:${amount}:${effectiveAt}:${expireAt}`;
    return withIdempotency(
      this.ctx,
      input.idempotencyKey,
      fingerprint,
      () => {
        const record: QuotaGrant = {
          id: this.ctx.ids.next('qg'),
          no: this.ctx.ids.quotaGrantNo(),
          tenantId,
          book,
          amountCredit: amount,
          source: input.source ?? (book === 'gift' ? 'gift' : 'contract'),
          effectiveAt,
          expireAt,
          status: input.pending ? 'pending' : 'active',
          contractNo: input.contractNo ?? null,
          reason: input.reason ?? null,
          operatorId: actor.id,
          consumedCredit: 0,
          revokedCredit: 0,
          expiredCredit: 0,
          createdAt: now.toISOString(),
        };
        this.ctx.store.quotaGrants.insert(record);

        if (record.status === 'active') {
          this.writeLedger(tenant, {
            direction: 'in',
            bizType: book === 'gift' ? 'gift' : 'grant',
            book,
            amountCredit: amount,
            grantId: record.id,
            operatorId: actor.id,
            occurredAt: now,
            remark: input.reason ?? null,
          });
          this.afterBalanceIncrease(tenant);
        }

        this.ctx.audit.record({
          actor,
          tenantId,
          objectType: 'quota_grant',
          objectId: record.id,
          action: book === 'gift' ? 'gift' : 'grant',
          summary: `向 ${tenant.name} 发放${book === 'gift' ? '赠送' : '购买'}额度 ${amount} credit（${record.no}）`,
          reason: input.reason ?? null,
        });
        return record;
      },
      (id) => this.ctx.store.quotaGrants.get(id),
    );
  }

  /**
   * 配置预警阈值、耗尽策略与透支上限（Spec 8.6 区块 4，权限点 platform.quota.config）。
   */
  setConfig(
    actor: Actor,
    tenantId: string,
    input: {
      quotaWarnThresholds?: Partial<Tenant['quotaWarnThresholds']>;
      exhaustPolicy?: Tenant['exhaustPolicy'];
      overdraftLimitCredit?: number;
    },
  ): Tenant {
    requirePermission(actor, 'platform.quota.config');
    const tenant = getTenant(this.ctx, tenantId);

    const thresholds = {
      ...tenant.quotaWarnThresholds,
      ...(input.quotaWarnThresholds ?? {}),
    };
    for (const [key, value] of Object.entries(thresholds)) {
      if (value === null) continue;
      if (typeof value !== 'number' || value < 0 || value > 1) {
        fail('VALIDATION_ERROR', `预警阈值 ${key} 必须是 0~1 之间的比例或 null`, {
          key,
          value,
        });
      }
    }

    const policy = input.exhaustPolicy ?? tenant.exhaustPolicy;
    const overdraft = input.overdraftLimitCredit ?? tenant.overdraftLimitCredit;
    if (!Number.isInteger(overdraft) || overdraft < 0) {
      fail('VALIDATION_ERROR', '透支上限必须是非负整数 credit', { overdraft });
    }
    if (policy !== 'overdraft' && overdraft > 0) {
      fail('VALIDATION_ERROR', '仅 overdraft 策略可以设置透支上限', { policy, overdraft });
    }

    const next = this.ctx.store.tenants.update(tenantId, {
      quotaWarnThresholds: thresholds,
      exhaustPolicy: policy,
      overdraftLimitCredit: overdraft,
      updatedAt: this.ctx.clock.now().toISOString(),
    })!;

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'quota_config',
      summary: `调整 ${tenant.name} 的额度策略：耗尽 ${policy}，透支上限 ${overdraft}`,
      diff: {
        exhaustPolicy: { from: tenant.exhaustPolicy, to: policy },
        overdraftLimitCredit: { from: tenant.overdraftLimitCredit, to: overdraft },
        quotaWarnThresholds: { from: tenant.quotaWarnThresholds, to: thresholds },
      },
    });
    return next;
  }

  /** 待确认 → 已到账 */
  confirm(actor: Actor, grantId: string): QuotaGrant {
    requirePermission(actor, 'platform.quota.grant');
    const grant = this.mustGrant(grantId);
    if (grant.status !== 'pending') {
      fail('QUOTA_GRANT_NOT_PENDING', '仅待确认状态的授予单可确认到账', {
        grantId,
        status: grant.status,
      });
    }
    const tenant = getTenant(this.ctx, grant.tenantId);
    const now = this.ctx.clock.now();

    const updated = this.ctx.store.quotaGrants.update(grantId, {
      status: 'active',
    })!;
    this.writeLedger(tenant, {
      direction: 'in',
      bizType: grant.book === 'gift' ? 'gift' : 'grant',
      book: grant.book,
      amountCredit: grant.amountCredit,
      grantId,
      operatorId: actor.id,
      occurredAt: now,
      remark: '确认到账',
    });
    this.afterBalanceIncrease(tenant);

    this.ctx.audit.record({
      actor,
      tenantId: grant.tenantId,
      objectType: 'quota_grant',
      objectId: grantId,
      action: 'confirm',
      summary: `确认 ${grant.no} 到账 ${grant.amountCredit} credit`,
    });
    return updated;
  }

  /** 回收未消耗额度。不修改原授予单金额，生成反向流水（Spec 8.2） */
  revoke(
    actor: Actor,
    grantId: string,
    amountCredit: number,
    reasonText: string,
  ): QuotaGrant {
    requirePermission(actor, 'platform.quota.revoke');
    const reason = requireReason(reasonText, '回收额度');
    const grant = this.mustGrant(grantId);
    const tenant = getTenant(this.ctx, grant.tenantId);
    const amount = assertPositiveCredit(amountCredit, '回收额度');

    const remaining = this.remainingOf(grant);
    if (amount > remaining) {
      fail(
        'QUOTA_REVOKE_EXCEEDS_REMAINING',
        `回收额度 ${amount} 超过该授予单未消耗余额 ${remaining}`,
        { grantId, amount, remaining },
      );
    }

    const updated = this.ctx.store.quotaGrants.update(grantId, {
      revokedCredit: grant.revokedCredit + amount,
    })!;
    this.writeLedger(tenant, {
      direction: 'out',
      bizType: 'revoke',
      book: grant.book,
      amountCredit: amount,
      grantId,
      operatorId: actor.id,
      occurredAt: this.ctx.clock.now(),
      remark: reason,
    });

    this.ctx.audit.record({
      actor,
      tenantId: grant.tenantId,
      objectType: 'quota_grant',
      objectId: grantId,
      action: 'revoke',
      summary: `回收 ${grant.no} 未消耗额度 ${amount} credit`,
      reason,
    });
    return updated;
  }

  /** 人工调账，仅超管，必须带工单号（Spec 8.2） */
  adjust(
    actor: Actor,
    tenantId: string,
    input: {
      direction: 'in' | 'out';
      book: QuotaBook;
      amountCredit: number;
      reason: string;
      ticketNo: string;
    },
  ): QuotaLedgerEntry {
    requirePermission(actor, 'platform.quota.adjust');
    const reason = requireReason(input.reason, '额度调账');
    const tenant = getTenant(this.ctx, tenantId);
    const amount = assertPositiveCredit(input.amountCredit, '调账金额');

    if (!input.ticketNo?.trim()) {
      fail('QUOTA_TICKET_REQUIRED', '调账必须关联工单号或事故编号', {});
    }

    const now = this.ctx.clock.now();

    if (input.direction === 'in') {
      // 调增：落一张 adjustment 来源的授予单承载余额
      const record: QuotaGrant = {
        id: this.ctx.ids.next('qg'),
        no: this.ctx.ids.quotaGrantNo(),
        tenantId,
        book: input.book,
        amountCredit: amount,
        source: 'adjustment',
        effectiveAt: now.toISOString(),
        expireAt:
          input.book === 'gift' ? endOfMonthFor(now, tenant.timezone).toISOString() : null,
        status: 'active',
        contractNo: null,
        reason,
        operatorId: actor.id,
        consumedCredit: 0,
        revokedCredit: 0,
        expiredCredit: 0,
        createdAt: now.toISOString(),
      };
      this.ctx.store.quotaGrants.insert(record);
      const entry = this.writeLedger(tenant, {
        direction: 'in',
        bizType: 'adjustment',
        book: input.book,
        amountCredit: amount,
        grantId: record.id,
        operatorId: actor.id,
        occurredAt: now,
        remark: reason,
        ticketNo: input.ticketNo,
      });
      this.afterBalanceIncrease(tenant);
      this.auditAdjust(actor, tenant, input, reason);
      return entry;
    }

    // 调减：按扣减顺序从现有授予单扣
    const deducted = this.deduct(tenant, amount, now, input.book);
    if (deducted.shortfall > 0) {
      fail('QUOTA_INSUFFICIENT', `调减金额超过当前可用余额`, {
        requested: amount,
        shortfall: deducted.shortfall,
      });
    }
    const entry = this.writeLedger(tenant, {
      direction: 'out',
      bizType: 'adjustment',
      book: input.book,
      amountCredit: amount,
      grantId: null,
      operatorId: actor.id,
      occurredAt: now,
      remark: reason,
      ticketNo: input.ticketNo,
    });
    this.auditAdjust(actor, tenant, input, reason);
    return entry;
  }

  private auditAdjust(
    actor: Actor,
    tenant: Tenant,
    input: { direction: 'in' | 'out'; book: QuotaBook; amountCredit: number; ticketNo: string },
    reason: string,
  ): void {
    this.ctx.audit.record({
      actor,
      tenantId: tenant.id,
      objectType: 'quota_ledger',
      objectId: null,
      action: 'adjust',
      summary: `${tenant.name} 额度调账 ${input.direction === 'in' ? '+' : '-'}${input.amountCredit} credit（${input.book}），工单 ${input.ticketNo}`,
      reason,
    });
  }

  // ── 消耗（Spec 8.3 扣减顺序 + 8.4 耗尽策略）──────────────────────────

  /**
   * 扣减顺序：赠送额度按到期时间升序优先，其次购买额度按到期时间升序（永久最后）。
   */
  private orderedGrants(tenantId: string, at: Date, book?: QuotaBook): QuotaGrant[] {
    const grants = this.activeGrants(tenantId, at).filter(
      (g) => this.remainingOf(g) > 0 && (book === undefined || g.book === book),
    );
    const rank = (g: QuotaGrant): number => (g.book === 'gift' ? 0 : 1);
    const expiry = (g: QuotaGrant): number =>
      g.expireAt === null ? Number.POSITIVE_INFINITY : new Date(g.expireAt).getTime();
    return grants.sort((a, b) => {
      if (rank(a) !== rank(b)) return rank(a) - rank(b);
      if (expiry(a) !== expiry(b)) return expiry(a) - expiry(b);
      return a.createdAt < b.createdAt ? -1 : 1;
    });
  }

  private deduct(
    tenant: Tenant,
    amount: number,
    at: Date,
    book?: QuotaBook,
  ): { fromGift: number; fromPurchased: number; shortfall: number } {
    let left = amount;
    let fromGift = 0;
    let fromPurchased = 0;

    for (const grant of this.orderedGrants(tenant.id, at, book)) {
      if (left <= 0) break;
      const remaining = this.remainingOf(grant);
      const take = Math.min(remaining, left);
      this.ctx.store.quotaGrants.update(grant.id, {
        consumedCredit: grant.consumedCredit + take,
      });
      if (grant.book === 'gift') fromGift += take;
      else fromPurchased += take;
      left -= take;
    }

    return { fromGift, fromPurchased, shortfall: left };
  }

  /**
   * 消耗额度。由网关计量链路回调，平台侧在此执行扣减、预警与耗尽策略。
   */
  consume(tenantId: string, input: ConsumeInput): ConsumeResult {
    const tenant = getTenant(this.ctx, tenantId);
    const now = input.occurredAt ?? this.ctx.clock.now();

    if (tenant.status === 'suspended') {
      fail('TENANT_SUSPENDED', '租户已停用，不能消耗额度', {
        tenantId,
        suspendReason: tenant.suspendReason,
      });
    }
    if (tenant.status !== 'active' && tenant.status !== 'trialing') {
      fail('TENANT_STATE_INVALID', '当前租户状态不允许消耗额度', {
        tenantId,
        status: tenant.status,
      });
    }

    const amount = ceilCredit(input.amountCredit);
    if (amount <= 0) {
      fail('QUOTA_AMOUNT_INVALID', '消耗金额必须为正', { amount });
    }

    const before = this.balance(tenantId, now);

    // degrade 策略：余额耗尽后只放行基础模型集
    if (tenant.exhaustPolicy === 'degrade' && before.availableCredit <= 0) {
      const model = input.modelCode ? this.ctx.store.catalog.get(input.modelCode) : undefined;
      if (!model || model.group !== BASIC_MODEL_GROUP) {
        fail('QUOTA_INSUFFICIENT', '额度已耗尽，当前仅允许调用基础模型集', {
          tenantId,
          modelCode: input.modelCode ?? null,
          policy: tenant.exhaustPolicy,
        });
      }
    }

    // 透支下限：hard_stop / degrade 为 0，overdraft 为 -limit
    const floor =
      tenant.exhaustPolicy === 'overdraft' ? -tenant.overdraftLimitCredit : 0;
    if (before.availableCredit - amount < floor) {
      fail('QUOTA_INSUFFICIENT', '可用额度不足', {
        tenantId,
        available: before.availableCredit,
        requested: amount,
        floor,
      });
    }

    const { fromGift, fromPurchased, shortfall } = this.deduct(tenant, amount, now);

    // shortfall 只可能出现在 overdraft 策略下，记为透支
    if (shortfall > 0) {
      const current = this.ctx.store.tenants.get(tenant.id)!;
      this.ctx.store.tenants.update(tenant.id, {
        overdraftUsedCredit: current.overdraftUsedCredit + shortfall,
      });
    }

    const entries: QuotaLedgerEntry[] = [];
    if (fromGift > 0) {
      entries.push(
        this.writeLedger(tenant, {
          direction: 'out',
          bizType: 'consume',
          book: 'gift',
          amountCredit: fromGift,
          grantId: null,
          operatorId: 'system',
          occurredAt: now,
          remark: input.remark ?? null,
          teamId: input.teamId ?? null,
          modelCode: input.modelCode ?? null,
        }),
      );
    }
    if (fromPurchased > 0 || shortfall > 0) {
      // shortfall 只可能出现在 overdraft 策略下，记为购买账本透支
      entries.push(
        this.writeLedger(tenant, {
          direction: 'out',
          bizType: 'consume',
          book: 'purchased',
          amountCredit: fromPurchased + shortfall,
          grantId: null,
          operatorId: 'system',
          occurredAt: now,
          remark: input.remark ?? null,
          teamId: input.teamId ?? null,
          modelCode: input.modelCode ?? null,
        }),
      );
    }

    const after = this.balance(tenantId, now);
    this.evaluateWarnings(tenant, after, now);
    this.enforceExhaustPolicy(tenant, after);

    return {
      consumedCredit: amount,
      fromGift,
      fromPurchased: fromPurchased + shortfall,
      balanceAfter: after,
      entries,
    };
  }

  // ── 预警与耗尽（Spec 8.4）────────────────────────────────────────────

  private evaluateWarnings(tenant: Tenant, balance: Balance, at: Date): void {
    const base = this.warnBase(tenant.id, at);
    if (base <= 0) return;
    const ratio = balance.availableCredit / base;
    const period = periodOf(at, tenant.timezone);
    const fired = new Set(tenant.firedWarnings[period] ?? []);
    const t = tenant.quotaWarnThresholds;

    const levels: {
      key: 'exhausted' | 'alert' | 'notice';
      threshold: number | null;
      recipients: string[];
      channels: ('email' | 'inbox')[];
    }[] = [
      {
        key: 'exhausted',
        threshold: t.exhausted,
        recipients: ['tenant_admin', 'owner_sales', 'platform_ops'],
        channels: ['email', 'inbox'],
      },
      {
        key: 'alert',
        threshold: t.alert,
        recipients: ['tenant_admin', 'owner_sales', 'platform_ops'],
        channels: ['email', 'inbox'],
      },
      {
        key: 'notice',
        threshold: t.notice,
        recipients: ['tenant_admin', 'owner_sales'],
        channels: ['email'],
      },
    ];

    for (const level of levels) {
      if (level.threshold === null) continue;
      if (ratio > level.threshold) continue;
      if (fired.has(level.key)) continue;
      fired.add(level.key);
      this.ctx.notifier.send({
        kind: `quota.${level.key}` as 'quota.notice' | 'quota.alert' | 'quota.exhausted',
        tenantId: tenant.id,
        recipients: level.recipients,
        channels: level.channels,
        subject: `${tenant.name} 额度${level.key === 'notice' ? '提醒' : level.key === 'alert' ? '告警' : '耗尽'}`,
        payload: {
          availableCredit: balance.availableCredit,
          base,
          ratio,
        },
        at: at.toISOString(),
      });
      // 每档在同一账期内只触发一次
      break;
    }

    this.ctx.store.tenants.update(tenant.id, {
      firedWarnings: { ...tenant.firedWarnings, [period]: [...fired] },
    });
  }

  private enforceExhaustPolicy(tenant: Tenant, balance: Balance): void {
    if (tenant.exhaustPolicy === 'overdraft') {
      if (balance.availableCredit > -tenant.overdraftLimitCredit) return;
    } else if (balance.availableCredit > 0) {
      return;
    }
    if (tenant.exhaustPolicy === 'degrade') return; // 降级不停服

    const current = this.ctx.store.tenants.get(tenant.id)!;
    if (current.status === 'suspended') return;
    this.tenants.suspend(SYSTEM_ACTOR, tenant.id, 'arrears');
  }

  /**
   * 新额度到账后：先偿还透支，再判断是否自动恢复 arrears 停用（Spec 6.1 第 3 条）。
   */
  private afterBalanceIncrease(tenant: Tenant): void {
    this.repayOverdraft(tenant.id);
    const current = this.ctx.store.tenants.get(tenant.id)!;
    if (current.status !== 'suspended' || current.suspendReason !== 'arrears') return;
    const balance = this.balance(tenant.id);
    if (balance.availableCredit > 0) {
      this.tenants.resume(SYSTEM_ACTOR, tenant.id, '额度补足后自动恢复');
    }
  }

  /** 透支优先从新到账的额度中扣回，保证授予单的 consumedCredit 与实际一致 */
  private repayOverdraft(tenantId: string): void {
    const tenant = this.ctx.store.tenants.get(tenantId)!;
    let debt = tenant.overdraftUsedCredit;
    if (debt <= 0) return;

    const now = this.ctx.clock.now();
    for (const grant of this.orderedGrants(tenantId, now)) {
      if (debt <= 0) break;
      const remaining = this.remainingOf(grant);
      const take = Math.min(remaining, debt);
      this.ctx.store.quotaGrants.update(grant.id, {
        consumedCredit: grant.consumedCredit + take,
      });
      debt -= take;
    }
    this.ctx.store.tenants.update(tenantId, { overdraftUsedCredit: debt });
  }

  // ── 赠送额度月度清零（Spec 8.3）──────────────────────────────────────

  /**
   * 清零已过期的赠送额度，写入 expire 流水保证账本可解释。
   * 返回被清零的 credit 总数。
   */
  expireGifts(tenantId: string, at?: Date): number {
    const tenant = getTenant(this.ctx, tenantId);
    const now = at ?? this.ctx.clock.now();
    let total = 0;

    const expiring = this.ctx.store.quotaGrants.find(
      (g) =>
        g.tenantId === tenantId &&
        g.book === 'gift' &&
        g.status === 'active' &&
        isExpired(g.expireAt, now),
    );

    for (const grant of expiring) {
      const remaining = this.remainingOf(grant);
      if (remaining > 0) {
        this.ctx.store.quotaGrants.update(grant.id, {
          expiredCredit: grant.expiredCredit + remaining,
          status: 'expired',
        });
        this.writeLedger(tenant, {
          direction: 'out',
          bizType: 'expire',
          book: 'gift',
          amountCredit: remaining,
          grantId: grant.id,
          operatorId: 'system',
          // 归属到过期发生的那一刻，即上一账期的最后一毫秒
          occurredAt: new Date(grant.expireAt!),
          remark: '赠送额度过期',
        });
        total += remaining;
      } else {
        this.ctx.store.quotaGrants.update(grant.id, { status: 'expired' });
      }
    }

    return total;
  }

  /**
   * 作废赠送额度。试用转正式与提前终止时调用（Spec 10.2）：
   * 试用发放的赠送额度不结转，立即写入 expire 流水。
   */
  voidGifts(
    tenantId: string,
    options: { source?: QuotaGrantSource; remark: string },
  ): number {
    const tenant = getTenant(this.ctx, tenantId);
    const now = this.ctx.clock.now();
    let total = 0;

    const targets = this.ctx.store.quotaGrants.find(
      (g) =>
        g.tenantId === tenantId &&
        g.book === 'gift' &&
        g.status === 'active' &&
        (options.source === undefined || g.source === options.source),
    );

    for (const grant of targets) {
      const remaining = this.remainingOf(grant);
      this.ctx.store.quotaGrants.update(grant.id, {
        expiredCredit: grant.expiredCredit + Math.max(remaining, 0),
        status: 'expired',
      });
      if (remaining > 0) {
        this.writeLedger(tenant, {
          direction: 'out',
          bizType: 'expire',
          book: 'gift',
          amountCredit: remaining,
          grantId: grant.id,
          operatorId: 'system',
          occurredAt: now,
          remark: options.remark,
        });
        total += remaining;
      }
    }
    return total;
  }

  // ── 团队分配（Spec 4.3 额度不变式）───────────────────────────────────

  /**
   * 租户侧把额度分配给团队。平台侧在此校验：
   * Σ 各团队已分配 ≤ 购买余额 + 赠送余额
   */
  allocateTeam(
    tenantId: string,
    teamId: string,
    teamName: string,
    allocatedCredit: number,
  ): TeamAllocation {
    getTenant(this.ctx, tenantId);
    if (!Number.isInteger(allocatedCredit) || allocatedCredit < 0) {
      fail('VALIDATION_ERROR', '团队分配额度必须是非负整数', { allocatedCredit });
    }

    const existing = this.ctx.store.teamAllocations.first(
      (a) => a.tenantId === tenantId && a.teamId === teamId,
    );
    const others = this.ctx.store.teamAllocations
      .find((a) => a.tenantId === tenantId && a.teamId !== teamId)
      .reduce((sum, a) => sum + a.allocatedCredit, 0);

    const balance = this.balance(tenantId);
    if (others + allocatedCredit > balance.availableCredit) {
      fail(
        'QUOTA_ALLOCATION_EXCEEDS_BALANCE',
        `团队分配总额 ${others + allocatedCredit} 超过可用余额 ${balance.availableCredit}，已达平台授予上限，请联系服务方扩容`,
        {
          tenantId,
          othersAllocated: others,
          requested: allocatedCredit,
          available: balance.availableCredit,
        },
      );
    }

    const now = this.ctx.clock.now().toISOString();
    if (existing) {
      return this.ctx.store.teamAllocations.update(existing.id, {
        allocatedCredit,
        teamName,
        updatedAt: now,
      })!;
    }
    return this.ctx.store.teamAllocations.insert({
      id: this.ctx.ids.next('alloc'),
      tenantId,
      teamId,
      teamName,
      allocatedCredit,
      updatedAt: now,
    });
  }

  totalAllocated(tenantId: string): number {
    return this.ctx.store.teamAllocations
      .find((a) => a.tenantId === tenantId)
      .reduce((sum, a) => sum + a.allocatedCredit, 0);
  }

  // ── 账期与对账（Spec 8.3 / 8.5）──────────────────────────────────────

  ledger(tenantId: string, filter: { period?: string } = {}): QuotaLedgerEntry[] {
    return this.ctx.store.quotaLedger
      .find(
        (e) =>
          e.tenantId === tenantId &&
          (filter.period === undefined || e.period === filter.period),
      )
      .sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : a.occurredAt > b.occurredAt ? 1 : 0));
  }

  /** 出账。已出账的账期数据冻结，后续调账只能计入当前账期 */
  closePeriod(actor: Actor, tenantId: string, period: string): BillingPeriod {
    const tenant = getTenant(this.ctx, tenantId);
    const existing = this.ctx.store.billingPeriods.first(
      (p) => p.tenantId === tenantId && p.period === period,
    );
    if (existing?.status === 'closed') {
      fail('QUOTA_PERIOD_CLOSED', `账期 ${period} 已出账，不可重复出账`, {
        tenantId,
        period,
      });
    }

    const prior = this.ctx.store.billingPeriods.first(
      (p) => p.tenantId === tenantId && p.period === prevPeriod(period),
    );
    const opening = prior?.closingCredit ?? 0;

    const entries = this.ledger(tenantId, { period });
    let recharge = 0;
    let consume = 0;
    let expire = 0;
    let adjustment = 0;
    let revoke = 0;

    for (const e of entries) {
      const signed = e.direction === 'in' ? e.amountCredit : -e.amountCredit;
      switch (e.bizType) {
        case 'grant':
        case 'gift':
          recharge += e.amountCredit;
          break;
        case 'consume':
          consume += e.amountCredit;
          break;
        case 'expire':
          expire += e.amountCredit;
          break;
        case 'adjustment':
          adjustment += signed;
          break;
        case 'revoke':
          revoke += e.amountCredit;
          break;
      }
    }

    const closing = opening + recharge - consume - expire + adjustment - revoke;
    const now = this.ctx.clock.now().toISOString();

    const record: BillingPeriod = {
      id: existing?.id ?? this.ctx.ids.next('bp'),
      tenantId,
      period,
      openingCredit: opening,
      rechargeCredit: recharge,
      consumeCredit: consume,
      expireCredit: expire,
      adjustmentCredit: adjustment,
      revokeCredit: revoke,
      closingCredit: closing,
      status: 'closed',
      closedAt: now,
    };

    if (existing) this.ctx.store.billingPeriods.update(existing.id, record);
    else this.ctx.store.billingPeriods.insert(record);

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'billing_period',
      objectId: record.id,
      action: 'close',
      summary: `${tenant.name} 账期 ${period} 出账，期末 ${closing} credit`,
    });
    return record;
  }

  billingPeriod(tenantId: string, period: string): BillingPeriod | undefined {
    return this.ctx.store.billingPeriods.first(
      (p) => p.tenantId === tenantId && p.period === period,
    );
  }

  /**
   * 对账（Spec 8.5）：核对授予单、流水、余额三组数是否一致。
   */
  reconcile(tenantId: string, period: string): ReconcileResult {
    const tenant = getTenant(this.ctx, tenantId);
    const from = startOfPeriod(period, tenant.timezone).getTime();
    const to = endOfPeriod(period, tenant.timezone).getTime();

    const grantsInPeriod = this.ctx.store.quotaGrants.find((g) => {
      if (g.tenantId !== tenantId) return false;
      if (g.status !== 'active' && g.status !== 'expired') return false;
      const t = new Date(g.effectiveAt).getTime();
      return t >= from && t < to;
    });
    const grantSum = grantsInPeriod.reduce((sum, g) => sum + g.amountCredit, 0);

    const entries = this.ledger(tenantId, { period });
    const ledgerRecharge = entries
      .filter((e) => e.bizType === 'grant' || e.bizType === 'gift')
      .reduce((sum, e) => sum + e.amountCredit, 0);
    const ledgerConsume = entries
      .filter((e) => e.bizType === 'consume')
      .reduce((sum, e) => sum + e.amountCredit, 0);

    const grantConsume = this.ctx.store.quotaGrants
      .find((g) => g.tenantId === tenantId)
      .reduce((sum, g) => sum + g.consumedCredit, 0);

    const bp = this.billingPeriod(tenantId, period);
    const computedBalance = this.balance(tenantId).availableCredit;

    const checks = [
      {
        name: '平台已发放 vs 账本本期充值',
        platform: grantSum,
        ledger: ledgerRecharge,
        diff: grantSum - ledgerRecharge,
        ok: grantSum === ledgerRecharge,
      },
      {
        name: '授予单已消耗 vs 账本累计消耗',
        platform: grantConsume,
        ledger: this.ctx.store.quotaLedger
          .find((e) => e.tenantId === tenantId && e.bizType === 'consume')
          .reduce((sum, e) => sum + e.amountCredit, 0),
        diff: 0,
        ok: true,
      },
      {
        name: '平台侧期末余额 vs 账期期末',
        platform: computedBalance,
        ledger: bp?.closingCredit ?? computedBalance,
        diff: computedBalance - (bp?.closingCredit ?? computedBalance),
        ok: bp === undefined || computedBalance === bp.closingCredit,
      },
    ];
    checks[1].diff = checks[1].platform - checks[1].ledger;
    checks[1].ok = checks[1].diff === 0;
    // 消耗流水中被 overdraft 透支的部分不计入授予单 consumedCredit，
    // 因此这里只在无透支时严格相等；有透支时差额即透支额。
    void ledgerConsume;

    return {
      period,
      ok: checks.every((c) => c.ok),
      checks,
    };
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private writeLedger(
    tenant: Tenant,
    input: {
      direction: 'in' | 'out';
      bizType: QuotaLedgerEntry['bizType'];
      book: QuotaBook;
      amountCredit: number;
      grantId: string | null;
      operatorId: string;
      occurredAt: Date;
      remark?: string | null;
      teamId?: string | null;
      modelCode?: string | null;
      ticketNo?: string | null;
    },
  ): QuotaLedgerEntry {
    const entry: QuotaLedgerEntry = {
      id: this.ctx.ids.next('ql'),
      tenantId: tenant.id,
      occurredAt: input.occurredAt.toISOString(),
      period: periodOf(input.occurredAt, tenant.timezone),
      direction: input.direction,
      bizType: input.bizType,
      book: input.book,
      amountCredit: input.amountCredit,
      balanceAfterCredit: 0,
      grantId: input.grantId,
      teamId: input.teamId ?? null,
      modelCode: input.modelCode ?? null,
      operatorId: input.operatorId,
      remark: input.remark ?? null,
      ticketNo: input.ticketNo ?? null,
    };
    // 余额快照在授予单更新之后计算，反映本次变动结果
    entry.balanceAfterCredit = this.balance(tenant.id).availableCredit;
    return this.ctx.store.quotaLedger.insert(entry);
  }

  private mustGrant(grantId: string): QuotaGrant {
    const grant = this.ctx.store.quotaGrants.get(grantId);
    if (!grant) {
      fail('QUOTA_GRANT_NOT_FOUND', `额度授予单 ${grantId} 不存在`, { grantId });
    }
    return grant;
  }

  grants(tenantId: string): QuotaGrant[] {
    return this.ctx.store.quotaGrants
      .find((g) => g.tenantId === tenantId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }
}
