// 组装。对外暴露 PlatformConsole 作为平台运营后台的应用服务门面。

import type { Actor, Tenant } from './domain/types.ts';
import { SYSTEM_ACTOR } from './domain/types.ts';
import type { Clock } from './domain/time.ts';
import { systemClock } from './domain/time.ts';
import { IdGenerator } from './domain/ids.ts';
import { fail } from './domain/errors.ts';
import { requirePermission } from './domain/rbac.ts';
import { Store } from './store/store.ts';
import { AuditService } from './services/audit.ts';
import { Notifier } from './services/notifier.ts';
import type { Ctx } from './services/context.ts';
import { TenantService } from './services/tenant.ts';
import type { CreateTenantInput } from './services/tenant.ts';
import { SeatService } from './services/seat.ts';
import { QuotaService } from './services/quota.ts';
import { ModelService } from './services/model.ts';
import { TrialService } from './services/trial.ts';
import { QueryService } from './services/query.ts';
import { ExportService } from './services/export.ts';
import { DailyJobs } from './jobs/daily.ts';

export interface FirstAdminInput {
  memberId: string;
  name: string;
  email: string;
}

/** Spec 6.2 开通方式 */
export type Provisioning =
  | { mode: 'none' }
  | { mode: 'trial'; planId: string }
  | {
      mode: 'active';
      seatCount: number;
      purchasedCredit: number;
      seatExpireAt?: string | null;
      modelGroups?: string[];
      modelCodes?: string[];
    };

export interface CreateTenantCommand extends CreateTenantInput {
  provisioning: Provisioning;
  firstAdmin: FirstAdminInput;
}

export class PlatformConsole {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  audit: AuditService;
  notifier: Notifier;
  ctx: Ctx;

  tenants: TenantService;
  seats: SeatService;
  quota: QuotaService;
  models: ModelService;
  trials: TrialService;
  query: QueryService;
  exports: ExportService;
  jobs: DailyJobs;

  constructor(clock: Clock = systemClock, store: Store = new Store()) {
    this.store = store;
    this.clock = clock;
    this.ids = new IdGenerator(clock);
    this.audit = new AuditService(store, clock, this.ids);
    this.notifier = new Notifier();
    this.ctx = {
      store: this.store,
      clock: this.clock,
      ids: this.ids,
      audit: this.audit,
      notifier: this.notifier,
    };

    this.tenants = new TenantService(this.ctx);
    this.seats = new SeatService(this.ctx);
    this.quota = new QuotaService(this.ctx, this.tenants);
    this.models = new ModelService(this.ctx);
    this.trials = new TrialService(
      this.ctx,
      this.tenants,
      this.seats,
      this.quota,
      this.models,
    );
    this.query = new QueryService(this.ctx, this.seats, this.quota, this.models);
    this.exports = new ExportService(
      this.ctx,
      this.seats,
      this.quota,
      this.audit,
      this.query,
    );
    this.jobs = new DailyJobs(
      this.ctx,
      this.tenants,
      this.seats,
      this.quota,
      this.trials,
    );
  }

  /**
   * 创建租户并按开通方式下发资源（Spec 6.2）。
   * 首个管理员默认占用一个席位；初始席位数为 0 时拒绝创建。
   */
  createTenant(actor: Actor, command: CreateTenantCommand): Tenant {
    // 顺序固定为「权限 → 入参结构 → 业务规则」，
    // 否则缺字段会先抛 TypeError，把 403 盖成 500。
    requirePermission(actor, 'platform.tenant.create');

    const { provisioning, firstAdmin, ...base } = command ?? {};

    if (!provisioning || typeof provisioning.mode !== 'string') {
      fail('VALIDATION_ERROR', 'provisioning.mode 必填，取值 none / trial / active', {
        field: 'provisioning',
      });
    }
    if (provisioning.mode !== 'none' && !firstAdmin?.memberId) {
      fail('VALIDATION_ERROR', '开通资源时必须指定首个租户管理员', {
        field: 'firstAdmin',
      });
    }

    if (provisioning.mode === 'active' && provisioning.seatCount <= 0) {
      fail('VALIDATION_ERROR', '直接开通正式时初始席位数必须大于 0', {
        seatCount: provisioning.seatCount,
      });
    }
    if (provisioning.mode === 'trial') {
      const plan = this.store.trialPlans.get(provisioning.planId);
      if (!plan) {
        fail('TRIAL_PLAN_NOT_FOUND', `试用套餐 ${provisioning.planId} 不存在`, {
          planId: provisioning.planId,
        });
      }
      if (plan.seatCount <= 0) {
        fail('VALIDATION_ERROR', '试用套餐的席位数必须大于 0', {
          planId: provisioning.planId,
        });
      }
    }

    const tenant = this.tenants.create(actor, base);

    if (provisioning.mode === 'trial') {
      this.trials.open(actor, tenant.id, provisioning.planId);
    } else if (provisioning.mode === 'active') {
      this.seats.grant(SYSTEM_ACTOR, tenant.id, {
        seatCount: provisioning.seatCount,
        source: 'contract',
        expireAt: provisioning.seatExpireAt ?? base.contractEndAt ?? null,
        contractNo: base.contractNo ?? null,
        remark: '开通正式',
      });
      if (provisioning.purchasedCredit > 0) {
        this.quota.grant(SYSTEM_ACTOR, tenant.id, {
          amountCredit: provisioning.purchasedCredit,
          source: 'contract',
          contractNo: base.contractNo ?? null,
          reason: '开通正式',
        });
      }
      for (const group of provisioning.modelGroups ?? []) {
        this.models.grantGroup(SYSTEM_ACTOR, tenant.id, group);
      }
      for (const code of provisioning.modelCodes ?? []) {
        this.models.grantModel(SYSTEM_ACTOR, tenant.id, { modelCode: code });
      }
      this.tenants.activate(actor, tenant.id);
    }

    // 首个管理员占用一个席位（仅在已下发资源时）
    if (provisioning.mode !== 'none') {
      this.seats.assign(tenant.id, {
        memberId: firstAdmin.memberId,
        memberName: firstAdmin.name,
        memberEmail: firstAdmin.email,
        isAdmin: true,
      });
      this.audit.record({
        actor,
        tenantId: tenant.id,
        objectType: 'tenant_admin',
        objectId: firstAdmin.memberId,
        action: 'set_first_admin',
        summary: `设置 ${firstAdmin.email} 为 ${tenant.name} 的首个管理员`,
      });
    }

    return this.store.tenants.get(tenant.id)!;
  }
}
