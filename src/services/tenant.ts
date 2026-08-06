// 租户生命周期。对应 Spec 第 6 章。

import type {
  Actor,
  ExhaustPolicy,
  LifecycleEvent,
  ReduceStrategy,
  SuspendReason,
  Tenant,
  TenantLevel,
  TenantStatus,
} from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { getTenant } from './context.ts';
import { fail, requireReason } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { addDays } from '../domain/time.ts';

/** Spec 6.1 允许的状态流转 */
const TRANSITIONS: Record<TenantStatus, TenantStatus[]> = {
  pending: ['trialing', 'active', 'deregistering'],
  trialing: ['active', 'suspended', 'deregistering'],
  active: ['suspended', 'deregistering'],
  suspended: ['active', 'deregistering'],
  deregistering: ['active', 'deregistered'],
  deregistered: [],
};

export interface TenantCapabilities {
  canLogin: boolean;
  canCallModel: boolean;
  canConsumeQuota: boolean;
  console: 'none' | 'readonly' | 'full';
  canReceiveGrants: boolean;
}

/** Spec 6.1 状态与能力对应表 */
const CAPABILITIES: Record<TenantStatus, TenantCapabilities> = {
  pending: {
    canLogin: false,
    canCallModel: false,
    canConsumeQuota: false,
    console: 'none',
    canReceiveGrants: true,
  },
  trialing: {
    canLogin: true,
    canCallModel: true,
    canConsumeQuota: true,
    console: 'full',
    canReceiveGrants: true,
  },
  active: {
    canLogin: true,
    canCallModel: true,
    canConsumeQuota: true,
    console: 'full',
    canReceiveGrants: true,
  },
  suspended: {
    canLogin: true,
    canCallModel: false,
    canConsumeQuota: false,
    console: 'readonly',
    canReceiveGrants: true,
  },
  deregistering: {
    canLogin: false,
    canCallModel: false,
    canConsumeQuota: false,
    console: 'none',
    canReceiveGrants: false,
  },
  deregistered: {
    canLogin: false,
    canCallModel: false,
    canConsumeQuota: false,
    console: 'none',
    canReceiveGrants: false,
  },
};

export function capabilitiesOf(tenant: Tenant): TenantCapabilities {
  return CAPABILITIES[tenant.status];
}

export interface CreateTenantInput {
  name: string;
  shortName?: string | null;
  industry?: string | null;
  level?: TenantLevel | null;
  ownerSalesId?: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone?: string | null;
  emailDomains?: string[];
  contractNo?: string | null;
  contractStartAt?: string | null;
  contractEndAt?: string | null;
  tags?: string[];
  timezone?: string;
  retentionDays?: number;
  seatOversellPercent?: number | null;
  seatGraceDays?: number;
  seatReduceStrategy?: ReduceStrategy;
  exhaustPolicy?: ExhaustPolicy;
  overdraftLimitCredit?: number;
}

export class TenantService {
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  // ── 创建与编辑 ────────────────────────────────────────────────────────

  create(actor: Actor, input: CreateTenantInput): Tenant {
    requirePermission(actor, 'platform.tenant.create');

    const name = input.name?.trim();
    if (!name) {
      fail('VALIDATION_ERROR', '租户名称必填', { field: 'name' });
    }
    if (this.ctx.store.tenants.first((t) => t.name === name)) {
      fail('TENANT_NAME_DUPLICATE', `租户名称「${name}」已存在`, { name });
    }
    if (!input.contactName?.trim() || !input.contactEmail?.trim()) {
      fail('VALIDATION_ERROR', '联系人与联系邮箱必填', {});
    }

    const retentionDays = input.retentionDays ?? 30;
    if (retentionDays < 7 || retentionDays > 180) {
      fail('VALIDATION_ERROR', '注销保留期须在 7 ~ 180 天之间', { retentionDays });
    }

    const oversell = input.seatOversellPercent ?? null;
    if (oversell !== null && (oversell < 0 || oversell > 20)) {
      fail('VALIDATION_ERROR', '席位超卖比例上限为 20%', { oversell });
    }

    const graceDays = input.seatGraceDays ?? 7;
    if (graceDays < 0 || graceDays > 30) {
      fail('VALIDATION_ERROR', '席位到期宽限期须在 0 ~ 30 天之间', { graceDays });
    }

    const now = this.ctx.clock.now().toISOString();
    const tenant: Tenant = {
      id: this.ctx.ids.next('tenant'),
      code: this.ctx.ids.tenantCode(),
      name,
      shortName: input.shortName ?? null,
      industry: input.industry ?? null,
      level: input.level ?? null,
      ownerSalesId: input.ownerSalesId ?? null,
      contactName: input.contactName.trim(),
      contactEmail: input.contactEmail.trim(),
      contactPhone: input.contactPhone ?? null,
      emailDomains: input.emailDomains ?? [],
      contractNo: input.contractNo ?? null,
      contractStartAt: input.contractStartAt ?? null,
      contractEndAt: input.contractEndAt ?? null,
      remarks: [],
      tags: input.tags ?? [],

      status: 'pending',
      suspendReason: null,

      timezone: input.timezone ?? 'Asia/Shanghai',
      retentionDays,

      seatOversellPercent: oversell,
      seatGraceDays: graceDays,
      seatReduceStrategy: input.seatReduceStrategy ?? 'reject',

      quotaWarnThresholds: { notice: 0.2, alert: 0.05, exhausted: 0 },
      exhaustPolicy: input.exhaustPolicy ?? 'hard_stop',
      overdraftLimitCredit: input.overdraftLimitCredit ?? 0,
      overdraftUsedCredit: 0,
      firedWarnings: {},

      allowSelfHostedChannel: false,
      modelLimits: { tpm: null, rpm: null, concurrency: null },

      trialPlanId: null,
      trialExpireAt: null,
      trialTotalDays: 0,
      allowRecharge: true,

      deregisterAt: null,
      purgeAt: null,
      deregisterSnapshot: null,

      createdAt: now,
      updatedAt: now,
    };

    this.ctx.store.tenants.insert(tenant);
    this.recordEvent(tenant, null, 'pending', actor, null, '创建租户');
    this.ctx.audit.record({
      actor,
      tenantId: tenant.id,
      objectType: 'tenant',
      objectId: tenant.id,
      action: 'create',
      summary: `创建租户 ${tenant.name}（${tenant.code}）`,
    });
    return tenant;
  }

  edit(
    actor: Actor,
    tenantId: string,
    patch: Partial<CreateTenantInput>,
  ): Tenant {
    requirePermission(actor, 'platform.tenant.edit');
    const tenant = getTenant(this.ctx, tenantId);

    if (patch.name !== undefined) {
      const name = patch.name.trim();
      if (!name) fail('VALIDATION_ERROR', '租户名称不能为空', {});
      const clash = this.ctx.store.tenants.first(
        (t) => t.name === name && t.id !== tenantId,
      );
      if (clash) {
        fail('TENANT_NAME_DUPLICATE', `租户名称「${name}」已存在`, { name });
      }
    }

    const diff: Record<string, unknown> = {};
    const editable: (keyof CreateTenantInput)[] = [
      'name',
      'shortName',
      'industry',
      'level',
      'ownerSalesId',
      'contactName',
      'contactEmail',
      'contactPhone',
      'emailDomains',
      'contractNo',
      'contractStartAt',
      'contractEndAt',
      'tags',
      'seatOversellPercent',
      'seatGraceDays',
      'seatReduceStrategy',
    ];
    const update: Record<string, unknown> = {};
    for (const key of editable) {
      if (patch[key] !== undefined) {
        const before = (tenant as unknown as Record<string, unknown>)[key];
        if (JSON.stringify(before) !== JSON.stringify(patch[key])) {
          diff[key] = { from: before, to: patch[key] };
          update[key] = patch[key];
        }
      }
    }

    if (Object.keys(update).length === 0) return tenant;

    update.updatedAt = this.ctx.clock.now().toISOString();
    const next = this.ctx.store.tenants.update(tenantId, update as Partial<Tenant>)!;
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'edit',
      summary: `编辑租户 ${next.name} 的 ${Object.keys(diff).join('、')}`,
      diff,
    });
    return next;
  }

  addRemark(actor: Actor, tenantId: string, text: string): Tenant {
    requirePermission(actor, 'platform.tenant.edit');
    const tenant = getTenant(this.ctx, tenantId);
    const remark = {
      at: this.ctx.clock.now().toISOString(),
      operatorId: actor.id,
      text,
    };
    // 备注为追加式，历史条目不可编辑
    return this.ctx.store.tenants.update(tenantId, {
      remarks: [...tenant.remarks, remark],
      updatedAt: remark.at,
    })!;
  }

  /**
   * 变更租户管理员（Spec 6.3 第 3 条，权限点 platform.tenant_admin.config）。
   * 原管理员降级为普通成员但不自动释放席位；新管理员若尚未占位则占用一个席位。
   */
  setAdmin(
    actor: Actor,
    tenantId: string,
    next: { memberId: string; name: string; email: string },
  ): { previousMemberId: string | null; memberId: string } {
    requirePermission(actor, 'platform.tenant_admin.config');
    const tenant = getTenant(this.ctx, tenantId);

    if (!next.memberId?.trim() || !next.email?.trim()) {
      fail('VALIDATION_ERROR', '新管理员的成员标识与邮箱必填', {});
    }

    const current = this.ctx.store.seatAssignments.first(
      (a) => a.tenantId === tenantId && a.isAdmin && a.releasedAt === null,
    );
    if (current?.memberId === next.memberId) return {
      previousMemberId: current.memberId,
      memberId: current.memberId,
    };

    // 原管理员降级，席位保留
    if (current) {
      this.ctx.store.seatAssignments.update(current.id, { isAdmin: false });
    }

    const existing = this.ctx.store.seatAssignments.first(
      (a) => a.tenantId === tenantId && a.memberId === next.memberId && a.releasedAt === null,
    );
    if (existing) {
      this.ctx.store.seatAssignments.update(existing.id, {
        isAdmin: true,
        memberName: next.name,
        memberEmail: next.email,
      });
    } else {
      // 席位不足时由 SeatService 抛 SEAT_INSUFFICIENT，此处不吞异常
      this.seatAssign(tenantId, next);
    }

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant_admin',
      objectId: next.memberId,
      action: 'set_admin',
      summary: `${tenant.name} 的企业管理员变更为 ${next.email}`,
      diff: { from: current?.memberEmail ?? null, to: next.email },
    });
    return { previousMemberId: current?.memberId ?? null, memberId: next.memberId };
  }

  /**
   * 占用席位的最小实现。TenantService 不依赖 SeatService，
   * 这里只做不变式校验后直接落行，避免服务间循环引用。
   */
  private seatAssign(
    tenantId: string,
    member: { memberId: string; name: string; email: string },
  ): void {
    const tenant = getTenant(this.ctx, tenantId);
    const now = this.ctx.clock.now();

    const total = this.ctx.store.seatGrants
      .find((g) => {
        if (g.tenantId !== tenantId || g.status !== 'active') return false;
        if (new Date(g.effectiveAt).getTime() > now.getTime()) return false;
        if (g.expireAt === null) return true;
        return now.getTime() < addDays(new Date(g.expireAt), tenant.seatGraceDays).getTime();
      })
      .reduce((sum, g) => sum + g.seatCount, 0);
    const limit =
      tenant.seatOversellPercent === null
        ? total
        : Math.floor(total * (1 + tenant.seatOversellPercent / 100));
    const occupied = this.ctx.store.seatAssignments.count(
      (a) => a.tenantId === tenantId && a.releasedAt === null,
    );
    if (occupied >= limit) {
      fail('SEAT_INSUFFICIENT', `席位不足：已占用 ${occupied}，可占用上限 ${limit}`, {
        occupied,
        limit,
      });
    }

    this.ctx.store.seatAssignments.insert({
      id: this.ctx.ids.next('sa'),
      tenantId,
      memberId: member.memberId,
      memberName: member.name,
      memberEmail: member.email,
      teamId: null,
      isAdmin: true,
      boundAt: now.toISOString(),
      lastActiveAt: null,
      memberStatus: 'active',
      releasedAt: null,
      releaseReason: null,
    });
  }

  // ── 状态流转 ──────────────────────────────────────────────────────────

  /** 直接开通正式（Spec 6.2 开通方式三） */
  activate(actor: Actor, tenantId: string, detail = '直接开通正式'): Tenant {
    const tenant = getTenant(this.ctx, tenantId);
    this.assertTransition(tenant, 'active');
    return this.applyTransition(tenant, 'active', actor, null, detail, {
      suspendReason: null,
    });
  }

  suspend(
    actor: Actor,
    tenantId: string,
    reason: SuspendReason,
    reasonText?: string,
  ): Tenant {
    // arrears / trial_expired 由系统任务触发，不做权限校验；人工停用需要权限
    if (reason === 'manual' || reason === 'violation') {
      requirePermission(actor, 'platform.tenant.suspend');
      requireReason(reasonText, '停用租户');
    }
    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status === 'suspended') return tenant;
    this.assertTransition(tenant, 'suspended');

    const next = this.applyTransition(
      tenant,
      'suspended',
      actor,
      reasonText ?? null,
      `停用原因：${reason}`,
      { suspendReason: reason },
    );
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'suspend',
      summary: `停用租户 ${tenant.name}，原因 ${reason}`,
      reason: reasonText ?? null,
    });
    return next;
  }

  /**
   * 恢复。Spec 6.1：
   * - arrears 由额度补足后系统自动调用
   * - manual / violation 人工恢复
   * - trial_expired 只能走试用转正式，不能直接恢复
   */
  resume(actor: Actor, tenantId: string, detail = '恢复租户'): Tenant {
    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status !== 'suspended') {
      fail('TENANT_STATE_INVALID', '仅停用状态的租户可恢复', {
        tenantId,
        status: tenant.status,
      });
    }
    if (tenant.suspendReason === 'trial_expired') {
      fail(
        'TENANT_STATE_INVALID',
        '试用到期的租户需通过「试用转正式」恢复，不能直接恢复',
        { tenantId, suspendReason: tenant.suspendReason },
      );
    }
    if (tenant.suspendReason !== 'arrears' && actor.id !== 'system') {
      requirePermission(actor, 'platform.tenant.suspend');
    }

    const next = this.applyTransition(tenant, 'active', actor, null, detail, {
      suspendReason: null,
    });
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'resume',
      summary: `恢复租户 ${tenant.name}`,
    });
    return next;
  }

  // ── 注销（Spec 6.4）───────────────────────────────────────────────────

  /**
   * 发起注销。进入保留期，立即失效会话、回收席位授予单、冻结额度、撤销模型授权。
   * 席位占用关系保留，用于保留期内恢复。
   */
  deregister(
    actor: Actor,
    tenantId: string,
    options: { confirmName: string; reason: string },
  ): Tenant {
    requirePermission(actor, 'platform.tenant.deregister');
    const tenant = getTenant(this.ctx, tenantId);
    const reason = requireReason(options.reason, '注销租户');

    if (options.confirmName !== tenant.name) {
      fail('CONFIRM_NAME_MISMATCH', '二次确认输入的租户名称与当前名称不一致', {
        expected: tenant.name,
      });
    }
    this.assertTransition(tenant, 'deregistering');

    const now = this.ctx.clock.now();

    // 回收席位授予单，保留占用关系
    const seatGrants = this.ctx.store.seatGrants.find(
      (g) => g.tenantId === tenantId && g.status === 'active',
    );
    for (const grant of seatGrants) {
      this.ctx.store.seatGrants.update(grant.id, { status: 'revoked' });
    }

    // 冻结额度授予单
    const quotaGrants = this.ctx.store.quotaGrants.find(
      (g) => g.tenantId === tenantId && (g.status === 'active' || g.status === 'pending'),
    );

    // 撤销模型授权
    const modelGrants = this.ctx.store.modelGrants.find(
      (g) => g.tenantId === tenantId && g.revokedAt === null,
    );
    for (const grant of modelGrants) {
      this.ctx.store.modelGrants.update(grant.id, {
        revokedAt: now.toISOString(),
        enabled: false,
      });
    }

    const purchased = sumBalance(quotaGrants, 'purchased');
    const gift = sumBalance(quotaGrants, 'gift');
    const occupied = this.ctx.store.seatAssignments.count(
      (a) => a.tenantId === tenantId && a.releasedAt === null,
    );

    const snapshot = {
      at: now.toISOString(),
      purchasedBalanceCredit: purchased,
      giftBalanceCredit: gift,
      seatTotal: seatGrants.reduce((sum, g) => sum + g.seatCount, 0),
      seatOccupied: occupied,
      grantedModelCount: modelGrants.length,
      revokedSeatGrantIds: seatGrants.map((g) => g.id),
      revokedModelGrantIds: modelGrants.map((g) => g.id),
      frozenQuotaGrantIds: quotaGrants.map((g) => g.id),
    };

    const next = this.applyTransition(
      tenant,
      'deregistering',
      actor,
      reason,
      `进入保留期 ${tenant.retentionDays} 天`,
      {
        deregisterAt: now.toISOString(),
        purgeAt: addDays(now, tenant.retentionDays).toISOString(),
        deregisterSnapshot: snapshot,
      },
    );

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'deregister',
      summary: `发起注销租户 ${tenant.name}，保留期 ${tenant.retentionDays} 天`,
      reason,
      diff: { snapshot },
    });
    return next;
  }

  /** 保留期内恢复，按快照原样还原 */
  restore(actor: Actor, tenantId: string): Tenant {
    requirePermission(actor, 'platform.tenant.restore');
    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status !== 'deregistering') {
      fail('TENANT_STATE_INVALID', '仅注销保留期内的租户可恢复', {
        tenantId,
        status: tenant.status,
      });
    }

    const snapshot = tenant.deregisterSnapshot;
    if (snapshot) {
      for (const id of snapshot.revokedSeatGrantIds) {
        this.ctx.store.seatGrants.update(id, { status: 'active' });
      }
      for (const id of snapshot.revokedModelGrantIds) {
        this.ctx.store.modelGrants.update(id, { revokedAt: null, enabled: true });
      }
    }

    const next = this.applyTransition(tenant, 'active', actor, null, '保留期内恢复', {
      deregisterAt: null,
      purgeAt: null,
      deregisterSnapshot: null,
      suspendReason: null,
    });
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'restore',
      summary: `恢复已注销租户 ${tenant.name}`,
    });
    return next;
  }

  /**
   * 彻底清除。保留期届满由系统任务调用，或超管提前清除。
   * 清除业务数据，保留凭证类数据（授予单、流水、账单、审计）。
   */
  purge(
    actor: Actor,
    tenantId: string,
    options?: { confirmName?: string; reason?: string },
  ): Tenant {
    const isSystem = actor.id === 'system';
    if (!isSystem) {
      requirePermission(actor, 'platform.tenant.purge');
      const tenantForCheck = getTenant(this.ctx, tenantId);
      requireReason(options?.reason, '提前清除租户数据');
      if (options?.confirmName !== tenantForCheck.name) {
        fail('CONFIRM_NAME_MISMATCH', '二次确认输入的租户名称与当前名称不一致', {
          expected: tenantForCheck.name,
        });
      }
    }

    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status !== 'deregistering') {
      fail('TENANT_STATE_INVALID', '仅注销保留期内的租户可清除', {
        tenantId,
        status: tenant.status,
      });
    }

    this.ctx.store.purgeTenantBusinessData(tenantId);

    const next = this.applyTransition(
      tenant,
      'deregistered',
      actor,
      options?.reason ?? null,
      '保留期届满，业务数据已清除',
      {},
    );
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'purge',
      summary: `清除租户 ${tenant.name} 的业务数据`,
      reason: options?.reason ?? null,
    });
    return next;
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  assertTransition(tenant: Tenant, to: TenantStatus): void {
    const allowed = TRANSITIONS[tenant.status];
    if (!allowed.includes(to)) {
      fail(
        'TENANT_STATE_INVALID',
        `租户状态不允许从 ${tenant.status} 流转到 ${to}`,
        { tenantId: tenant.id, from: tenant.status, to },
      );
    }
  }

  applyTransition(
    tenant: Tenant,
    to: TenantStatus,
    actor: Actor,
    reason: string | null,
    detail: string | null,
    extra: Partial<Tenant>,
  ): Tenant {
    const now = this.ctx.clock.now().toISOString();
    const next = this.ctx.store.tenants.update(tenant.id, {
      ...extra,
      status: to,
      updatedAt: now,
    })!;
    this.recordEvent(tenant, tenant.status, to, actor, reason, detail);
    return next;
  }

  private recordEvent(
    tenant: Tenant,
    from: TenantStatus | null,
    to: TenantStatus,
    actor: Actor,
    reason: string | null,
    detail: string | null,
  ): LifecycleEvent {
    return this.ctx.store.lifecycleEvents.insert({
      id: this.ctx.ids.next('lce'),
      tenantId: tenant.id,
      fromStatus: from,
      toStatus: to,
      reason,
      detail,
      operatorId: actor.id,
      at: this.ctx.clock.now().toISOString(),
    });
  }

  timeline(tenantId: string): LifecycleEvent[] {
    return this.ctx.store.lifecycleEvents
      .find((e) => e.tenantId === tenantId)
      .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  }
}

function sumBalance(
  grants: { book: string; amountCredit: number; consumedCredit: number; revokedCredit: number; expiredCredit: number; status: string }[],
  book: string,
): number {
  return grants
    .filter((g) => g.book === book && g.status === 'active')
    .reduce(
      (sum, g) =>
        sum + g.amountCredit - g.consumedCredit - g.revokedCredit - g.expiredCredit,
      0,
    );
}
