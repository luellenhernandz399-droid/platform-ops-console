// HTTP 路由。对应 Spec 第 13 章接口清单。
//
// 鉴权：请求头 X-Actor-Id / X-Actor-Role 标识平台侧操作者，
// 真实部署替换为 JWT 解析即可，其余逻辑不变。
// 幂等：写接口读取 Idempotency-Key 请求头。

import type { Actor, PlatformRole, TenantStatus } from '../domain/types.ts';
import { AppError } from '../domain/errors.ts';
import { requirePermission } from '../domain/rbac.ts';
import type { PlatformConsole } from '../app.ts';
import type { RiskView, SortKey } from '../services/query.ts';

export interface ApiRequest {
  method: string;
  path: string;
  query?: Record<string, string | string[]>;
  body?: unknown;
  headers?: Record<string, string | undefined>;
}

export interface ApiResponse {
  status: number;
  body: unknown;
}

type Handler = (
  ctx: {
    actor: Actor;
    params: Record<string, string>;
    body: Record<string, unknown>;
    query: Record<string, string | string[]>;
    idempotencyKey: string | null;
  },
) => unknown;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

const VALID_ROLES: PlatformRole[] = ['super_admin', 'operator', 'sales', 'auditor'];

export class Router {
  private app: PlatformConsole;
  private routes: Route[] = [];

  constructor(app: PlatformConsole) {
    this.app = app;
    this.register();
  }

  private add(method: string, pattern: string, handler: Handler): void {
    this.routes.push({
      method,
      segments: pattern.split('/').filter((s) => s.length > 0),
      handler,
    });
  }

  handle(request: ApiRequest): ApiResponse {
    const segments = request.path.split('?')[0].split('/').filter((s) => s.length > 0);

    let matched: { route: Route; params: Record<string, string> } | null = null;
    let pathExists = false;

    for (const route of this.routes) {
      const params = matchSegments(route.segments, segments);
      if (params === null) continue;
      pathExists = true;
      if (route.method === request.method) {
        matched = { route, params };
        break;
      }
    }

    if (!matched) {
      return {
        status: pathExists ? 405 : 404,
        body: {
          code: pathExists ? 'METHOD_NOT_ALLOWED' : 'NOT_FOUND',
          message: pathExists ? '方法不被允许' : '接口不存在',
        },
      };
    }

    const actor = readActor(request.headers ?? {});
    if (!actor) {
      return {
        status: 401,
        body: {
          code: 'UNAUTHENTICATED',
          message: '缺少或非法的 X-Actor-Id / X-Actor-Role 请求头',
        },
      };
    }

    try {
      const result = matched.route.handler({
        actor,
        params: matched.params,
        body: (request.body ?? {}) as Record<string, unknown>,
        query: request.query ?? {},
        idempotencyKey: request.headers?.['idempotency-key'] ?? null,
      });
      const status = request.method === 'POST' ? 201 : 200;
      return { status: result === undefined ? 204 : status, body: result ?? null };
    } catch (error) {
      if (error instanceof AppError) {
        return {
          status: error.httpStatus,
          body: {
            code: error.code,
            message: error.message,
            details: error.details,
          },
        };
      }
      return {
        status: 500,
        body: {
          code: 'INTERNAL_ERROR',
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  // ── 路由表 ────────────────────────────────────────────────────────────

  private register(): void {
    const app = this.app;

    // 租户
    this.add('GET', '/platform/v1/tenants', ({ actor, query }) =>
      app.query.list(actor, parseListFilter(query), (query.sort as SortKey) ?? 'lastActiveAt'),
    );
    this.add('POST', '/platform/v1/tenants', ({ actor, body }) =>
      app.createTenant(actor, body as never),
    );
    this.add('GET', '/platform/v1/tenants/:id', ({ actor, params }) =>
      app.query.detail(actor, params.id),
    );
    this.add('PATCH', '/platform/v1/tenants/:id', ({ actor, params, body }) =>
      app.tenants.edit(actor, params.id, body as never),
    );
    this.add('POST', '/platform/v1/tenants/:id/suspend', ({ actor, params, body }) =>
      app.tenants.suspend(
        actor,
        params.id,
        (body.reasonCode as 'manual' | 'violation') ?? 'manual',
        body.reason as string,
      ),
    );
    this.add('POST', '/platform/v1/tenants/:id/resume', ({ actor, params }) =>
      app.tenants.resume(actor, params.id),
    );
    this.add('POST', '/platform/v1/tenants/:id/deregister', ({ actor, params, body }) =>
      app.tenants.deregister(actor, params.id, {
        confirmName: body.confirmName as string,
        reason: body.reason as string,
      }),
    );
    this.add('POST', '/platform/v1/tenants/:id/restore', ({ actor, params }) =>
      app.tenants.restore(actor, params.id),
    );
    this.add('POST', '/platform/v1/tenants/:id/purge', ({ actor, params, body }) =>
      app.tenants.purge(actor, params.id, {
        confirmName: body.confirmName as string,
        reason: body.reason as string,
      }),
    );

    // 席位
    this.add('GET', '/platform/v1/tenants/:id/seat-overview', ({ actor, params }) => {
      requirePermission(actor, 'platform.seat.view');
      return app.seats.overview(params.id);
    });
    this.add('GET', '/platform/v1/tenants/:id/seat-grants', ({ actor, params }) => {
      requirePermission(actor, 'platform.seat.view');
      return app.seats.grants(params.id);
    });
    this.add(
      'POST',
      '/platform/v1/tenants/:id/seat-grants',
      ({ actor, params, body, idempotencyKey }) =>
        app.seats.grant(actor, params.id, {
          ...(body as never),
          idempotencyKey,
        }),
    );
    this.add('POST', '/platform/v1/seat-grants/:gid/reduce', ({ actor, params, body }) =>
      app.seats.reduce(actor, params.gid, body.targetCount as number, {
        strategy: body.strategy as never,
        reason: body.reason as string,
        confirmedMemberIds: body.confirmedMemberIds as string[] | undefined,
      }),
    );
    this.add('POST', '/platform/v1/seat-grants/:gid/revoke', ({ actor, params, body }) =>
      app.seats.revoke(actor, params.gid, {
        strategy: body.strategy as never,
        reason: body.reason as string,
        confirmedMemberIds: body.confirmedMemberIds as string[] | undefined,
      }),
    );
    this.add('POST', '/platform/v1/seat-grants/:gid/renew', ({ actor, params, body }) =>
      app.seats.renew(actor, params.gid, (body.expireAt as string | null) ?? null),
    );
    this.add('GET', '/platform/v1/tenants/:id/seat-assignments', ({ actor, params, query }) => {
      requirePermission(actor, 'platform.seat.view');
      return app.seats.assignments(params.id, query.includeReleased === 'true');
    });
    this.add(
      'POST',
      '/platform/v1/tenants/:id/seat-assignments/:mid/force-release',
      ({ actor, params, body }) =>
        app.seats.forceRelease(actor, params.id, params.mid, body.reason as string),
    );

    // 额度
    this.add('GET', '/platform/v1/tenants/:id/quota', ({ actor, params }) => {
      requirePermission(actor, 'platform.quota.view');
      return app.quota.balance(params.id);
    });
    this.add('GET', '/platform/v1/tenants/:id/quota-grants', ({ actor, params }) => {
      requirePermission(actor, 'platform.quota.view');
      return app.quota.grants(params.id);
    });
    this.add(
      'POST',
      '/platform/v1/tenants/:id/quota-grants',
      ({ actor, params, body, idempotencyKey }) => {
        const input = { ...(body as never), idempotencyKey } as never;
        return body.book === 'gift'
          ? app.quota.gift(actor, params.id, input)
          : app.quota.grant(actor, params.id, input);
      },
    );
    this.add('POST', '/platform/v1/quota-grants/:gid/confirm', ({ actor, params }) =>
      app.quota.confirm(actor, params.gid),
    );
    this.add('POST', '/platform/v1/quota-grants/:gid/revoke', ({ actor, params, body }) =>
      app.quota.revoke(
        actor,
        params.gid,
        body.amountCredit as number,
        body.reason as string,
      ),
    );
    this.add(
      'POST',
      '/platform/v1/tenants/:id/quota-adjustments',
      ({ actor, params, body }) => app.quota.adjust(actor, params.id, body as never),
    );
    this.add('GET', '/platform/v1/tenants/:id/quota-ledger', ({ actor, params, query }) => {
      requirePermission(actor, 'platform.quota.view');
      return app.quota.ledger(params.id, { period: query.period as string | undefined });
    });
    this.add(
      'POST',
      '/platform/v1/tenants/:id/billing-periods/:period/close',
      ({ actor, params }) => app.quota.closePeriod(actor, params.id, params.period),
    );
    this.add(
      'GET',
      '/platform/v1/tenants/:id/reconciliation/:period',
      ({ actor, params }) => {
        requirePermission(actor, 'platform.quota.view');
        return app.quota.reconcile(params.id, params.period);
      },
    );

    // 模型
    this.add('GET', '/platform/v1/model-catalog', ({ actor, query }) => {
      requirePermission(actor, 'platform.model_catalog.view');
      return app.models.catalog({
        status: query.status as never,
        group: query.group as string | undefined,
      });
    });
    this.add('POST', '/platform/v1/model-catalog', ({ actor, body }) =>
      app.models.createModel(actor, body as never),
    );
    this.add('POST', '/platform/v1/model-catalog/:code/publish', ({ actor, params }) =>
      app.models.publish(actor, params.code),
    );
    this.add(
      'POST',
      '/platform/v1/model-catalog/:code/schedule-offline',
      ({ actor, params, body }) =>
        app.models.scheduleOffline(
          actor,
          params.code,
          body.offlineAt as string,
          body.reason as string,
        ),
    );
    this.add('POST', '/platform/v1/model-catalog/:code/offline', ({ actor, params }) =>
      app.models.offline(actor, params.code),
    );
    this.add('GET', '/platform/v1/tenants/:id/model-grants', ({ actor, params }) => {
      requirePermission(actor, 'platform.model_grant.view');
      return app.models.activeGrants(params.id);
    });
    this.add('POST', '/platform/v1/tenants/:id/model-grants', ({ actor, params, body }) =>
      body.group
        ? app.models.grantGroup(actor, params.id, body.group as string)
        : app.models.grantModel(actor, params.id, body as never),
    );
    this.add(
      'DELETE',
      '/platform/v1/tenants/:id/model-grants/:code',
      ({ actor, params }) => app.models.revokeModel(actor, params.id, params.code),
    );
    this.add(
      'DELETE',
      '/platform/v1/tenants/:id/model-groups/:group',
      ({ actor, params }) => ({
        revoked: app.models.revokeGroup(actor, params.id, params.group),
      }),
    );

    // 试用
    this.add('GET', '/platform/v1/trial-plans', ({ actor, query }) => {
      requirePermission(actor, 'platform.trial_plan.view');
      return app.trials.plans(query.includeDisabled === 'true');
    });
    this.add('POST', '/platform/v1/trial-plans', ({ actor, body }) =>
      app.trials.createPlan(actor, body as never),
    );
    this.add('PATCH', '/platform/v1/trial-plans/:id', ({ actor, params, body }) =>
      body.status === 'disabled'
        ? app.trials.disablePlan(actor, params.id)
        : app.trials.editPlan(actor, params.id, body as never),
    );
    this.add('POST', '/platform/v1/tenants/:id/trial/open', ({ actor, params, body }) =>
      app.trials.open(actor, params.id, body.planId as string),
    );
    this.add('POST', '/platform/v1/tenants/:id/trial/extend', ({ actor, params, body }) =>
      app.trials.extend(actor, params.id, body.days as number, {
        reason: body.reason as string,
        extraGiftCredit: body.extraGiftCredit as number | undefined,
      }),
    );
    this.add('POST', '/platform/v1/tenants/:id/trial/convert', ({ actor, params, body }) =>
      app.trials.convert(actor, params.id, body as never),
    );
    this.add('POST', '/platform/v1/tenants/:id/trial/terminate', ({ actor, params, body }) =>
      app.trials.terminate(actor, params.id, body.reason as string),
    );

    this.add('POST', '/platform/v1/tenants/:id/remarks', ({ actor, params, body }) =>
      app.tenants.addRemark(actor, params.id, String(body.text ?? '')),
    );

    // 租户管理员与额度策略配置
    this.add('PUT', '/platform/v1/tenants/:id/admin', ({ actor, params, body }) =>
      app.tenants.setAdmin(actor, params.id, body as never),
    );
    this.add('PATCH', '/platform/v1/tenants/:id/quota-config', ({ actor, params, body }) =>
      app.quota.setConfig(actor, params.id, body as never),
    );

    // 模型授权的默认、限额与自建渠道
    this.add(
      'POST',
      '/platform/v1/tenants/:id/model-grants/:code/default',
      ({ actor, params }) => app.models.setDefault(actor, params.id, params.code),
    );
    this.add(
      'PATCH',
      '/platform/v1/tenants/:id/model-grants/:code',
      ({ actor, params, body }) =>
        app.models.setLimits(actor, params.id, params.code, body as never),
    );
    this.add('PATCH', '/platform/v1/tenants/:id/model-limits', ({ actor, params, body }) =>
      app.models.setTenantLimits(actor, params.id, body as never),
    );
    this.add(
      'PUT',
      '/platform/v1/tenants/:id/self-hosted-channel',
      ({ actor, params, body }) =>
        app.models.setSelfHostedChannel(actor, params.id, body.allowed === true),
    );

    // 导出（Spec 11.4）
    this.add('POST', '/platform/v1/exports/:kind', ({ actor, params, body }) =>
      app.exports.run(actor, params.kind as never, {
        tenantId: body.tenantId as string | undefined,
        filter: body.filter as never,
      }),
    );

    // 看板与审计
    this.add('GET', '/platform/v1/dashboard', ({ actor }) => app.query.dashboard(actor));
    this.add('GET', '/platform/v1/risk-views/:view', ({ actor, params }) =>
      app.query.riskView(actor, params.view as RiskView),
    );
    this.add('GET', '/platform/v1/audit-logs', ({ actor, query }) => {
      requirePermission(actor, 'platform.audit.view');
      return app.audit.query({
        tenantId: query.tenantId as string | undefined,
        actorId: query.actorId as string | undefined,
        objectType: query.objectType as string | undefined,
        action: query.action as string | undefined,
      });
    });

    // 内部：手动触发每日任务
    this.add('POST', '/platform/v1/jobs/daily-run', ({ actor }) => {
      requirePermission(actor, 'platform.account.manage');
      return app.jobs.run();
    });
  }
}

function matchSegments(
  pattern: string[],
  actual: string[],
): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i];
    if (p.startsWith(':')) {
      params[p.slice(1)] = decodeURIComponent(actual[i]);
    } else if (p !== actual[i]) {
      return null;
    }
  }
  return params;
}

function readActor(headers: Record<string, string | undefined>): Actor | null {
  const id = headers['x-actor-id'];
  const role = headers['x-actor-role'] as PlatformRole | undefined;
  if (!id || !role || !VALID_ROLES.includes(role)) return null;
  return { id, role, source: 'api' };
}

function parseListFilter(query: Record<string, string | string[]>) {
  const asArray = (v: string | string[] | undefined): string[] | undefined => {
    if (v === undefined) return undefined;
    return Array.isArray(v) ? v : v.split(',');
  };
  return {
    status: asArray(query.status) as TenantStatus[] | undefined,
    level: asArray(query.level) as never,
    ownerSalesId: query.ownerSalesId as string | undefined,
    industry: query.industry as string | undefined,
    tags: asArray(query.tags),
    trialOnly: query.trialOnly === 'true',
    keyword: query.keyword as string | undefined,
    expiringWithinDays: query.expiringWithinDays
      ? Number(query.expiringWithinDays)
      : undefined,
  };
}
