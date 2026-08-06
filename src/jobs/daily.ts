// 每日任务。对应 Spec 7.5（宽限期届满）、8.3（赠送额度清零、出账）、
// 10.4（试用到期提醒与处理）、6.4（保留期届满清除）。

import type { Tenant } from '../domain/types.ts';
import { SYSTEM_ACTOR } from '../domain/types.ts';
import type { Ctx } from './../services/context.ts';
import type { TenantService } from '../services/tenant.ts';
import type { SeatService } from '../services/seat.ts';
import type { QuotaService } from '../services/quota.ts';
import type { TrialService } from '../services/trial.ts';
import { addDays, diffDays, partsInZone, periodOf, prevPeriod } from '../domain/time.ts';

/** 试用到期提醒的提前天数（Spec 10.4） */
export const TRIAL_REMINDER_DAYS = [7, 3, 1];

export interface DailyReport {
  at: string;
  seatGrantsExpired: number;
  deferredReductionsApplied: number;
  tenantsFrozenForSeatOverflow: string[];
  giftCreditExpired: number;
  trialsReminded: number;
  trialsExpired: string[];
  periodsClosed: number;
  tenantsPurged: string[];
}

export class DailyJobs {
  private ctx: Ctx;
  private tenants: TenantService;
  private seats: SeatService;
  private quota: QuotaService;
  private trials: TrialService;

  constructor(
    ctx: Ctx,
    tenants: TenantService,
    seats: SeatService,
    quota: QuotaService,
    trials: TrialService,
  ) {
    this.ctx = ctx;
    this.tenants = tenants;
    this.seats = seats;
    this.quota = quota;
    this.trials = trials;
  }

  run(at?: Date): DailyReport {
    const now = at ?? this.ctx.clock.now();
    const report: DailyReport = {
      at: now.toISOString(),
      seatGrantsExpired: 0,
      deferredReductionsApplied: 0,
      tenantsFrozenForSeatOverflow: [],
      giftCreditExpired: 0,
      trialsReminded: 0,
      trialsExpired: [],
      periodsClosed: 0,
      tenantsPurged: [],
    };

    for (const tenant of this.ctx.store.tenants.all()) {
      if (tenant.status === 'deregistered') continue;

      this.expireSeatGrants(tenant, now, report);
      this.applyDeferredReductions(tenant, now, report);
      this.handleSeatOverflow(tenant, now, report);
      report.giftCreditExpired += this.quota.expireGifts(tenant.id, now);
      this.closeDuePeriod(tenant, now, report);
      this.handleTrial(tenant, now, report);
      this.purgeIfDue(tenant, now, report);
    }

    return report;
  }

  // ── 席位宽限期届满（Spec 7.5）───────────────────────────────────────

  private expireSeatGrants(tenant: Tenant, now: Date, report: DailyReport): void {
    for (const grant of this.seats.grants(tenant.id, ['active'])) {
      if (grant.expireAt === null) continue;
      const graceEnd = addDays(new Date(grant.expireAt), tenant.seatGraceDays);
      if (now.getTime() < graceEnd.getTime()) {
        // 宽限期内：提示剩余天数
        if (new Date(grant.expireAt).getTime() <= now.getTime()) {
          this.ctx.notifier.send({
            kind: 'seat.grace_expiring',
            tenantId: tenant.id,
            recipients: ['owner_sales', 'platform_ops'],
            channels: ['inbox'],
            subject: `${tenant.name} 有 ${grant.seatCount} 个席位已过期`,
            payload: {
              grantNo: grant.no,
              seatCount: grant.seatCount,
              graceRemainingDays: Math.ceil(diffDays(graceEnd, now)),
            },
            at: now.toISOString(),
          });
        }
        continue;
      }
      this.ctx.store.seatGrants.update(grant.id, { status: 'expired' });
      report.seatGrantsExpired += 1;
    }
  }

  /** 策略 B：延期生效的缩容到点后重新评估 */
  private applyDeferredReductions(tenant: Tenant, now: Date, report: DailyReport): void {
    for (const grant of this.seats.grants(tenant.id, ['active'])) {
      if (grant.pendingReduceTo === null || grant.pendingReduceAt === null) continue;
      if (now.getTime() < new Date(grant.pendingReduceAt).getTime()) continue;

      this.ctx.store.seatGrants.update(grant.id, {
        seatCount: grant.pendingReduceTo,
        status: grant.pendingReduceTo === 0 ? 'revoked' : grant.status,
        pendingReduceTo: null,
        pendingReduceAt: null,
      });
      this.ctx.audit.record({
        actor: SYSTEM_ACTOR,
        tenantId: tenant.id,
        objectType: 'seat_grant',
        objectId: grant.id,
        action: 'reduce_deferred_applied',
        summary: `${grant.no} 延期缩容生效：${grant.seatCount} → ${grant.pendingReduceTo}`,
      });
      report.deferredReductionsApplied += 1;
    }
  }

  /**
   * 宽限期届满后仍超限：不强制回收，冻结超出部分的成员登录，
   * 并置租户为 suspended 需人工介入（Spec 7.5）。
   */
  private handleSeatOverflow(tenant: Tenant, now: Date, report: DailyReport): void {
    const current = this.ctx.store.tenants.get(tenant.id)!;
    if (current.status !== 'active' && current.status !== 'trialing') return;

    const total = this.seats.seatTotal(tenant.id, now);
    const occupied = this.seats.occupiedCount(tenant.id);
    const excess = occupied - total;
    if (excess <= 0) return;

    const candidates = this.seats
      .recoveryCandidates(tenant.id)
      .filter((a) => a.memberStatus === 'active');
    const frozen = candidates.slice(0, excess);
    for (const assignment of frozen) {
      this.ctx.store.seatAssignments.update(assignment.id, {
        memberStatus: 'disabled',
      });
    }

    this.tenants.suspend(
      SYSTEM_ACTOR,
      tenant.id,
      'manual',
      `席位宽限期届满后仍超限 ${excess} 个，已冻结超出成员，需人工介入处理`,
    );
    report.tenantsFrozenForSeatOverflow.push(tenant.id);
  }

  // ── 出账（Spec 8.3）─────────────────────────────────────────────────

  /** 次月 1 日 02:00 触发上一账期出账 */
  private closeDuePeriod(tenant: Tenant, now: Date, report: DailyReport): void {
    const parts = partsInZone(now, tenant.timezone);
    if (parts.day !== 1 || parts.hour < 2) return;

    const target = prevPeriod(periodOf(now, tenant.timezone));
    const existing = this.quota.billingPeriod(tenant.id, target);
    if (existing?.status === 'closed') return;

    this.quota.closePeriod(SYSTEM_ACTOR, tenant.id, target);
    report.periodsClosed += 1;
  }

  // ── 试用（Spec 10.4）────────────────────────────────────────────────

  private handleTrial(tenant: Tenant, now: Date, report: DailyReport): void {
    const current = this.ctx.store.tenants.get(tenant.id)!;
    if (current.status !== 'trialing' || current.trialExpireAt === null) return;

    const expire = new Date(current.trialExpireAt);
    if (expire.getTime() <= now.getTime()) {
      this.trials.expireTrial(current);
      report.trialsExpired.push(tenant.id);
      return;
    }

    const remaining = Math.ceil(diffDays(expire, now));
    if (TRIAL_REMINDER_DAYS.includes(remaining)) {
      this.ctx.notifier.send({
        kind: 'trial.expiring',
        tenantId: tenant.id,
        recipients: ['tenant_admin', 'owner_sales', 'platform_ops'],
        channels: ['email'],
        subject: `${current.name} 试用将在 ${remaining} 天后到期`,
        payload: { remainingDays: remaining, expireAt: current.trialExpireAt },
        at: now.toISOString(),
      });
      report.trialsReminded += 1;
    }
  }

  // ── 保留期届满清除（Spec 6.4）───────────────────────────────────────

  private purgeIfDue(tenant: Tenant, now: Date, report: DailyReport): void {
    const current = this.ctx.store.tenants.get(tenant.id)!;
    if (current.status !== 'deregistering' || current.purgeAt === null) return;
    if (now.getTime() < new Date(current.purgeAt).getTime()) return;

    this.tenants.purge(SYSTEM_ACTOR, tenant.id);
    report.tenantsPurged.push(tenant.id);
  }
}
