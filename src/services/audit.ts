// 审计日志。对应 Spec 第 15 章，字段沿用租户侧管理日志结构。

import type { Actor, AuditLog } from '../domain/types.ts';
import type { Clock } from '../domain/time.ts';
import type { IdGenerator } from '../domain/ids.ts';
import type { Store } from '../store/store.ts';

export interface AuditInput {
  actor: Actor;
  tenantId?: string | null;
  objectType: string;
  objectId?: string | null;
  action: string;
  summary: string;
  reason?: string | null;
  diff?: Record<string, unknown> | null;
  status?: 'success' | 'failure';
}

export class AuditService {
  private store: Store;
  private clock: Clock;
  private ids: IdGenerator;

  constructor(store: Store, clock: Clock, ids: IdGenerator) {
    this.store = store;
    this.clock = clock;
    this.ids = ids;
  }

  record(input: AuditInput): AuditLog {
    const log: AuditLog = {
      id: this.ids.next('audit'),
      at: this.clock.now().toISOString(),
      actorId: input.actor.id,
      actorRole: input.actor.role,
      tenantId: input.tenantId ?? null,
      objectType: input.objectType,
      objectId: input.objectId ?? null,
      action: input.action,
      summary: input.summary,
      source: input.actor.source ?? 'console',
      status: input.status ?? 'success',
      reason: input.reason ?? null,
      diff: input.diff ?? null,
    };
    return this.store.auditLogs.insert(log);
  }

  query(filter: {
    tenantId?: string;
    actorId?: string;
    objectType?: string;
    action?: string;
    from?: string;
    to?: string;
  } = {}): AuditLog[] {
    return this.store.auditLogs
      .find((log) => {
        if (filter.tenantId && log.tenantId !== filter.tenantId) return false;
        if (filter.actorId && log.actorId !== filter.actorId) return false;
        if (filter.objectType && log.objectType !== filter.objectType) return false;
        if (filter.action && log.action !== filter.action) return false;
        if (filter.from && log.at < filter.from) return false;
        if (filter.to && log.at > filter.to) return false;
        return true;
      })
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  }
}
