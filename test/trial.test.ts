// Spec 第 10 章：试用管理标准化（最小集）。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVANCED_MODEL_GROUP,
  expectError,
  operator,
  sales,
  setup,
  superAdmin,
  tenantCommand,
} from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';
import { TRIAL_MAX_TOTAL_DAYS } from '../src/services/trial.ts';
import { addDays } from '../src/domain/time.ts';

function trialTenant(fx: Fixture, name?: string) {
  return fx.app.createTenant(
    superAdmin,
    tenantCommand({
      name,
      provisioning: { mode: 'trial', planId: fx.trialPlanId },
    }),
  );
}

describe('Spec 10.1 试用套餐模板', () => {
  it('模板必须指定模型分组或具体模型', () => {
    const fx = setup();
    expectError(
      () =>
        fx.app.trials.createPlan(superAdmin, {
          name: '空模型集套餐',
          seatCount: 5,
          giftCredit: 1_000,
          durationDays: 7,
        }),
      'VALIDATION_ERROR',
    );
  });

  it('模板时长不得超过 90 天', () => {
    const fx = setup();
    expectError(
      () =>
        fx.app.trials.createPlan(superAdmin, {
          name: '超长套餐',
          seatCount: 5,
          giftCredit: 1_000,
          modelGroups: [BASIC_MODEL_GROUP],
          durationDays: 120,
        }),
      'TRIAL_MAX_DURATION_EXCEEDED',
    );
  });

  it('停用模板后不能用于新开通，但不影响已开通的试用', () => {
    const fx = setup();
    const existing = trialTenant(fx, '已开通试用企业');
    fx.app.trials.disablePlan(superAdmin, fx.trialPlanId);

    assert.equal(fx.app.store.tenants.get(existing.id)!.status, 'trialing');
    expectError(
      () =>
        fx.app.createTenant(
          superAdmin,
          tenantCommand({ provisioning: { mode: 'trial', planId: fx.trialPlanId } }),
        ),
      'TRIAL_PLAN_DISABLED',
    );
  });

  it('模板字段校验：席位、额度、时长必须为正整数', () => {
    const fx = setup();
    for (const bad of [
      { seatCount: 0, giftCredit: 100, durationDays: 7 },
      { seatCount: 5, giftCredit: 0, durationDays: 7 },
      { seatCount: 5, giftCredit: 100, durationDays: 0 },
    ]) {
      expectError(
        () =>
          fx.app.trials.createPlan(superAdmin, {
            name: '非法套餐',
            modelGroups: [BASIC_MODEL_GROUP],
            ...bad,
          }),
        'VALIDATION_ERROR',
      );
    }
  });
});

describe('Spec 10.2 开通试用', () => {
  it('按模板一次性下发席位、赠送额度、模型授权', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);

    assert.equal(tenant.status, 'trialing');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 20_000);
    assert.equal(fx.app.quota.balance(tenant.id).purchasedCredit, 0);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, 2);
    assert.equal(tenant.trialExpireAt, addDays(t0, 14).toISOString());
    assert.equal(tenant.trialTotalDays, 14);
  });

  it('试用的席位与额度授予单来源都是 trial，到期时间跟随试用期', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);

    const seatGrant = fx.app.seats.grants(tenant.id)[0];
    assert.equal(seatGrant.source, 'trial');
    assert.equal(seatGrant.expireAt, addDays(t0, 14).toISOString());

    const quotaGrant = fx.app.quota.grants(tenant.id)[0];
    assert.equal(quotaGrant.source, 'trial');
    assert.equal(quotaGrant.book, 'gift');
    assert.equal(quotaGrant.expireAt, addDays(t0, 14).toISOString());
  });

  it('商务角色可以开通试用', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(
      sales,
      tenantCommand({
        name: '商务开通的企业',
        provisioning: { mode: 'trial', planId: fx.trialPlanId },
      }),
    );
    assert.equal(tenant.status, 'trialing');
  });
});

describe('Spec 10.3 试用期限制', () => {
  it('试用期默认不允许充值', () => {
    const fx = setup();
    const tenant = trialTenant(fx);

    expectError(
      () => fx.app.quota.grant(operator, tenant.id, { amountCredit: 50_000 }),
      'RECHARGE_NOT_ALLOWED',
    );
    // 赠送不受限
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 1_000 });
  });

  it('允许充值的套餐不拦截', () => {
    const fx = setup();
    const plan = fx.app.trials.createPlan(superAdmin, {
      name: '可充值试用',
      seatCount: 5,
      giftCredit: 1_000,
      modelGroups: [BASIC_MODEL_GROUP],
      durationDays: 7,
      allowRecharge: true,
    });
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({ provisioning: { mode: 'trial', planId: plan.id } }),
    );
    const grant = fx.app.quota.grant(operator, tenant.id, { amountCredit: 10_000 });
    assert.equal(grant.status, 'active');
  });

  it('试用期默认不允许自建渠道，模板可覆盖', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.allowSelfHostedChannel, false);

    const plan = fx.app.trials.createPlan(superAdmin, {
      name: '开放自建渠道试用',
      seatCount: 5,
      giftCredit: 1_000,
      modelGroups: [BASIC_MODEL_GROUP],
      durationDays: 7,
      allowSelfHostedChannel: true,
    });
    const other = fx.app.createTenant(
      superAdmin,
      tenantCommand({ provisioning: { mode: 'trial', planId: plan.id } }),
    );
    assert.equal(fx.app.store.tenants.get(other.id)!.allowSelfHostedChannel, true);
  });

  it('模板的并发上限写入租户级限制', () => {
    const fx = setup();
    const plan = fx.app.trials.createPlan(superAdmin, {
      name: '限并发试用',
      seatCount: 5,
      giftCredit: 1_000,
      modelGroups: [BASIC_MODEL_GROUP],
      durationDays: 7,
      concurrencyLimit: 3,
    });
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({ provisioning: { mode: 'trial', planId: plan.id } }),
    );
    assert.equal(
      fx.app.models.effectiveLimits(tenant.id, 'claude-sonnet-5').concurrency,
      3,
    );
  });
});

describe('Spec 10.2 延期', () => {
  it('席位、额度、模型授权的到期时间同步顺延', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);

    const next = fx.app.trials.extend(operator, tenant.id, 7, {
      reason: '客户还在评估中申请延长试用',
    });

    assert.equal(next.trialExpireAt, addDays(t0, 21).toISOString());
    assert.equal(next.trialTotalDays, 21);
    assert.equal(fx.app.seats.grants(tenant.id)[0].expireAt, addDays(t0, 21).toISOString());
    assert.equal(fx.app.quota.grants(tenant.id)[0].expireAt, addDays(t0, 21).toISOString());
  });

  it('默认不补发额度，显式指定才补', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    fx.app.trials.extend(operator, tenant.id, 7, { reason: '客户还在评估中申请延长' });
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 20_000);

    fx.app.trials.extend(operator, tenant.id, 7, {
      reason: '客户还在评估中申请再次延长',
      extraGiftCredit: 5_000,
    });
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 25_000);
  });

  it('试用总时长超过 90 天时拒绝', () => {
    const fx = setup();
    const tenant = trialTenant(fx); // 14 天

    fx.app.trials.extend(superAdmin, tenant.id, 70, { reason: '客户流程长需要延期评估' }); // 84
    const error = expectError(
      () =>
        fx.app.trials.extend(superAdmin, tenant.id, 10, {
          reason: '客户流程长需要再次延期',
        }),
      'TRIAL_MAX_DURATION_EXCEEDED',
    );
    assert.equal(error.details.max, TRIAL_MAX_TOTAL_DAYS);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.trialTotalDays, 84);
  });

  it('非试用状态的租户不能延期', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, tenantCommand());
    expectError(
      () => fx.app.trials.extend(operator, tenant.id, 7, { reason: '尝试给未开通的租户延期' }),
      'TRIAL_NOT_ACTIVE',
    );
  });
});

describe('Spec 10.2 转正式', () => {
  it('试用席位保留至原到期时间，与正式席位叠加', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);

    fx.app.trials.convert(operator, tenant.id, {
      seatCount: 50,
      purchasedCredit: 500_000,
      contractEndAt: addDays(t0, 365).toISOString(),
    });

    assert.equal(fx.app.seats.seatTotal(tenant.id), 60, '转换瞬间不掉席位');

    // 试用席位到期并走完宽限期后回落到 50
    fx.clock.set(addDays(t0, 22).toISOString());
    assert.equal(fx.app.seats.seatTotal(tenant.id), 50);
  });

  it('试用赠送额度立即作废，不结转到正式', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 20_000);

    fx.app.trials.convert(operator, tenant.id, {
      seatCount: 50,
      purchasedCredit: 500_000,
    });

    const balance = fx.app.quota.balance(tenant.id);
    assert.equal(balance.giftCredit, 0, '赠送额度必须作废');
    assert.equal(balance.purchasedCredit, 500_000);

    const expired = fx.app.quota
      .ledger(tenant.id)
      .filter((e) => e.bizType === 'expire');
    assert.equal(expired.length, 1);
    assert.equal(expired[0].amountCredit, 20_000);
  });

  it('转正式后解除试用限制：可充值、模型授权不再有到期时间', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    const next = fx.app.trials.convert(operator, tenant.id, {
      seatCount: 50,
      purchasedCredit: 100_000,
    });

    assert.equal(next.status, 'active');
    assert.equal(next.allowRecharge, true);
    assert.equal(next.trialPlanId, null);
    assert.equal(next.trialExpireAt, null);
    for (const grant of fx.app.models.activeGrants(tenant.id)) {
      assert.equal(grant.expireAt, null);
    }
    // 充值不再被拦截
    fx.app.quota.grant(operator, tenant.id, { amountCredit: 10_000 });
  });

  it('试用到期已停用的租户仍可转正式', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    fx.app.trials.terminate(superAdmin, tenant.id, '客户暂时搁置后又决定签约');

    const suspended = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.suspendReason, 'trial_expired');

    const converted = fx.app.trials.convert(operator, tenant.id, {
      seatCount: 20,
      purchasedCredit: 200_000,
    });
    assert.equal(converted.status, 'active');
    assert.equal(converted.suspendReason, null);
  });

  it('转正式可以追加模型授权', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    assert.equal(fx.app.models.activeGrant(tenant.id, 'claude-opus-5'), undefined);

    fx.app.trials.convert(operator, tenant.id, {
      seatCount: 20,
      purchasedCredit: 100_000,
      modelCodes: ['claude-opus-5'],
    });
    assert.ok(fx.app.models.activeGrant(tenant.id, 'claude-opus-5'));
    void ADVANCED_MODEL_GROUP;
  });
});

describe('Spec 10.2 提前终止', () => {
  it('终止后回收席位、作废赠送额度、撤销模型授权', () => {
    const fx = setup();
    const tenant = trialTenant(fx);

    const next = fx.app.trials.terminate(
      superAdmin,
      tenant.id,
      '客户明确表示不再继续试用',
    );

    assert.equal(next.status, 'suspended');
    assert.equal(next.suspendReason, 'trial_expired');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 0);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 0);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, 0);
    assert.deepEqual(fx.app.models.followedGroups(tenant.id), []);
  });

  it('终止需要 10 字符以上理由，且商务无权终止', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    expectError(
      () => fx.app.trials.terminate(superAdmin, tenant.id, '不续'),
      'REASON_REQUIRED',
    );
    expectError(
      () => fx.app.trials.terminate(sales, tenant.id, '商务尝试终止应当被拒绝'),
      'PERMISSION_DENIED',
    );
  });

  it('终止会发出试用结束通知', () => {
    const fx = setup();
    const tenant = trialTenant(fx);
    fx.app.trials.terminate(superAdmin, tenant.id, '客户明确表示不再继续试用');

    const notices = fx.app.notifier.byKind('trial.expired');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].tenantId, tenant.id);
  });
});
