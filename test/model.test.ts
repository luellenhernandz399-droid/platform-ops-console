// Spec 第 9 章：平台模型目录、租户授权、限额限速、与租户侧渠道的边界。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADVANCED_MODEL_GROUP,
  activeTenant,
  expectError,
  operator,
  setup,
  superAdmin,
  tenantCommand,
} from './helpers.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';
import { OFFLINE_NOTICE_DAYS } from '../src/services/model.ts';
import { addDays } from '../src/domain/time.ts';

describe('Spec 9.1 模型目录上下架', () => {
  it('新建模型默认 draft，未上架不能授权', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.models.createModel(superAdmin, {
      code: 'gpt-5',
      displayName: 'GPT-5',
      channel: 'OpenAI-Main',
      vendor: 'openai',
      group: ADVANCED_MODEL_GROUP,
    });

    expectError(
      () => fx.app.models.grantModel(operator, tenant.id, { modelCode: 'gpt-5' }),
      'MODEL_NOT_PUBLISHED',
    );
  });

  it('弃用后已授权租户继续可用，但禁止新授权', () => {
    const fx = setup();
    const a = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });
    const b = activeTenant(fx, { modelGroups: [] });

    fx.app.models.deprecate(superAdmin, 'claude-sonnet-5');

    // a 已授权，仍在可用列表
    assert.ok(fx.app.models.activeGrant(a.id, 'claude-sonnet-5'));
    fx.app.models.assertCallable(a.id, 'claude-sonnet-5');

    // b 新授权被拒绝
    expectError(
      () => fx.app.models.grantModel(operator, b.id, { modelCode: 'claude-sonnet-5' }),
      'MODEL_NOT_PUBLISHED',
    );
  });

  it('下线时间距今不足 30 天时拒绝', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    expectError(
      () =>
        fx.app.models.scheduleOffline(
          superAdmin,
          'claude-sonnet-5',
          addDays(t0, 15).toISOString(),
          '上游供应商通知该模型即将停止服务',
        ),
      'MODEL_OFFLINE_NOTICE_TOO_SHORT',
    );

    const ok = fx.app.models.scheduleOffline(
      superAdmin,
      'claude-sonnet-5',
      addDays(t0, OFFLINE_NOTICE_DAYS + 1).toISOString(),
      '上游供应商通知该模型即将停止服务',
    );
    assert.equal(ok.status, 'deprecated');
    assert.ok(ok.offlineAt !== null);
  });

  it('安排下线时向所有已授权租户发通知', () => {
    const fx = setup();
    const t0 = fx.clock.now();
    activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });
    activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });

    fx.app.models.scheduleOffline(
      superAdmin,
      'claude-sonnet-5',
      addDays(t0, 40).toISOString(),
      '上游供应商通知该模型即将停止服务',
    );

    assert.equal(fx.app.notifier.byKind('model.offline_notice').length, 2);
  });

  it('正式下线撤销所有租户授权，调用返回 MODEL_OFFLINE', () => {
    const fx = setup();
    const tenant = activeTenant(fx, {
      modelGroups: [],
    });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'deepseek-v3' });

    fx.app.models.offline(superAdmin, 'claude-sonnet-5');

    assert.equal(fx.app.models.activeGrant(tenant.id, 'claude-sonnet-5'), undefined);
    expectError(
      () => fx.app.models.assertCallable(tenant.id, 'claude-sonnet-5'),
      'MODEL_OFFLINE',
    );
    // 其余模型不受影响
    fx.app.models.assertCallable(tenant.id, 'deepseek-v3');
  });

  it('已下线的模型不能重新上架', () => {
    const fx = setup();
    fx.app.models.offline(superAdmin, 'deepseek-v3');
    expectError(() => fx.app.models.publish(superAdmin, 'deepseek-v3'), 'MODEL_OFFLINE');
  });
});

describe('Spec 9.2 按分组授权与跟随', () => {
  it('按分组授权后，分组内新上架的模型自动授权', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });
    const before = fx.app.models.activeGrants(tenant.id).length;

    fx.app.models.createModel(superAdmin, {
      code: 'qwen3-72b',
      displayName: 'Qwen3 72B',
      channel: 'Local-vLLM',
      vendor: 'self_hosted',
      group: BASIC_MODEL_GROUP,
    });
    fx.app.models.publish(superAdmin, 'qwen3-72b');

    const after = fx.app.models.activeGrants(tenant.id);
    assert.equal(after.length, before + 1);
    const added = after.find((g) => g.modelCode === 'qwen3-72b')!;
    assert.equal(added.grantMode, 'group');
    assert.equal(added.group, BASIC_MODEL_GROUP);
  });

  it('未跟随该分组的租户不会被自动授权', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [ADVANCED_MODEL_GROUP] });
    const before = fx.app.models.activeGrants(tenant.id).length;

    fx.app.models.createModel(superAdmin, {
      code: 'kimi-k2',
      displayName: 'Kimi K2',
      channel: 'Moonshot',
      vendor: 'deepseek',
      group: BASIC_MODEL_GROUP,
    });
    fx.app.models.publish(superAdmin, 'kimi-k2');

    assert.equal(fx.app.models.activeGrants(tenant.id).length, before);
  });

  it('跟随分组的模型不能单独取消，必须先解除分组授权', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });

    const error = expectError(
      () => fx.app.models.revokeModel(operator, tenant.id, 'claude-sonnet-5'),
      'MODEL_GROUP_FOLLOWED',
    );
    assert.equal(error.details.group, BASIC_MODEL_GROUP);

    // 解除分组后模型全部撤销
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-opus-5' });
    const removed = fx.app.models.revokeGroup(operator, tenant.id, BASIC_MODEL_GROUP);
    assert.equal(removed, 2);
    assert.deepEqual(fx.app.models.followedGroups(tenant.id), []);
  });

  it('单独授权的模型在按分组授权后升级为跟随模式', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });
    assert.equal(
      fx.app.models.activeGrant(tenant.id, 'claude-sonnet-5')!.grantMode,
      'individual',
    );

    fx.app.models.grantGroup(operator, tenant.id, BASIC_MODEL_GROUP);
    assert.equal(
      fx.app.models.activeGrant(tenant.id, 'claude-sonnet-5')!.grantMode,
      'group',
    );
  });
});

describe('Spec 9.2 默认模型', () => {
  it('第一个被授权的模型自动成为默认模型', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });
    assert.equal(fx.app.models.defaultModel(tenant.id)!.modelCode, 'claude-sonnet-5');
  });

  it('撤销默认模型时自动接管为剩余模型中最早授权的一个', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'deepseek-v3' });
    assert.equal(fx.app.models.defaultModel(tenant.id)!.modelCode, 'claude-sonnet-5');

    fx.app.models.revokeModel(operator, tenant.id, 'claude-sonnet-5');
    assert.equal(fx.app.models.defaultModel(tenant.id)!.modelCode, 'deepseek-v3');
  });

  it('撤销后没有任何可用模型时拒绝撤销', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });

    expectError(
      () => fx.app.models.revokeModel(operator, tenant.id, 'claude-sonnet-5'),
      'MODEL_DEFAULT_REQUIRED',
    );
  });

  it('切换默认模型时旧默认被取消', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'deepseek-v3' });

    fx.app.models.setDefault(operator, tenant.id, 'deepseek-v3');
    const defaults = fx.app.models
      .activeGrants(tenant.id)
      .filter((g) => g.isDefault)
      .map((g) => g.modelCode);
    assert.deepEqual(defaults, ['deepseek-v3']);
  });
});

describe('Spec 9.3 限额与限速', () => {
  it('租户级与单模型配置取最严', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, {
      modelCode: 'claude-sonnet-5',
      tpm: 100_000,
      rpm: 60,
    });
    fx.app.models.setTenantLimits(operator, tenant.id, { tpm: 50_000, concurrency: 10 });

    const limits = fx.app.models.effectiveLimits(tenant.id, 'claude-sonnet-5');
    assert.equal(limits.tpm, 50_000, '取更严的租户级');
    assert.equal(limits.rpm, 60, '租户级未设则取模型级');
    assert.equal(limits.concurrency, 10, '模型级未设则取租户级');
  });

  it('未配置表示不限制', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-sonnet-5' });

    const limits = fx.app.models.effectiveLimits(tenant.id, 'claude-sonnet-5');
    assert.equal(limits.tpm, null);
    assert.equal(limits.rpm, null);
  });

  it('单模型额度上限用尽后返回 MODEL_QUOTA_EXCEEDED', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, {
      modelCode: 'claude-sonnet-5',
      modelQuotaCapCredit: 1_000,
    });

    fx.app.models.assertCallable(tenant.id, 'claude-sonnet-5');
    fx.app.models.recordUsage(tenant.id, 'claude-sonnet-5', 1_000);

    expectError(
      () => fx.app.models.assertCallable(tenant.id, 'claude-sonnet-5'),
      'MODEL_QUOTA_EXCEEDED',
    );
  });

  it('账期切换后单模型用量清零', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [] });
    fx.app.models.grantModel(operator, tenant.id, {
      modelCode: 'claude-sonnet-5',
      modelQuotaCapCredit: 1_000,
    });
    fx.app.models.recordUsage(tenant.id, 'claude-sonnet-5', 1_000);
    expectError(
      () => fx.app.models.assertCallable(tenant.id, 'claude-sonnet-5'),
      'MODEL_QUOTA_EXCEEDED',
    );

    fx.clock.set('2026-04-02T02:00:00.000Z');
    fx.app.models.assertCallable(tenant.id, 'claude-sonnet-5');
  });
});

describe('Spec 9.4 与租户侧渠道的边界', () => {
  it('未授权模型不可调用', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });
    expectError(
      () => fx.app.models.assertCallable(tenant.id, 'claude-opus-5'),
      'MODEL_NOT_GRANTED',
    );
  });

  it('自建渠道受平台总开关控制，且不受白名单约束', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });

    // 默认关闭
    expectError(
      () => fx.app.models.assertCallable(tenant.id, 'my-local-model', { selfHosted: true }),
      'SELF_HOSTED_CHANNEL_DISABLED',
    );

    fx.app.models.setSelfHostedChannel(operator, tenant.id, true);
    // 目录里根本没有这个模型，但自建渠道不查白名单
    fx.app.models.assertCallable(tenant.id, 'my-local-model', { selfHosted: true });
  });

  it('平台授权是白名单上限，租户可用集合是它的子集', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { modelGroups: [BASIC_MODEL_GROUP] });

    const whitelist = new Set(
      fx.app.models.activeGrants(tenant.id).map((g) => g.modelCode),
    );
    const catalogAll = fx.app.models.catalog().map((m) => m.code);

    for (const code of catalogAll) {
      if (whitelist.has(code)) {
        fx.app.models.assertCallable(tenant.id, code);
      } else {
        expectError(() => fx.app.models.assertCallable(tenant.id, code), 'MODEL_NOT_GRANTED');
      }
    }
  });

  it('注销中的租户不能再授权模型', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    fx.app.tenants.deregister(superAdmin, tenant.id, {
      confirmName: tenant.name,
      reason: '合同到期不再续约，客户确认注销',
    });
    expectError(
      () => fx.app.models.grantModel(operator, tenant.id, { modelCode: 'claude-opus-5' }),
      'TENANT_STATE_INVALID',
    );
  });

  it('商务角色不能授权模型', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, tenantCommand());
    expectError(
      () =>
        fx.app.models.grantModel(
          { id: 'u_sales', role: 'sales' },
          tenant.id,
          { modelCode: 'claude-sonnet-5' },
        ),
      'PERMISSION_DENIED',
    );
  });
});
