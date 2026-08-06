// Spec 第 8 章：额度分发、账本、清零、预警、耗尽策略、对账。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTenant,
  expectError,
  operator,
  setup,
  superAdmin,
  T0,
  tenantCommand,
} from './helpers.ts';
import { ceilCredit, creditToUsd, usdToCredit } from '../src/domain/money.ts';
import { addDays } from '../src/domain/time.ts';

describe('Spec 8.1 credit 语义与精度', () => {
  it('1 credit = $0.01，双向换算一致', () => {
    assert.equal(usdToCredit(100), 10_000);
    assert.equal(usdToCredit(0.01), 1);
    assert.equal(usdToCredit(1509.69), 150_969);
    assert.equal(creditToUsd(150_969), '1509.69');
    assert.equal(creditToUsd(3), '0.03');
    assert.equal(creditToUsd(0), '0.00');
  });

  it('浮点噪声不会导致换算失败', () => {
    // 这些值 × 100 都会产生 IEEE754 误差，但都是合法的两位小数金额
    assert.equal(usdToCredit(0.1), 10); // 10.000000000000002
    assert.equal(usdToCredit(0.29), 29); // 28.999999999999996
    assert.equal(usdToCredit(1.1), 110); // 110.00000000000001
    assert.equal(usdToCredit(8.28), 828); // 827.9999999999999
    assert.equal(usdToCredit(70.07), 7007); // 7007.000000000001
  });

  it('无法换算为整数 credit 的金额被拒绝', () => {
    expectError(() => usdToCredit(10.005), 'QUOTA_AMOUNT_INVALID');
    expectError(() => usdToCredit(Number.NaN), 'QUOTA_AMOUNT_INVALID');
  });

  it('消耗侧小数 credit 向上取整，但不受浮点噪声影响', () => {
    assert.equal(ceilCredit(0.1), 1);
    assert.equal(ceilCredit(3.0), 3);
    assert.equal(ceilCredit(3 * 1.1), 4); // 3.3000000000000003 → 4，不是 5
    assert.equal(ceilCredit(2.00000000001), 2); // 噪声被抹掉
  });

  it('发放金额必须是正整数 credit', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () => fx.app.quota.grant(operator, tenant.id, { amountCredit: 0 }),
      'QUOTA_AMOUNT_INVALID',
    );
    expectError(
      () => fx.app.quota.grant(operator, tenant.id, { amountCredit: 10.5 }),
      'QUOTA_AMOUNT_INVALID',
    );
  });
});

describe('Spec 8.1 双账本与待确认', () => {
  it('购买额度与赠送额度分开记账', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });

    const balance = fx.app.quota.balance(tenant.id);
    assert.equal(balance.purchasedCredit, 100_000);
    assert.equal(balance.giftCredit, 20_000);
    assert.equal(balance.availableCredit, 120_000);
  });

  it('赠送额度的到期时间被强制设为当月月末', () => {
    const fx = setup(); // 2026-03-10T02:00Z = 2026-03-10 10:00 +08
    const tenant = activeTenant(fx);
    const gift = fx.app.quota.gift(operator, tenant.id, { amountCredit: 5_000 });

    // 2026-04-01 00:00 +08 = 2026-03-31T16:00Z，减 1 毫秒
    assert.equal(gift.expireAt, '2026-03-31T15:59:59.999Z');
  });

  it('待确认的授予单不计入余额，确认到账后才计入', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });

    const pending = fx.app.quota.grant(operator, tenant.id, {
      amountCredit: 200_000,
      pending: true,
    });
    assert.equal(pending.status, 'pending');
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 10_000);

    fx.app.quota.confirm(operator, pending.id);
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 210_000);
  });

  it('重复确认到账被拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const pending = fx.app.quota.grant(operator, tenant.id, {
      amountCredit: 1_000,
      pending: true,
    });
    fx.app.quota.confirm(operator, pending.id);
    expectError(() => fx.app.quota.confirm(operator, pending.id), 'QUOTA_GRANT_NOT_PENDING');
  });
});

describe('Spec 8.2 回收与调账', () => {
  it('只能回收未消耗的部分', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    const grant = fx.app.quota.grants(tenant.id)[0];
    fx.app.quota.consume(tenant.id, { amountCredit: 30_000 });

    const error = expectError(
      () => fx.app.quota.revoke(superAdmin, grant.id, 80_000, '客户取消订单需要回收额度'),
      'QUOTA_REVOKE_EXCEEDS_REMAINING',
    );
    assert.equal(error.details.remaining, 70_000);

    const after = fx.app.quota.revoke(
      superAdmin,
      grant.id,
      70_000,
      '客户取消订单需要回收额度',
    );
    assert.equal(after.revokedCredit, 70_000);
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 0);
  });

  it('回收不修改原授予单金额，只生成反向流水', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    const grant = fx.app.quota.grants(tenant.id)[0];

    const after = fx.app.quota.revoke(
      superAdmin,
      grant.id,
      40_000,
      '客户取消部分订单回收额度',
    );
    assert.equal(after.amountCredit, 100_000, '原始金额不可变');

    const revokeEntries = fx.app.quota
      .ledger(tenant.id)
      .filter((e) => e.bizType === 'revoke');
    assert.equal(revokeEntries.length, 1);
    assert.equal(revokeEntries[0].direction, 'out');
    assert.equal(revokeEntries[0].amountCredit, 40_000);
  });

  it('回收与调账仅超管可执行', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });
    const grant = fx.app.quota.grants(tenant.id)[0];

    expectError(
      () => fx.app.quota.revoke(operator, grant.id, 1_000, '运营尝试回收应当被拒绝'),
      'PERMISSION_DENIED',
    );
    expectError(
      () =>
        fx.app.quota.adjust(operator, tenant.id, {
          direction: 'in',
          book: 'purchased',
          amountCredit: 1_000,
          reason: '运营尝试调账应当被拒绝',
          ticketNo: 'INC-001',
        }),
      'PERMISSION_DENIED',
    );
  });

  it('调账必须带工单号与 10 字符以上理由', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () =>
        fx.app.quota.adjust(superAdmin, tenant.id, {
          direction: 'in',
          book: 'purchased',
          amountCredit: 1_000,
          reason: '补偿',
          ticketNo: 'INC-001',
        }),
      'REASON_REQUIRED',
    );
    expectError(
      () =>
        fx.app.quota.adjust(superAdmin, tenant.id, {
          direction: 'in',
          book: 'purchased',
          amountCredit: 1_000,
          reason: '系统故障导致扣费错误需要补偿',
          ticketNo: '   ',
        }),
      'QUOTA_TICKET_REQUIRED',
    );
  });

  it('调账流水单列，不混入充值与消耗', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });
    fx.app.quota.adjust(superAdmin, tenant.id, {
      direction: 'in',
      book: 'purchased',
      amountCredit: 3_000,
      reason: '系统故障导致多扣需要补偿',
      ticketNo: 'INC-2026-031',
    });

    const entries = fx.app.quota.ledger(tenant.id);
    const adjustments = entries.filter((e) => e.bizType === 'adjustment');
    assert.equal(adjustments.length, 1);
    assert.equal(adjustments[0].ticketNo, 'INC-2026-031');
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 13_000);

    // 充值口径不包含调账
    const recharge = entries.filter((e) => e.bizType === 'grant' || e.bizType === 'gift');
    assert.equal(recharge.reduce((s, e) => s + e.amountCredit, 0), 10_000);
  });

  it('调减超过余额时被拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 1_000 });
    expectError(
      () =>
        fx.app.quota.adjust(superAdmin, tenant.id, {
          direction: 'out',
          book: 'purchased',
          amountCredit: 5_000,
          reason: '错误的调减金额超过余额',
          ticketNo: 'INC-002',
        }),
      'QUOTA_INSUFFICIENT',
    );
  });
});

describe('Spec 8.3 扣减顺序', () => {
  it('赠送额度优先于购买额度，且早到期的先扣', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });

    const lateGift = fx.app.quota.gift(operator, tenant.id, {
      amountCredit: 5_000,
      expireAt: addDays(t0, 20).toISOString(),
    });
    const earlyGift = fx.app.quota.gift(operator, tenant.id, {
      amountCredit: 3_000,
      expireAt: addDays(t0, 5).toISOString(),
    });

    const result = fx.app.quota.consume(tenant.id, { amountCredit: 6_000 });

    assert.equal(result.fromGift, 6_000, '应全部走赠送账本');
    assert.equal(result.fromPurchased, 0);

    // 早到期的 3000 被扣光，晚到期的扣 3000
    assert.equal(fx.app.store.quotaGrants.get(earlyGift.id)!.consumedCredit, 3_000);
    assert.equal(fx.app.store.quotaGrants.get(lateGift.id)!.consumedCredit, 3_000);
  });

  it('赠送额度不足时溢出到购买额度', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 2_000 });

    const result = fx.app.quota.consume(tenant.id, { amountCredit: 5_000 });
    assert.equal(result.fromGift, 2_000);
    assert.equal(result.fromPurchased, 3_000);
  });

  it('永久购买额度排在有到期时间的购买额度之后', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, { purchasedCredit: 0, seatCount: 5 });

    const forever = fx.app.quota.grant(operator, tenant.id, {
      amountCredit: 10_000,
      expireAt: null,
    });
    const dated = fx.app.quota.grant(operator, tenant.id, {
      amountCredit: 4_000,
      expireAt: addDays(t0, 30).toISOString(),
    });

    fx.app.quota.consume(tenant.id, { amountCredit: 4_000 });
    assert.equal(fx.app.store.quotaGrants.get(dated.id)!.consumedCredit, 4_000);
    assert.equal(fx.app.store.quotaGrants.get(forever.id)!.consumedCredit, 0);
  });
});

describe('Spec 8.3 赠送额度月度清零', () => {
  it('过期赠送额度被清零并写入 expire 流水', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 50_000 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 20_000);

    // 跨月
    fx.clock.set('2026-04-01T00:00:00.000Z');
    const expired = fx.app.quota.expireGifts(tenant.id);

    assert.equal(expired, 20_000);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 0);
    assert.equal(fx.app.quota.balance(tenant.id).purchasedCredit, 50_000, '购买额度不清零');

    const expireEntries = fx.app.quota
      .ledger(tenant.id)
      .filter((e) => e.bizType === 'expire');
    assert.equal(expireEntries.length, 1);
    assert.equal(expireEntries[0].amountCredit, 20_000);
    assert.equal(expireEntries[0].period, '2026-03', '过期归属到发生的账期');
  });

  it('已部分消耗的赠送额度只清零剩余部分', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 0, seatCount: 5 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });
    fx.app.quota.consume(tenant.id, { amountCredit: 8_000 });

    fx.clock.set('2026-04-01T00:00:00.000Z');
    assert.equal(fx.app.quota.expireGifts(tenant.id), 12_000);
  });
});

describe('Spec 8.3 账期闭合', () => {
  it('期初 + 充值 − 消耗 − 过期 + 调账 − 回收 = 期末', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });
    fx.app.quota.consume(tenant.id, { amountCredit: 15_000 });
    fx.app.quota.adjust(superAdmin, tenant.id, {
      direction: 'in',
      book: 'purchased',
      amountCredit: 5_000,
      reason: '系统故障导致多扣需要补偿',
      ticketNo: 'INC-100',
    });

    fx.clock.set('2026-04-01T03:00:00.000Z');
    fx.app.quota.expireGifts(tenant.id);
    const bp = fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03');

    const computed =
      bp.openingCredit +
      bp.rechargeCredit -
      bp.consumeCredit -
      bp.expireCredit +
      bp.adjustmentCredit -
      bp.revokeCredit;
    assert.equal(computed, bp.closingCredit, '账期必须闭合');
    assert.equal(bp.rechargeCredit, 120_000);
    assert.equal(bp.consumeCredit, 15_000);
    assert.equal(bp.expireCredit, 5_000); // 赠送 20000 用掉 15000，剩 5000 过期
    assert.equal(bp.adjustmentCredit, 5_000);
    assert.equal(bp.closingCredit, 105_000);
  });

  it('无调账与回收时退化为租户侧现有的三项公式', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, { amountCredit: 25_000 });

    fx.clock.set('2026-04-01T03:00:00.000Z');
    const bp = fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03');

    assert.equal(bp.adjustmentCredit, 0);
    assert.equal(bp.revokeCredit, 0);
    assert.equal(bp.expireCredit, 0);
    assert.equal(
      bp.openingCredit + bp.rechargeCredit - bp.consumeCredit,
      bp.closingCredit,
    );
  });

  it('上一账期的期末结转为下一账期的期初', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, { amountCredit: 20_000 });

    fx.clock.set('2026-04-05T03:00:00.000Z');
    const march = fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03');
    fx.app.quota.consume(tenant.id, { amountCredit: 10_000 });

    fx.clock.set('2026-05-02T03:00:00.000Z');
    const april = fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-04');

    assert.equal(april.openingCredit, march.closingCredit);
    assert.equal(april.consumeCredit, 10_000);
    assert.equal(april.closingCredit, 70_000);
  });

  it('已出账的账期不可重复出账', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });
    fx.clock.set('2026-04-01T03:00:00.000Z');
    fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03');
    expectError(
      () => fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03'),
      'QUOTA_PERIOD_CLOSED',
    );
  });
});

describe('Spec 8.4 预警与耗尽策略', () => {
  it('余额跌破阈值时按档触发通知，同账期不重复', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });

    fx.app.quota.consume(tenant.id, { amountCredit: 85_000 }); // 剩 15%
    assert.equal(fx.app.notifier.byKind('quota.notice').length, 1);

    fx.app.quota.consume(tenant.id, { amountCredit: 1_000 }); // 仍在 notice 档
    assert.equal(fx.app.notifier.byKind('quota.notice').length, 1, '同档不重复触发');

    fx.app.quota.consume(tenant.id, { amountCredit: 12_000 }); // 剩 2%
    assert.equal(fx.app.notifier.byKind('quota.alert').length, 1);
  });

  it('hard_stop：余额耗尽后自动停用，补额度后自动恢复', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000, seatCount: 5 });

    fx.app.quota.consume(tenant.id, { amountCredit: 10_000 });
    const suspended = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.suspendReason, 'arrears');

    // 停用后不能再消耗
    expectError(
      () => fx.app.quota.consume(tenant.id, { amountCredit: 1 }),
      'TENANT_SUSPENDED',
    );

    fx.app.quota.grant(operator, tenant.id, { amountCredit: 50_000 });
    const resumed = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(resumed.status, 'active');
    assert.equal(resumed.suspendReason, null);
  });

  it('hard_stop：超出余额的单次消耗直接拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 1_000, seatCount: 5 });
    expectError(
      () => fx.app.quota.consume(tenant.id, { amountCredit: 2_000 }),
      'QUOTA_INSUFFICIENT',
    );
  });

  it('overdraft：允许透支到配置上限，余额真实为负', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '透支企业',
        exhaustPolicy: 'overdraft',
        overdraftLimitCredit: 5_000,
        provisioning: { mode: 'active', seatCount: 5, purchasedCredit: 1_000 },
      }),
    );

    fx.app.quota.consume(tenant.id, { amountCredit: 3_000 });
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, -2_000);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'active', '透支期内不停服');

    // 超过透支上限被拒绝
    expectError(
      () => fx.app.quota.consume(tenant.id, { amountCredit: 4_000 }),
      'QUOTA_INSUFFICIENT',
    );
  });

  it('overdraft：新额度到账时优先偿还透支', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '透支偿还企业',
        exhaustPolicy: 'overdraft',
        overdraftLimitCredit: 5_000,
        provisioning: { mode: 'active', seatCount: 5, purchasedCredit: 1_000 },
      }),
    );
    fx.app.quota.consume(tenant.id, { amountCredit: 3_000 });
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, -2_000);

    fx.app.quota.grant(operator, tenant.id, { amountCredit: 10_000 });
    assert.equal(fx.app.quota.balance(tenant.id).availableCredit, 8_000);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.overdraftUsedCredit, 0);
  });

  it('degrade：余额耗尽后只放行基础模型集', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({
        name: '降级企业',
        exhaustPolicy: 'degrade',
        provisioning: {
          mode: 'active',
          seatCount: 5,
          purchasedCredit: 1_000,
          modelCodes: ['claude-sonnet-5', 'claude-opus-5'],
        },
      }),
    );

    fx.app.quota.consume(tenant.id, { amountCredit: 1_000 });
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'active', '降级不停服');

    // 高级模型被拒绝
    expectError(
      () =>
        fx.app.quota.consume(tenant.id, {
          amountCredit: 100,
          modelCode: 'claude-opus-5',
        }),
      'QUOTA_INSUFFICIENT',
    );
  });
});

describe('Spec 4.3 额度不变式：团队分配总额不超过余额', () => {
  it('团队分配之和超过可用余额时拦截', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });

    fx.app.quota.allocateTeam(tenant.id, 'team_a', '研发一组', 60_000);
    fx.app.quota.allocateTeam(tenant.id, 'team_b', '研发二组', 40_000);
    assert.equal(fx.app.quota.totalAllocated(tenant.id), 100_000);

    const error = expectError(
      () => fx.app.quota.allocateTeam(tenant.id, 'team_c', '研发三组', 1),
      'QUOTA_ALLOCATION_EXCEEDS_BALANCE',
    );
    assert.equal(error.details.available, 100_000);
  });

  it('调整已有团队的分配时不把自己算进已占用', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000 });
    fx.app.quota.allocateTeam(tenant.id, 'team_a', '研发一组', 100_000);

    // 把 team_a 从 100000 调到 50000 应当允许
    const updated = fx.app.quota.allocateTeam(tenant.id, 'team_a', '研发一组', 50_000);
    assert.equal(updated.allocatedCredit, 50_000);
  });
});

describe('Spec 8.5 对账', () => {
  it('正常链路下三组数一致', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });
    fx.app.quota.consume(tenant.id, { amountCredit: 30_000 });

    fx.clock.set('2026-04-01T03:00:00.000Z');
    fx.app.quota.expireGifts(tenant.id);
    fx.app.quota.closePeriod(superAdmin, tenant.id, '2026-03');

    const result = fx.app.quota.reconcile(tenant.id, '2026-03');
    assert.equal(result.ok, true, JSON.stringify(result.checks, null, 2));
  });

  it('账本流水的账期按租户时区归属', () => {
    // 2026-03-31T20:00Z = 2026-04-01 04:00 +08，属于 4 月账期
    const fx = setup('2026-03-31T20:00:00.000Z');
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });
    const entry = fx.app.quota.ledger(tenant.id)[0];
    assert.equal(entry.period, '2026-04');
  });
});

describe('Spec 8.6 流水字段', () => {
  it('消耗流水记录团队与模型维度，可下钻', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, {
      amountCredit: 1_200,
      teamId: 'team_a',
      modelCode: 'claude-sonnet-5',
    });

    const entry = fx.app.quota
      .ledger(tenant.id)
      .find((e) => e.bizType === 'consume')!;
    assert.equal(entry.teamId, 'team_a');
    assert.equal(entry.modelCode, 'claude-sonnet-5');
    assert.equal(entry.balanceAfterCredit, 98_800);
  });

  it('T0 常量未被测试意外修改', () => {
    assert.equal(T0, '2026-03-10T02:00:00.000Z');
  });
});
