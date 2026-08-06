// Spec 第 13 章：HTTP 接口、鉴权、幂等、错误码映射。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { activeTenant, setup } from './helpers.ts';
import type { Fixture } from './helpers.ts';
import { Router } from '../src/api/router.ts';
import type { ApiRequest, ApiResponse } from '../src/api/router.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';

function client(fx: Fixture) {
  const router = new Router(fx.app);
  return function call(
    method: string,
    path: string,
    options: {
      as?: { id: string; role: string };
      body?: unknown;
      query?: Record<string, string | string[]>;
      idempotencyKey?: string;
      noAuth?: boolean;
    } = {},
  ): ApiResponse {
    const headers: Record<string, string | undefined> = {};
    if (!options.noAuth) {
      const actor = options.as ?? { id: 'u_super', role: 'super_admin' };
      headers['x-actor-id'] = actor.id;
      headers['x-actor-role'] = actor.role;
    }
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;

    const request: ApiRequest = {
      method,
      path,
      body: options.body,
      query: options.query,
      headers,
    };
    return router.handle(request);
  };
}

describe('Spec 13 鉴权', () => {
  it('缺少身份请求头返回 401', () => {
    const fx = setup();
    const call = client(fx);
    const res = call('GET', '/platform/v1/tenants', { noAuth: true });
    assert.equal(res.status, 401);
    assert.equal((res.body as { code: string }).code, 'UNAUTHENTICATED');
  });

  it('非法角色返回 401', () => {
    const fx = setup();
    const call = client(fx);
    const res = call('GET', '/platform/v1/tenants', {
      as: { id: 'x', role: 'root' },
    });
    assert.equal(res.status, 401);
  });

  it('权限不足返回 403 与 PERMISSION_DENIED', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const call = client(fx);

    const res = call('POST', `/platform/v1/tenants/${tenant.id}/quota-grants`, {
      as: { id: 'u_audit', role: 'auditor' },
      body: { amountCredit: 1000 },
    });
    assert.equal(res.status, 403);
    assert.equal((res.body as { code: string }).code, 'PERMISSION_DENIED');
  });

  it('只读角色可以读，不能写', () => {
    const fx = setup();
    activeTenant(fx);
    const call = client(fx);
    const auditor = { id: 'u_audit', role: 'auditor' };

    assert.equal(call('GET', '/platform/v1/tenants', { as: auditor }).status, 200);
    assert.equal(
      call('POST', '/platform/v1/tenants', {
        as: auditor,
        body: { name: 'x', contactName: 'y', contactEmail: 'z@x.com' },
      }).status,
      403,
    );
  });
});

describe('Spec 13 路由与错误映射', () => {
  it('未知路径返回 404，方法不匹配返回 405', () => {
    const fx = setup();
    const call = client(fx);
    assert.equal(call('GET', '/platform/v1/not-exist').status, 404);
    assert.equal(call('DELETE', '/platform/v1/tenants').status, 405);
  });

  it('领域错误码映射到对应 HTTP 状态码', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 3 });
    const call = client(fx);

    // 404
    assert.equal(call('GET', '/platform/v1/tenants/不存在的租户').status, 404);

    // 409：缩容冲突
    fx.app.seats.assign(tenant.id, { memberId: 'a', memberName: 'A', memberEmail: 'a@x.com' });
    fx.app.seats.assign(tenant.id, { memberId: 'b', memberName: 'B', memberEmail: 'b@x.com' });
    const grant = fx.app.seats.grants(tenant.id)[0];
    const conflict = call('POST', `/platform/v1/seat-grants/${grant.id}/reduce`, {
      body: { targetCount: 1, strategy: 'reject', reason: '合同缩减席位数量到一个' },
    });
    assert.equal(conflict.status, 409);
    assert.equal((conflict.body as { code: string }).code, 'SEAT_REDUCE_CONFLICT');

    // 400：理由太短
    const badReason = call('POST', `/platform/v1/seat-grants/${grant.id}/reduce`, {
      body: { targetCount: 1, reason: '短' },
    });
    assert.equal(badReason.status, 400);
    assert.equal((badReason.body as { code: string }).code, 'REASON_REQUIRED');
  });

  it('错误响应带 details 便于前端展示冲突明细', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 3 });
    fx.app.seats.assign(tenant.id, { memberId: 'a', memberName: 'A', memberEmail: 'a@x.com' });
    fx.app.seats.assign(tenant.id, { memberId: 'b', memberName: 'B', memberEmail: 'b@x.com' });
    const grant = fx.app.seats.grants(tenant.id)[0];
    const call = client(fx);

    const res = call('POST', `/platform/v1/seat-grants/${grant.id}/reduce`, {
      body: { targetCount: 1, strategy: 'reject', reason: '合同缩减席位数量到一个' },
    });
    const details = (res.body as { details: Record<string, number> }).details;
    assert.equal(details.occupied, 3);
    assert.equal(details.mustRelease, 2);
  });
});

describe('Spec 13 主流程走通', () => {
  it('创建租户 → 发席位 → 发额度 → 授权模型 → 查询详情', () => {
    const fx = setup();
    const call = client(fx);

    const created = call('POST', '/platform/v1/tenants', {
      body: {
        name: 'API 集成企业',
        contactName: '赵六',
        contactEmail: 'zhao@example.com',
        provisioning: { mode: 'active', seatCount: 20, purchasedCredit: 200_000 },
        firstAdmin: { memberId: 'm_api_admin', name: '赵六', email: 'zhao@example.com' },
      },
    });
    assert.equal(created.status, 201);
    const tenantId = (created.body as { id: string }).id;

    const seatRes = call('POST', `/platform/v1/tenants/${tenantId}/seat-grants`, {
      body: { seatCount: 10, expireAt: null },
    });
    assert.equal(seatRes.status, 201);

    const quotaRes = call('POST', `/platform/v1/tenants/${tenantId}/quota-grants`, {
      body: { amountCredit: 50_000, book: 'purchased' },
    });
    assert.equal(quotaRes.status, 201);

    const modelRes = call('POST', `/platform/v1/tenants/${tenantId}/model-grants`, {
      body: { group: BASIC_MODEL_GROUP },
    });
    assert.equal(modelRes.status, 201);

    const detail = call('GET', `/platform/v1/tenants/${tenantId}`);
    assert.equal(detail.status, 200);
    const body = detail.body as {
      seat: { overview: { seatTotal: number; occupied: number } };
      quota: { balance: { availableCredit: number } };
      model: { grants: unknown[] };
    };
    assert.equal(body.seat.overview.seatTotal, 30);
    assert.equal(body.seat.overview.occupied, 1);
    assert.equal(body.quota.balance.availableCredit, 250_000);
    assert.equal(body.model.grants.length, 2);
  });

  it('赠送额度走同一个接口，由 book 字段区分', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000 });
    const call = client(fx);

    call('POST', `/platform/v1/tenants/${tenant.id}/quota-grants`, {
      body: { amountCredit: 5_000, book: 'gift' },
    });

    const balance = call('GET', `/platform/v1/tenants/${tenant.id}/quota`).body as {
      purchasedCredit: number;
      giftCredit: number;
    };
    assert.equal(balance.purchasedCredit, 10_000);
    assert.equal(balance.giftCredit, 5_000);
  });

  it('列表接口支持筛选与排序', () => {
    const fx = setup();
    activeTenant(fx, { name: '甲公司' });
    activeTenant(fx, { name: '乙公司' });
    const call = client(fx);

    const all = call('GET', '/platform/v1/tenants').body as unknown[];
    assert.equal(all.length, 2);

    const filtered = call('GET', '/platform/v1/tenants', {
      query: { keyword: '甲' },
    }).body as { name: string }[];
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].name, '甲公司');

    const byStatus = call('GET', '/platform/v1/tenants', {
      query: { status: 'suspended' },
    }).body as unknown[];
    assert.equal(byStatus.length, 0);
  });

  it('风险视图接口可用', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { purchasedCredit: 10_000, seatCount: 5 });
    fx.app.quota.consume(tenant.id, { amountCredit: 9_800 });
    const call = client(fx);

    const rows = call('GET', '/platform/v1/risk-views/quota_alert').body as {
      tenantId: string;
    }[];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].tenantId, tenant.id);
  });
});

describe('Spec 14.1 幂等键', () => {
  it('相同 Idempotency-Key 重复提交只产生一条授予单', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const call = client(fx);
    const before = fx.app.seats.grants(tenant.id).length;

    const first = call('POST', `/platform/v1/tenants/${tenant.id}/seat-grants`, {
      body: { seatCount: 5, expireAt: null },
      idempotencyKey: 'api-key-1',
    });
    const second = call('POST', `/platform/v1/tenants/${tenant.id}/seat-grants`, {
      body: { seatCount: 5, expireAt: null },
      idempotencyKey: 'api-key-1',
    });

    assert.equal((first.body as { id: string }).id, (second.body as { id: string }).id);
    assert.equal(fx.app.seats.grants(tenant.id).length, before + 1);
  });

  it('同键不同参数返回 409', () => {
    const fx = setup();
    const tenant = activeTenant(fx, { seatCount: 10 });
    const call = client(fx);

    call('POST', `/platform/v1/tenants/${tenant.id}/seat-grants`, {
      body: { seatCount: 5, expireAt: null },
      idempotencyKey: 'api-key-2',
    });
    const res = call('POST', `/platform/v1/tenants/${tenant.id}/seat-grants`, {
      body: { seatCount: 8, expireAt: null },
      idempotencyKey: 'api-key-2',
    });
    assert.equal(res.status, 409);
    assert.equal((res.body as { code: string }).code, 'IDEMPOTENCY_CONFLICT');
  });
});

describe('Spec 13 危险操作经由接口仍受保护', () => {
  it('运营通过接口注销租户被拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const call = client(fx);

    const res = call('POST', `/platform/v1/tenants/${tenant.id}/deregister`, {
      as: { id: 'u_ops', role: 'operator' },
      body: { confirmName: tenant.name, reason: '运营尝试注销应当被拒绝' },
    });
    assert.equal(res.status, 403);
  });

  it('注销确认名称不匹配返回 400', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const call = client(fx);

    const res = call('POST', `/platform/v1/tenants/${tenant.id}/deregister`, {
      body: { confirmName: '错误名称', reason: '合同到期不再续约客户确认注销' },
    });
    assert.equal(res.status, 400);
    assert.equal((res.body as { code: string }).code, 'CONFIRM_NAME_MISMATCH');
  });

  it('审计日志接口按租户过滤', () => {
    const fx = setup();
    const a = activeTenant(fx, { name: '审计甲' });
    activeTenant(fx, { name: '审计乙' });
    const call = client(fx);

    const logs = call('GET', '/platform/v1/audit-logs', {
      query: { tenantId: a.id },
    }).body as { tenantId: string }[];
    assert.ok(logs.length > 0);
    assert.ok(logs.every((l) => l.tenantId === a.id));
  });
});
