// 席位管理与分发。对应 Spec 第 7 章。
//
// 核心约定：租户席位总数不是一个可直接编辑的数字，而是「有效授予单数量之和」。
// 扩容永远是新建授予单，不修改已有单，这样每批席位的到期时间互相独立。

import type {
  Actor,
  ReduceStrategy,
  SeatAssignment,
  SeatGrant,
  SeatGrantSource,
  SeatReleaseReason,
  Tenant,
} from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { assertGrantable, getTenant, withIdempotency } from './context.ts';
import { fail, requireReason } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { addDays } from '../domain/time.ts';

export interface GrantSeatInput {
  seatCount: number;
  source?: SeatGrantSource;
  effectiveAt?: string;
  expireAt?: string | null;
  contractNo?: string | null;
  remark?: string | null;
  reason?: string | null;
  idempotencyKey?: string | null;
}

export interface SeatOverview {
  seatTotal: number;
  occupied: number;
  remaining: number;
  /** 占用率，seatTotal 为 0 时返回 0 */
  occupancyRate: number;
  oversold: boolean;
  /** 30 天内到期的席位数 */
  expiringSoon: number;
  /** 已过期但仍在宽限期内的席位数 */
  inGrace: number;
}

export interface ReduceResult {
  grant: SeatGrant;
  strategy: ReduceStrategy;
  /** 策略 C 实际强制释放的占用 */
  released: SeatAssignment[];
  /** 策略 B 记录的延期生效目标 */
  deferredTo: number | null;
}

export class SeatService {
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  // ── 总量计算（Spec 7.1）───────────────────────────────────────────────

  /**
   * 有效席位总数。宽限期内的已过期授予单仍然计入（Spec 7.5）。
   */
  seatTotal(tenantId: string, at?: Date): number {
    const tenant = getTenant(this.ctx, tenantId);
    const now = at ?? this.ctx.clock.now();
    return this.effectiveGrants(tenant, now).reduce(
      (sum, g) => sum + g.seatCount,
      0,
    );
  }

  effectiveGrants(tenant: Tenant, at: Date): SeatGrant[] {
    return this.ctx.store.seatGrants.find((g) => {
      if (g.tenantId !== tenant.id) return false;
      if (g.status !== 'active') return false;
      if (new Date(g.effectiveAt).getTime() > at.getTime()) return false;
      if (g.expireAt === null) return true;
      // 到期后进入宽限期，宽限期内仍计入总数
      const graceEnd = addDays(new Date(g.expireAt), tenant.seatGraceDays);
      return at.getTime() < graceEnd.getTime();
    });
  }

  occupiedCount(tenantId: string): number {
    return this.ctx.store.seatAssignments.count(
      (a) => a.tenantId === tenantId && a.releasedAt === null,
    );
  }

  /** 含超卖软限后的实际可占用上限（Spec 7.5） */
  assignableLimit(tenant: Tenant, at?: Date): number {
    const total = this.seatTotal(tenant.id, at);
    if (tenant.seatOversellPercent === null) return total;
    return Math.floor(total * (1 + tenant.seatOversellPercent / 100));
  }

  overview(tenantId: string, at?: Date): SeatOverview {
    const tenant = getTenant(this.ctx, tenantId);
    const now = at ?? this.ctx.clock.now();
    const grants = this.effectiveGrants(tenant, now);
    const seatTotal = grants.reduce((sum, g) => sum + g.seatCount, 0);
    const occupied = this.occupiedCount(tenantId);
    const soon = addDays(now, 30);

    let expiringSoon = 0;
    let inGrace = 0;
    for (const g of grants) {
      if (g.expireAt === null) continue;
      const expire = new Date(g.expireAt);
      if (expire.getTime() <= now.getTime()) {
        inGrace += g.seatCount;
      } else if (expire.getTime() <= soon.getTime()) {
        expiringSoon += g.seatCount;
      }
    }

    return {
      seatTotal,
      occupied,
      remaining: seatTotal - occupied,
      occupancyRate: seatTotal === 0 ? 0 : occupied / seatTotal,
      oversold: occupied > seatTotal,
      expiringSoon,
      inGrace,
    };
  }

  // ── 平台侧操作（Spec 7.2）─────────────────────────────────────────────

  /** 分发 / 扩容：永远新建授予单 */
  grant(actor: Actor, tenantId: string, input: GrantSeatInput): SeatGrant {
    requirePermission(actor, 'platform.seat.grant');
    const tenant = getTenant(this.ctx, tenantId);
    assertGrantable(tenant);

    if (!Number.isInteger(input.seatCount) || input.seatCount <= 0) {
      fail('VALIDATION_ERROR', '席位数量必须是正整数', {
        seatCount: input.seatCount,
      });
    }

    const source = input.source ?? 'contract';
    const expireAt = input.expireAt ?? null;
    // 只有合同采购允许永久席位（Spec 7.1）
    if (expireAt === null && source !== 'contract') {
      fail('VALIDATION_ERROR', '仅 contract 来源的席位授予单允许永久有效', {
        source,
      });
    }

    const now = this.ctx.clock.now();
    const effectiveAt = input.effectiveAt ?? now.toISOString();
    if (expireAt !== null && new Date(expireAt).getTime() <= new Date(effectiveAt).getTime()) {
      fail('VALIDATION_ERROR', '到期时间必须晚于生效时间', { effectiveAt, expireAt });
    }

    const fingerprint = `seat.grant:${tenantId}:${input.seatCount}:${source}:${effectiveAt}:${expireAt}`;
    return withIdempotency(
      this.ctx,
      input.idempotencyKey,
      fingerprint,
      () => {
        const record: SeatGrant = {
          id: this.ctx.ids.next('sg'),
          no: this.ctx.ids.seatGrantNo(),
          tenantId,
          seatCount: input.seatCount,
          seatType: 'standard',
          source,
          effectiveAt,
          expireAt,
          status: 'active',
          contractNo: input.contractNo ?? null,
          remark: input.remark ?? null,
          pendingReduceTo: null,
          pendingReduceAt: null,
          operatorId: actor.id,
          reason: input.reason ?? null,
          createdAt: now.toISOString(),
        };
        this.ctx.store.seatGrants.insert(record);
        this.ctx.audit.record({
          actor,
          tenantId,
          objectType: 'seat_grant',
          objectId: record.id,
          action: 'grant',
          summary: `向 ${tenant.name} 分发 ${input.seatCount} 个席位（${record.no}）`,
          reason: input.reason ?? null,
        });
        return record;
      },
      (id) => this.ctx.store.seatGrants.get(id),
    );
  }

  /**
   * 缩容。目标数低于当前占用时触发冲突，按策略处理（Spec 7.4）。
   */
  reduce(
    actor: Actor,
    grantId: string,
    targetCount: number,
    options: { strategy?: ReduceStrategy; reason: string; confirmedMemberIds?: string[] },
  ): ReduceResult {
    requirePermission(actor, 'platform.seat.reduce');
    const grant = this.mustGrant(grantId);
    const tenant = getTenant(this.ctx, grant.tenantId);
    const reason = requireReason(options.reason, '缩容席位');

    if (!Number.isInteger(targetCount) || targetCount < 0) {
      fail('VALIDATION_ERROR', '缩容目标必须是非负整数', { targetCount });
    }
    if (targetCount > grant.seatCount) {
      fail('VALIDATION_ERROR', '缩容不能增加席位数，扩容请新建授予单', {
        current: grant.seatCount,
        targetCount,
      });
    }

    const strategy = options.strategy ?? tenant.seatReduceStrategy;
    const now = this.ctx.clock.now();
    const delta = grant.seatCount - targetCount;
    const totalAfter = this.seatTotal(tenant.id, now) - delta;
    const occupied = this.occupiedCount(tenant.id);

    // 不冲突，直接生效
    if (occupied <= totalAfter) {
      return {
        grant: this.applyReduce(actor, grant, targetCount, reason, tenant.name),
        strategy,
        released: [],
        deferredTo: null,
      };
    }

    if (strategy === 'reject') {
      fail(
        'SEAT_REDUCE_CONFLICT',
        `缩容后席位总数 ${totalAfter} 低于当前占用 ${occupied}，需先释放 ${occupied - totalAfter} 个席位`,
        {
          grantId,
          targetCount,
          seatTotalAfter: totalAfter,
          occupied,
          mustRelease: occupied - totalAfter,
        },
      );
    }

    if (strategy === 'defer') {
      // 不改 seatCount，记录延期生效意图，到期由每日任务重新评估
      const updated = this.ctx.store.seatGrants.update(grantId, {
        pendingReduceTo: targetCount,
        pendingReduceAt: grant.expireAt ?? addDays(now, tenant.seatGraceDays).toISOString(),
      })!;
      this.ctx.audit.record({
        actor,
        tenantId: tenant.id,
        objectType: 'seat_grant',
        objectId: grantId,
        action: 'reduce_defer',
        summary: `${grant.no} 登记延期缩容至 ${targetCount}，生效时间 ${updated.pendingReduceAt}`,
        reason,
      });
      return { grant: updated, strategy, released: [], deferredTo: targetCount };
    }

    // strategy === 'force'：仅超管，需确认名单
    requirePermission(actor, 'platform.seat.force_release');
    const need = occupied - totalAfter;
    const candidates = this.recoveryCandidates(tenant.id);

    if (candidates.length < need) {
      fail(
        'SEAT_ADMIN_PROTECTED',
        `需回收 ${need} 个席位，但可回收的非管理员席位只有 ${candidates.length} 个`,
        { need, available: candidates.length },
      );
    }

    const victims = candidates.slice(0, need);
    if (options.confirmedMemberIds) {
      const expected = new Set(victims.map((v) => v.memberId));
      const confirmed = new Set(options.confirmedMemberIds);
      const match =
        expected.size === confirmed.size &&
        [...expected].every((id) => confirmed.has(id));
      if (!match) {
        fail('VALIDATION_ERROR', '确认的回收名单与系统计算结果不一致，请刷新后重试', {
          expected: [...expected],
          confirmed: [...confirmed],
        });
      }
    }

    const released: SeatAssignment[] = [];
    for (const victim of victims) {
      released.push(this.releaseAssignment(victim.id, 'force_released', now));
    }

    const updated = this.applyReduce(actor, grant, targetCount, reason, tenant.name);

    this.ctx.notifier.send({
      kind: 'seat.force_released',
      tenantId: tenant.id,
      recipients: ['tenant_admin'],
      channels: ['email', 'inbox'],
      subject: `${released.length} 个席位已被回收`,
      payload: {
        members: released.map((r) => ({
          memberId: r.memberId,
          name: r.memberName,
          email: r.memberEmail,
          lastActiveAt: r.lastActiveAt,
        })),
      },
      at: now.toISOString(),
    });

    this.ctx.audit.record({
      actor,
      tenantId: tenant.id,
      objectType: 'seat_grant',
      objectId: grantId,
      action: 'reduce_force',
      summary: `${grant.no} 强制缩容至 ${targetCount}，回收 ${released.length} 个占用`,
      reason,
      diff: { released: released.map((r) => r.memberEmail) },
    });

    return { grant: updated, strategy, released, deferredTo: null };
  }

  /** 回收整张授予单，等价于缩容到 0 */
  revoke(
    actor: Actor,
    grantId: string,
    options: { strategy?: ReduceStrategy; reason: string; confirmedMemberIds?: string[] },
  ): ReduceResult {
    requirePermission(actor, 'platform.seat.revoke');
    const result = this.reduce(actor, grantId, 0, options);
    const updated = this.ctx.store.seatGrants.update(grantId, {
      status: result.deferredTo === null ? 'revoked' : result.grant.status,
    })!;
    return { ...result, grant: updated };
  }

  /** 续期：只能往后延 */
  renew(actor: Actor, grantId: string, newExpireAt: string | null): SeatGrant {
    requirePermission(actor, 'platform.seat.renew');
    const grant = this.mustGrant(grantId);

    if (newExpireAt !== null && grant.expireAt !== null) {
      if (new Date(newExpireAt).getTime() <= new Date(grant.expireAt).getTime()) {
        fail('SEAT_RENEW_BACKWARDS', '续期只能延后到期时间，提前到期请使用缩容或回收', {
          current: grant.expireAt,
          requested: newExpireAt,
        });
      }
    }
    if (newExpireAt === null && grant.source !== 'contract') {
      fail('VALIDATION_ERROR', '仅 contract 来源的席位授予单允许永久有效', {
        source: grant.source,
      });
    }

    const updated = this.ctx.store.seatGrants.update(grantId, {
      expireAt: newExpireAt,
      status: 'active',
      pendingReduceTo: null,
      pendingReduceAt: null,
    })!;
    this.ctx.audit.record({
      actor,
      tenantId: grant.tenantId,
      objectType: 'seat_grant',
      objectId: grantId,
      action: 'renew',
      summary: `${grant.no} 续期至 ${newExpireAt ?? '永久'}`,
      diff: { from: grant.expireAt, to: newExpireAt },
    });
    return updated;
  }

  // ── 占用与释放（Spec 7.3）─────────────────────────────────────────────

  /**
   * 占用席位。由租户侧创建成员时触发，平台侧只在此校验席位不变式。
   */
  assign(
    tenantId: string,
    member: {
      memberId: string;
      memberName: string;
      memberEmail: string;
      teamId?: string | null;
      isAdmin?: boolean;
      lastActiveAt?: string | null;
    },
  ): SeatAssignment {
    const tenant = getTenant(this.ctx, tenantId);
    if (tenant.status === 'deregistering' || tenant.status === 'deregistered') {
      fail('TENANT_STATE_INVALID', '注销中或已注销的租户不能占用席位', {
        tenantId,
        status: tenant.status,
      });
    }

    const existing = this.ctx.store.seatAssignments.first(
      (a) => a.tenantId === tenantId && a.memberId === member.memberId && a.releasedAt === null,
    );
    if (existing) {
      fail('SEAT_ALREADY_ASSIGNED', '该成员已占用席位', {
        memberId: member.memberId,
      });
    }

    const now = this.ctx.clock.now();
    const limit = this.assignableLimit(tenant, now);
    const occupied = this.occupiedCount(tenantId);
    if (occupied >= limit) {
      fail(
        'SEAT_INSUFFICIENT',
        `席位不足：已占用 ${occupied}，可占用上限 ${limit}。已达平台授予上限，请联系服务方扩容`,
        { occupied, limit, seatTotal: this.seatTotal(tenantId, now) },
      );
    }

    const record: SeatAssignment = {
      id: this.ctx.ids.next('sa'),
      tenantId,
      memberId: member.memberId,
      memberName: member.memberName,
      memberEmail: member.memberEmail,
      teamId: member.teamId ?? null,
      isAdmin: member.isAdmin ?? false,
      boundAt: now.toISOString(),
      lastActiveAt: member.lastActiveAt ?? null,
      memberStatus: 'active',
      releasedAt: null,
      releaseReason: null,
    };
    this.ctx.store.seatAssignments.insert(record);

    // 超卖时提示平台侧（Spec 7.5）
    const seatTotal = this.seatTotal(tenantId, now);
    if (occupied + 1 > seatTotal) {
      this.ctx.notifier.send({
        kind: 'seat.oversell',
        tenantId,
        recipients: ['owner_sales', 'platform_ops'],
        channels: ['inbox'],
        subject: `${tenant.name} 席位超卖`,
        payload: { occupied: occupied + 1, seatTotal, limit },
        at: now.toISOString(),
      });
    }

    return record;
  }

  /** 成员停用：仍占用席位（Spec 7.3） */
  disableMember(tenantId: string, memberId: string): SeatAssignment {
    const assignment = this.mustAssignment(tenantId, memberId);
    return this.ctx.store.seatAssignments.update(assignment.id, {
      memberStatus: 'disabled',
    })!;
  }

  enableMember(tenantId: string, memberId: string): SeatAssignment {
    const assignment = this.mustAssignment(tenantId, memberId);
    return this.ctx.store.seatAssignments.update(assignment.id, {
      memberStatus: 'active',
    })!;
  }

  touchActivity(tenantId: string, memberId: string, at?: Date): SeatAssignment {
    const assignment = this.mustAssignment(tenantId, memberId);
    return this.ctx.store.seatAssignments.update(assignment.id, {
      lastActiveAt: (at ?? this.ctx.clock.now()).toISOString(),
    })!;
  }

  /** 释放席位：成员删除、离职同步触发 */
  release(
    tenantId: string,
    memberId: string,
    reason: SeatReleaseReason = 'member_deleted',
  ): SeatAssignment {
    const assignment = this.mustAssignment(tenantId, memberId);
    return this.releaseAssignment(assignment.id, reason, this.ctx.clock.now());
  }

  /** 平台强制释放，仅超管（Spec 7.3） */
  forceRelease(
    actor: Actor,
    tenantId: string,
    memberId: string,
    reasonText: string,
  ): SeatAssignment {
    requirePermission(actor, 'platform.seat.force_release');
    const reason = requireReason(reasonText, '强制释放席位');
    const assignment = this.mustAssignment(tenantId, memberId);

    if (assignment.isAdmin) {
      fail('SEAT_ADMIN_PROTECTED', '企业管理员的席位不能被强制释放', {
        memberId,
      });
    }

    const released = this.releaseAssignment(
      assignment.id,
      'force_released',
      this.ctx.clock.now(),
    );
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'seat_assignment',
      objectId: assignment.id,
      action: 'force_release',
      summary: `强制释放 ${assignment.memberEmail} 的席位`,
      reason,
    });
    return released;
  }

  assignments(tenantId: string, includeReleased = false): SeatAssignment[] {
    return this.ctx.store.seatAssignments.find(
      (a) => a.tenantId === tenantId && (includeReleased || a.releasedAt === null),
    );
  }

  grants(tenantId: string, statuses?: SeatGrant['status'][]): SeatGrant[] {
    return this.ctx.store.seatGrants
      .find(
        (g) =>
          g.tenantId === tenantId &&
          (statuses === undefined || statuses.includes(g.status)),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
  }

  /**
   * 强制回收候选，按 Spec 7.4 的顺序排列。
   * 企业管理员不进入候选池。
   */
  recoveryCandidates(tenantId: string): SeatAssignment[] {
    return this.assignments(tenantId)
      .filter((a) => !a.isAdmin)
      .sort((a, b) => {
        // 1 & 2：从未登录（null）视为最早，优先回收
        const ta = a.lastActiveAt === null ? -Infinity : new Date(a.lastActiveAt).getTime();
        const tb = b.lastActiveAt === null ? -Infinity : new Date(b.lastActiveAt).getTime();
        if (ta !== tb) return ta - tb;
        // 3：非管理员优先（此处已过滤管理员，保留比较以防候选池规则放宽）
        if (a.isAdmin !== b.isAdmin) return a.isAdmin ? 1 : -1;
        // 4：创建时间最晚的优先
        return new Date(b.boundAt).getTime() - new Date(a.boundAt).getTime();
      });
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private applyReduce(
    actor: Actor,
    grant: SeatGrant,
    targetCount: number,
    reason: string,
    tenantName: string,
  ): SeatGrant {
    const updated = this.ctx.store.seatGrants.update(grant.id, {
      seatCount: targetCount,
      status: targetCount === 0 ? 'revoked' : grant.status,
      pendingReduceTo: null,
      pendingReduceAt: null,
    })!;
    this.ctx.audit.record({
      actor,
      tenantId: grant.tenantId,
      objectType: 'seat_grant',
      objectId: grant.id,
      action: 'reduce',
      summary: `${tenantName} 的 ${grant.no} 席位数 ${grant.seatCount} → ${targetCount}`,
      reason,
      diff: { seatCount: { from: grant.seatCount, to: targetCount } },
    });
    return updated;
  }

  releaseAssignment(
    assignmentId: string,
    reason: SeatReleaseReason,
    at: Date,
  ): SeatAssignment {
    return this.ctx.store.seatAssignments.update(assignmentId, {
      releasedAt: at.toISOString(),
      releaseReason: reason,
    })!;
  }

  private mustGrant(grantId: string): SeatGrant {
    const grant = this.ctx.store.seatGrants.get(grantId);
    if (!grant) {
      fail('SEAT_GRANT_NOT_FOUND', `席位授予单 ${grantId} 不存在`, { grantId });
    }
    return grant;
  }

  private mustAssignment(tenantId: string, memberId: string): SeatAssignment {
    const assignment = this.ctx.store.seatAssignments.first(
      (a) => a.tenantId === tenantId && a.memberId === memberId && a.releasedAt === null,
    );
    if (!assignment) {
      fail('SEAT_ASSIGNMENT_NOT_FOUND', `成员 ${memberId} 没有占用中的席位`, {
        tenantId,
        memberId,
      });
    }
    return assignment;
  }
}
