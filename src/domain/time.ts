// 时钟与时区。账期归属、赠送额度月度清零都以租户时区为准（Spec 8.3）。

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** 测试用可控时钟 */
export class TestClock implements Clock {
  private current: Date;

  constructor(iso: string) {
    this.current = new Date(iso);
  }

  now(): Date {
    return new Date(this.current.getTime());
  }

  set(iso: string): void {
    this.current = new Date(iso);
  }

  advanceDays(days: number): void {
    this.current = new Date(this.current.getTime() + days * 86400000);
  }

  advanceMs(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface ZonedParts {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function partsInZone(date: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(date);
  const get = (type: string): number => {
    const found = parts.find((p) => p.type === type);
    return found ? Number(found.value) : 0;
  };
  // en-US 的 hourCycle 在午夜可能给出 24，归一到 0
  const hour = get('hour') % 24;
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour,
    minute: get('minute'),
    second: get('second'),
  };
}

function zoneOffsetMs(date: Date, timeZone: string): number {
  const p = partsInZone(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** 把某时区的墙上时间转成 UTC 瞬间，两轮修正以覆盖 DST 边界 */
export function zonedToUtc(
  timeZone: string,
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, second);
  let offset = zoneOffsetMs(new Date(guess), timeZone);
  let result = new Date(guess - offset);
  offset = zoneOffsetMs(result, timeZone);
  result = new Date(guess - offset);
  return result;
}

/** 账期键 YYYY-MM，按租户时区归属（Spec 8.3） */
export function periodOf(date: Date, timeZone: string): string {
  const p = partsInZone(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}`;
}

export function parsePeriod(period: string): { year: number; month: number } {
  const [y, m] = period.split('-');
  return { year: Number(y), month: Number(m) };
}

export function nextPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  const y = month === 12 ? year + 1 : year;
  const m = month === 12 ? 1 : month + 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

export function prevPeriod(period: string): string {
  const { year, month } = parsePeriod(period);
  const y = month === 1 ? year - 1 : year;
  const m = month === 1 ? 12 : month - 1;
  return `${y}-${String(m).padStart(2, '0')}`;
}

/** 账期起点（该月 1 日 00:00:00 租户时区）对应的 UTC 瞬间 */
export function startOfPeriod(period: string, timeZone: string): Date {
  const { year, month } = parsePeriod(period);
  return zonedToUtc(timeZone, year, month, 1, 0, 0, 0);
}

/** 账期终点（下月 1 日 00:00:00 租户时区）对应的 UTC 瞬间，右开区间 */
export function endOfPeriod(period: string, timeZone: string): Date {
  return startOfPeriod(nextPeriod(period), timeZone);
}

/** 赠送额度的到期时间 = 当月月末（Spec 8.1），即下月 1 日 00:00 减 1 毫秒 */
export function endOfMonthFor(date: Date, timeZone: string): Date {
  const period = periodOf(date, timeZone);
  return new Date(endOfPeriod(period, timeZone).getTime() - 1);
}

export function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

export function diffDays(a: Date, b: Date): number {
  return (a.getTime() - b.getTime()) / 86400000;
}

export function iso(date: Date): string {
  return date.toISOString();
}

export function toDate(value: string | Date): Date {
  return value instanceof Date ? value : new Date(value);
}

/** null 视为永不过期 */
export function isExpired(expireAt: string | null, at: Date): boolean {
  if (expireAt === null) return false;
  return new Date(expireAt).getTime() <= at.getTime();
}

/**
 * 自然月加法（对公权益下单 PRD 24/78）：结果保留原墙上时刻，
 * 目标月无该日期时（29/30/31 日遇小月）顺延至目标月最后一天。
 */
export function addCalendarMonths(date: Date, months: number, timeZone: string): Date {
  const p = partsInZone(date, timeZone);
  const totalMonths = p.month - 1 + months;
  const year = p.year + Math.floor(totalMonths / 12);
  const month = ((totalMonths % 12) + 12) % 12 + 1;
  const daysInTargetMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const day = Math.min(p.day, daysInTargetMonth);
  return zonedToUtc(timeZone, year, month, day, p.hour, p.minute, p.second);
}
