// 编号生成。Spec 6.2 / 7.1 / 8.1。

import type { Clock } from './time.ts';
import { partsInZone } from './time.ts';

/** 单号使用平台自身时区，与租户时区无关，保证全局唯一且可排序 */
const PLATFORM_TZ = 'Asia/Shanghai';

export class IdGenerator {
  private clock: Clock;
  private seq = new Map<string, number>();
  private uid = 0;

  constructor(clock: Clock) {
    this.clock = clock;
  }

  /** 内部主键 */
  next(prefix: string): string {
    this.uid += 1;
    return `${prefix}_${String(this.uid).padStart(6, '0')}`;
  }

  /** 租户编码 T + 8 位数字 */
  tenantCode(): string {
    const n = this.bump('tenant');
    return `T${String(n).padStart(8, '0')}`;
  }

  /** SG-YYMM-NNN */
  seatGrantNo(): string {
    return this.dated('SG');
  }

  /** QG-YYMM-NNN */
  quotaGrantNo(): string {
    return this.dated('QG');
  }

  /** CO-YYMM-NNN */
  corpOrderNo(): string {
    return this.dated('CO');
  }

  private dated(prefix: string): string {
    const p = partsInZone(this.clock.now(), PLATFORM_TZ);
    const yymm = `${String(p.year % 100).padStart(2, '0')}${String(p.month).padStart(2, '0')}`;
    const key = `${prefix}-${yymm}`;
    const n = this.bump(key);
    return `${key}-${String(n).padStart(3, '0')}`;
  }

  private bump(key: string): number {
    const n = (this.seq.get(key) ?? 0) + 1;
    this.seq.set(key, n);
    return n;
  }
}
