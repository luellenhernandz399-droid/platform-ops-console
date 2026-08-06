// 控制台主壳：侧边栏、路由、看板、租户列表、模型目录、试用套餐、审计、每日任务。

import {
  actor, api, badge, day, downloadCsv, dt, esc, EXHAUST_POLICY, LEVEL, MODEL_GROUPS,
  MODEL_STATUS, meter, openForm, pct, ROLES, setRole, statusBadge, STATUS, toast,
  toastError, usd, VENDOR, currentPath, go,
} from './core.js';
import { renderTenantDetail } from './detail.js';

const NAV = [
  { key: 'dashboard', label: '运营看板' },
  { key: 'tenants', label: '租户管理' },
  { key: 'models', label: '模型目录' },
  { key: 'trials', label: '试用套餐' },
  { key: 'audit', label: '审计日志' },
  { key: 'jobs', label: '每日任务' },
];

const RISK_VIEWS = [
  ['quota_alert', '额度告警'],
  ['seat_oversell', '席位超卖'],
  ['expiring_soon', '即将到期'],
  ['inactive', '长期不活跃'],
  ['trial_expiring', '试用即将到期'],
];

const app = document.getElementById('root');

// ── 骨架 ──────────────────────────────────────────────────────────────

function shell(active, title) {
  return `
    <div class="shell">
      <aside class="sidebar">
        <div class="brand">
          <div class="brand-mark"></div>
          <div>
            <div class="brand-name">平台运营后台</div>
            <div class="brand-sub">租户 · 席位 · 额度 · 模型</div>
          </div>
        </div>
        <nav>
          <div class="nav-section">运营</div>
          ${NAV.map((n) => `<div class="nav-item ${n.key === active ? 'active' : ''}" data-nav="${n.key}">
            <span class="dot"></span>${n.label}</div>`).join('')}
        </nav>
        <div style="margin-top:auto" class="hint">
          平台侧只管上限与可用范围，租户内部怎么分由租户侧管理中心决定。
        </div>
      </aside>
      <div class="main">
        <div class="topbar">
          <div class="topbar-title">${esc(title)}</div>
          <div class="topbar-spacer"></div>
          <div class="role-switch">
            <span>当前身份</span>
            <select id="role-select">
              ${Object.entries(ROLES).map(([v, l]) =>
                `<option value="${v}" ${v === actor.role ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
          </div>
        </div>
        <div id="view"></div>
      </div>
    </div>`;
}

function mount(active, title) {
  app.innerHTML = shell(active, title);
  app.querySelectorAll('[data-nav]').forEach((n) =>
    n.addEventListener('click', () => go(n.dataset.nav)));
  app.querySelector('#role-select').addEventListener('change', (e) => {
    setRole(e.target.value);
    toast(`已切换为${ROLES[e.target.value]}`);
    route();
  });
  return app.querySelector('#view');
}

function bindActions(root, table) {
  root.addEventListener('click', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node) return;
    const fn = table[node.dataset.act];
    if (fn) fn(node.dataset);
  });
}

// ── 运营看板 ──────────────────────────────────────────────────────────

async function viewDashboard() {
  const view = mount('dashboard', '运营看板');
  view.innerHTML = '<div class="loading">加载中</div>';
  let d;
  try {
    d = await api('GET', '/dashboard');
  } catch (error) {
    toastError(error);
    view.innerHTML = `<div class="page"><div class="card"><div class="empty">${esc(error.message)}</div></div></div>`;
    return;
  }

  const stat = (label, value, sub = '', cls = '') =>
    `<div class="card stat"><div class="stat-label">${label}</div>
     <div class="stat-value ${cls}">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">运营看板</div>
          <div class="page-desc">平台向租户下发的席位、额度、模型三类资源的总体水位与风险清单</div>
        </div>
      </div>

      <div class="grid grid-4">
        ${stat('租户总数', d.tenantCount.total,
          `正式 ${d.tenantCount.active} · 试用 ${d.tenantCount.trialing} · 停用 ${d.tenantCount.suspended}`)}
        ${stat('席位占用', `${d.seats.occupied} / ${d.seats.granted}`, `占用率 ${pct(d.seats.occupancyRate)}`,
          d.seats.occupancyRate >= 0.9 ? 'warn' : '')}
        ${stat('在途余额', usd(d.quota.outstandingCredit),
          `累计发放 ${usd(d.quota.grantedCredit)} · 累计消耗 ${usd(d.quota.consumedCredit)}`)}
        ${stat('本月转化', `${d.monthConverted}`, `新增租户 ${d.monthNewTenants} · 转化率 ${pct(d.conversionRate)}`)}
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">风险清单</div>
          <div class="card-note">点击任一项进入对应的筛选视图</div>
        </div>
        <div class="card-body">
          <div class="grid grid-3">
            ${RISK_VIEWS.map(([key, label]) => {
              const rows = d.risks[key] ?? [];
              return `<div>
                <div class="section-title">
                  ${label}
                  <span class="badge ${rows.length ? (key === 'inactive' ? 'warn' : 'danger') : 'mute'}">${rows.length}</span>
                </div>
                ${rows.length
                  ? rows.slice(0, 5).map((r) => `<div class="remark" style="cursor:pointer" data-act="open" data-id="${r.tenantId}">
                      ${esc(r.name)}
                      <div class="remark-meta">${riskHint(key, r)}</div></div>`).join('')
                  : '<div class="hint">暂无</div>'}
                ${rows.length ? `<button class="btn-link" data-act="risk" data-view="${key}" style="margin-top:8px">查看全部</button>` : ''}
              </div>`;
            }).join('')}
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><div class="card-title">模型消耗分布</div>
          <div class="card-note">按 credit 消耗排序</div></div>
        <div class="card-body flush table-wrap">
          <table><thead><tr><th>模型</th><th class="num">使用租户数</th><th class="num">累计消耗</th><th>占比</th></tr></thead>
          <tbody>${d.modelUsage.length ? d.modelUsage.map((m) => {
            const total = d.modelUsage.reduce((s, x) => s + x.consumedCredit, 0) || 1;
            return `<tr><td class="mono">${esc(m.modelCode)}</td>
              <td class="num">${m.tenantCount}</td>
              <td class="num">${usd(m.consumedCredit)}</td>
              <td>${meter(m.consumedCredit / total)}</td></tr>`;
          }).join('') : '<tr><td colspan="4"><div class="empty">暂无消耗</div></td></tr>'}</tbody></table>
        </div>
      </div>
    </div>`;

  bindActions(view, {
    open: (ds) => go(`tenants/${ds.id}/basic`),
    risk: (ds) => go(`tenants?risk=${ds.view}`),
  });
}

function riskHint(key, r) {
  switch (key) {
    case 'quota_alert': return `可用 ${usd(r.availableCredit)}`;
    case 'seat_oversell': return `占用 ${r.seatOccupied} / 总数 ${r.seatTotal}`;
    case 'expiring_soon': return `到期 ${day(r.expireAt)}`;
    case 'inactive': return r.lastActiveAt ? `最后活跃 ${day(r.lastActiveAt)}` : '从未活跃';
    case 'trial_expiring': return `试用到期 ${day(r.expireAt)}`;
    default: return '';
  }
}

// ── 租户列表 ──────────────────────────────────────────────────────────

const filters = { keyword: '', status: '', level: '', sort: 'lastActiveAt', risk: '' };

async function viewTenants(params) {
  const view = mount('tenants', '租户管理');
  if (params.has('risk')) filters.risk = params.get('risk');

  const draw = async () => {
    view.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <div class="page-title">租户管理</div>
            <div class="page-desc">席位、额度、模型三个维度的总览。点击任一行进入详情。</div>
          </div>
          <div class="page-actions">
            <button class="btn" data-act="export">导出列表</button>
            <button class="btn btn-cta" data-act="create">新建租户</button>
          </div>
        </div>

        <div class="card"><div class="card-body">
          <div class="filters">
            <input id="f-keyword" placeholder="搜索名称、编码或联系人" value="${esc(filters.keyword)}" />
            <select id="f-status">
              <option value="">全部状态</option>
              ${Object.entries(STATUS).map(([v, s]) =>
                `<option value="${v}" ${filters.status === v ? 'selected' : ''}>${s.label}</option>`).join('')}
            </select>
            <select id="f-level">
              <option value="">全部等级</option>
              ${Object.entries(LEVEL).map(([v, l]) =>
                `<option value="${v}" ${filters.level === v ? 'selected' : ''}>${l}</option>`).join('')}
            </select>
            <select id="f-sort">
              <option value="lastActiveAt" ${filters.sort === 'lastActiveAt' ? 'selected' : ''}>按最后活跃</option>
              <option value="availableCredit" ${filters.sort === 'availableCredit' ? 'selected' : ''}>按可用余额</option>
              <option value="consumeRate" ${filters.sort === 'consumeRate' ? 'selected' : ''}>按消耗率</option>
              <option value="occupancyRate" ${filters.sort === 'occupancyRate' ? 'selected' : ''}>按占用率</option>
              <option value="expireAt" ${filters.sort === 'expireAt' ? 'selected' : ''}>按到期时间</option>
            </select>
            <div class="chips">
              <span class="chip ${filters.risk === '' ? 'active' : ''}" data-risk="">全部</span>
              ${RISK_VIEWS.map(([k, l]) =>
                `<span class="chip ${filters.risk === k ? 'active' : ''}" data-risk="${k}">${l}</span>`).join('')}
            </div>
          </div>
        </div></div>

        <div class="card">
          <div class="card-body flush table-wrap" id="tenant-table">
            <div class="loading">加载中</div>
          </div>
        </div>
      </div>`;

    view.querySelector('#f-keyword').addEventListener('input', (e) => {
      filters.keyword = e.target.value; refresh();
    });
    for (const [id, key] of [['#f-status', 'status'], ['#f-level', 'level'], ['#f-sort', 'sort']]) {
      view.querySelector(id).addEventListener('change', (e) => { filters[key] = e.target.value; refresh(); });
    }
    view.querySelectorAll('[data-risk]').forEach((n) =>
      n.addEventListener('click', () => { filters.risk = n.dataset.risk; draw(); }));

    bindActions(view, {
      create: () => openCreateTenant(),
      export: async () => {
        try { downloadCsv(await api('POST', '/exports/tenants', { filter: buildFilter() })); }
        catch (error) { toastError(error); }
      },
    });

    refresh();
  };

  const buildFilter = () => {
    const f = {};
    if (filters.keyword) f.keyword = filters.keyword;
    if (filters.status) f.status = [filters.status];
    if (filters.level) f.level = [filters.level];
    return f;
  };

  const refresh = async () => {
    const box = view.querySelector('#tenant-table');
    if (!box) return;
    try {
      let rows;
      if (filters.risk) {
        rows = await api('GET', `/risk-views/${filters.risk}`);
      } else {
        const q = new URLSearchParams();
        if (filters.keyword) q.set('keyword', filters.keyword);
        if (filters.status) q.set('status', filters.status);
        if (filters.level) q.set('level', filters.level);
        q.set('sort', filters.sort);
        rows = await api('GET', `/tenants?${q}`);
      }
      box.innerHTML = renderTenantTable(rows);
      box.querySelectorAll('[data-id]').forEach((n) =>
        n.addEventListener('click', () => go(`tenants/${n.dataset.id}/basic`)));
    } catch (error) {
      toastError(error);
      box.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
    }
  };

  draw();
}

function renderTenantTable(rows) {
  if (!rows.length) return '<div class="empty">没有匹配的租户</div>';
  return `<table><thead><tr>
    <th>租户</th><th>状态</th><th>等级</th><th>席位</th><th>占用率</th>
    <th class="num">可用额度</th><th class="num">本月消耗</th><th class="num">模型</th>
    <th>到期</th><th>归属销售</th><th>最后活跃</th>
  </tr></thead><tbody>
    ${rows.map((r) => {
      const live = ['pending', 'trialing', 'active', 'suspended'].includes(r.status);
      const expDays = r.expireAt ? Math.ceil((new Date(r.expireAt) - Date.now()) / 86400000) : null;
      return `<tr class="row-link" data-id="${r.tenantId}">
        <td><div>${esc(r.name)}</div><div class="dual-sub">${esc(r.code)}</div></td>
        <td>${statusBadge(r)}</td>
        <td>${r.level ? LEVEL[r.level] : '—'}</td>
        <td>${r.seatOccupied} / ${r.seatTotal}${live && r.oversold ? ' ' + badge('超卖', 'danger') : ''}</td>
        <td>${meter(r.occupancyRate, live && r.oversold)}<div class="dual-sub">${pct(r.occupancyRate)}</div></td>
        <td class="num"><div class="dual-main">${r.availableUsd.startsWith('-') ? '-$' + r.availableUsd.slice(1) : '$' + r.availableUsd}</div>
          <div class="dual-sub">${Number(r.availableCredit).toLocaleString()} credit</div></td>
        <td class="num">${usd(r.monthConsumeCredit)}</td>
        <td class="num">${r.grantedModelCount}</td>
        <td>${r.expireAt ? `${day(r.expireAt)}${expDays !== null && expDays <= 30 ? ' ' + badge(`${expDays} 天`, 'warn') : ''}` : '—'}</td>
        <td>${esc(r.ownerSalesId ?? '—')}</td>
        <td>${r.lastActiveAt ? day(r.lastActiveAt) : badge('从未活跃', 'mute')}</td>
      </tr>`;
    }).join('')}
  </tbody></table>`;
}

async function openCreateTenant() {
  const plans = await api('GET', '/trial-plans');
  openForm({
    title: '新建租户',
    desc: '开通方式决定是否立即下发资源。选择「开通试用」或「直接开通正式」时，首个管理员会占用一个席位。',
    wide: true,
    fields: [
      { name: 'name', label: '企业全称', type: 'text', required: true, help: '全局唯一，注销二次确认以此为准。' },
      { name: 'shortName', label: '简称', type: 'text' },
      { name: 'industry', label: '所属行业', type: 'text' },
      { name: 'level', label: '客户等级', type: 'select', value: 'normal',
        options: Object.entries(LEVEL).map(([v, l]) => ({ value: v, label: l })) },
      { name: 'ownerSalesId', label: '归属销售', type: 'text', value: 'u_sales' },
      { name: 'contactName', label: '联系人', type: 'text', required: true },
      { name: 'contactEmail', label: '联系邮箱', type: 'text', required: true },
      { name: 'contractNo', label: '合同编号', type: 'text' },
      { name: 'contractEndAt', label: '合同到期', type: 'date' },
      { name: 'retentionDays', label: '注销保留期（天）', type: 'number', value: 30, min: 7,
        help: '范围 7 ~ 180 天。' },
      { name: 'seatOversellPercent', label: '席位超卖比例（%）', type: 'number', min: 0,
        help: '留空表示硬限，最大 20%。' },
      { name: 'exhaustPolicy', label: '额度耗尽策略', type: 'select', value: 'hard_stop',
        options: Object.entries(EXHAUST_POLICY).map(([v, l]) => ({ value: v, label: l })) },

      { name: 'mode', label: '开通方式', type: 'select', required: true, value: 'active',
        options: [
          { value: 'active', label: '直接开通正式' },
          { value: 'trial', label: '开通试用' },
          { value: 'none', label: '仅创建不开通' },
        ] },
      { name: 'planId', label: '试用套餐', type: 'select', when: (v) => v.mode === 'trial',
        value: plans[0]?.id,
        options: plans.map((p) => ({ value: p.id, label: `${p.name} · ${p.seatCount} 席位 / ${usd(p.giftCredit)} / ${p.durationDays} 天` })) },
      { name: 'seatCount', label: '初始席位数', type: 'number', min: 1, value: 20,
        when: (v) => v.mode === 'active', help: '为 0 时创建会被拒绝，首个管理员需要占一个席位。' },
      { name: 'purchasedCredit', label: '初始购买额度（美元）', type: 'usd', min: 0, value: 5000,
        when: (v) => v.mode === 'active' },
      { name: 'modelGroups', label: '模型分组授权', type: 'multiselect', value: ['基础模型集'],
        when: (v) => v.mode === 'active',
        options: MODEL_GROUPS.map((g) => ({ value: g, label: g })) },

      { name: 'adminId', label: '首个管理员标识', type: 'text', value: '', placeholder: 'm_xxx_admin',
        when: (v) => v.mode !== 'none', required: true },
      { name: 'adminName', label: '管理员姓名', type: 'text', when: (v) => v.mode !== 'none', required: true },
      { name: 'adminEmail', label: '管理员邮箱', type: 'text', when: (v) => v.mode !== 'none', required: true },
    ],
    submitLabel: '创建租户',
    onSubmit: async (v) => {
      const provisioning = v.mode === 'trial'
        ? { mode: 'trial', planId: v.planId }
        : v.mode === 'active'
          ? { mode: 'active', seatCount: v.seatCount, purchasedCredit: v.purchasedCredit, modelGroups: v.modelGroups }
          : { mode: 'none' };

      const created = await api('POST', '/tenants', {
        name: v.name,
        shortName: v.shortName || null,
        industry: v.industry || null,
        level: v.level,
        ownerSalesId: v.ownerSalesId || null,
        contactName: v.contactName,
        contactEmail: v.contactEmail,
        contractNo: v.contractNo || null,
        contractEndAt: v.contractEndAt ? new Date(v.contractEndAt).toISOString() : null,
        retentionDays: v.retentionDays,
        seatOversellPercent: v.seatOversellPercent,
        exhaustPolicy: v.exhaustPolicy,
        provisioning,
        firstAdmin: { memberId: v.adminId || 'm_admin', name: v.adminName || '管理员', email: v.adminEmail || '' },
      });
      toast(`租户 ${created.name} 已创建`);
      go(`tenants/${created.id}/basic`);
    },
  });
}

// ── 模型目录 ──────────────────────────────────────────────────────────

async function viewModels() {
  const view = mount('models', '模型目录');
  const draw = async () => {
    view.innerHTML = '<div class="loading">加载中</div>';
    const catalog = await api('GET', '/model-catalog');
    view.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <div class="page-title">平台模型目录</div>
            <div class="page-desc">所有租户可见模型的全集。下线前必须给足 30 天通知，这是硬约束。</div>
          </div>
          <div class="page-actions"><button class="btn btn-cta" data-act="create">新建模型</button></div>
        </div>
        <div class="card"><div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>模型编码</th><th>展示名称</th><th>渠道</th><th>供应商</th><th>分组</th>
            <th class="num">计价倍率</th><th>状态</th><th>上线</th><th>计划下线</th><th></th>
          </tr></thead><tbody>
            ${catalog.length ? catalog.map((m) => {
              const s = MODEL_STATUS[m.status];
              return `<tr>
                <td class="mono">${esc(m.code)}</td>
                <td>${esc(m.displayName)}</td>
                <td>${esc(m.channel)}</td>
                <td>${VENDOR[m.vendor] ?? m.vendor}</td>
                <td>${badge(m.group)}</td>
                <td class="num">${m.priceMultiplier}</td>
                <td>${badge(s.label, s.tone)}</td>
                <td>${day(m.publishedAt)}</td>
                <td>${m.offlineAt ? day(m.offlineAt) : '—'}</td>
                <td><div class="cell-actions">
                  ${m.status === 'draft' ? `<button class="btn-link" data-act="publish" data-code="${esc(m.code)}">上架</button>` : ''}
                  ${m.status === 'published' ? `<button class="btn-link" data-act="schedule" data-code="${esc(m.code)}">安排下线</button>` : ''}
                  ${m.status === 'deprecated' ? `<button class="btn-link danger" data-act="offline" data-code="${esc(m.code)}">立即下线</button>` : ''}
                </div></td></tr>`;
            }).join('') : '<tr><td colspan="10"><div class="empty">目录为空</div></td></tr>'}
          </tbody></table>
        </div></div>
      </div>`;

    bindActions(view, {
      create: () => openForm({
        title: '新建模型',
        desc: '新建后处于草稿状态，上架后才能授权给租户。',
        fields: [
          { name: 'code', label: '模型编码', type: 'text', required: true, placeholder: 'claude-opus-5' },
          { name: 'displayName', label: '展示名称', type: 'text', required: true },
          { name: 'channel', label: '所属渠道', type: 'text', required: true, placeholder: 'Anthropic-Prod' },
          { name: 'vendor', label: '供应商', type: 'select', value: 'anthropic',
            options: Object.entries(VENDOR).map(([v, l]) => ({ value: v, label: l })) },
          { name: 'group', label: '分组', type: 'select', value: MODEL_GROUPS[0],
            options: MODEL_GROUPS.map((g) => ({ value: g, label: g })) },
          { name: 'priceMultiplier', label: '计价倍率', type: 'number', step: '0.1', value: 1 },
        ],
        submitLabel: '创建',
        onSubmit: async (v) => { await api('POST', '/model-catalog', v); toast('模型已创建'); draw(); },
      }),
      publish: async (ds) => {
        try { await api('POST', `/model-catalog/${ds.code}/publish`, {}); toast('模型已上架'); draw(); }
        catch (error) { toastError(error); }
      },
      schedule: (ds) => openForm({
        title: `安排 ${ds.code} 下线`,
        desc: '下线时间距今必须不少于 30 天，安排后立即向所有已授权租户发通知。',
        danger: true,
        fields: [
          { name: 'offlineAt', label: '下线时间', type: 'date', required: true },
          { name: 'reason', label: '下线理由', type: 'textarea', required: true,
            help: '不少于 10 个字符，会写入审计日志。' },
        ],
        submitLabel: '确认安排',
        onSubmit: async (v) => {
          await api('POST', `/model-catalog/${ds.code}/schedule-offline`, {
            offlineAt: new Date(v.offlineAt).toISOString(), reason: v.reason,
          });
          toast('已安排下线并通知租户'); draw();
        },
      }),
      offline: async (ds) => {
        try { await api('POST', `/model-catalog/${ds.code}/offline`, {}); toast('模型已下线'); draw(); }
        catch (error) { toastError(error); }
      },
    });
  };
  draw().catch(toastError);
}

// ── 试用套餐 ──────────────────────────────────────────────────────────

async function viewTrials() {
  const view = mount('trials', '试用套餐');
  const draw = async () => {
    view.innerHTML = '<div class="loading">加载中</div>';
    const plans = await api('GET', '/trial-plans?includeDisabled=true');
    view.innerHTML = `
      <div class="page">
        <div class="page-head">
          <div>
            <div class="page-title">试用套餐模板</div>
            <div class="page-desc">开通即按模板一次性下发席位、赠送额度与模型授权。单个租户试用总时长上限 90 天。</div>
          </div>
          <div class="page-actions"><button class="btn btn-cta" data-act="create">新建套餐</button></div>
        </div>
        <div class="card"><div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>套餐名称</th><th class="num">席位数</th><th class="num">赠送额度</th><th>模型集</th>
            <th class="num">时长</th><th>可充值</th><th>自建渠道</th><th class="num">并发上限</th>
            <th>到期动作</th><th>状态</th><th></th>
          </tr></thead><tbody>
            ${plans.length ? plans.map((p) => `<tr>
              <td>${esc(p.name)}</td>
              <td class="num">${p.seatCount}</td>
              <td class="num">${usd(p.giftCredit)}</td>
              <td>${[...p.modelGroups, ...p.modelCodes].map((g) => badge(g)).join(' ')}</td>
              <td class="num">${p.durationDays} 天</td>
              <td>${p.allowRecharge ? '允许' : '禁止'}</td>
              <td>${p.allowSelfHostedChannel ? '允许' : '禁止'}</td>
              <td class="num">${p.concurrencyLimit ?? '不限'}</td>
              <td>${p.expireAction === 'suspend' ? '停用' : '保留只读'}</td>
              <td>${badge(p.status === 'enabled' ? '启用' : '已停用', p.status === 'enabled' ? 'ok' : 'mute')}</td>
              <td><div class="cell-actions">
                ${p.status === 'enabled' ? `<button class="btn-link danger" data-act="disable" data-id="${p.id}" data-name="${esc(p.name)}">停用</button>` : ''}
              </div></td></tr>`).join('') : '<tr><td colspan="11"><div class="empty">暂无套餐</div></td></tr>'}
          </tbody></table>
        </div></div>
      </div>`;

    bindActions(view, {
      create: () => openForm({
        title: '新建试用套餐',
        desc: '套餐决定试用期下发多少席位、多少赠送额度、可用哪些模型、以及到期怎么处理。',
        wide: true,
        fields: [
          { name: 'name', label: '套餐名称', type: 'text', required: true, placeholder: '标准试用 14 天' },
          { name: 'seatCount', label: '席位数', type: 'number', min: 1, value: 10, required: true },
          { name: 'giftCredit', label: '赠送额度（美元）', type: 'usd', min: 0.01, value: 200, required: true },
          { name: 'durationDays', label: '试用时长（天）', type: 'number', min: 1, value: 14, required: true,
            help: '不得超过 90 天。' },
          { name: 'modelGroups', label: '模型分组', type: 'multiselect', value: ['基础模型集'],
            options: MODEL_GROUPS.map((g) => ({ value: g, label: g })) },
          { name: 'concurrencyLimit', label: '并发上限', type: 'number', min: 1, help: '留空表示不额外限制。' },
          { name: 'allowRecharge', label: '试用期允许充值', type: 'checkbox' },
          { name: 'allowSelfHostedChannel', label: '试用期允许自建渠道', type: 'checkbox' },
          { name: 'expireAction', label: '到期动作', type: 'select', value: 'suspend',
            options: [{ value: 'suspend', label: '停用' }, { value: 'keep_readonly', label: '保留只读访问' }] },
        ],
        submitLabel: '创建套餐',
        onSubmit: async (v) => { await api('POST', '/trial-plans', v); toast('套餐已创建'); draw(); },
      }),
      disable: async (ds) => {
        try {
          await api('PATCH', `/trial-plans/${ds.id}`, { status: 'disabled' });
          toast(`${ds.name} 已停用`); draw();
        } catch (error) { toastError(error); }
      },
    });
  };
  draw().catch(toastError);
}

// ── 审计日志 ──────────────────────────────────────────────────────────

async function viewAudit() {
  const view = mount('audit', '审计日志');
  view.innerHTML = '<div class="loading">加载中</div>';
  const logs = await api('GET', '/audit-logs');
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">平台审计日志</div>
          <div class="page-desc">所有平台侧写操作强制留痕。与账单、授予单同属凭证类数据，不随租户注销清除。</div>
        </div>
        <div class="page-actions"><button class="btn" data-act="export">导出日志</button></div>
      </div>
      <div class="card"><div class="card-body flush table-wrap">
        <table><thead><tr>
          <th>时间</th><th>操作人</th><th>角色</th><th>对象类型</th><th>操作</th>
          <th>变更摘要</th><th>来源</th><th>状态</th><th>理由</th>
        </tr></thead><tbody>
          ${logs.length ? logs.slice(0, 200).map((l) => `<tr>
            <td>${dt(l.at)}</td>
            <td>${esc(l.actorId)}</td>
            <td>${esc(ROLES[l.actorRole] ?? l.actorRole)}</td>
            <td class="mono">${esc(l.objectType)}</td>
            <td class="mono">${esc(l.action)}</td>
            <td class="wrap">${esc(l.summary)}</td>
            <td>${badge(l.source, l.source === 'system' ? 'mute' : '')}</td>
            <td>${badge(l.status === 'success' ? '成功' : '失败', l.status === 'success' ? 'ok' : 'danger')}</td>
            <td>${esc(l.reason ?? '')}</td></tr>`).join('')
            : '<tr><td colspan="9"><div class="empty">暂无日志</div></td></tr>'}
        </tbody></table>
      </div></div>
    </div>`;

  bindActions(view, {
    export: async () => {
      try { downloadCsv(await api('POST', '/exports/audit-logs', {})); }
      catch (error) { toastError(error); }
    },
  });
}

// ── 每日任务 ──────────────────────────────────────────────────────────

function viewJobs() {
  const view = mount('jobs', '每日任务');
  view.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="page-title">每日任务</div>
          <div class="page-desc">宽限期届满、延期缩容生效、赠送额度清零、账期出账、试用到期、保留期清除。</div>
        </div>
        <div class="page-actions"><button class="btn btn-cta" data-act="run">执行任务</button></div>
      </div>
      <div class="card"><div class="card-body">
        <div class="notice info">
          生产环境由调度器触发。Spec 规定的时点为：试用到期检查每日 00:30、账期出账次月 1 日 02:00。
          手动执行需要 platform.account.manage 权限。
        </div>
      </div></div>
      <div id="job-result"></div>
    </div>`;

  bindActions(view, {
    run: async () => {
      const box = view.querySelector('#job-result');
      box.innerHTML = '<div class="loading">执行中</div>';
      try {
        const r = await api('POST', '/jobs/daily-run', {});
        const row = (label, value) =>
          `<div class="card stat"><div class="stat-label">${label}</div><div class="stat-value sm">${value}</div></div>`;
        box.innerHTML = `
          <div class="grid grid-4">
            ${row('席位授予单转过期', r.seatGrantsExpired)}
            ${row('延期缩容生效', r.deferredReductionsApplied)}
            ${row('赠送额度清零', usd(r.giftCreditExpired))}
            ${row('账期出账', r.periodsClosed)}
            ${row('试用提醒', r.trialsReminded)}
            ${row('试用到期收口', r.trialsExpired.length)}
            ${row('席位超限冻结', r.tenantsFrozenForSeatOverflow.length)}
            ${row('保留期清除', r.tenantsPurged.length)}
          </div>
          <div class="card" style="margin-top:var(--pc-space-5)"><div class="card-body">
            <div class="section-title">执行时刻</div>
            <div class="hint">${esc(r.at)}</div>
          </div></div>`;
        toast('每日任务已执行');
      } catch (error) {
        toastError(error);
        box.innerHTML = `<div class="card"><div class="empty">${esc(error.message)}</div></div>`;
      }
    },
  });
}

// ── 路由 ──────────────────────────────────────────────────────────────

function route() {
  const raw = currentPath();
  const [pathPart, queryPart] = raw.split('?');
  const parts = pathPart.split('/').filter(Boolean);
  const params = new URLSearchParams(queryPart ?? '');

  const page = parts[0] || 'dashboard';
  try {
    if (page === 'tenants' && parts[1]) {
      const view = mount('tenants', '租户详情');
      renderTenantDetail(view, parts[1], parts[2] || 'basic');
      return;
    }
    ({
      dashboard: viewDashboard,
      tenants: () => viewTenants(params),
      models: viewModels,
      trials: viewTrials,
      audit: viewAudit,
      jobs: viewJobs,
    }[page] ?? viewDashboard)();
  } catch (error) {
    toastError(error);
  }
}

for (const evt of ['hashchange', 'popstate', 'app:navigate']) {
  window.addEventListener(evt, route);
}
route();
