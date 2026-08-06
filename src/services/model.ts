// 平台模型目录与租户授权。对应 Spec 第 9 章。
//
// 边界：平台管「有哪些模型可用」和「限额上限」，租户侧管「怎么路由」和「可否收紧」。

import type {
  Actor,
  CatalogModel,
  ModelCapability,
  ModelGroupFollow,
  ModelStatus,
  ModelVendor,
  Tenant,
  TenantModelGrant,
  TenantModelLimits,
} from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { assertGrantable, getTenant } from './context.ts';
import { fail, requireReason } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import { diffDays, periodOf } from '../domain/time.ts';

/** 下线前必须给足的通知天数（Spec 9.1 第 4 条） */
export const OFFLINE_NOTICE_DAYS = 30;

export interface CreateModelInput {
  code: string;
  displayName: string;
  channel: string;
  vendor: ModelVendor;
  capabilities?: ModelCapability[];
  priceMultiplier?: number;
  group: string;
}

export interface GrantModelInput {
  modelCode: string;
  isDefault?: boolean;
  expireAt?: string | null;
  tpm?: number | null;
  rpm?: number | null;
  concurrency?: number | null;
  modelQuotaCapCredit?: number | null;
}

export interface EffectiveLimits {
  tpm: number | null;
  rpm: number | null;
  concurrency: number | null;
  modelQuotaCapCredit: number | null;
}

export class ModelService {
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  // ── 模型目录（Spec 9.1）──────────────────────────────────────────────

  createModel(actor: Actor, input: CreateModelInput): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.create');
    if (this.ctx.store.catalog.get(input.code)) {
      fail('VALIDATION_ERROR', `模型编码 ${input.code} 已存在`, { code: input.code });
    }
    const now = this.ctx.clock.now().toISOString();
    return this.ctx.store.catalog.insert({
      code: input.code,
      displayName: input.displayName,
      channel: input.channel,
      vendor: input.vendor,
      capabilities: input.capabilities ?? ['chat'],
      priceMultiplier: input.priceMultiplier ?? 1,
      group: input.group,
      status: 'draft',
      publishedAt: null,
      offlineAt: null,
      createdAt: now,
    });
  }

  editModel(
    actor: Actor,
    code: string,
    patch: Partial<Omit<CatalogModel, 'code' | 'status' | 'createdAt'>>,
  ): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.edit');
    this.mustModel(code);
    const updated = this.ctx.store.catalog.update(code, patch)!;
    this.ctx.audit.record({
      actor,
      objectType: 'model_catalog',
      objectId: code,
      action: 'edit',
      summary: `编辑模型目录 ${code}`,
      diff: patch as Record<string, unknown>,
    });
    return updated;
  }

  /** 上架。上架后分组跟随者自动获得授权 */
  publish(actor: Actor, code: string): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.publish');
    const model = this.mustModel(code);
    if (model.status === 'offline') {
      fail('MODEL_OFFLINE', '已下线的模型不能重新上架，请新建目录条目', { code });
    }
    const now = this.ctx.clock.now();
    const updated = this.ctx.store.catalog.update(code, {
      status: 'published',
      publishedAt: model.publishedAt ?? now.toISOString(),
    })!;

    // 分组跟随：该分组的跟随者自动授权（Spec 9.2 批量授权第 1 条）
    const followers = this.ctx.store.modelGroupFollows.find(
      (f) => f.group === updated.group,
    );
    for (const follow of followers) {
      const existing = this.activeGrant(follow.tenantId, code);
      if (!existing) {
        this.insertGrant(follow.tenantId, code, 'group', updated.group, {});
      }
    }

    this.ctx.audit.record({
      actor,
      objectType: 'model_catalog',
      objectId: code,
      action: 'publish',
      summary: `上架模型 ${code}，同步授权 ${followers.length} 个跟随分组的租户`,
    });
    return updated;
  }

  /** 标记弃用：已授权租户继续可用，禁止新授权 */
  deprecate(actor: Actor, code: string): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.publish');
    const model = this.mustModel(code);
    if (model.status !== 'published') {
      fail('MODEL_NOT_PUBLISHED', '仅已上架的模型可标记弃用', {
        code,
        status: model.status,
      });
    }
    const updated = this.ctx.store.catalog.update(code, { status: 'deprecated' })!;
    this.ctx.audit.record({
      actor,
      objectType: 'model_catalog',
      objectId: code,
      action: 'deprecate',
      summary: `标记模型 ${code} 为弃用`,
    });
    return updated;
  }

  /**
   * 安排下线。距今必须 ≥30 天（硬约束，防止上游突然下线导致客户无感知中断）。
   * 立即向所有已授权租户发通知。
   */
  scheduleOffline(
    actor: Actor,
    code: string,
    offlineAt: string,
    reasonText: string,
  ): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.publish');
    const reason = requireReason(reasonText, '安排模型下线');
    const model = this.mustModel(code);
    const now = this.ctx.clock.now();
    const target = new Date(offlineAt);

    if (diffDays(target, now) < OFFLINE_NOTICE_DAYS) {
      fail(
        'MODEL_OFFLINE_NOTICE_TOO_SHORT',
        `下线时间距今需不少于 ${OFFLINE_NOTICE_DAYS} 天`,
        { code, offlineAt, minDays: OFFLINE_NOTICE_DAYS },
      );
    }

    const updated = this.ctx.store.catalog.update(code, {
      status: 'deprecated',
      offlineAt: target.toISOString(),
    })!;

    const affected = this.ctx.store.modelGrants.find(
      (g) => g.modelCode === code && g.revokedAt === null,
    );
    for (const grant of affected) {
      this.ctx.notifier.send({
        kind: 'model.offline_notice',
        tenantId: grant.tenantId,
        recipients: ['tenant_admin'],
        channels: ['email', 'inbox'],
        subject: `模型 ${model.displayName} 将于 ${target.toISOString().slice(0, 10)} 下线`,
        payload: { modelCode: code, offlineAt: target.toISOString() },
        at: now.toISOString(),
      });
    }

    this.ctx.audit.record({
      actor,
      objectType: 'model_catalog',
      objectId: code,
      action: 'schedule_offline',
      summary: `安排模型 ${code} 于 ${target.toISOString()} 下线，影响 ${affected.length} 个租户`,
      reason,
    });
    return updated;
  }

  /** 正式下线：撤销所有租户授权 */
  offline(actor: Actor, code: string): CatalogModel {
    requirePermission(actor, 'platform.model_catalog.publish');
    this.mustModel(code);
    const now = this.ctx.clock.now().toISOString();
    const updated = this.ctx.store.catalog.update(code, { status: 'offline' })!;

    const grants = this.ctx.store.modelGrants.find(
      (g) => g.modelCode === code && g.revokedAt === null,
    );
    for (const grant of grants) {
      this.ctx.store.modelGrants.update(grant.id, {
        revokedAt: now,
        enabled: false,
        isDefault: false,
      });
      // 默认模型被下线时自动接管
      if (grant.isDefault) this.electDefault(grant.tenantId);
    }

    this.ctx.audit.record({
      actor,
      objectType: 'model_catalog',
      objectId: code,
      action: 'offline',
      summary: `下线模型 ${code}，撤销 ${grants.length} 个租户授权`,
    });
    return updated;
  }

  catalog(filter: { status?: ModelStatus; group?: string; vendor?: ModelVendor } = {}): CatalogModel[] {
    return this.ctx.store.catalog.find((m) => {
      if (filter.status && m.status !== filter.status) return false;
      if (filter.group && m.group !== filter.group) return false;
      if (filter.vendor && m.vendor !== filter.vendor) return false;
      return true;
    });
  }

  // ── 租户授权（Spec 9.2）──────────────────────────────────────────────

  grantModel(
    actor: Actor,
    tenantId: string,
    input: GrantModelInput,
  ): TenantModelGrant {
    requirePermission(actor, 'platform.model_grant.grant');
    const tenant = getTenant(this.ctx, tenantId);
    assertGrantable(tenant);
    const model = this.mustModel(input.modelCode);

    if (model.status === 'offline') {
      fail('MODEL_OFFLINE', `模型 ${model.code} 已下线`, { code: model.code });
    }
    if (model.status !== 'published') {
      fail('MODEL_NOT_PUBLISHED', `模型 ${model.code} 未上架，不能授权`, {
        code: model.code,
        status: model.status,
      });
    }

    const existing = this.activeGrant(tenantId, input.modelCode);
    if (existing) {
      return this.setLimits(actor, tenantId, input.modelCode, input);
    }

    const grant = this.insertGrant(tenantId, input.modelCode, 'individual', null, input);
    if (input.isDefault) this.setDefault(actor, tenantId, input.modelCode);

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'model_grant',
      objectId: grant.id,
      action: 'grant',
      summary: `向 ${tenant.name} 授权模型 ${model.displayName}`,
    });
    return grant;
  }

  /** 按分组授权，后续该分组新增模型自动跟随 */
  grantGroup(actor: Actor, tenantId: string, group: string): TenantModelGrant[] {
    requirePermission(actor, 'platform.model_grant.grant');
    const tenant = getTenant(this.ctx, tenantId);
    assertGrantable(tenant);

    const already = this.ctx.store.modelGroupFollows.first(
      (f) => f.tenantId === tenantId && f.group === group,
    );
    if (!already) {
      const follow: ModelGroupFollow = {
        id: this.ctx.ids.next('mgf'),
        tenantId,
        group,
        followedAt: this.ctx.clock.now().toISOString(),
      };
      this.ctx.store.modelGroupFollows.insert(follow);
    }

    const models = this.ctx.store.catalog.find(
      (m) => m.group === group && m.status === 'published',
    );
    const granted: TenantModelGrant[] = [];
    for (const model of models) {
      const existing = this.activeGrant(tenantId, model.code);
      if (existing) {
        // 单独授权升级为跟随分组
        if (existing.grantMode === 'individual') {
          granted.push(
            this.ctx.store.modelGrants.update(existing.id, {
              grantMode: 'group',
              group,
            })!,
          );
        } else {
          granted.push(existing);
        }
        continue;
      }
      granted.push(this.insertGrant(tenantId, model.code, 'group', group, {}));
    }

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'model_grant',
      objectId: null,
      action: 'grant_group',
      summary: `向 ${tenant.name} 按分组授权「${group}」，共 ${granted.length} 个模型`,
    });
    return granted;
  }

  revokeGroup(actor: Actor, tenantId: string, group: string): number {
    requirePermission(actor, 'platform.model_grant.revoke');
    const tenant = getTenant(this.ctx, tenantId);
    const follow = this.ctx.store.modelGroupFollows.first(
      (f) => f.tenantId === tenantId && f.group === group,
    );
    if (follow) this.ctx.store.modelGroupFollows.delete(follow.id);

    const now = this.ctx.clock.now().toISOString();
    const grants = this.ctx.store.modelGrants.find(
      (g) => g.tenantId === tenantId && g.group === group && g.revokedAt === null,
    );

    // 撤销后必须仍有可用模型（Spec 9.2）
    const remaining = this.activeGrants(tenantId).filter(
      (g) => !grants.some((x) => x.id === g.id),
    );
    if (remaining.length === 0 && grants.length > 0) {
      fail('MODEL_DEFAULT_REQUIRED', '撤销后租户将没有任何可用模型，操作被拒绝', {
        tenantId,
        group,
      });
    }

    let hadDefault = false;
    for (const grant of grants) {
      if (grant.isDefault) hadDefault = true;
      this.ctx.store.modelGrants.update(grant.id, {
        revokedAt: now,
        enabled: false,
        isDefault: false,
      });
    }
    if (hadDefault) this.electDefault(tenantId);

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'model_grant',
      objectId: null,
      action: 'revoke_group',
      summary: `撤销 ${tenant.name} 的分组授权「${group}」，共 ${grants.length} 个模型`,
    });
    return grants.length;
  }

  revokeModel(actor: Actor, tenantId: string, modelCode: string): TenantModelGrant {
    requirePermission(actor, 'platform.model_grant.revoke');
    const tenant = getTenant(this.ctx, tenantId);
    const grant = this.activeGrant(tenantId, modelCode);
    if (!grant) {
      fail('MODEL_GRANT_NOT_FOUND', `租户未授权模型 ${modelCode}`, {
        tenantId,
        modelCode,
      });
    }

    // 跟随分组的模型不可单独取消（Spec 9.2）
    if (grant.grantMode === 'group') {
      fail(
        'MODEL_GROUP_FOLLOWED',
        `模型 ${modelCode} 属于跟随分组「${grant.group}」，需先解除分组授权`,
        { tenantId, modelCode, group: grant.group },
      );
    }

    const others = this.activeGrants(tenantId).filter((g) => g.id !== grant.id);
    if (others.length === 0) {
      fail('MODEL_DEFAULT_REQUIRED', '撤销后租户将没有任何可用模型，操作被拒绝', {
        tenantId,
        modelCode,
      });
    }

    const updated = this.ctx.store.modelGrants.update(grant.id, {
      revokedAt: this.ctx.clock.now().toISOString(),
      enabled: false,
      isDefault: false,
    })!;
    if (grant.isDefault) this.electDefault(tenantId);

    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'model_grant',
      objectId: grant.id,
      action: 'revoke',
      summary: `撤销 ${tenant.name} 的模型授权 ${modelCode}`,
    });
    return updated;
  }

  setDefault(actor: Actor, tenantId: string, modelCode: string): TenantModelGrant {
    requirePermission(actor, 'platform.model_grant.grant');
    const grant = this.activeGrant(tenantId, modelCode);
    if (!grant) {
      fail('MODEL_GRANT_NOT_FOUND', `租户未授权模型 ${modelCode}`, {
        tenantId,
        modelCode,
      });
    }
    for (const g of this.activeGrants(tenantId)) {
      if (g.isDefault && g.id !== grant.id) {
        this.ctx.store.modelGrants.update(g.id, { isDefault: false });
      }
    }
    const updated = this.ctx.store.modelGrants.update(grant.id, { isDefault: true })!;
    this.ctx.store.tenants.update(tenantId, { });
    return updated;
  }

  setLimits(
    actor: Actor,
    tenantId: string,
    modelCode: string,
    limits: Partial<GrantModelInput>,
  ): TenantModelGrant {
    requirePermission(actor, 'platform.model_grant.limit');
    const grant = this.activeGrant(tenantId, modelCode);
    if (!grant) {
      fail('MODEL_GRANT_NOT_FOUND', `租户未授权模型 ${modelCode}`, {
        tenantId,
        modelCode,
      });
    }
    const patch: Partial<TenantModelGrant> = {};
    if (limits.tpm !== undefined) patch.tpm = limits.tpm;
    if (limits.rpm !== undefined) patch.rpm = limits.rpm;
    if (limits.concurrency !== undefined) patch.concurrency = limits.concurrency;
    if (limits.modelQuotaCapCredit !== undefined) {
      patch.modelQuotaCapCredit = limits.modelQuotaCapCredit;
    }
    if (limits.expireAt !== undefined) patch.expireAt = limits.expireAt;

    const updated = this.ctx.store.modelGrants.update(grant.id, patch)!;
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'model_grant',
      objectId: grant.id,
      action: 'set_limits',
      summary: `调整 ${modelCode} 的限额限速`,
      diff: patch as Record<string, unknown>,
    });
    return updated;
  }

  setTenantLimits(
    actor: Actor,
    tenantId: string,
    limits: Partial<TenantModelLimits>,
  ): Tenant {
    requirePermission(actor, 'platform.model_grant.limit');
    const tenant = getTenant(this.ctx, tenantId);
    return this.ctx.store.tenants.update(tenantId, {
      modelLimits: { ...tenant.modelLimits, ...limits },
    })!;
  }

  setSelfHostedChannel(actor: Actor, tenantId: string, allowed: boolean): Tenant {
    requirePermission(actor, 'platform.model_grant.grant');
    getTenant(this.ctx, tenantId);
    const updated = this.ctx.store.tenants.update(tenantId, {
      allowSelfHostedChannel: allowed,
    })!;
    this.ctx.audit.record({
      actor,
      tenantId,
      objectType: 'tenant',
      objectId: tenantId,
      action: 'set_self_hosted_channel',
      summary: `${allowed ? '开启' : '关闭'}自建渠道`,
    });
    return updated;
  }

  // ── 调用侧校验（Spec 9.3 / 9.4）─────────────────────────────────────

  /** 租户级与单模型配置取最严 */
  effectiveLimits(tenantId: string, modelCode: string): EffectiveLimits {
    const tenant = getTenant(this.ctx, tenantId);
    const grant = this.activeGrant(tenantId, modelCode);
    const strictest = (a: number | null, b: number | null): number | null => {
      if (a === null) return b;
      if (b === null) return a;
      return Math.min(a, b);
    };
    return {
      tpm: strictest(tenant.modelLimits.tpm, grant?.tpm ?? null),
      rpm: strictest(tenant.modelLimits.rpm, grant?.rpm ?? null),
      concurrency: strictest(tenant.modelLimits.concurrency, grant?.concurrency ?? null),
      modelQuotaCapCredit: grant?.modelQuotaCapCredit ?? null,
    };
  }

  /**
   * 调用前置校验：模型是否在白名单内、是否启用、是否已下线、是否超单模型额度上限。
   * 自建渠道不受白名单约束，但受「允许自建渠道」总开关控制（Spec 9.4）。
   */
  assertCallable(
    tenantId: string,
    modelCode: string,
    options: { selfHosted?: boolean } = {},
  ): void {
    const tenant = getTenant(this.ctx, tenantId);

    if (options.selfHosted) {
      if (!tenant.allowSelfHostedChannel) {
        fail('SELF_HOSTED_CHANNEL_DISABLED', '平台未开启该租户的自建渠道', {
          tenantId,
        });
      }
      return;
    }

    const model = this.ctx.store.catalog.get(modelCode);
    if (!model) {
      fail('MODEL_NOT_FOUND', `模型 ${modelCode} 不存在`, { modelCode });
    }
    if (model.status === 'offline') {
      fail('MODEL_OFFLINE', `模型 ${modelCode} 已下线`, { modelCode });
    }

    const grant = this.activeGrant(tenantId, modelCode);
    if (!grant || !grant.enabled) {
      fail('MODEL_NOT_GRANTED', `租户无权调用模型 ${modelCode}`, {
        tenantId,
        modelCode,
      });
    }

    const cap = grant.modelQuotaCapCredit;
    if (cap !== null) {
      const period = periodOf(this.ctx.clock.now(), tenant.timezone);
      const used = grant.periodKey === period ? grant.periodUsedCredit : 0;
      if (used >= cap) {
        fail('MODEL_QUOTA_EXCEEDED', `模型 ${modelCode} 已达本账期额度上限`, {
          tenantId,
          modelCode,
          used,
          cap,
        });
      }
    }
  }

  /** 记录单模型账期用量，账期切换时清零 */
  recordUsage(tenantId: string, modelCode: string, credit: number): void {
    const tenant = getTenant(this.ctx, tenantId);
    const grant = this.activeGrant(tenantId, modelCode);
    if (!grant) return;
    const period = periodOf(this.ctx.clock.now(), tenant.timezone);
    const used = grant.periodKey === period ? grant.periodUsedCredit : 0;
    this.ctx.store.modelGrants.update(grant.id, {
      periodKey: period,
      periodUsedCredit: used + credit,
    });
  }

  // ── 查询 ──────────────────────────────────────────────────────────────

  activeGrants(tenantId: string): TenantModelGrant[] {
    return this.ctx.store.modelGrants.find(
      (g) => g.tenantId === tenantId && g.revokedAt === null,
    );
  }

  activeGrant(tenantId: string, modelCode: string): TenantModelGrant | undefined {
    return this.ctx.store.modelGrants.first(
      (g) => g.tenantId === tenantId && g.modelCode === modelCode && g.revokedAt === null,
    );
  }

  followedGroups(tenantId: string): string[] {
    return this.ctx.store.modelGroupFollows
      .find((f) => f.tenantId === tenantId)
      .map((f) => f.group);
  }

  defaultModel(tenantId: string): TenantModelGrant | undefined {
    return this.activeGrants(tenantId).find((g) => g.isDefault);
  }

  // ── 内部 ──────────────────────────────────────────────────────────────

  private insertGrant(
    tenantId: string,
    modelCode: string,
    mode: 'group' | 'individual',
    group: string | null,
    input: Partial<GrantModelInput>,
  ): TenantModelGrant {
    const now = this.ctx.clock.now().toISOString();
    const record: TenantModelGrant = {
      id: this.ctx.ids.next('mg'),
      tenantId,
      modelCode,
      enabled: true,
      isDefault: false,
      grantMode: mode,
      group,
      effectiveAt: now,
      expireAt: input.expireAt ?? null,
      tpm: input.tpm ?? null,
      rpm: input.rpm ?? null,
      concurrency: input.concurrency ?? null,
      modelQuotaCapCredit: input.modelQuotaCapCredit ?? null,
      periodUsedCredit: 0,
      periodKey: null,
      revokedAt: null,
    };
    this.ctx.store.modelGrants.insert(record);
    // 租户第一个模型自动成为默认模型
    if (this.activeGrants(tenantId).filter((g) => g.isDefault).length === 0) {
      this.ctx.store.modelGrants.update(record.id, { isDefault: true });
      return this.ctx.store.modelGrants.get(record.id)!;
    }
    return record;
  }

  /** 默认模型被撤销时自动接管：取最早授权的剩余模型 */
  private electDefault(tenantId: string): TenantModelGrant | undefined {
    const remaining = this.activeGrants(tenantId).sort((a, b) =>
      a.effectiveAt === b.effectiveAt
        ? a.modelCode < b.modelCode
          ? -1
          : 1
        : a.effectiveAt < b.effectiveAt
          ? -1
          : 1,
    );
    const next = remaining[0];
    if (!next) return undefined;
    return this.ctx.store.modelGrants.update(next.id, { isDefault: true })!;
  }

  private mustModel(code: string): CatalogModel {
    const model = this.ctx.store.catalog.get(code);
    if (!model) {
      fail('MODEL_NOT_FOUND', `模型 ${code} 不存在于平台目录`, { code });
    }
    return model;
  }
}
