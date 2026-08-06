// 开发/演示用种子数据。仅由 main.ts 在 SEED !== '0' 时调用，不参与测试与生产逻辑。

import type { PlatformConsole } from '../app.ts';
import type { Actor } from '../domain/types.ts';
import { addDays } from '../domain/time.ts';

const admin: Actor = { id: 'u_super', role: 'super_admin', source: 'console' };
const ops: Actor = { id: 'u_ops', role: 'operator', source: 'console' };

const BASIC = '基础模型集';
const ADVANCED = '高级模型集';
const EXPERIMENTAL = '实验模型集';

export function seed(app: PlatformConsole): void {
  const now = app.clock.now();

  // ── 平台模型目录 ────────────────────────────────────────────────────
  const models = [
    ['claude-opus-5', 'Claude Opus 5', 'Anthropic-Prod', 'anthropic', 5, ADVANCED],
    ['claude-sonnet-5', 'Claude Sonnet 5', 'Anthropic-Prod', 'anthropic', 1, BASIC],
    ['gpt-5', 'GPT-5', 'OpenAI-Main', 'openai', 4, ADVANCED],
    ['gpt-4o', 'GPT-4o', 'Azure-East-2', 'azure', 1.5, BASIC],
    ['deepseek-v3', 'DeepSeek V3', 'Deepseek-Cn', 'deepseek', 0.2, BASIC],
    ['gemini-2-5-pro', 'Gemini 2.5 Pro', 'Gemini-Vertex', 'google', 2, ADVANCED],
    ['qwen3-72b', 'Qwen3 72B', 'Local-vLLM', 'self_hosted', 0.1, EXPERIMENTAL],
  ] as const;

  for (const [code, name, channel, vendor, mult, group] of models) {
    app.models.createModel(admin, {
      code,
      displayName: name,
      channel,
      vendor: vendor as never,
      priceMultiplier: mult,
      group,
      capabilities: ['chat', 'code'],
    });
    app.models.publish(admin, code);
  }

  // ── 试用套餐模板（Spec 10.1 的三个预置）────────────────────────────
  const plans = [
    { name: '轻量试用 7 天', seatCount: 3, giftCredit: 5_000, durationDays: 7, modelGroups: [BASIC] },
    { name: '标准试用 14 天', seatCount: 10, giftCredit: 20_000, durationDays: 14, modelGroups: [BASIC] },
    { name: 'POC 试用 30 天', seatCount: 30, giftCredit: 100_000, durationDays: 30, modelGroups: [BASIC, ADVANCED] },
  ];
  const planIds = plans.map((p) => app.trials.createPlan(admin, p).id);

  // ── 租户 ────────────────────────────────────────────────────────────

  // 1. 大客户：正式、席位充足、额度健康
  const t1 = app.createTenant(admin, {
    name: '词元内部产品组',
    shortName: '词元内部',
    industry: '软件与信息服务',
    level: 'strategic',
    ownerSalesId: 'u_sales',
    contactName: '胡艺馨',
    contactEmail: 'ops@ciyuan.example',
    contractNo: 'HT-2026-0101',
    contractEndAt: addDays(now, 300).toISOString(),
    tags: ['内部', '战略'],
    provisioning: {
      mode: 'active',
      seatCount: 60,
      purchasedCredit: 1_000_000,
      modelGroups: [BASIC, ADVANCED],
    },
    firstAdmin: { memberId: 'm_ciyuan_admin', name: '胡艺馨', email: 'ops@ciyuan.example' },
  });
  fill(app, t1.id, 41, '词元');
  app.quota.allocateTeam(t1.id, 'team_core', '核心研发', 400_000);
  app.quota.allocateTeam(t1.id, 'team_data', '数据平台', 200_000);
  spend(app, t1.id, [
    ['claude-sonnet-5', 'team_core', 62_000],
    ['claude-opus-5', 'team_core', 48_000],
    ['deepseek-v3', 'team_data', 9_400],
  ]);

  // 2. 额度告警客户
  const t2 = app.createTenant(admin, {
    name: '北京理工雷科空天',
    industry: '航空航天',
    level: 'key',
    ownerSalesId: 'u_sales',
    contactName: '李工',
    contactEmail: 'li@leike.example',
    contractNo: 'HT-2026-0233',
    contractEndAt: addDays(now, 18).toISOString(),
    provisioning: { mode: 'active', seatCount: 12, purchasedCredit: 100_000, modelGroups: [BASIC] },
    firstAdmin: { memberId: 'm_leike_admin', name: '李工', email: 'li@leike.example' },
  });
  fill(app, t2.id, 8, '雷科');
  spend(app, t2.id, [['claude-sonnet-5', 'team_a', 96_500]]);

  // 3. 席位超卖客户（软限 20%）
  const t3 = app.createTenant(admin, {
    name: '东软医保事业部',
    industry: '医疗健康',
    level: 'key',
    ownerSalesId: 'u_sales2',
    contactName: '王经理',
    contactEmail: 'wang@neusoft.example',
    seatOversellPercent: 20,
    provisioning: { mode: 'active', seatCount: 20, purchasedCredit: 300_000, modelGroups: [BASIC] },
    firstAdmin: { memberId: 'm_neusoft_admin', name: '王经理', email: 'wang@neusoft.example' },
  });
  fill(app, t3.id, 22, '东软'); // 23 > 20，触发超卖
  spend(app, t3.id, [['gpt-4o', 'team_a', 41_000]]);

  // 4. 试用中，7 天内到期
  const t4 = app.createTenant(admin, {
    name: '金蝶国际软件集团',
    industry: '软件与信息服务',
    level: 'normal',
    ownerSalesId: 'u_sales2',
    contactName: '陈总',
    contactEmail: 'chen@kingdee.example',
    provisioning: { mode: 'trial', planId: planIds[1] },
    firstAdmin: { memberId: 'm_kingdee_admin', name: '陈总', email: 'chen@kingdee.example' },
  });
  fill(app, t4.id, 5, '金蝶');
  spend(app, t4.id, [['claude-sonnet-5', 'team_a', 6_200]]);
  // 把试用推进到只剩 4 天，进入「试用即将到期」风险视图
  app.store.tenants.update(t4.id, { trialExpireAt: addDays(now, 4).toISOString() });

  // 5. 试用中，刚开通
  const t5 = app.createTenant(admin, {
    name: '华为金融军团',
    industry: '金融科技',
    level: 'strategic',
    ownerSalesId: 'u_sales',
    contactName: '赵架构',
    contactEmail: 'zhao@hw.example',
    provisioning: { mode: 'trial', planId: planIds[2] },
    firstAdmin: { memberId: 'm_hw_admin', name: '赵架构', email: 'zhao@hw.example' },
  });
  fill(app, t5.id, 11, '华为');
  spend(app, t5.id, [['gemini-2-5-pro', 'team_a', 21_000]]);

  // 6. 欠费停用
  const t6 = app.createTenant(admin, {
    name: '北航先进制造',
    industry: '教育科研',
    level: 'normal',
    ownerSalesId: 'u_sales2',
    contactName: '孙老师',
    contactEmail: 'sun@buaa.example',
    provisioning: { mode: 'active', seatCount: 8, purchasedCredit: 20_000, modelGroups: [BASIC] },
    firstAdmin: { memberId: 'm_buaa_admin', name: '孙老师', email: 'sun@buaa.example' },
  });
  fill(app, t6.id, 4, '北航');
  spend(app, t6.id, [['deepseek-v3', 'team_a', 20_000]]); // 打到 0，自动 arrears 停用

  // 7. 待开通
  app.createTenant(admin, {
    name: '新华社中国财富传媒',
    industry: '媒体',
    level: 'normal',
    ownerSalesId: 'u_sales',
    contactName: '刘主任',
    contactEmail: 'liu@xinhua.example',
    provisioning: { mode: 'none' },
    firstAdmin: { memberId: 'm_xinhua_admin', name: '刘主任', email: 'liu@xinhua.example' },
  });

  // 8. 注销保留期内
  const t8 = app.createTenant(admin, {
    name: '泽西科技',
    industry: '软件与信息服务',
    level: 'longtail',
    ownerSalesId: 'u_sales2',
    contactName: '周经理',
    contactEmail: 'zhou@zexi.example',
    provisioning: { mode: 'active', seatCount: 5, purchasedCredit: 30_000, modelGroups: [BASIC] },
    firstAdmin: { memberId: 'm_zexi_admin', name: '周经理', email: 'zhou@zexi.example' },
  });
  fill(app, t8.id, 2, '泽西');
  app.tenants.deregister(admin, t8.id, {
    confirmName: '泽西科技',
    reason: '合同到期客户不再续约，确认注销',
  });

  // 一笔待确认充值单，用于演示「确认到账」
  app.quota.grant(ops, t2.id, {
    amountCredit: 500_000,
    source: 'contract',
    contractNo: 'HT-2026-0233-A1',
    pending: true,
    reason: '续签合同已签，等待到账',
  });
}

/** 批量占用席位，最后一个成员标为从未登录，便于演示强制回收排序 */
function fill(app: PlatformConsole, tenantId: string, count: number, prefix: string): void {
  const now = app.clock.now();
  for (let i = 0; i < count; i += 1) {
    const memberId = `${prefix}_m${i}`;
    try {
      app.seats.assign(tenantId, {
        memberId,
        memberName: `${prefix}成员${i + 1}`,
        memberEmail: `${memberId}@example.com`,
        teamId: i % 3 === 0 ? 'team_core' : i % 3 === 1 ? 'team_data' : 'team_a',
      });
      if (i % 5 !== 0) {
        app.seats.touchActivity(tenantId, memberId, addDays(now, -(i % 40)));
      }
    } catch {
      // 席位不足时停止，超卖场景由调用方通过 seatOversellPercent 控制
      break;
    }
  }
}

function spend(
  app: PlatformConsole,
  tenantId: string,
  items: [string, string, number][],
): void {
  for (const [modelCode, teamId, amountCredit] of items) {
    try {
      app.quota.consume(tenantId, { amountCredit, modelCode, teamId });
      app.models.recordUsage(tenantId, modelCode, amountCredit);
    } catch {
      // 余额不足即止，用于制造欠费停用场景
      break;
    }
  }
}
