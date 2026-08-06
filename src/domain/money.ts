// credit 与美元的换算。Spec 8.1：1 credit = $0.01，存储一律用 credit 整数。

import { fail } from './errors.ts';

export const CREDIT_PER_USD = 100;

/**
 * 美元转 credit。非整数 credit 直接拒绝（Spec 8.1 第 3 条）：
 * $10.005 → 1000.5 credit → 报错。
 */
export function usdToCredit(usd: number): number {
  if (!Number.isFinite(usd)) {
    fail('QUOTA_AMOUNT_INVALID', '金额必须是有限数值', { usd });
  }
  // 先按分四舍五入消除 IEEE754 表示误差（0.1*100 = 10.000000000000002），
  // 再比对回原值，确保输入本身确实是 2 位小数。
  const credit = Math.round(usd * CREDIT_PER_USD);
  if (Math.abs(credit - usd * CREDIT_PER_USD) > 1e-6) {
    fail('QUOTA_AMOUNT_INVALID', `金额 ${usd} 无法换算为整数 credit，最小粒度为 $0.01`, {
      usd,
    });
  }
  return credit;
}

/** credit 转美元展示串，保留 2 位小数 */
export function creditToUsd(credit: number): string {
  const sign = credit < 0 ? '-' : '';
  const abs = Math.abs(credit);
  const whole = Math.floor(abs / CREDIT_PER_USD);
  const cents = abs % CREDIT_PER_USD;
  return `${sign}${whole}.${String(cents).padStart(2, '0')}`;
}

/**
 * 消耗侧产生小数 credit 时向上取整（Spec 8.1 第 4 条）。
 * 宁可多扣，避免长期累积误差。
 */
export function ceilCredit(value: number): number {
  if (!Number.isFinite(value)) {
    fail('QUOTA_AMOUNT_INVALID', '消耗量必须是有限数值', { value });
  }
  // 先抹掉浮点噪声再向上取整，否则 3 * 1.1 = 3.3000000000000003 会多进 1
  const rounded = Math.round(value * 1e6) / 1e6;
  return Math.ceil(rounded);
}

/** 授予/回收/调账的金额校验：必须是正整数 credit */
export function assertPositiveCredit(credit: number, field = '金额'): number {
  if (!Number.isInteger(credit) || credit <= 0) {
    fail('QUOTA_AMOUNT_INVALID', `${field}必须是正整数 credit`, { credit });
  }
  return credit;
}
