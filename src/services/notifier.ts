// 通知出口。Spec 8.4 预警、9.1 模型下线、10.4 试用到期提醒都从这里发出。
// 本工程只负责产生通知事件，实际投递（邮件 / 站内信）由外部通道实现。

export type NotificationKind =
  | 'quota.notice'
  | 'quota.alert'
  | 'quota.exhausted'
  | 'seat.oversell'
  | 'seat.grace_expiring'
  | 'seat.force_released'
  | 'model.offline_notice'
  | 'trial.expiring'
  | 'trial.expired';

export type NotificationChannel = 'email' | 'inbox';

export interface Notification {
  kind: NotificationKind;
  tenantId: string | null;
  /** 收件人角色标识：tenant_admin / owner_sales / platform_ops */
  recipients: string[];
  channels: NotificationChannel[];
  subject: string;
  payload: Record<string, unknown>;
  at: string;
}

export class Notifier {
  private sent: Notification[] = [];

  send(notification: Notification): void {
    this.sent.push(notification);
  }

  all(): Notification[] {
    return [...this.sent];
  }

  byKind(kind: NotificationKind): Notification[] {
    return this.sent.filter((n) => n.kind === kind);
  }

  byTenant(tenantId: string): Notification[] {
    return this.sent.filter((n) => n.tenantId === tenantId);
  }

  clear(): void {
    this.sent = [];
  }
}
