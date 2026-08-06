// 服务共享上下文与通用守卫。

import type { Clock } from '../domain/time.ts';
import type { IdGenerator } from '../domain/ids.ts';
import type { Store } from '../store/store.ts';
import type { Tenant } from '../domain/types.ts';
import type { AuditService } from './audit.ts';
import type { Notifier } from './notifier.ts';
import { fail } from '../domain/errors.ts';

export interface Ctx {
  store: Store;
  clock: Clock;
  ids: IdGenerator;
  audit: AuditService;
  notifier: Notifier;
}

export function getTenant(ctx: Ctx, tenantId: string): Tenant {
  const tenant = ctx.store.tenants.get(tenantId);
  if (!tenant) {
    fail('TENANT_NOT_FOUND', `租户 ${tenantId} 不存在`, { tenantId });
  }
  return tenant;
}

/**
 * 平台侧下发资源的前置校验（Spec 6.1 状态表最后一列）：
 * pending / trialing / active / suspended 可下发，注销后不可。
 */
export function assertGrantable(tenant: Tenant): void {
  if (tenant.status === 'deregistering') {
    fail('TENANT_STATE_INVALID', '租户处于注销保留期，不可下发资源', {
      tenantId: tenant.id,
      status: tenant.status,
    });
  }
  if (tenant.status === 'deregistered') {
    fail('TENANT_DEREGISTERED', '租户已注销，不可下发资源', {
      tenantId: tenant.id,
    });
  }
}

/**
 * 幂等键处理（Spec 14.1）。同一个 key 重复提交返回首次的结果标识，
 * 不重复产生副作用；key 相同但业务参数不同则报冲突。
 */
export function withIdempotency<T extends { id: string }>(
  ctx: Ctx,
  key: string | null | undefined,
  fingerprint: string,
  produce: () => T,
  load: (resultId: string) => T | undefined,
): T {
  if (!key) return produce();

  const composite = `${key}::${fingerprint}`;
  const existing = ctx.store.idempotency.get(key);
  if (existing) {
    const sameFingerprint = ctx.store.idempotency.get(composite) !== undefined;
    if (!sameFingerprint) {
      fail('IDEMPOTENCY_CONFLICT', '幂等键已被不同的请求参数使用', { key });
    }
    const cached = load(existing.resultId);
    if (cached) return cached;
  }

  const result = produce();
  const at = ctx.clock.now().toISOString();
  ctx.store.idempotency.set(key, { at, resultId: result.id });
  ctx.store.idempotency.set(composite, { at, resultId: result.id });
  return result;
}
