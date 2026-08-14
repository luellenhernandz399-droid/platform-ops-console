// PRD-席位与额度包商品化：商品目录的新建/复用去重、停用启用、下单校验、使用次数统计、权限矩阵。

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { activeTenant, auditor, expectError, sales, setup } from './helpers.ts';
import { addDays } from '../src/domain/time.ts';

describe('PRD-席位与额度包商品化 新建或复用', () => {
  it('无重复时新建商品', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    const result = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
      note: '专业版',
    });

    assert.equal(result.created, true);
    assert.equal(result.product.active, true);
    assert.equal(result.product.useCount, 0);
    assert.equal(result.product.lastUsedAt, null);
    assert.equal(fx.app.products.list(tenant.id, 'seat').length, 1);
  });

  it('已存在相同商品且启用中：不新建，直接复用', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const first = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
      note: '专业版',
    }).product;

    const second = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
      note: '备注不参与去重',
    });

    assert.equal(second.created, false);
    assert.equal(second.product.id, first.id);
    assert.equal(fx.app.products.list(tenant.id, 'seat').length, 1);
  });

  it('已存在相同商品但已停用：拦截，提示先启用', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
      note: '专业版',
    }).product;
    fx.app.products.setActive(sales, tenant.id, product.id, false);

    const error = expectError(
      () =>
        fx.app.products.createOrReuse(sales, tenant.id, {
          category: 'seat',
          unitPriceFen: 59_900,
          creditAmount: 12_000,
          note: '随便什么备注',
        }),
      'PRODUCT_INACTIVE',
    );
    assert.equal(error.details.productId, product.id);
  });

  it('单价或额度非正整数拒绝', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    expectError(
      () =>
        fx.app.products.createOrReuse(sales, tenant.id, {
          category: 'seat',
          unitPriceFen: 0,
          creditAmount: 12_000,
        }),
      'VALIDATION_ERROR',
    );
    expectError(
      () =>
        fx.app.products.createOrReuse(sales, tenant.id, {
          category: 'package',
          unitPriceFen: 10_000,
          creditAmount: -1,
        }),
      'VALIDATION_ERROR',
    );
  });

  it('同一租户内席位商品与额度包商品各自独立去重', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    const seatProduct = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    });
    const pkgProduct = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'package',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    });

    assert.equal(seatProduct.created, true);
    assert.equal(pkgProduct.created, true);
    assert.notEqual(seatProduct.product.id, pkgProduct.product.id);
  });
});

describe('PRD-席位与额度包商品化 停用与启用', () => {
  it('停用后 mustActive 拒绝，启用后恢复可选', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
    }).product;

    fx.app.products.setActive(sales, tenant.id, product.id, false);
    expectError(
      () => fx.app.products.mustActive(tenant.id, 'seat', product.id),
      'PRODUCT_INACTIVE',
    );

    fx.app.products.setActive(sales, tenant.id, product.id, true);
    const active = fx.app.products.mustActive(tenant.id, 'seat', product.id);
    assert.equal(active.active, true);
  });

  it('停用不影响历史订单已发放的额度/席位', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 59_900,
      creditAmount: 12_000,
    }).product;
    const now = fx.clock.now();

    const order = fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        { productId: product.id, seatCount: 5, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 },
      ],
    });

    fx.app.products.setActive(sales, tenant.id, product.id, false);

    const detail = fx.app.corpOrders.orderDetail(order.id);
    assert.equal(detail.seatLines[0].unitPriceFen, 59_900);
    assert.equal(detail.seatLines[0].monthlyCredit, 12_000);
  });
});

describe('PRD-席位与额度包商品化 mustActive 校验', () => {
  it('不存在的商品 id 报 PRODUCT_NOT_FOUND', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    expectError(
      () => fx.app.products.mustActive(tenant.id, 'seat', 'prod_not_exist'),
      'PRODUCT_NOT_FOUND',
    );
  });

  it('类型不匹配（额度包商品当席位商品用）报 PRODUCT_NOT_FOUND', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const pkgProduct = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'package',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;

    expectError(
      () => fx.app.products.mustActive(tenant.id, 'seat', pkgProduct.id),
      'PRODUCT_NOT_FOUND',
    );
  });

  it('属于其他租户的商品报 PRODUCT_NOT_FOUND', () => {
    const fx = setup();
    const tenantA = activeTenant(fx);
    const tenantB = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenantA.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;

    expectError(
      () => fx.app.products.mustActive(tenantB.id, 'seat', product.id),
      'PRODUCT_NOT_FOUND',
    );
  });
});

describe('PRD-席位与额度包商品化 列表排序', () => {
  it('用过的商品按最近使用时间倒序，从未用过的按创建时间倒序排在后面', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    const a = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
      note: 'A',
    }).product;
    const b = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 20_000,
      creditAmount: 2_000,
      note: 'B',
    }).product;
    const c = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 30_000,
      creditAmount: 3_000,
      note: 'C',
    }).product;

    // b 最近用过，a 更早用过，c 从未用过
    fx.app.products.recordUsage(a.id, addDays(fx.clock.now(), -5).toISOString());
    fx.app.products.recordUsage(b.id, addDays(fx.clock.now(), -1).toISOString());

    const rows = fx.app.products.list(tenant.id, 'seat');
    assert.deepEqual(rows.map((p) => p.id), [b.id, a.id, c.id]);
  });
});

describe('PRD-席位与额度包商品化 使用次数统计', () => {
  it('核对/校验阶段不计数，只有订单真正创建成功后才累加，同一商品同订单多行各计一次', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;
    const now = fx.clock.now();

    // mustActive 仅做校验，不计数（对应「核对弹窗阶段不累加」）
    fx.app.products.mustActive(tenant.id, 'seat', product.id);
    assert.equal(fx.app.products.list(tenant.id, 'seat')[0].useCount, 0);

    fx.app.corpOrders.createOrder(sales, tenant.id, {
      voucherFileName: 'voucher.pdf',
      voucherMime: 'application/pdf',
      voucherDataBase64: 'ZGVtby12b3VjaGVy',
      seatLines: [
        { productId: product.id, seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 },
        { productId: product.id, seatCount: 2, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 },
      ],
    });

    const after = fx.app.products.list(tenant.id, 'seat')[0];
    assert.equal(after.useCount, 2);
    assert.equal(after.lastUsedAt, now.toISOString());
  });

  it('下单校验失败（未上传凭证）不产生任何使用次数', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;
    const now = fx.clock.now();

    expectError(
      () =>
        fx.app.corpOrders.createOrder(sales, tenant.id, {
          voucherFileName: '',
          voucherMime: '',
          voucherDataBase64: '',
          seatLines: [
            { productId: product.id, seatCount: 1, effectiveAt: addDays(now, -1).toISOString(), termMonths: 1 },
          ],
        }),
      'VALIDATION_ERROR',
    );

    assert.equal(fx.app.products.list(tenant.id, 'seat')[0].useCount, 0);
  });
});

describe('PRD-席位与额度包商品化 权限矩阵', () => {
  it('商务可以新建与停用商品', () => {
    const fx = setup();
    const tenant = activeTenant(fx);

    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;
    const updated = fx.app.products.setActive(sales, tenant.id, product.id, false);
    assert.equal(updated.active, false);
  });

  it('审计角色只能查看，不能新建或停用', () => {
    const fx = setup();
    const tenant = activeTenant(fx);
    const product = fx.app.products.createOrReuse(sales, tenant.id, {
      category: 'seat',
      unitPriceFen: 10_000,
      creditAmount: 1_000,
    }).product;

    expectError(
      () =>
        fx.app.products.createOrReuse(auditor, tenant.id, {
          category: 'seat',
          unitPriceFen: 20_000,
          creditAmount: 2_000,
        }),
      'PERMISSION_DENIED',
    );
    expectError(
      () => fx.app.products.setActive(auditor, tenant.id, product.id, false),
      'PERMISSION_DENIED',
    );
    // 查看不做权限校验（由路由层的 platform.corp_order.view 拦截）
    assert.equal(fx.app.products.list(tenant.id, 'seat').length, 1);
  });
});
