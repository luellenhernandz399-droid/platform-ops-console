// 平台侧角色与权限点。对应 Spec 5.1 / 5.2 的权限点与角色矩阵，另含对公权益下单的 3 个权限点。

import type { Actor, PlatformRole } from './types.ts';
import { fail } from './errors.ts';

export const PERMISSIONS = [
  'platform.tenant.view',
  'platform.tenant.create',
  'platform.tenant.edit',
  'platform.tenant.suspend',
  'platform.tenant.deregister',
  'platform.tenant.restore',
  'platform.tenant.purge',
  'platform.tenant_admin.config',
  'platform.seat.view',
  'platform.seat.grant',
  'platform.seat.reduce',
  'platform.seat.revoke',
  'platform.seat.force_release',
  'platform.seat.renew',
  'platform.seat.export',
  'platform.quota.view',
  'platform.quota.grant',
  'platform.quota.gift',
  'platform.quota.revoke',
  'platform.quota.adjust',
  'platform.quota.config',
  'platform.quota.export',
  'platform.model_catalog.view',
  'platform.model_catalog.create',
  'platform.model_catalog.edit',
  'platform.model_catalog.publish',
  'platform.model_grant.view',
  'platform.model_grant.grant',
  'platform.model_grant.revoke',
  'platform.model_grant.limit',
  'platform.trial_plan.view',
  'platform.trial_plan.create',
  'platform.trial_plan.edit',
  'platform.trial_plan.disable',
  'platform.trial.open',
  'platform.trial.extend',
  'platform.trial.convert',
  'platform.trial.terminate',
  'platform.dashboard.view',
  'platform.audit.view',
  'platform.audit.export',
  'platform.account.manage',
  'platform.corp_order.view',
  'platform.corp_order.create',
  'platform.corp_order.export',
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/** 只读审计：全部 .view 与 .export */
const AUDITOR: Permission[] = PERMISSIONS.filter(
  (p) => p.endsWith('.view') || p.endsWith('.export'),
) as Permission[];

/** 平台商务：只读 + 建客户 + 开试用，不能下发正式资源 */
const SALES: Permission[] = [
  ...AUDITOR,
  'platform.tenant.create',
  'platform.tenant.edit',
  'platform.tenant_admin.config',
  'platform.trial.open',
  'platform.trial.extend',
  'platform.trial.convert',
  'platform.corp_order.create',
];

/** 平台运营：日常下发资源，不能注销租户、不能回收/调账额度、不能强制释放席位 */
const OPERATOR: Permission[] = [
  ...SALES,
  'platform.tenant.suspend',
  'platform.seat.grant',
  'platform.seat.reduce',
  'platform.seat.revoke',
  'platform.seat.renew',
  'platform.quota.grant',
  'platform.quota.gift',
  'platform.quota.config',
  'platform.model_catalog.create',
  'platform.model_catalog.edit',
  'platform.model_catalog.publish',
  'platform.model_grant.grant',
  'platform.model_grant.revoke',
  'platform.model_grant.limit',
  'platform.trial_plan.create',
  'platform.trial_plan.edit',
  'platform.trial_plan.disable',
  'platform.trial.terminate',
];

export const ROLE_PERMISSIONS: Record<PlatformRole, ReadonlySet<Permission>> = {
  super_admin: new Set(PERMISSIONS),
  operator: new Set(OPERATOR),
  sales: new Set(SALES),
  auditor: new Set(AUDITOR),
};

export function hasPermission(actor: Actor, permission: Permission): boolean {
  const granted = ROLE_PERMISSIONS[actor.role];
  return granted !== undefined && granted.has(permission);
}

export function requirePermission(actor: Actor, permission: Permission): void {
  if (!hasPermission(actor, permission)) {
    fail('PERMISSION_DENIED', `当前角色缺少权限点 ${permission}`, {
      role: actor.role,
      permission,
    });
  }
}

/** 仅超管可执行的危险操作（Spec 5.1） */
export const SUPER_ADMIN_ONLY: Permission[] = [
  'platform.tenant.deregister',
  'platform.tenant.restore',
  'platform.tenant.purge',
  'platform.seat.force_release',
  'platform.quota.revoke',
  'platform.quota.adjust',
  'platform.account.manage',
];
