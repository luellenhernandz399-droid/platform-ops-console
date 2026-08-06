// 试用管理标准化（最小集）。对应 Spec 第 10 章。
//
// 试用不再逐单拍脑袋，改为选择预置模板，开通即按模板一次性下发三类资源，到期自动收口。

import type { Actor, TrialPlan, Tenant, TrialExpireAction } from '../domain/types.ts';
import { SYSTEM_ACTOR } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { getTenant } from './context.ts';
import { fail, requireReason } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { addDays } from '../domain/time.ts';
import type { TenantService } from './tenant.ts';
import type { SeatService } from './seat.ts';
import type { QuotaService } from './quota.ts';
import type { ModelService } from './model.ts';

/** 单个租户的试用总时长上限，防止「永久试用」（Spec 10.2） */
export const TRIAL_MAX_TOTAL_DAYS = 90;

export interface CreateTrialPlanInput {
  name: string;
  seatCount: number;
  giftCredit: number;
  modelGroups?: string[];
  modelCodes?: string[];
  durationDays: number;
  allowRecharge?: boolean;
  allowSelfHostedChannel?: boolean;
  concurrencyLimit?: number | null;
  expireAction?: TrialExpireAction;
}

export interface ConvertInput {
  seatCount: number;
  purchasedCredit: number;
  contractNo?: string | null;
  contractStartAt?: string | null;
  contractEndAt?: string | null;
  seatExpireAt?: string | null;
  /** 不传则继承试用期的模型授权 */
  modelCodes?: string[];
  reason?: string | null;
}

export class TrialService {
  private ctx: Ctx;
  private tenants: TenantService;
  private seats: SeatService;
  private quota: QuotaService;
  private models: ModelService;

  constructor(
    ctx: Ctx,
    tenants: TenantService,
    seats: SeatService,
    quota: QuotaService,
    models: ModelService,
  ) {
    this.ctx = ctx;
    this.tenants = tenants;
    this.seats = seats;
    this.quota = quota;
    this.models = models;
  }

  // ── 套餐模板（Spec 10.1）────────────────────────────────────────────

  createPlan(actor: Actor, input: CreateTrialPlanInput): TrialPlan {
    requirePermission(actor, 'platform.trial_plan.create');
    if (!Number.isInteger(input.seatCount) || input.seatCount <= 0) {
      fail('VALIDATION_ERROR', '试用席位数必须是正整数', { seatCount: input.seatCount });
    }
    if (!Number.isInteger(input.giftCredit) || input.giftCredit <= 0) {
      fail('VALIDATION_ERROR', '试用赠送额度必须是正整数 credit', {
        giftCredit: input.giftCredit,
      });
    }
    if (!Number.isInteger(input.durationDays) || input.durationDays <= 0) {
      fail('VALIDATION_ERROR', '试用时长必须是正整数天', {
        durationDays: input.durationDays,
      });
    }
    if (input.durationDays > TRIAL_MAX_TOTAL_DAYS) {
      fail(
        'TRIAL_MAX_DURATION_EXCEEDED',
        `单个试用套餐时长不得超过 ${TRIAL_MAX_TOTAL_DAYS} 天`,
        { durationDays: input.durationDays },
      );
    }
    if ((input.modelGroups ?? []).length === 0 && (input.modelCodes ?? []).length === 0) {
      fail('VALIDATION_ERROR', '试用套餐必须指定模型分组或具体模型', {});
    }

    const plan: TrialPlan = {
      id: this.ctx.ids.next('tp'),
      name: input.name,
      seatCount: input.seatCount,
      giftCredit: input.giftCredit,
      modelGroups: input.modelGroups ?? [],
      modelCodes: input.modelCodes ?? [],
      durationDays: input.durationDays,
      allowRecharge: input.allowRecharge ?? false,
      allowSelfHostedChannel: input.allowSelfHostedChannel ?? false,
      concurrencyLimit: input.concurrencyLimit ?? null,
      expireAction: input.expireAction ?? 'suspend',
      status: 'enabled',
      createdAt: this.ctx.clock.now().toISOString(),
    };
    this.ctx.store.trialPlans.insert(plan);
    this.ctx.audit.record({
      actor,
      objectType: 'trial_plan',
      objectId: plan.id,
      action: 'create',
      summary: `新建试用套餐「${plan.name}」`,
    });
    return plan;
  }

  editPlan(actor: Actor, planId: string, patch: Partial<CreateTrialPlanInput>): TrialPlan {
    requirePermission(actor, 'platform.trial_plan.edit');
    this.mustPlan(planId);
    return this.ctx.store.trialPlans.update(planId, patch as Partial<TrialPlan>)!;
  }

  /** 停用模板不影响已开通的试用，只是不能再用于新开通 */
  disablePlan(actor: Actor, planId: string): TrialPlan {
    requirePermission(actor, 'platform.trial_plan.disable');
    this.mustPlan(planId);
    return this.ctx.store.trialPlans.update(planId, { status: 'disabled' })!;
  }

  plans(includeDisabled = false): TrialPlan[] {
    return this.ctx.store.trialPlans.find(
      (p) => includeDisabled || p.status === 'enabled',
    );
  }

  // ── 开通（Spec 10.2）────────────────────────────────────────────────

  open(actor: Actor, tenantId: string, planId: string): Tenant {
    requirePermission(actor, 'platform.trial.open');
    const tenant = getTenant(this.ctx, tenantId);
    const plan = this.mustPlan(planId);

    if (plan.status !== 'enabled') {
      fail('TRIAL_PLAN_DISABLED', `试用套餐「${plan.name}」已停用`, { planId });
    }
    this.tenants.assertTransition(tenant, 'trialing');

    const now = this.ctx.clock.now();
    const expireAt = addDays(now, plan.durationDays);

    // 席位：一条 source=trial 的授予单
    this.seats.grant(SYSTEM_ACTOR, tenantId, {
      seatCount: plan.seatCount,
      source: 'trial',
      expireAt: expireAt.toISOString(),
      remark: `试用套餐「${plan.name}」`,
    });

    // 额度：一条 gift + source=trial 的授予单，到期时间跟随试用期
    this.quota.gift(SYSTEM_ACTOR, tenantId, {
      amountCredit: plan.giftCredit,
      source: 'trial',
      expireAt: expireAt.toISOString(),
      reason: `试用套餐「${plan.name}」`,
    });

    // 模型：按模板的分组与具体模型授权
    for (const group of plan.modelGroups) {
      this.models.grantGroup(SYSTEM_ACTOR, tenantId, group);
    }
    for (const code of plan.modelCodes) {
      this.models.grantModel(SYSTEM_ACTOR, tenantId, { modelCode: code });
    }
    if (plan.concurrencyLimit !== null) {
      this.models.setTenantLimits(SYSTEM_ACTOR, tenantId, {
        concurrency: plan.concurrencyLimit,
      });
    }
    this.models.setSelfHostedChannel(SYSTEM_ACTOR, tenantId, plan.allowSelfHostedChannel);

    const next = this.tenants.applyTransition(
      tenant,
      'trialing',
      actor,
      null,
      `按套餐「${plan.name}」开通 ${plan.durationDays} 天试用`,
      {
        trialPlanId: planId,
        trialExpireAt: expireAt.toISOString(),
        trialTotalDays: plan.durationDays,
        allowRecharge: plan.allowRecharge,
      },
    );

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'trial',
      objectId: tenantId,
      action: 'open',
      summary: `为 ${tenant.name} 开通试用「${plan.name}」，${plan.seatCount} 席位 / ${plan.giftCredit} credit / ${plan.durationDays} 天`,
    });
    return next;
  }

  // ── 延期（Spec 10.2）────────────────────────────────────────────────

  extend(
    actor: Actor,
    tenantId: string,
    days: number,
    options: { reason: string; extraGiftCredit?: number },
  ): Tenant {
    requirePermission(actor, 'platform.trial.extend');
    const tenant = getTenant(this.ctx, tenantId);
    const reason = requireReason(options.reason, '试用延期');

    if (tenant.status !== 'trialing') {
      fail('TRIAL_NOT_ACTIVE', '仅试用中的租户可延期', {
        tenantId,
        status: tenant.status,
      });
    }
    if (!Number.isInteger(days) || days <= 0) {
      fail('VALIDATION_ERROR', '延期天数必须是正整数', { days });
    }

    const total = tenant.trialTotalDays + days;
    if (total > TRIAL_MAX_TOTAL_DAYS) {
      fail(
        'TRIAL_MAX_DURATION_EXCEEDED',
        `试用总时长 ${total} 天超过上限 ${TRIAL_MAX_TOTAL_DAYS} 天，需超管审批`,
        { current: tenant.trialTotalDays, requested: days, max: TRIAL_MAX_TOTAL_DAYS },
      );
    }

    const oldExpire = new Date(tenant.trialExpireAt!);
    const newExpire = addDays(oldExpire, days);

    // 席位、模型授权的到期时间同步顺延
    for (const grant of this.seats.grants(tenantId, ['active'])) {
      if (grant.source === 'trial' && grant.expireAt !== null) {
        this.seats.renew(SYSTEM_ACTOR, grant.id, addDays(new Date(grant.expireAt), days).toISOString());
      }
    }
    for (const grant of this.models.activeGrants(tenantId)) {
      if (grant.expireAt !== null) {
        this.ctx.store.modelGrants.update(grant.id, {
          expireAt: addDays(new Date(grant.expireAt), days).toISOString(),
        });
      }
    }
    // 额度授予单顺延
    for (const grant of this.quota.grants(tenantId)) {
      if (grant.source === 'trial' && grant.status === 'active' && grant.expireAt !== null) {
        this.ctx.store.quotaGrants.update(grant.id, {
          expireAt: addDays(new Date(grant.expireAt), days).toISOString(),
        });
      }
    }

    // 是否补发额度由操作人决定，默认不补
    if (options.extraGiftCredit && options.extraGiftCredit > 0) {
      this.quota.gift(SYSTEM_ACTOR, tenantId, {
        amountCredit: options.extraGiftCredit,
        source: 'trial',
        expireAt: newExpire.toISOString(),
        reason: `试用延期补发：${reason}`,
      });
    }

    const next = this.ctx.store.tenants.update(tenantId, {
      trialExpireAt: newExpire.toISOString(),
      trialTotalDays: total,
      updatedAt: this.ctx.clock.now().toISOString(),
    })!;

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'trial',
      objectId: tenantId,
      action: 'extend',
      summary: `${tenant.name} 试用延期 ${days} 天至 ${newExpire.toISOString()}，累计 ${total} 天`,
      reason,
    });
    return next;
  }

  // ── 转正式（Spec 10.2）──────────────────────────────────────────────

  /**
   * 试用的席位授予单保留至原到期时间，与新的正式席位授予单叠加，
   * 客户不会在转换瞬间掉席位；试用赠送额度立即作废，不结转。
   */
  convert(actor: Actor, tenantId: string, input: ConvertInput): Tenant {
    requirePermission(actor, 'platform.trial.convert');
    const tenant = getTenant(this.ctx, tenantId);

    if (tenant.status !== 'trialing' && tenant.suspendReason !== 'trial_expired') {
      fail('TRIAL_NOT_ACTIVE', '仅试用中或试用到期的租户可转正式', {
        tenantId,
        status: tenant.status,
        suspendReason: tenant.suspendReason,
      });
    }

    // 转正式即脱离试用，先解除「试用期不可充值」限制，
    // 否则下面发放正式购买额度会被租户自身的试用规则拦住。
    this.ctx.store.tenants.update(tenantId, { allowRecharge: true });

    // 正式席位（叠加，不动试用授予单）
    this.seats.grant(SYSTEM_ACTOR, tenantId, {
      seatCount: input.seatCount,
      source: 'contract',
      expireAt: input.seatExpireAt ?? input.contractEndAt ?? null,
      contractNo: input.contractNo ?? null,
      remark: '试用转正式',
    });

    // 试用赠送额度作废
    const voided = this.quota.voidGifts(tenantId, {
      source: 'trial',
      remark: '试用转正式，赠送额度不结转',
    });

    // 正式购买额度
    if (input.purchasedCredit > 0) {
      this.quota.grant(SYSTEM_ACTOR, tenantId, {
        amountCredit: input.purchasedCredit,
        source: 'contract',
        contractNo: input.contractNo ?? null,
        reason: '试用转正式',
      });
    }

    // 模型授权：默认继承，指定则以指定为准
    if (input.modelCodes) {
      const current = this.models.activeGrants(tenantId).map((g) => g.modelCode);
      for (const code of input.modelCodes) {
        if (!current.includes(code)) {
          this.models.grantModel(SYSTEM_ACTOR, tenantId, { modelCode: code });
        }
      }
    }
    // 去掉试用期的到期限制
    for (const grant of this.models.activeGrants(tenantId)) {
      this.ctx.store.modelGrants.update(grant.id, { expireAt: null });
    }
    // 去掉试用期的并发上限
    this.models.setTenantLimits(SYSTEM_ACTOR, tenantId, { concurrency: null });

    const current = this.ctx.store.tenants.get(tenantId)!;
    const next = this.tenants.applyTransition(
      current,
      'active',
      actor,
      input.reason ?? null,
      `试用转正式，作废赠送额度 ${voided} credit`,
      {
        trialPlanId: null,
        trialExpireAt: null,
        allowRecharge: true,
        suspendReason: null,
        contractNo: input.contractNo ?? current.contractNo,
        contractStartAt: input.contractStartAt ?? current.contractStartAt,
        contractEndAt: input.contractEndAt ?? current.contractEndAt,
      },
    );

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'trial',
      objectId: tenantId,
      action: 'convert',
      summary: `${tenant.name} 试用转正式：${input.seatCount} 席位 / ${input.purchasedCredit} credit，作废赠送额度 ${voided} credit`,
      reason: input.reason ?? null,
    });
    return next;
  }

  // ── 终止与到期（Spec 10.2 / 10.4）───────────────────────────────────

  terminate(actor: Actor, tenantId: string, reasonText: string): Tenant {
    requirePermission(actor, 'platform.trial.terminate');
    const reason = requireReason(reasonText, '提前终止试用');
    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status !== 'trialing') {
      fail('TRIAL_NOT_ACTIVE', '仅试用中的租户可提前终止', {
        tenantId,
        status: tenant.status,
      });
    }
    return this.closeTrial(actor, tenant, 'suspend', reason, '提前终止试用');
  }

  /** 到期自动处理，由每日任务调用 */
  expireTrial(tenant: Tenant): Tenant {
    const plan = tenant.trialPlanId
      ? this.ctx.store.trialPlans.get(tenant.trialPlanId)
      : undefined;
    const action: TrialExpireAction = plan?.expireAction ?? 'suspend';
    return this.closeTrial(SYSTEM_ACTOR, tenant, action, null, '试用到期自动处理');
  }

  private closeTrial(
    actor: Actor,
    tenant: Tenant,
    action: TrialExpireAction,
    reason: string | null,
    detail: string,
  ): Tenant {
    const now = this.ctx.clock.now();

    // 回收试用席位授予单
    for (const grant of this.seats.grants(tenant.id, ['active'])) {
      if (grant.source === 'trial') {
        this.ctx.store.seatGrants.update(grant.id, { status: 'revoked' });
      }
    }
    // 作废试用赠送额度
    const voided = this.quota.voidGifts(tenant.id, {
      source: 'trial',
      remark: detail,
    });
    // 撤销模型授权
    for (const grant of this.models.activeGrants(tenant.id)) {
      this.ctx.store.modelGrants.update(grant.id, {
        revokedAt: now.toISOString(),
        enabled: false,
        isDefault: false,
      });
    }
    for (const follow of this.ctx.store.modelGroupFollows.find(
      (f) => f.tenantId === tenant.id,
    )) {
      this.ctx.store.modelGroupFollows.delete(follow.id);
    }

    const next = this.tenants.applyTransition(
      tenant,
      'suspended',
      actor,
      reason,
      `${detail}，作废赠送额度 ${voided} credit，到期动作 ${action}`,
      {
        suspendReason: 'trial_expired',
        trialExpireAt: tenant.trialExpireAt,
      },
    );

    this.ctx.notifier.send({
      kind: 'trial.expired',
      tenantId: tenant.id,
      recipients: ['tenant_admin', 'owner_sales', 'platform_ops'],
      channels: ['email', 'inbox'],
      subject: `${tenant.name} 试用已结束`,
      payload: { action, voidedCredit: voided },
      at: now.toISOString(),
    });

    this.ctx.audit.record({
      actor,
      tenantId: tenant.id,
      objectType: 'trial',
      objectId: tenant.id,
      action: reason === null ? 'expire' : 'terminate',
      summary: `${tenant.name} ${detail}`,
      reason,
    });
    return next;
  }

  /**
   * keep_readonly 到期动作下，租户侧管理中心仍可只读访问。
   * 与 suspend 的差别体现在这里，供查询层判断。
   */
  expireActionOf(tenant: Tenant): TrialExpireAction {
    const plan = tenant.trialPlanId
      ? this.ctx.store.trialPlans.get(tenant.trialPlanId)
      : undefined;
    return plan?.expireAction ?? 'suspend';
  }

  private mustPlan(planId: string): TrialPlan {
    const plan = this.ctx.store.trialPlans.get(planId);
    if (!plan) {
      fail('TRIAL_PLAN_NOT_FOUND', `试用套餐 ${planId} 不存在`, { planId });
    }
    return plan;
  }
}
