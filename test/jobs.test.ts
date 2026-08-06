// Spec 7.5 / 8.3 / 10.4 / 6.4：每日任务。

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
import { addDays } from '../src/domain/time.ts';
import { TRIAL_REMINDER_DAYS } from '../src/jobs/daily.ts';

function trialTenant(fx: Fixture, name?: string) {
  return fx.app.createTenant(
    superAdmin,
    tenantCommand({
      name,
      provisioning: { mode: 'trial', planId: fx.trialPlanId },
    }),
  );
}

describe('Spec 7.5 席位宽限期届满', () => {
  it('宽限期内不置为过期，届满后置为 expired', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 10).toISOString(),
    });

    fx.clock.set(addDays(t0, 12).toISOString());
    let report = fx.app.jobs.run();
    assert.equal(report.seatGrantsExpired, 0, '宽限期内不过期');
    assert.equal(fx.app.seats.grants(tenant.id)[0].status, 'active');

    fx.clock.set(addDays(t0, 18).toISOString());
    report = fx.app.jobs.run();
    assert.equal(report.seatGrantsExpired, 1);
    assert.equal(fx.app.seats.grants(tenant.id)[0].status, 'expired');
  });

  it('宽限期内向销售与运营提示剩余天数', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    activeTenant(fx, { seatCount: 10, seatExpireAt: addDays(t0, 10).toISOString() });

    fx.clock.set(addDays(t0, 12).toISOString());
    fx.app.jobs.run();

    const notices = fx.app.notifier.byKind('seat.grace_expiring');
    assert.equal(notices.length, 1);
    assert.equal(notices[0].payload.graceRemainingDays, 5);
  });

  it('宽限期届满后仍超限：冻结超出成员并置租户为停用', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 10).toISOString(),
    });
    fillSeats(fx, tenant.id, 4); // 占用 5

    // 再补一批小额永久席位，使届满后总数 2 < 占用 5
    fx.app.seats.grant(operator, tenant.id, { seatCount: 2, expireAt: null });

    fx.clock.set(addDays(t0, 18).toISOString());
    const report = fx.app.jobs.run();

    assert.deepEqual(report.tenantsFrozenForSeatOverflow, [tenant.id]);
    const after = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(after.status, 'suspended');
    assert.equal(after.suspendReason, 'manual');

    const disabled = fx.app.seats
      .assignments(tenant.id)
      .filter((a) => a.memberStatus === 'disabled');
    assert.equal(disabled.length, 3, '冻结超出的 3 个占用');
    assert.ok(disabled.every((a) => !a.isAdmin), '管理员不被冻结');
  });

  it('策略 B 登记的延期缩容到点后自动生效', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 30).toISOString(),
    });
    fillSeats(fx, tenant.id, 7); // 占用 8
    const grant = fx.app.seats.grants(tenant.id)[0];

    fx.app.seats.reduce(superAdmin, grant.id, 5, {
      strategy: 'defer',
      reason: '合同到期不续，让客户自然消化席位',
    });
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);

    // 释放 3 个，使届满时不再冲突
    for (let i = 0; i < 3; i += 1) {
      fx.app.seats.release(tenant.id, `m_${tenant.id}_${i}`, 'member_deleted');
    }

    fx.clock.set(addDays(t0, 30).toISOString());
    const report = fx.app.jobs.run();
    assert.equal(report.deferredReductionsApplied, 1);
    assert.equal(fx.app.seats.grants(tenant.id)[0].seatCount, 5);
  });
});

describe('Spec 8.3 赠送额度月度清零与出账', () => {
  it('跨月后赠送额度被清零，购买额度不受影响', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });

    fx.clock.set('2026-04-01T03:00:00.000Z'); // +08 = 11:00，day=1 hour=11
    const report = fx.app.jobs.run();

    assert.equal(report.giftCreditExpired, 20_000);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 0);
    assert.equal(fx.app.quota.balance(tenant.id).purchasedCredit, 100_000);
  });

  it('每月 1 日 02:00 之后触发上一账期出账，且只出一次', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, { amountCredit: 30_000 });

    // 1 日 00:30（+08 08:30）已过 02:00
    fx.clock.set('2026-04-01T00:30:00.000Z');
    let report = fx.app.jobs.run();
    assert.equal(report.periodsClosed, 1);

    const bp = fx.app.quota.billingPeriod(tenant.id, '2026-03')!;
    assert.equal(bp.status, 'closed');
    assert.equal(bp.consumeCredit, 30_000);

    // 同一天再跑不重复出账
    report = fx.app.jobs.run();
    assert.equal(report.periodsClosed, 0);
  });

  it('非 1 日不触发出账', () => {
    const fx = setup();
    activeTenant(fx, { purchasedCredit: 10_000 });
    fx.clock.set('2026-04-15T03:00:00.000Z');
    const report = fx.app.jobs.run();
    assert.equal(report.periodsClosed, 0);
  });
});

describe('Spec 10.4 试用到期提醒与自动处理', () => {
  it('到期前 7 / 3 / 1 天各提醒一次', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    trialTenant(fx); // 14 天

    for (const day of [5, 6, 7, 8, 9, 10, 11, 12, 13]) {
      fx.clock.set(addDays(t0, day).toISOString());
      fx.app.jobs.run();
    }

    const reminders = fx.app.notifier.byKind('trial.expiring');
    const days = reminders.map((n) => n.payload.remainingDays).sort((a, b) => Number(b) - Number(a));
    assert.deepEqual(days, TRIAL_REMINDER_DAYS);
  });

  it('到期后自动收口：回收席位、作废赠送额度、撤销模型授权', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);

    fx.clock.set(addDays(t0, 15).toISOString());
    const report = fx.app.jobs.run();

    assert.deepEqual(report.trialsExpired, [tenant.id]);
    const after = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(after.status, 'suspended');
    assert.equal(after.suspendReason, 'trial_expired');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 0);
    assert.equal(fx.app.quota.balance(tenant.id).giftCredit, 0);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, 0);
  });

  it('到期动作 keep_readonly 也会停用，但由套餐区分后续处理', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const plan = fx.app.trials.createPlan(superAdmin, {
      name: '只读到期试用',
      seatCount: 5,
      giftCredit: 1_000,
      modelGroups: ['基础模型集'],
      durationDays: 7,
      expireAction: 'keep_readonly',
    });
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({ provisioning: { mode: 'trial', planId: plan.id } }),
    );

    fx.clock.set(addDays(t0, 8).toISOString());
    fx.app.jobs.run();

    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'suspended');
    assert.equal(
      fx.app.trials.expireActionOf(fx.app.store.tenants.get(tenant.id)!),
      'keep_readonly',
    );
  });

  it('到期后不自动注销', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = trialTenant(fx);

    fx.clock.set(addDays(t0, 60).toISOString());
    fx.app.jobs.run();
    fx.app.jobs.run();

    const after = fx.app.store.tenants.get(tenant.id)!;
    assert.equal(after.status, 'suspended');
    assert.notEqual(after.status, 'deregistering');
  });
});

describe('Spec 6.4 保留期届满自动清除', () => {
  it('保留期内不清除，届满后清除业务数据', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });

    fx.clock.set(addDays(t0, 20).toISOString());
    let report = fx.app.jobs.run();
    assert.deepEqual(report.tenantsPurged, []);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'deregistering');

    fx.clock.set(addDays(t0, 31).toISOString()); // 默认保留期 30 天
    report = fx.app.jobs.run();
    assert.deepEqual(report.tenantsPurged, [tenant.id]);
    assert.equal(fx.app.store.tenants.get(tenant.id)!.status, 'deregistered');
    assert.equal(fx.app.seats.assignments(tenant.id, true).length, 0);
  });

  it('自动清除的审计日志操作人记为 system', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx);
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });

    fx.clock.set(addDays(t0, 31).toISOString());
    fx.app.jobs.run();

    const purgeLog = fx.app.audit
      .query({ tenantId: tenant.id, action: 'purge' })
      .at(0)!;
    assert.equal(purgeLog.actorId, 'system');
    assert.equal(purgeLog.source, 'system');
  });

  it('已注销的租户不再被后续任务处理', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx);
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });
    fx.clock.set(addDays(t0, 31).toISOString());
    fx.app.jobs.run();

    const report = fx.app.jobs.run();
    assert.deepEqual(report.tenantsPurged, []);
  });
});

describe('每日任务的整体幂等性', () => {
  it('同一天重复执行不产生重复副作用', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, { purchasedCredit: 100_000, seatCount: 5 });
    fx.app.quota.gift(operator, tenant.id, { amountCredit: 20_000 });
    trialTenant(fx);

    fx.clock.set(addDays(t0, 25).toISOString());
    const first = fx.app.jobs.run();
    const ledgerAfterFirst = fx.app.quota.ledger(tenant.id).length;

    const second = fx.app.jobs.run();
    assert.equal(second.giftCreditExpired, 0);
    assert.equal(second.trialsExpired.length, 0);
    assert.equal(fx.app.quota.ledger(tenant.id).length, ledgerAfterFirst);
    assert.ok(first.giftCreditExpired > 0);
  });
});
