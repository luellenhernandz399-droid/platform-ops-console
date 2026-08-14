// 商品目录。对应 PRD-席位与额度包商品化。
//
// 商品由「类型 + 归属 + 单价 + 额度」唯一确定，创建后单价/额度/备注名一律不可修改，
// 只能停用/启用；停用只影响下拉可选性，不影响任何历史订单（订单落库时已快照价格）。

import type { Actor, Product, ProductCategory } from '../domain/types.ts';
import type { Ctx } from './context.ts';
import { getTenant } from './context.ts';
import { fail } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';

export interface CreateOrReuseProductInput {
  category: ProductCategory;
  unitPriceFen: number;
  creditAmount: number;
  note?: string;
}

export interface CreateOrReuseProductResult {
  product: Product;
  /** false 表示复用了目录中已存在的商品，未新建 */
  created: boolean;
}

export class ProductService {
  private ctx: Ctx;

  constructor(ctx: Ctx) {
    this.ctx = ctx;
  }

  list(tenantId: string, category: ProductCategory): Product[] {
    getTenant(this.ctx, tenantId);
    return this.ctx.store.products
      .find((p) => p.tenantId === tenantId && p.category === category)
      .sort((a, b) => {
        if (a.lastUsedAt && b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
        if (a.lastUsedAt) return -1;
        if (b.lastUsedAt) return 1;
        return a.createdAt < b.createdAt ? 1 : -1;
      });
  }

  createOrReuse(
    actor: Actor,
    tenantId: string,
    input: CreateOrReuseProductInput,
  ): CreateOrReuseProductResult {
    requirePermission(actor, 'platform.corp_order.create');
    getTenant(this.ctx, tenantId);

    if (!Number.isInteger(input.unitPriceFen) || input.unitPriceFen <= 0) {
      fail('VALIDATION_ERROR', '单价必须填写且大于 0', { unitPriceFen: input.unitPriceFen });
    }
    if (!Number.isInteger(input.creditAmount) || input.creditAmount <= 0) {
      fail('VALIDATION_ERROR', '额度必须填写且大于 0', { creditAmount: input.creditAmount });
    }

    const dup = this.ctx.store.products.first(
      (p) =>
        p.tenantId === tenantId &&
        p.category === input.category &&
        p.unitPriceFen === input.unitPriceFen &&
        p.creditAmount === input.creditAmount,
    );
    if (dup) {
      if (!dup.active) {
        fail('PRODUCT_INACTIVE', '已存在相同商品但已停用，请先在下拉里启用', {
          productId: dup.id,
        });
      }
      return { product: dup, created: false };
    }

    const now = this.ctx.clock.now().toISOString();
    const product: Product = {
      id: this.ctx.ids.next('prod'),
      category: input.category,
      scope: 'tenant',
      tenantId,
      unitPriceFen: input.unitPriceFen,
      creditAmount: input.creditAmount,
      note: (input.note ?? '').trim(),
      active: true,
      useCount: 0,
      lastUsedAt: null,
      createdAt: now,
      createdBy: actor.id,
    };
    this.ctx.store.products.insert(product);
    return { product, created: true };
  }

  setActive(actor: Actor, tenantId: string, productId: string, active: boolean): Product {
    requirePermission(actor, 'platform.corp_order.create');
    const product = this.mustProduct(tenantId, productId);
    return this.ctx.store.products.update(product.id, { active }) as Product;
  }

  /** 供 CorpOrderService 下单解析时调用：商品必须存在、属于该租户+类型、且启用中 */
  mustActive(tenantId: string, category: ProductCategory, productId: string): Product {
    const product = this.mustProduct(tenantId, productId);
    if (product.category !== category) {
      fail('PRODUCT_NOT_FOUND', `商品 ${productId} 不属于该类型`, { productId, category });
    }
    if (!product.active) {
      fail('PRODUCT_INACTIVE', '该商品已停用，请重新选择', { productId });
    }
    return product;
  }

  recordUsage(productId: string, when: string): void {
    const product = this.ctx.store.products.get(productId);
    if (!product) return;
    this.ctx.store.products.update(productId, {
      useCount: product.useCount + 1,
      lastUsedAt: when,
    });
  }

  private mustProduct(tenantId: string, productId: string): Product {
    const product = this.ctx.store.products.get(productId);
    if (!product || product.tenantId !== tenantId) {
      fail('PRODUCT_NOT_FOUND', `商品 ${productId} 不存在`, { productId });
    }
    return product;
  }
}
