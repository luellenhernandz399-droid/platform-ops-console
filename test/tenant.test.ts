// Spec 第 5、6 章：角色权限、租户生命周期状态机、创建与注销。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVANCED_MODEL_GROUP,
  activeTenant,
  auditor,
  expectError,
  operator,
  sales,
  setup,
  superAdmin,
  tenantCommand,
} from './helpers.ts';
import { capabilitiesOf } from '../src/services/tenant.ts';
import { hasPermission, PERMISSIONS, ROLE_PERMISSIONS } from '../src/domain/rbac.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';

describe('Spec 5.2 权限点与角色矩阵', () => {
  it('权限点清单共 45 条且编码格式为 模块.资源.操作', () => {
    assert.equal(PERMISSIONS.length, 45);
    for (const p of PERMISSIONS) {
      assert.match(p, /^platform\.[a-z_]+\.[a-z_]+$/);
    }
  });

  it('只读审计拥有全部 view/export，且没有任何写权限', () => {
    for (const p of PERMISSIONS) {
      const readOnly = p.endsWith('.view') || p.endsWith('.export');
      assert.equal(
        hasPermission(auditor, p),
        readOnly,
        `审计角色对 ${p} 的权限判定不符预期`,
      );
    }
  });

  it('危险操作仅超管可执行', () => {
    const dangerous = [
      'platform.tenant.deregister',
      'platform.tenant.restore',
      'platform.tenant.purge',
      'platform.seat.force_release',
      'platform.quota.revoke',
      'platform.quota.adjust',
      'platform.account.manage',
    ] as const;
    for (const p of dangerous) {
      assert.ok(hasPermission(superAdmin, p), `超管应有 ${p}`);
      assert.ok(!hasPermission(operator, p), `运营不应有 ${p}`);
      assert.ok(!hasPermission(sales, p), `商务不应有 ${p}`);
      assert.ok(!hasPermission(auditor, p), `审计不应有 ${p}`);
    }
  });

  it('商务不能下发正式资源，运营可以', () => {
    assert.ok(!hasPermission(sales, 'platform.quota.grant'));
    assert.ok(!hasPermission(sales, 'platform.seat.grant'));
    assert.ok(hasPermission(operator, 'platform.quota.grant'));
    assert.ok(hasPermission(operator, 'platform.seat.grant'));
  });

  it('角色权限是逐级包含的：审计 ⊂ 商务 ⊂ 运营 ⊂ 超管', () => {
    const sets = ['auditor', 'sales', 'operator', 'super_admin'] as const;
    for (let i = 0; i < sets.length - 1; i += 1) {
      const smaller = ROLE_PERMISSIONS[sets[i]];
      const larger = ROLE_PERMISSIONS[sets[i + 1]];
      for (const p of smaller) {
        assert.ok(larger.has(p), `${sets[i + 1]} 应包含 ${sets[i]} 的 ${p}`);
      }
    }
  });
});

describe('Spec 6.2 创建租户', () => {
  it('仅创建不开通：状态 pending，不生成任何授予单', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, tenantCommand());

    assert.equal(tenant.status, 'pending');
    assert.match(tenant.code, /^T\d{8}$/);
    assert.equal(fx.app.seats.grants(tenant.id).length, 0);
    assert.equal(fx.app.quota.grants(tenant.id).length, 0);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, 0);
    // 未开通时不占席位
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 0);
  });

  it('直接开通正式：生成席位与额度授予单，首个管理员占用一席', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10, purchasedCredit: 100_000 });

    assert.equal(tenant.status, 'active');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 1);
    assert.equal(fx.app.quota.balance(tenant.id).purchasedCredit, 100_000);

    const admin = fx.app.seats.assignments(tenant.id)[0];
    assert.equal(admin.isAdmin, true);
  });

  it('直接开通正式时初始席位数为 0 直接拒绝', () => {
    const fx = setup();
    expectError(
      () =>
        fx.app.createTenant(
          superAdmin,
          tenantCommand({
            provisioning: { mode: 'active', seatCount: 0, purchasedCredit: 1000 },
          }),
        ),
      'VALIDATION_ERROR',
    );
  });

  it('租户名称全局唯一', () => {
    const fx = setup();
    fx.app.createTenant(superAdmin, tenantCommand({ name: '词元无限' }));
    expectError(
      () => fx.app.createTenant(superAdmin, tenantCommand({ name: '词元无限' })),
      'TENANT_NAME_DUPLICATE',
    );
  });

  it('保留期超出 7~180 天范围时拒绝', () => {
    const fx = setup();
    expectError(
      () => fx.app.createTenant(superAdmin, tenantCommand({ retentionDays: 3 })),
      'VALIDATION_ERROR',
    );
    expectError(
      () => fx.app.createTenant(superAdmin, tenantCommand({ retentionDays: 365 })),
      'VALIDATION_ERROR',
    );
  });

  it('席位超卖比例上限 20%', () => {
    const fx = setup();
    expectError(
      () =>
        fx.app.createTenant(superAdmin, tenantCommand({ seatOversellPercent: 50 })),
      'VALIDATION_ERROR',
    );
  });

  it('审计角色不能创建租户', () => {
    const fx = setup();
    expectError(
      () => fx.app.createTenant(auditor, tenantCommand()),
      'PERMISSION_DENIED',
    );
  });
});

describe('Spec 6.2 待开通租户一次性开通正式（租户管理列表内联操作）', () => {
  it('待开通租户可一次性开通：生成席位与额度授予单，首个管理员占用一席', () => {
    const fx = setup();
    const pending = fx.app.createTenant(superAdmin, tenantCommand());

    const tenant = fx.app.activateTenant(superAdmin, pending.id, {
      seatCount: 10,
      purchasedCredit: 100_000,
      modelGroups: [BASIC_MODEL_GROUP],
      firstAdmin: { memberId: 'm_admin_1', name: '张三', email: 'admin1@example.com' },
    });

    assert.equal(tenant.status, 'active');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 10);
    assert.equal(fx.app.seats.occupiedCount(tenant.id), 1);
    assert.equal(fx.app.quota.balance(tenant.id).purchasedCredit, 100_000);
    assert.equal(fx.app.models.activeGrants(tenant.id).length > 0, true);

    const admin = fx.app.seats.assignments(tenant.id)[0];
    assert.equal(admin.isAdmin, true);
  });

  it('非待开通状态调用报错', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    expectError(
      () =>
        fx.app.activateTenant(superAdmin, tenant.id, {
          seatCount: 10,
          purchasedCredit: 100_000,
          firstAdmin: { memberId: 'm_admin_2', name: '李四', email: 'admin2@example.com' },
        }),
      'VALIDATION_ERROR',
    );
  });

  it('席位数为 0 时拒绝', () => {
    const fx = setup();
    const pending = fx.app.createTenant(superAdmin, tenantCommand());

    expectError(
      () =>
        fx.app.activateTenant(superAdmin, pending.id, {
          seatCount: 0,
          purchasedCredit: 100_000,
          firstAdmin: { memberId: 'm_admin_3', name: '王五', email: 'admin3@example.com' },
        }),
      'VALIDATION_ERROR',
    );
  });
});

describe('Spec 6.1 状态机与能力表', () => {
  it('各状态的能力与 Spec 6.1 表格一致', () => {
    const expected = {
      pending: { canLogin: false, canCallModel: false, console: 'none', canReceiveGrants: true },
      trialing: { canLogin: true, canCallModel: true, console: 'full', canReceiveGrants: true },
      active: { canLogin: true, canCallModel: true, console: 'full', canReceiveGrants: true },
      suspended: { canLogin: true, canCallModel: false, console: 'readonly', canReceiveGrants: true },
      deregistering: { canLogin: false, canCallModel: false, console: 'none', canReceiveGrants: false },
      deregistered: { canLogin: false, canCallModel: false, console: 'none', canReceiveGrants: false },
    } as const;

    for (const [status, want] of Object.entries(expected)) {
      const caps = capabilitiesOf({ status } as never);
      assert.equal(caps.canLogin, want.canLogin, `${status}.canLogin`);
      assert.equal(caps.canCallModel, want.canCallModel, `${status}.canCallModel`);
      assert.equal(caps.console, want.console, `${status}.console`);
      assert.equal(caps.canReceiveGrants, want.canReceiveGrants, `${status}.canReceiveGrants`);
    }
  });

  it('非法流转被拒绝：active 不能直接回到 pending 或 trialing', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () => fx.app.trials.open(superAdmin, tenant.id, fx.trialPlanId),
      'TENANT_STATE_INVALID',
    );
  });

  it('人工停用需要理由，且理由不少于 10 字符', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () => fx.app.tenants.suspend(operator, tenant.id, 'manual', '太短'),
      'REASON_REQUIRED',
    );
    const suspended = fx.app.tenants.suspend(
      operator,
      tenant.id,
      'manual',
      '客户要求暂停服务，等待续签合同',
    );
    assert.equal(suspended.status, 'suspended');
    assert.equal(suspended.suspendReason, 'manual');
  });

  it('停用后仍可下发资源，用于先补额度后恢复', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.suspend(operator, tenant.id, 'manual', '客户要求暂停服务等待续签');

    const grant = fx.app.quota.grant(operator, tenant.id, { amountCredit: 5_000 });
    assert.equal(grant.status, 'active');
  });

  it('试用到期停用的租户不能直接恢复，必须走转正式', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(
      superAdmin,
      tenantCommand({ provisioning: { mode: 'trial', planId: fx.trialPlanId } }),
    );
    fx.app.trials.terminate(superAdmin, tenant.id, '客户明确表示不再继续试用');

    const error = expectError(
      () => fx.app.tenants.resume(superAdmin, tenant.id),
      'TENANT_STATE_INVALID',
    );
    assert.equal(error.details.suspendReason, 'trial_expired');
  });
});

describe('Spec 6.4 注销、恢复与清除', () => {
  it('注销需要名称完全匹配与 10 字符以上理由', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { name: '东软集团' });

    expectError(
      () =>
        fx.app.tenants.deregister(superAdmin, tenant.id, {
          confirmName: '东软',
          reason: '合同到期不再续约，客户确认注销',
        }),
      'CONFIRM_NAME_MISMATCH',
    );
    expectError(
      () =>
        fx.app.tenants.deregister(superAdmin, tenant.id, {
          confirmName: '东软集团',
          reason: '短',
        }),
      'REASON_REQUIRED',
    );
  });

  it('注销后席位授予单回收、模型授权撤销，占用关系保留用于恢复', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const occupiedBefore = fx.app.seats.occupiedCount(tenant.id);
    assert.ok(occupiedBefore > 0);
    assert.ok(fx.app.models.activeGrants(tenant.id).length > 0);

    const next = fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });

    assert.equal(next.status, 'deregistering');
    assert.equal(fx.app.seats.seatTotal(tenant.id), 0);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, 0);
    // 占用关系保留
    assert.equal(fx.app.seats.occupiedCount(tenant.id), occupiedBefore);
    assert.ok(next.deregisterSnapshot);
    assert.equal(next.deregisterSnapshot.seatOccupied, occupiedBefore);
  });

  it('保留期内恢复，席位与模型授权按快照原样还原', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const seatsBefore = fx.app.seats.seatTotal(tenant.id);
    const modelsBefore = fx.app.models.activeGrants(tenant.id).length;

    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '客户暂停合作，先行注销观察',
    });
    const restored = fx.app.tenants.restore(superAdmin, tenant.id);

    assert.equal(restored.status, 'active');
    assert.equal(fx.app.seats.seatTotal(tenant.id), seatsBefore);
    assert.equal(fx.app.models.activeGrants(tenant.id).length, modelsBefore);
    assert.equal(restored.deregisterSnapshot, null);
  });

  it('注销保留期内不可下发资源', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });

    expectError(
      () => fx.app.quota.grant(operator, tenant.id, { amountCredit: 1000 }),
      'TENANT_STATE_INVALID',
    );
    expectError(
      () => fx.app.seats.grant(operator, tenant.id, { seatCount: 5 }),
      'TENANT_STATE_INVALID',
    );
  });

  it('清除后业务数据消失，但授予单、流水与审计日志保留', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10, purchasedCredit: 50_000 });
    const grantCount = fx.app.quota.grants(tenant.id).length;
    const ledgerCount = fx.app.quota.ledger(tenant.id).length;

    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });
    const purged = fx.app.tenants.purge(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '客户要求立即清除全部数据',
    });

    assert.equal(purged.status, 'deregistered');
    // 业务数据已清除
    assert.equal(fx.app.seats.assignments(tenant.id, true).length, 0);
    assert.equal(fx.app.store.modelGrants.find((g) => g.tenantId === tenant.id).length, 0);
    // 凭证类数据保留
    assert.equal(fx.app.quota.grants(tenant.id).length, grantCount);
    assert.equal(fx.app.quota.ledger(tenant.id).length, ledgerCount);
    assert.ok(fx.app.audit.query({ tenantId: tenant.id }).length > 0);
  });

  it('已注销是终态，不可再恢复', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });
    fx.app.tenants.purge(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '客户要求立即清除全部数据',
    });

    expectError(() => fx.app.tenants.restore(superAdmin, tenant.id), 'TENANT_STATE_INVALID');
  });

  it('生命周期事件按顺序记录了每一次流转', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.suspend(operator, tenant.id, 'manual', '客户要求暂停服务等待续签');
    fx.app.tenants.resume(operator, tenant.id);

    const timeline = fx.app.tenants.timeline(tenant.id);
    const path = timeline.map((e) => `${e.fromStatus ?? '-'}→${e.toStatus}`);
    assert.deepEqual(path, ['-→pending', 'pending→active', 'active→suspended', 'suspended→active']);
  });
});

describe('Spec 6.3 租户管理', () => {
  it('编辑记录逐字段 diff 到审计日志', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { name: '北航' });
    fx.app.tenants.edit(superAdmin, tenant.id, { level: 'key', industry: '教育' });

    const logs = fx.app.audit.query({ tenantId: tenant.id, action: 'edit' });
    assert.equal(logs.length, 1);
    assert.deepEqual(logs[0].diff, {
      level: { from: null, to: 'key' },
      industry: { from: null, to: '教育' },
    });
  });

  it('改名后注销的二次确认以新名称为准', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { name: '旧名称公司' });
    fx.app.tenants.edit(superAdmin, tenant.id, { name: '新名称公司' });

    expectError(
      () =>
        fx.app.tenants.deregister(superAdmin, tenant.id, {
          confirmName: '旧名称公司',
          reason: '合同到期不再续约，客户确认注销',
        }),
      'CONFIRM_NAME_MISMATCH',
    );
    const next = fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: '新名称公司',
      reason: '合同到期不再续约，客户确认注销',
    });
    assert.equal(next.status, 'deregistering');
  });

  it('备注为追加式，历史条目不被覆盖', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.addRemark(superAdmin, tenant.id, '第一条备注');
    const after = fx.app.tenants.addRemark(operator, tenant.id, '第二条备注');

    assert.equal(after.remarks.length, 2);
    assert.equal(after.remarks[0].text, '第一条备注');
    assert.equal(after.remarks[0].operatorId, superAdmin.id);
    assert.equal(after.remarks[1].operatorId, operator.id);
  });
});

describe('Spec 4.3 模型不变式', () => {
  it('未授权的分组不会出现在租户可用模型中', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const codes = fx.app.models.activeGrants(tenant.id).map((g) => g.modelCode).sort();
    assert.deepEqual(codes, ['claude-sonnet-5', 'deepseek-v3']);
    assert.ok(!codes.includes('claude-opus-5'));
    void ADVANCED_MODEL_GROUP;
  });
});
