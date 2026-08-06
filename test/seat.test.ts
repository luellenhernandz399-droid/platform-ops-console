// Spec 第 7 章：席位管理与分发。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  activeTenant,
  expectError,
  fillSeats,
  operator,
  setup,
  superAdmin,
} from './helpers.ts';
import { addDays } from '../src/domain/time.ts';

describe('Spec 7.1 席位总数与计费口径', () => {
  it('席位总数是有效授予单之和，扩容不修改已有授予单', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 50 });
    const before = fx.app.seats.grants(tenant.id);
    assert.equal(before.length, 1);
    assert.equal(fx.app.seats.seatTotal(tenant.id), 50);

    fx.app.seats.grant(operator, tenant.id, {
      seatCount: 20,
      expireAt: addDays(fx.clock.now(), 365).toISOString(),
    });

    const after = fx.app.seats.grants(tenant.id);
    assert.equal(after.length, 2, '扩容应新建授予单');
    assert.equal(after[0].seatCount, 50, '原授予单不应被修改');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 70);
  });

  it('每批席位的到期时间互相独立', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 50,
      seatExpireAt: addDays(t0, 90).toISOString(),
    });
    fx.app.seats.grant(operator, tenant.id, {
      seatCount: 20,
      expireAt: addDays(t0, 300).toISOString(),
    });
    assert.equal(fx.app.seats.seatTotal(tenant.id), 70);

    // 第一批过期并走完宽限期（默认 7 天）后，只剩第二批
    fx.clock.set(addDays(t0, 98).toISOString());
    assert.equal(fx.app.seats.seatTotal(tenant.id), 20);
  });

  it('停用的成员仍然占用席位，删除才释放', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    const [m0] = fillSeats(fx, tenant.id, 2);
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 3); // 含管理员

    fx.app.seats.disableMember(tenant.id, m0);
    assert.equal(
      fx.app.seats.occupiedCount(tenant.id),
      3,
      '停用不释放席位',
    );

    fx.app.seats.release(tenant.id, m0, 'member_deleted');
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 2);
  });

  it('同一成员不能重复占用席位', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    fx.app.seats.assign(tenant.id, {
      memberId: 'm1',
      memberName: '李四',
      memberEmail: 'l@example.com',
    });
    expectError(
      () =>
        fx.app.seats.assign(tenant.id, {
          memberId: 'm1',
          memberName: '李四',
          memberEmail: 'l@example.com',
        }),
      'SEAT_ALREADY_ASSIGNED',
    );
  });

  it('释放后席位立即可被新成员占用，无冷却期', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 2 });
    fillSeats(fx, tenant.id, 1); // 占满 2 席（含管理员）
    expectError(() => fillSeats(fx, tenant.id, 1, 'x'), 'SEAT_INSUFFICIENT');

    fx.app.seats.release(tenant.id, `m_${tenant.id}_0`, 'member_deleted');
    const ids = fillSeats(fx, tenant.id, 1, 'y');
    assert.equal(ids.length, 1);
  });

  it('仅 contract 来源允许永久席位', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () =>
        fx.app.seats.grant(operator, tenant.id, {
          seatCount: 5,
          source: 'gift',
          expireAt: null,
        }),
      'VALIDATION_ERROR',
    );
  });
});

describe('Spec 7.2 平台侧操作', () => {
  it('缩容不能增加席位数', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const grant = fx.app.seats.grants(tenant.id)[0];
    expectError(
      () =>
        fx.app.seats.reduce(superAdmin, grant.id, 20, {
          reason: '客户要求调整席位数量',
        }),
      'VALIDATION_ERROR',
    );
  });

  it('续期只能往后延，不能提前到期', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 100).toISOString(),
    });
    const grant = fx.app.seats.grants(tenant.id)[0];

    expectError(
      () => fx.app.seats.renew(operator, grant.id, addDays(t0, 50).toISOString()),
      'SEAT_RENEW_BACKWARDS',
    );
    const renewed = fx.app.seats.renew(
      operator,
      grant.id,
      addDays(t0, 200).toISOString(),
    );
    assert.equal(renewed.expireAt, addDays(t0, 200).toISOString());
  });

  it('缩容与回收都要求 10 字符以上理由', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const grant = fx.app.seats.grants(tenant.id)[0];
    expectError(
      () => fx.app.seats.reduce(superAdmin, grant.id, 5, { reason: '缩容' }),
      'REASON_REQUIRED',
    );
  });

  it('运营可分发席位，但强制释放仅超管', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 2);

    fx.app.seats.grant(operator, tenant.id, { seatCount: 5, expireAt: null });
    expectError(
      () =>
        fx.app.seats.forceRelease(
          operator,
          tenant.id,
          `m_${tenant.id}_0`,
          '成员长期未使用需要回收席位',
        ),
      'PERMISSION_DENIED',
    );
  });

  it('相同幂等键重复提交不会重复产生授予单', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const before = fx.app.seats.grants(tenant.id).length;

    const a = fx.app.seats.grant(operator, tenant.id, {
      seatCount: 5,
      expireAt: null,
      idempotencyKey: 'req-001',
    });
    const b = fx.app.seats.grant(operator, tenant.id, {
      seatCount: 5,
      expireAt: null,
      idempotencyKey: 'req-001',
    });

    assert.equal(a.id, b.id);
    assert.equal(fx.app.seats.grants(tenant.id).length, before + 1);
  });

  it('幂等键相同但参数不同报冲突', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fx.app.seats.grant(operator, tenant.id, {
      seatCount: 5,
      expireAt: null,
      idempotencyKey: 'req-002',
    });
    expectError(
      () =>
        fx.app.seats.grant(operator, tenant.id, {
          seatCount: 9,
          expireAt: null,
          idempotencyKey: 'req-002',
        }),
      'IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('Spec 7.4 缩容冲突三策略', () => {
  it('策略 A 拒绝：返回需释放的数量', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 7); // 占用 8（含管理员）
    const grant = fx.app.seats.grants(tenant.id)[0];

    const error = expectError(
      () =>
        fx.app.seats.reduce(superAdmin, grant.id, 5, {
          strategy: 'reject',
          reason: '合同缩减席位数量至五个',
        }),
      'SEAT_REDUCE_CONFLICT',
    );
    assert.equal(error.details.occupied, 8);
    assert.equal(error.details.seatTotalAfter, 5);
    assert.equal(error.details.mustRelease, 3);
    // 拒绝后授予单未被修改
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);
  });

  it('策略 B 延期生效：当下不改数量，登记待生效目标', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 30).toISOString(),
    });
    fillSeats(fx, tenant.id, 7);
    const grant = fx.app.seats.grants(tenant.id)[0];

    const result = fx.app.seats.reduce(superAdmin, grant.id, 5, {
      strategy: 'defer',
      reason: '合同到期不续，让客户自然消化',
    });

    assert.equal(result.deferredTo, 5);
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10, '当下不变');
    assert.equal(result.grant.pendingReduceTo, 5);
    assert.equal(result.grant.pendingReduceAt, addDays(t0, 30).toISOString());
  });

  it('策略 C 强制回收：按「从未登录 → 最早活跃 → 最晚创建」顺序', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, { seatCount: 10 });

    // 三个成员：活跃时间递减，外加一个从未登录的
    fx.app.seats.assign(tenant.id, { memberId: 'a', memberName: 'A', memberEmail: 'a@x.com' });
    fx.app.seats.assign(tenant.id, { memberId: 'b', memberName: 'B', memberEmail: 'b@x.com' });
    fx.app.seats.assign(tenant.id, { memberId: 'c', memberName: 'C', memberEmail: 'c@x.com' });
    fx.app.seats.assign(tenant.id, { memberId: 'd', memberName: 'D', memberEmail: 'd@x.com' });

    fx.app.seats.touchActivity(tenant.id, 'a', addDays(t0, -1));
    fx.app.seats.touchActivity(tenant.id, 'b', addDays(t0, -10));
    fx.app.seats.touchActivity(tenant.id, 'c', addDays(t0, -5));
    // d 从未登录

    const order = fx.app.seats.recoveryCandidates(tenant.id).map((x) => x.memberId);
    assert.deepEqual(order, ['d', 'b', 'c', 'a']);
  });

  it('策略 C 实际回收后满足席位不变式', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 7); // 占用 8
    const grant = fx.app.seats.grants(tenant.id)[0];

    const result = fx.app.seats.reduce(superAdmin, grant.id, 5, {
      strategy: 'force',
      reason: '合同缩减席位，客户已确认强制回收',
    });

    assert.equal(result.released.length, 3);
    assert.equal(fx.app.seats.seatTotal(tenant.id), 5);
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 5);
    assert.ok(
      fx.app.seats.occupiedCount(tenant.id) <= fx.app.seats.seatTotal(tenant.id),
      '席位不变式必须成立',
    );
  });

  it('策略 C 会给租户管理员发通知，列出被回收成员', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 7);
    const grant = fx.app.seats.grants(tenant.id)[0];

    fx.app.seats.reduce(superAdmin, grant.id, 5, {
      strategy: 'force',
      reason: '合同缩减席位，客户已确认强制回收',
    });

    const notices = fx.app.notifier.byKind('seat.force_released');
    assert.equal(notices.length, 1);
    assert.equal((notices[0].payload.members as unknown[]).length, 3);
  });

  it('企业管理员永不被自动回收；只剩管理员时操作失败', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 3 });
    fillSeats(fx, tenant.id, 2); // 管理员 + 2 = 3

    const candidates = fx.app.seats.recoveryCandidates(tenant.id);
    assert.ok(candidates.every((c) => !c.isAdmin));

    const grant = fx.app.seats.grants(tenant.id)[0];
    // 缩到 0 需要回收 3 个，但只有 2 个非管理员候选
    const error = expectError(
      () =>
        fx.app.seats.reduce(superAdmin, grant.id, 0, {
          strategy: 'force',
          reason: '客户终止合作需要清空全部席位',
        }),
      'SEAT_ADMIN_PROTECTED',
    );
    assert.equal(error.details.need, 3);
    assert.equal(error.details.available, 2);
  });

  it('强制释放不能作用于企业管理员', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    const admin = fx.app.seats.assignments(tenant.id).find((a) => a.isAdmin)!;

    expectError(
      () =>
        fx.app.seats.forceRelease(
          superAdmin,
          tenant.id,
          admin.memberId,
          '尝试回收管理员席位应当被拒绝',
        ),
      'SEAT_ADMIN_PROTECTED',
    );
  });

  it('确认名单与系统计算不一致时拒绝执行', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 7);
    const grant = fx.app.seats.grants(tenant.id)[0];

    expectError(
      () =>
        fx.app.seats.reduce(superAdmin, grant.id, 5, {
          strategy: 'force',
          reason: '合同缩减席位，客户已确认强制回收',
          confirmedMemberIds: ['不存在的成员'],
        }),
      'VALIDATION_ERROR',
    );
  });

  it('不冲突时缩容直接生效', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    fillSeats(fx, tenant.id, 2); // 占用 3
    const grant = fx.app.seats.grants(tenant.id)[0];

    const result = fx.app.seats.reduce(superAdmin, grant.id, 5, {
      reason: '客户主动缩减席位到五个',
    });
    assert.equal(result.released.length, 0);
    assert.equal(fx.app.seats.seatTotal(tenant.id), 5);
  });
});

describe('Spec 7.5 超卖与宽限期', () => {
  it('默认硬限：占满后拒绝新成员', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 3 });
    fillSeats(fx, tenant.id, 2); // 占满 3

    const error = expectError(() => fillSeats(fx, tenant.id, 1, 'z'), 'SEAT_INSUFFICIENT');
    assert.equal(error.details.limit, 3);
  });

  it('软限允许超出配置比例，超出后仍然拒绝', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, {
      name: '软限企业',
      contactName: '王五',
      contactEmail: 'w@example.com',
      seatOversellPercent: 20,
      provisioning: { mode: 'active', seatCount: 10, purchasedCredit: 1000 },
      firstAdmin: { memberId: 'admin_soft', name: '王五', email: 'w@example.com' },
    });

    // 10 * 1.2 = 12
    fillSeats(fx, tenant.id, 11); // 占用 12
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 12);
    expectError(() => fillSeats(fx, tenant.id, 1, 'over'), 'SEAT_INSUFFICIENT');

    const overview = fx.app.seats.overview(tenant.id);
    assert.equal(overview.oversold, true);
  });

  it('超卖时给归属销售与平台运营发通知', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, {
      name: '超卖通知企业',
      contactName: '王五',
      contactEmail: 'w2@example.com',
      seatOversellPercent: 20,
      provisioning: { mode: 'active', seatCount: 10, purchasedCredit: 1000 },
      firstAdmin: { memberId: 'admin_notify', name: '王五', email: 'w2@example.com' },
    });
    fillSeats(fx, tenant.id, 10); // 占用 11 > 10

    const notices = fx.app.notifier.byKind('seat.oversell');
    assert.ok(notices.length >= 1);
    assert.equal(notices[0].tenantId, tenant.id);
  });

  it('宽限期内已过期席位仍计入总数，届满后退出', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 10).toISOString(),
    });

    // 到期当天：仍计入
    fx.clock.set(addDays(t0, 10).toISOString());
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);
    assert.equal(fx.app.seats.overview(tenant.id).inGrace, 10);

    // 宽限期第 6 天：仍计入
    fx.clock.set(addDays(t0, 16).toISOString());
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);

    // 宽限期届满（默认 7 天）
    fx.clock.set(addDays(t0, 17).toISOString());
    assert.equal(fx.app.seats.seatTotal(tenant.id), 0);
  });

  it('总览统计 30 天内到期的席位数', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    const tenant = activeTenant(fx, {
      seatCount: 10,
      seatExpireAt: addDays(t0, 20).toISOString(),
    });
    fx.app.seats.grant(operator, tenant.id, {
      seatCount: 5,
      expireAt: addDays(t0, 200).toISOString(),
    });

    const overview = fx.app.seats.overview(tenant.id);
    assert.equal(overview.seatTotal, 15);
    assert.equal(overview.expiringSoon, 10);
  });
});

describe('Spec 7.3 释放场景表', () => {
  it('租户停用不释放占用，恢复后原样可用', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    fillSeats(fx, tenant.id, 2);
    const before = fx.app.seats.occupiedCount(tenant.id);

    fx.app.tenants.suspend(operator, tenant.id, 'manual', '客户要求暂停服务等待续签');
    assert.equal(fx.app.seats.occupiedCount(tenant.id), before);

    fx.app.tenants.resume(operator, tenant.id);
    assert.equal(fx.app.seats.occupiedCount(tenant.id), before);
  });

  it('离职同步释放席位并记录释放原因', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    const [m0] = fillSeats(fx, tenant.id, 1);

    fx.app.seats.release(tenant.id, m0, 'member_resigned');
    const released = fx.app.seats
      .assignments(tenant.id, true)
      .find((a) => a.memberId === m0)!;
    assert.equal(released.releaseReason, 'member_resigned');
    assert.ok(released.releasedAt !== null);
  });

  it('注销中的租户不能再占用席位', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 5 });
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });
    expectError(() => fillSeats(fx, tenant.id, 1), 'TENANT_STATE_INVALID');
  });
});
