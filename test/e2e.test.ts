// 端到端：完整客户旅程 + Spec 4.3 三条不变式 + 第 11 章查询与看板。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTenant,
  fillSeats,
  operator,
  setup,
  superAdmin,
  tenantCommand,
} from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';
import { addDays } from '../src/domain/time.ts';

/** 席位与额度不变式只约束存活态；注销后占用关系是恢复快照，不再是活跃占用 */
const LIVE_STATUSES = new Set(['pending', 'trialing', 'active', 'suspended']);

/** Spec 4.3 的三条不变式，任何操作之后都必须成立 */
function assertInvariants(fx: Fixture, tenantId: string, label: string): void {
  const tenant = fx.app.store.tenants.get(tenantId)!;
  const live = LIVE_STATUSES.has(tenant.status);

  // 1. 席位不变式（含超卖软限）
  const occupied = fx.app.seats.occupiedCount(tenantId);
  const limit = fx.app.seats.assignableLimit(tenant);
  if (live) {
    assert.ok(
      occupied <= limit,
      `[${label}] 席位不变式被打破：占用 ${occupied} > 上限 ${limit}`,
    );
  } else {
    // Spec 6.4：注销时授予单全部回收，但占用关系保留用于保留期内恢复
    assert.equal(limit, 0, `[${label}] 注销后席位授予单应已全部回收`);
  }

  // 2. 额度不变式
  const allocated = fx.app.quota.totalAllocated(tenantId);
  const available = fx.app.quota.balance(tenantId).availableCredit;
  assert.ok(
    allocated <= Math.max(available, 0) || allocated === 0,
    `[${label}] 额度不变式被打破：已分配 ${allocated} > 可用 ${available}`,
  );

  // 3. 模型不变式：可用模型 ⊆ 平台授权白名单
  const whitelist = new Set(
    fx.app.models.activeGrants(tenantId).map((g) => g.modelCode),
  );
  for (const code of whitelist) {
    const model = fx.app.store.catalog.get(code);
    assert.ok(model, `[${label}] 授权了不存在于目录的模型 ${code}`);
    assert.notEqual(
      model.status,
      'offline',
      `[${label}] 已下线模型 ${code} 仍在授权白名单中`,
    );
  }
}

describe('端到端：试用 → 转正式 → 扩容 → 欠费 → 注销', () => {
  it('完整旅程中三条不变式始终成立', () => {
    const fx = setup();
    const t0 = fx.clock.now();

    // 1. 开通试用
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '端到端企业',
        provisioning: { mode: 'trial', planId: fx.trialPlanId },
      }),
    );
    assertInvariants(fx, tenant.id, '开通试用');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);

    // 2. 试用期内占用席位并消耗额度
    fillSeats(fx, tenant.id, 6);
    fx.app.quota.consume(tenant.id, {
      amountCredit: 8_000,
      modelCode: 'claude-sonnet-5',
      teamId: 'team_a',
    });
    assertInvariants(fx, tenant.id, '试用期使用');

    // 3. 延期
    fx.clock.set(addDays(t0, 10).toISOString());
    fx.app.trials.extend(operator, tenant.id, 14, {
      reason: '客户内部评审流程未走完申请延期',
    });
    assertInvariants(fx, tenant.id, '试用延期');

    // 4. 转正式
    fx.clock.set(addDays(t0, 20).toISOString());
    fx.app.trials.convert(operator, tenant.id, {
      seatCount: 50,
      purchasedCredit: 500_000,
      contractNo: 'HT-2026-0421',
      contractEndAt: addDays(t0, 385).toISOString(),
    });
    assertInvariants(fx, tenant.id, '转正式');
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 0, '试用赠送额度作废');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 60, '试用席位叠加保留');

    // 5. 试用席位到期后回落
    fx.clock.set(addDays(t0, 40).toISOString());
    fx.app.jobs.run();
    assertInvariants(fx, tenant.id, '试用席位到期');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 50);

    // 6. 扩容
    fx.app.seats.grant(operator, tenant.id, {
      seatCount: 30,
      expireAt: addDays(t0, 385).toISOString(),
      contractNo: 'HT-2026-0421-A1',
    });
    fillSeats(fx, tenant.id, 40, 'wave2');
    assertInvariants(fx, tenant.id, '扩容后占用');
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 47);

    // 7. 烧完额度触发欠费停用
    fx.app.quota.consume(tenant.id, { amountCredit: 500_000 });
    const arrears = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(arrears.status, 'suspended');
    assert.equal(arrears.suspendReason, 'arrears');
    assertInvariants(fx, tenant.id, '欠费停用');

    // 8. 补额度自动恢复
    fx.app.quota.grant(operator, tenant.id, {
      amountCredit: 1_000_000,
      contractNo: 'HT-2026-0421-A2',
    });
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'active');
    assertInvariants(fx, tenant.id, '补额度恢复');

    // 9. 出账并对账
    fx.clock.set('2026-05-01T03:00:00.000Z');
    fx.app.jobs.run();
    const bp = fx.app.quota.billingPeriod(tenant.id, '2026-04');
    if (bp) {
      const closed =
        bp.openingCredit +
        bp.rechargeCredit -
        bp.consumeCredit -
        bp.expireCredit +
        bp.adjustmentCredit -
        bp.revokeCredit;
      assert.equal(closed, bp.closingCredit, '账期必须闭合');
    }

    // 10. 注销并清除
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: '端到端企业',
      reason: '客户业务调整决定终止合作并注销',
    });
    assertInvariants(fx, tenant.id, '注销');

    fx.clock.set('2026-06-15T03:00:00.000Z');
    fx.app.jobs.run();
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'deregistered');

    // 凭证类数据保留
    assert.ok(fx.app.quota.grants(tenant.id).length > 0);
    assert.ok(fx.app.audit.query({ tenantId: tenant.id }).length > 0);
  });
});

describe('Spec 4.3 不变式在边界操作下依然成立', () => {
  it('模型下线后不会留下悬空授权', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-opus-5' });

    fx.app.models.offline(superAdmin, 'claude-sonnet-5');
    assertInvariants(fx, tenant.id, '模型下线');
    assert.equal(fx.app.models.activeGrant(tenant.id, 'claude-sonnet-5'), undefined);
  });

  it('强制回收后占用数严格不超过席位总数', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 20 });
    fillSeats(fx, tenant.id, 15);
    const grant = fx.app.seats.grants(tenant.id)[0];

    fx.app.seats.reduce(superAdmin, grant.id, 8, {
      strategy: 'force',
      reason: '合同缩减席位客户已确认强制回收',
    });
    assertInvariants(fx, tenant.id, '强制回收');
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 8);
  });

  it('额度回收后团队分配总额不会超过余额', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    fx.app.quota.allocateTeam(tenant.id, 'team_a', '研发一组', 30_000);
    const grant = fx.app.quota.grants(tenant.id)[0];

    fx.app.quota.revoke(superAdmin, grant.id, 50_000, '客户取消部分订单回收额度');
    assertInvariants(fx, tenant.id, '额度回收');
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 50_000);

    // 已分配 30000 仍在余额 50000 之内；再加 30000 会超
    assert.throws(() =>
      fx.app.quota.allocateTeam(tenant.id, 'team_b', '研发二组', 30_000),
    );
  });
});

describe('Spec 11 查询与看板', () => {
  it('总览行包含席位、额度、模型三个维度', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 20, purchasedCredit: 150_000 });
    fillSeats(fx, tenant.id, 9); // 占用 10
    fx.app.quota.consume(tenant.id, { amountCredit: 30_000 });

    const rows = fx.app.query.list(superAdmin, {});
    const row = rows.find((r) => r.tenantId === tenant.id)!;

    assert.equal(row.seatTotal, 20);
    assert.equal(row.seatOccupied, 10);
    assert.equal(row.occupancyRate, 0.5);
    assert.equal(row.availableCredit, 120_000);
    assert.equal(row.availableUsd, '1200.00');
    assert.equal(row.monthConsumeCredit, 30_000);
    assert.equal(row.grantedModelCount, 2);
  });

  it('风险视图：额度告警、席位超卖、即将到期、长期不活跃', () => {
    const fx = setup();
    const t0 = fx.clock.now();

    const lowQuota = activeTenant(fx, {
      name: '额度告警企业',
      purchasedCredit: 10_000,
      seatCount: 5,
    });
    fx.app.quota.consume(lowQuota.id, { amountCredit: 9_800 });

    const expiring = activeTenant(fx, {
      name: '即将到期企业',
      seatCount: 5,
      seatExpireAt: addDays(t0, 10).toISOString(),
    });
    fx.app.tenants.edit(superAdmin, expiring.id, {
      contractEndAt: addDays(t0, 10).toISOString(),
    });

    assert.deepEqual(
      fx.app.query.riskView(superAdmin, 'quota_alert').map((r) => r.tenantId),
      [lowQuota.id],
    );
    assert.deepEqual(
      fx.app.query.riskView(superAdmin, 'expiring_soon').map((r) => r.tenantId),
      [expiring.id],
    );
    // 两个租户都没有活跃记录，都算长期不活跃
    assert.equal(fx.app.query.riskView(superAdmin, 'inactive').length, 2);
  });

  it('试用即将到期视图只包含 7 天内到期的试用租户', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const trial = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '试用到期企业',
        provisioning: { mode: 'trial', planId: fx.trialPlanId },
      }),
    );
    activeTenant(fx, { name: '正式企业' });

    // 试用 14 天，第 8 天后进入 7 天窗口
    assert.equal(fx.app.query.riskView(superAdmin, 'trial_expiring').length, 0);
    fx.clock.set(addDays(t0, 8).toISOString());
    assert.deepEqual(
      fx.app.query.riskView(superAdmin, 'trial_expiring').map((r) => r.tenantId),
      [trial.id],
    );
  });

  it('看板汇总租户数、席位、额度与转化率', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    activeTenant(fx, { name: '看板正式企业', seatCount: 20, purchasedCredit: 100_000 });
    const trial = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '看板试用企业',
        provisioning: { mode: 'trial', planId: fx.trialPlanId },
      }),
    );

    let board = fx.app.query.dashboard(superAdmin);
    assert.equal(board.tenantCount.total, 2);
    assert.equal(board.tenantCount.active, 1);
    assert.equal(board.tenantCount.trialing, 1);
    assert.equal(board.seats.granted, 30);
    assert.equal(board.seats.occupied, 2);
    assert.equal(board.monthConverted, 0);

    fx.clock.set(addDays(t0, 5).toISOString());
    fx.app.trials.convert(operator, trial.id, { seatCount: 30, purchasedCredit: 200_000 });

    board = fx.app.query.dashboard(superAdmin);
    assert.equal(board.monthConverted, 1);
    assert.equal(board.conversionRate, 1);
  });

  it('看板给出模型消耗分布', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, { amountCredit: 3_000, modelCode: 'claude-sonnet-5' });
    fx.app.quota.consume(tenant.id, { amountCredit: 1_000, modelCode: 'deepseek-v3' });

    const board = fx.app.query.dashboard(superAdmin);
    assert.deepEqual(board.modelUsage, [
      { modelCode: 'claude-sonnet-5', tenantCount: 1, consumedCredit: 3_000 },
      { modelCode: 'deepseek-v3', tenantCount: 1, consumedCredit: 1_000 },
    ]);
  });

  it('详情页返回五个 tab 所需的全部数据', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10, purchasedCredit: 50_000 });
    const detail = fx.app.query.detail(superAdmin, tenant.id);

    assert.equal(detail.tenant.id, tenant.id);
    assert.equal(detail.capabilities.console, 'full');
    assert.ok(detail.seat.overview);
    assert.ok(detail.seat.grants.length > 0);
    assert.ok(detail.quota.grants.length > 0);
    assert.ok(detail.model.grants.length > 0);
    assert.ok(detail.lifecycle.length > 0);
  });

  it('只读审计可以看板与列表，但看板需要 dashboard 权限', () => {
    const fx = setup();
    activeTenant(fx);
    const auditorActor = { id: 'u_audit', role: 'auditor' as const };
    assert.ok(fx.app.query.list(auditorActor, {}).length > 0);
    assert.ok(fx.app.query.dashboard(auditorActor).tenantCount.total > 0);
  });
});
