// PRD-对公支付权益下单：创建订单发放条数、月末顺延、权限矩阵、幂等重放。
// 席位行与额度包行结构一致：均引用商品目录（PRD-席位与额度包商品化）里的商品，不再自由填写名称/单价/额度。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { Fixture } from './helpers.ts';
import {
  activeTenant,
  auditor,
  expectError,
  operator,
  sales,
  setup,
  superAdmin,
  tenantCommand,
} from './helpers.ts';
import { addCalendarMonths, addDays } from '../src/domain/time.ts';
import type { CreateOrderInput } from '../src/services/corpOrder.ts';

function seatProductId(
  fx: Fixture,
  tenantId: string,
  opts: { unitPriceFen: number; creditAmount: number; note: string },
): string {
  return fx.app.products.createOrReuse(sales, tenantId, { category: 'seat', ...opts }).product.id;
}

function packageProductId(
  fx: Fixture,
  tenantId: string,
  opts: { unitPriceFen: number; creditAmount: number; note: string },
): string {
  return fx.app.products.createOrReuse(sales, tenantId, { category: 'package', ...opts }).product.id;
}

function professionalLine(
  fx: Fixture,
  tenantId: string,
  overrides: Partial<CreateOrderInput['seatLines'][number]> = {},
) {
  return {
    productId: seatProductId(fx, tenantId, { unitPriceFen: 59_900, creditAmount: 12_000, note: '专业版' }),
    seatCount: 20,
    effectiveAt: new Date().toISOString(),
    termMonths: 12,
    ...overrides,
  };
}

function flagshipLine(
  fx: Fixture,
  tenantId: string,
  overrides: Partial<CreateOrderInput['seatLines'][number]> = {},
) {
  return {
    productId: seatProductId(fx, tenantId, { unitPriceFen: 99_900, creditAmount: 25_000, note: '旗舰版' }),
    seatCount: 10,
    effectiveAt: new Date().toISOString(),
    termMonths: 12,
    ...overrides,
  };
}

function packageLine(
  fx: Fixture,
  tenantId: string,
  opts: {
    unitPriceFen: number;
    creditAmount: number;
    note: string;
    count: number;
    effectiveAt: string;
    termMonths?: number;
  },
) {
  return {
    productId: packageProductId(fx, tenantId, {
      unitPriceFen: opts.unitPriceFen,
      creditAmount: opts.creditAmount,
      note: opts.note,
    }),
    count: opts.count,
    effectiveAt: opts.effectiveAt,
    ...(opts.termMonths !== undefined ? { termMonths: opts.termMonths } : {}),
  };
}

function baseOrderInput(overrides: Partial<CreateOrderInput> = {}): CreateOrderInput {
  return {
    voucherFileName: 'voucher.pdf',
    voucherMime: 'application/pdf',
    voucherDataBase64: 'ZGVtby12b3VjaGVy',
    seatLines: [],
    quotaPackages: [],
    idempotencyKey: null,
    ...overrides,
  };
}

describe('PRD-对公支付权益下单 创建订单', () => {
  it('非正式客户不能下单', () => {
    const fx = setup();
    const tenant = fx.app.createTenant(superAdmin, tenantCommand());
    assert.equal(tenant.status, 'pending');
    expectError(
      () => fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput()),
      'TENANT_STATE_INVALID',
    );
  });

  it('必须上传付款凭证', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () =>
        fx.app.corpOrders.createOrder(
          sales,
          tenant.id,
          baseOrderInput({
            voucherFileName: '',
            voucherDataBase64: '',
            seatLines: [professionalLine(fx, tenant.id, { seatCount: 5, termMonths: 1, effectiveAt: fx.clock.now().toISOString() })],
          }),
        ),
      'VALIDATION_ERROR',
    );
  });

  it('至少需要一行席位权益，或至少一行额度包', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () => fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput()),
      'VALIDATION_ERROR',
    );
  });

  it('席位行数超过 20 行拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const seatLines = Array.from({ length: 21 }, () =>
      professionalLine(fx, tenant.id, { seatCount: 1, termMonths: 1, effectiveAt: fx.clock.now().toISOString() }),
    );
    expectError(
      () => fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput({ seatLines })),
      'VALIDATION_ERROR',
    );
  });

  it('额度包行数超过 20 行拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const quotaPackages = Array.from({ length: 21 }, () =>
      packageLine(fx, tenant.id, {
        note: '算力包',
        count: 1,
        unitPriceFen: 10_000,
        creditAmount: 1_000,
        effectiveAt: fx.clock.now().toISOString(),
        termMonths: 6,
      }),
    );
    expectError(
      () => fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput({ quotaPackages })),
      'VALIDATION_ERROR',
    );
  });

  it('未选择商品的行拦截', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () =>
        fx.app.corpOrders.createOrder(
          sales,
          tenant.id,
          baseOrderInput({
            seatLines: [professionalLine(fx, tenant.id, { productId: '', effectiveAt: fx.clock.now().toISOString() })],
          }),
        ),
      'VALIDATION_ERROR',
    );
  });

  it('支持同时购买多种类型的额度包', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput({
      quotaPackages: [
        packageLine(fx, tenant.id, {
          note: '年度算力包',
          count: 1,
          unitPriceFen: 500_000,
          creditAmount: 200_000,
          effectiveAt: addDays(now, -1).toISOString(),
          termMonths: 12,
        }),
        packageLine(fx, tenant.id, {
          note: '加油包',
          count: 3,
          unitPriceFen: 10_000,
          creditAmount: 5_000,
          effectiveAt: addDays(now, -1).toISOString(),
          termMonths: 6,
        }),
      ],
    }));

    assert.equal(order.quotaPackages.length, 2);
    assert.equal(order.quotaPackages[1].lineAmountFen, 10_000 * 3);
    assert.equal(order.grantDetailCount, 2);
    const details = fx.app.corpOrders.grantDetails(tenant.id);
    const byType = details.reduce<Record<string, number>>((acc, d) => {
      acc[d.grantType] = (acc[d.grantType] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(byType, { quota_package: 2 });
    assert.equal(details.find((d) => d.sourceLineLabel.startsWith('加油包'))!.creditAmount, 5_000 * 3);
  });

  it('专业版12月20%赠送 + 旗舰版12月30%赠送 + 额度包 = 49 条发放明细', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        professionalLine(fx, tenant.id, { seatCount: 20, effectiveAt: addDays(now, -60).toISOString(), termMonths: 12, poolPercent: 20 }),
        flagshipLine(fx, tenant.id, { seatCount: 10, effectiveAt: addDays(now, -60).toISOString(), termMonths: 12, poolPercent: 30 }),
      ],
      quotaPackages: [
        packageLine(fx, tenant.id, {
          note: '年度算力包',
          count: 1,
          unitPriceFen: 500_000,
          creditAmount: 200_000,
          effectiveAt: addDays(now, -60).toISOString(),
          termMonths: 12,
        }),
      ],
    });

    assert.equal(order.grantDetailCount, 49);
    const details = fx.app.corpOrders.grantDetails(tenant.id);
    assert.equal(details.length, 49);
    const byType = details.reduce<Record<string, number>>((acc, d) => {
      acc[d.grantType] = (acc[d.grantType] ?? 0) + 1;
      return acc;
    }, {});
    assert.deepEqual(byType, { seat_bonus: 24, seat_gift: 24, quota_package: 1 });
  });

  it('个人席位附带额度（seat_bonus）只是信息展示，不产生真实额度授予单', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();
    const before = fx.app.quota.grants(tenant.id).length;

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [professionalLine(fx, tenant.id, { seatCount: 5, effectiveAt: addDays(now, -10).toISOString(), termMonths: 3 })],
    });

    assert.equal(order.grantDetailCount, 3);
    const details = fx.app.corpOrders.grantDetails(tenant.id);
    assert.equal(details.length, 3);
    for (const d of details) {
      assert.equal(d.grantType, 'seat_bonus');
      assert.equal(d.owner, 'individual');
      assert.equal(d.linkedQuotaGrantId, null);
      assert.ok(d.linkedSeatGrantId);
    }
    // 没有 poolPercent，没有真实 QuotaGrant 产生
    assert.equal(fx.app.quota.grants(tenant.id).length, before);
    // 但席位授予单是真实的，进入既有席位体系
    const seatGrant = fx.app.seats.grants(tenant.id).find((g) => g.id === details[0].linkedSeatGrantId);
    assert.ok(seatGrant);
    assert.equal(seatGrant!.seatCount, 5);
  });

  it('赠送池化与额度包会调用真实的额度引擎，产生可查询的 QuotaGrant', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        professionalLine(fx, tenant.id, { seatCount: 5, effectiveAt: addDays(now, -10).toISOString(), termMonths: 1, poolPercent: 50 }),
      ],
      quotaPackages: [
        packageLine(fx, tenant.id, {
          note: '算力包',
          count: 1,
          unitPriceFen: 100_000,
          creditAmount: 50_000,
          effectiveAt: addDays(now, -10).toISOString(),
          termMonths: 6,
        }),
      ],
    });

    const realGrantIds = new Set(fx.app.quota.grants(tenant.id).map((g) => g.id));
    const details = fx.app.corpOrders.orderDetail(order.id).grantDetails;
    const gift = details.find((d) => d.grantType === 'seat_gift')!;
    const pkg = details.find((d) => d.grantType === 'quota_package')!;
    assert.ok(realGrantIds.has(gift.linkedQuotaGrantId!));
    assert.ok(realGrantIds.has(pkg.linkedQuotaGrantId!));
    assert.equal(gift.creditAmount, Math.round(12_000 * 5 * 0.5));
    assert.equal(pkg.creditAmount, 50_000);
  });
});

describe('PRD-对公支付权益下单 自然月顺延', () => {
  it('1月31日生效、有效期1个月，到期日顺延为2月末（2026年2月28日）', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        professionalLine(fx, tenant.id, { seatCount: 1, effectiveAt: '2026-01-31T00:00:00.000Z', termMonths: 1 }),
      ],
    });

    assert.equal(
      order.seatLines[0].expireAt,
      addCalendarMonths(new Date('2026-01-31T00:00:00.000Z'), 1, tenant.timezone).toISOString(),
    );
    assert.equal(order.seatLines[0].expireAt, '2026-02-28T00:00:00.000Z');
  });
});

describe('PRD-对公支付权益下单 生效状态派生', () => {
  it('按当前时间派生未开始/生效中/即将到期/已过期', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    const makeOrder = (effectiveAt: string, termMonths: number) =>
      fx.app.corpOrders.createOrder(sales, tenant.id, {
        voucherFileName: 'voucher.pdf',
        voucherMime: 'application/pdf',
        voucherDataBase64: 'ZGVtby12b3VjaGVy',
        seatLines: [professionalLine(fx, tenant.id, { seatCount: 1, effectiveAt, termMonths })],
      });

    const notStarted = makeOrder(addDays(now, 5).toISOString(), 1);
    const active = makeOrder(addDays(now, -10).toISOString(), 6);
    const expiringSoon = makeOrder(addDays(now, -20).toISOString(), 1);
    const expired = makeOrder(addDays(now, -400).toISOString(), 1);

    const rows = fx.app.corpOrders.listOrders(tenant.id);
    const statusOf = (id: string) => rows.find((r) => r.id === id)!.lifecycleStatus;
    assert.equal(statusOf(notStarted.id), 'not_started');
    assert.equal(statusOf(active.id), 'active');
    assert.equal(statusOf(expiringSoon.id), 'expiring_soon');
    assert.equal(statusOf(expired.id), 'expired');
  });
});

describe('PRD-对公支付权益下单 权限矩阵', () => {
  it('商务可以创建订单，运营也可以（继承商务）', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();
    const line = (poolPercent = 0) => [
      professionalLine(fx, tenant.id, { seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1, poolPercent }),
    ];

    const bySales = fx.app.corpOrders.createOrder(
      sales,
      tenant.id,
      baseOrderInput({ seatLines: line() }),
    );
    assert.ok(bySales.id);
    const byOperator = fx.app.corpOrders.createOrder(
      operator,
      tenant.id,
      baseOrderInput({ seatLines: line() }),
    );
    assert.ok(byOperator.id);
  });

  it('审计角色无权创建订单，但能查看历史', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    expectError(
      () =>
        fx.app.corpOrders.createOrder(
          auditor,
          tenant.id,
          baseOrderInput({
            seatLines: [professionalLine(fx, tenant.id, { seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 })],
          }),
        ),
      'PERMISSION_DENIED',
    );
    // 只读方法本身不做权限校验（由路由层拦截），服务层调用应正常返回
    assert.deepEqual(fx.app.corpOrders.listOrders(tenant.id), []);
  });
});

describe('PRD-对公支付权益下单 幂等', () => {
  it('相同幂等键重复提交返回同一订单，不重复发放', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();
    const input = baseOrderInput({
      seatLines: [professionalLine(fx, tenant.id, { seatCount: 5, effectiveAt: addDays(now, -1).toISOString(), termMonths: 2 })],
      idempotencyKey: 'corp-req-001',
    });

    const before = fx.app.corpOrders.listOrders(tenant.id).length;
    const a = fx.app.corpOrders.createOrder(sales, tenant.id, input);
    const b = fx.app.corpOrders.createOrder(sales, tenant.id, input);

    assert.equal(a.id, b.id);
    assert.equal(fx.app.corpOrders.listOrders(tenant.id).length, before + 1);
    assert.equal(fx.app.corpOrders.grantDetails(tenant.id).length, 2);
  });

  it('幂等键相同但参数不同报冲突', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    fx.app.corpOrders.createOrder(
      sales,
      tenant.id,
      baseOrderInput({
        seatLines: [professionalLine(fx, tenant.id, { seatCount: 5, effectiveAt: addDays(now, -1).toISOString(), termMonths: 2 })],
        idempotencyKey: 'corp-req-002',
      }),
    );

    expectError(
      () =>
        fx.app.corpOrders.createOrder(
          sales,
          tenant.id,
          baseOrderInput({
            seatLines: [professionalLine(fx, tenant.id, { seatCount: 9, effectiveAt: addDays(now, -1).toISOString(), termMonths: 2 })],
            idempotencyKey: 'corp-req-002',
          }),
        ),
      'IDEMPOTENCY_CONFLICT',
    );
  });
});

describe('PRD-对公支付权益下单 查询', () => {
  it('历史订单按创建时间倒序，支持按订单号搜索', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();
    const line = () => [professionalLine(fx, tenant.id, { seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 })];

    const first = fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput({ seatLines: line() }));
    fx.clock.advanceDays(1);
    const second = fx.app.corpOrders.createOrder(sales, tenant.id, baseOrderInput({ seatLines: line() }));

    const rows = fx.app.corpOrders.listOrders(tenant.id);
    assert.deepEqual(rows.map((r) => r.id), [second.id, first.id]);

    const found = fx.app.corpOrders.listOrders(tenant.id, { q: second.orderNo });
    assert.deepEqual(found.map((r) => r.id), [second.id]);
  });

  it('订单详情包含全部发放明细', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const now = fx.clock.now();

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        professionalLine(fx, tenant.id, { seatCount: 2, effectiveAt: addDays(now, -1).toISOString(), termMonths: 2, poolPercent: 10 }),
        flagshipLine(fx, tenant.id, { seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 }),
      ],
    });

    const detail = fx.app.corpOrders.orderDetail(order.id);
    assert.equal(detail.grantDetails.length, order.grantDetailCount);
    assert.equal(detail.seatLines.length, 2);
    expectError(() => fx.app.corpOrders.orderDetail('co_not_exist'), 'CORP_ORDER_NOT_FOUND');
  });
});
