// 测试夹具。构造一个带模型目录与试用套餐的平台运营后台实例。

import type { Actor } from '../src/domain/types.ts';
import { TestClock } from '../src/domain/time.ts';
import { PlatformConsole } from '../src/app.ts';
import type { CreateTenantCommand } from '../src/app.ts';
import { AppError } from '../src/domain/errors.ts';
import type { ErrorCode } from '../src/domain/errors.ts';
import { BASIC_MODEL_GROUP } from '../src/services/quota.ts';

export const ADVANCED_MODEL_GROUP = '高级模型集';

export const superAdmin: Actor = { id: 'u_super', role: 'super_admin' };
export const operator: Actor = { id: 'u_ops', role: 'operator' };
export const sales: Actor = { id: 'u_sales', role: 'sales' };
export const auditor: Actor = { id: 'u_audit', role: 'auditor' };

export const T0 = '2026-03-10T02:00:00.000Z';

export interface Fixture {
  clock: TestClock;
  app: PlatformConsole;
  trialPlanId: string;
}

export function setup(startIso: string = T0): Fixture {
  const clock = new TestClock(startIso);
  const app = new PlatformConsole(clock);

  // 平台模型目录
  app.models.createModel(superAdmin, {
    code: 'claude-sonnet-5',
    displayName: 'Claude Sonnet 5',
    channel: 'Anthropic-Prod',
    vendor: 'anthropic',
    capabilities: ['chat', 'code'],
    priceMultiplier: 1,
    group: BASIC_MODEL_GROUP,
  });
  app.models.createModel(superAdmin, {
    code: 'claude-opus-5',
    displayName: 'Claude Opus 5',
    channel: 'Anthropic-Prod',
    vendor: 'anthropic',
    capabilities: ['chat', 'code', 'reasoning'],
    priceMultiplier: 5,
    group: ADVANCED_MODEL_GROUP,
  });
  app.models.createModel(superAdmin, {
    code: 'deepseek-v3',
    displayName: 'DeepSeek V3',
    channel: 'Deepseek-Cn',
    vendor: 'deepseek',
    priceMultiplier: 0.2,
    group: BASIC_MODEL_GROUP,
  });
  app.models.publish(superAdmin, 'claude-sonnet-5');
  app.models.publish(superAdmin, 'claude-opus-5');
  app.models.publish(superAdmin, 'deepseek-v3');

  // 标准试用套餐：10 席位 / $200 / 基础模型集 / 14 天
  const plan = app.trials.createPlan(superAdmin, {
    name: '标准试用 14 天',
    seatCount: 10,
    giftCredit: 20_000,
    modelGroups: [BASIC_MODEL_GROUP],
    durationDays: 14,
  });

  return { clock, app, trialPlanId: plan.id };
}

let seq = 0;

export function tenantCommand(
  overrides: Partial<CreateTenantCommand> = {},
): CreateTenantCommand {
  seq += 1;
  const base: CreateTenantCommand = {
    name: `测试企业 ${seq}`,
    contactName: '张三',
    contactEmail: `admin${seq}@example.com`,
    provisioning: { mode: 'none' },
    firstAdmin: {
      memberId: `m_admin_${seq}`,
      name: '张三',
      email: `admin${seq}@example.com`,
    },
  };
  // 显式忽略值为 undefined 的键，否则会把默认值覆盖成 undefined
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      (base as Record<string, unknown>)[key] = value;
    }
  }
  return base;
}

/** 直接开通正式的租户：seatCount 个席位 + purchasedCredit 额度 + 基础模型集 */
export function activeTenant(
  fx: Fixture,
  options: {
    seatCount?: number;
    purchasedCredit?: number;
    modelGroups?: string[];
    name?: string;
    seatExpireAt?: string | null;
  } = {},
) {
  return fx.app.createTenant(
    superAdmin,
    tenantCommand({
      name: options.name,
      provisioning: {
        mode: 'active',
        seatCount: options.seatCount ?? 10,
        purchasedCredit: options.purchasedCredit ?? 100_000,
        seatExpireAt: options.seatExpireAt ?? null,
        modelGroups: options.modelGroups ?? [BASIC_MODEL_GROUP],
      },
    }),
  );
}

/** 断言抛出指定错误码，并返回该错误以便进一步检查 details */
export function expectError(fn: () => unknown, code: ErrorCode): AppError {
  try {
    fn();
  } catch (error) {
    if (!(error instanceof AppError)) {
      throw new Error(
        `期望抛出 AppError(${code})，实际抛出 ${String(error)}`,
      );
    }
    if (error.code !== code) {
      throw new Error(
        `期望错误码 ${code}，实际 ${error.code}：${error.message}`,
      );
    }
    return error;
  }
  throw new Error(`期望抛出 AppError(${code})，但没有抛出任何错误`);
}

/** 批量占用席位，返回成员 id 列表 */
export function fillSeats(
  fx: Fixture,
  tenantId: string,
  count: number,
  prefix = 'm',
): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const memberId = `${prefix}_${tenantId}_${i}`;
    fx.app.seats.assign(tenantId, {
      memberId,
      memberName: `成员${i}`,
      memberEmail: `${memberId}@example.com`,
    });
    ids.push(memberId);
  }
  return ids;
}
