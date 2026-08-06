// 租户详情页与其上的全部操作项。对应 Spec 11.2 的五个 tab。

import {
  api, badge, BIZ_TYPE, BOOK, closeModal, confirmName, creditText, day, downloadCsv, dt,
  dual, esc, EXHAUST_POLICY, LEVEL, meter, MODEL_GROUPS, openForm, pct,
  QUOTA_GRANT_STATUS, reasonField, REDUCE_STRATEGY, RELEASE_REASON, SEAT_GRANT_STATUS,
  SEAT_SOURCE, statusBadge, SUSPEND_REASON, toast, toastError, usd, currentPath, go,
} from './core.js';

const TABS = [
  ['basic', '基本信息'],
  ['seat', '席位'],
  ['quota', '额度'],
  ['model', '模型'],
  ['audit', '审计'],
];

let cache = null;
let mountEl = null;

export async function renderTenantDetail(root, tenantId, tab = 'basic') {
  mountEl = root;
  root.innerHTML = '<div class="loading">加载中</div>';
  let detail;
  try {
    detail = await api('GET', `/tenants/${encodeURIComponent(tenantId)}`);
  } catch (error) {
    toastError(error);
    root.innerHTML = `<div class="page"><div class="card"><div class="empty">${esc(error.message)}</div></div></div>`;
    return;
  }
  cache = detail;
  const t = detail.tenant;

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="tenant-head">
            <span class="tenant-name">${esc(t.name)}</span>
            ${statusBadge(t)}
            ${t.level ? badge(LEVEL[t.level] ?? t.level) : ''}
          </div>
          <div class="page-desc">
            <span class="tenant-code">${esc(t.code)}</span>
            · 归属销售 ${esc(t.ownerSalesId ?? '未指定')}
            · 联系人 ${esc(t.contactName)}
            ${t.trialExpireAt ? `· 试用到期 ${day(t.trialExpireAt)}` : ''}
            ${t.contractEndAt ? `· 合同到期 ${day(t.contractEndAt)}` : ''}
          </div>
        </div>
        <div class="page-actions">${headerActions(t)}</div>
      </div>
      <div class="tabs">
        ${TABS.map(([k, label]) =>
          `<div class="tab ${k === tab ? 'active' : ''}" data-tab="${k}">${label}</div>`).join('')}
      </div>
      <div id="tab-body"></div>
    </div>`;

  root.querySelectorAll('[data-tab]').forEach((n) =>
    n.addEventListener('click', () => go(`tenants/${tenantId}/${n.dataset.tab}`)),
  );

  const body = root.querySelector('#tab-body');
  ({ basic: tabBasic, seat: tabSeat, quota: tabQuota, model: tabModel, audit: tabAudit }[tab] ?? tabBasic)(
    body,
    detail,
  );

  body.addEventListener('click', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node) return;
    const handler = ACTIONS[node.dataset.act];
    if (handler) handler(detail, node.dataset);
  });
  root.querySelector('.page-actions')?.addEventListener('click', (e) => {
    const node = e.target.closest('[data-act]');
    if (!node) return;
    const handler = ACTIONS[node.dataset.act];
    if (handler) handler(detail, node.dataset);
  });
}

function reload() {
  const [, id, tab] = currentPath().split('/');
  renderTenantDetail(mountEl ?? document.getElementById('root'), id, tab || 'basic');
}

// ── 顶部状态操作区 ────────────────────────────────────────────────────

function headerActions(t) {
  const b = (act, label, cls = 'btn') => `<button class="${cls}" data-act="${act}">${label}</button>`;
  const out = [];

  if (t.status === 'pending') out.push(b('trial.open', '开通试用', 'btn btn-cta'));
  if (t.status === 'trialing') {
    out.push(b('trial.convert', '转为正式', 'btn btn-cta'));
    out.push(b('trial.extend', '试用延期'));
    out.push(b('trial.terminate', '终止试用', 'btn btn-danger'));
  }
  if (t.status === 'suspended' && t.suspendReason === 'trial_expired') {
    out.push(b('trial.convert', '转为正式', 'btn btn-cta'));
  }
  if (t.status === 'active' || t.status === 'trialing') out.push(b('tenant.suspend', '停用租户'));
  if (t.status === 'suspended' && t.suspendReason !== 'trial_expired') {
    out.push(b('tenant.resume', '恢复租户', 'btn btn-cta'));
  }
  if (['pending', 'trialing', 'active', 'suspended'].includes(t.status)) {
    out.push(b('tenant.deregister', '发起注销', 'btn btn-danger'));
  }
  if (t.status === 'deregistering') {
    out.push(b('tenant.restore', '撤销注销', 'btn btn-cta'));
    out.push(b('tenant.purge', '立即清除', 'btn btn-danger'));
  }
  return out.join('');
}

// ── Tab 1：基本信息 ───────────────────────────────────────────────────

function tabBasic(root, d) {
  const t = d.tenant;
  const f = (label, value) =>
    `<div><div class="field-label">${label}</div><div class="field-value">${value ?? '—'}</div></div>`;

  root.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      <div class="card">
        <div class="card-head">
          <div class="card-title">租户资料</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-act="tenant.edit">编辑资料</button>
            <button class="btn btn-sm" data-act="tenant.setAdmin">变更管理员</button>
          </div>
        </div>
        <div class="card-body">
          <div class="fields">
            ${f('租户编码', `<span class="tenant-code">${esc(t.code)}</span>`)}
            ${f('企业全称', esc(t.name))}
            ${f('简称', esc(t.shortName ?? ''))}
            ${f('所属行业', esc(t.industry ?? ''))}
            ${f('客户等级', t.level ? LEVEL[t.level] : '')}
            ${f('归属销售', esc(t.ownerSalesId ?? ''))}
            ${f('联系人', `${esc(t.contactName)} · ${esc(t.contactEmail)}`)}
            ${f('联系电话', esc(t.contactPhone ?? ''))}
            ${f('邮箱域名', t.emailDomains.length ? esc(t.emailDomains.join('、')) : '')}
            ${f('合同编号', esc(t.contractNo ?? ''))}
            ${f('合同起止', t.contractStartAt || t.contractEndAt ? `${t.contractStartAt ? day(t.contractStartAt) : '未填'} ~ ${t.contractEndAt ? day(t.contractEndAt) : '未填'}` : '未填')}
            ${f('时区', esc(t.timezone))}
            ${f('注销保留期', `${t.retentionDays} 天`)}
            ${f('席位超卖', t.seatOversellPercent === null ? '硬限' : `软限 ${t.seatOversellPercent}%`)}
            ${f('席位宽限期', `${t.seatGraceDays} 天`)}
            ${f('缩容冲突策略', REDUCE_STRATEGY[t.seatReduceStrategy])}
            ${f('标签', t.tags.length ? t.tags.map((x) => badge(x)).join(' ') : '')}
            ${f('企业管理员', currentAdmin(d))}
          </div>
        </div>
      </div>

      <div class="grid grid-2">
        <div class="card">
          <div class="card-head">
            <div class="card-title">备注</div>
            <div class="card-note">追加式，历史条目不可编辑</div>
            <div class="card-actions"><button class="btn btn-sm" data-act="tenant.remark">添加备注</button></div>
          </div>
          <div class="card-body">
            ${t.remarks.length
              ? t.remarks.map((r) => `<div class="remark">${esc(r.text)}
                  <div class="remark-meta">${esc(r.operatorId)} · ${dt(r.at)}</div></div>`).join('')
              : '<div class="empty">暂无备注</div>'}
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">生命周期</div>
            <div class="card-note">共 ${d.lifecycle.length} 次状态流转</div></div>
          <div class="card-body">
            <div class="timeline">
              ${d.lifecycle.map((e) => `<div class="tl-item">
                <div class="tl-time">${dt(e.at)}</div>
                <div>
                  <div>${e.fromStatus ? `${esc(e.fromStatus)} → ` : ''}<strong>${esc(e.toStatus)}</strong></div>
                  <div class="tl-detail">${esc(e.detail ?? '')}${e.reason ? ` · ${esc(e.reason)}` : ''} · ${esc(e.operatorId)}</div>
                </div></div>`).join('')}
            </div>
          </div>
        </div>
      </div>
    </div>`;
}

function currentAdmin(d) {
  const admin = d.seat.assignments.find((a) => a.isAdmin);
  return admin ? `${esc(admin.memberName)} · ${esc(admin.memberEmail)}` : '未设置';
}

// ── Tab 2：席位 ───────────────────────────────────────────────────────

function tabSeat(root, d) {
  const o = d.seat.overview;
  const live = ['pending', 'trialing', 'active', 'suspended'].includes(d.tenant.status);
  const stat = (label, value, sub = '', cls = '') =>
    `<div class="card stat"><div class="stat-label">${label}</div>
     <div class="stat-value sm ${cls}">${value}</div>${sub ? `<div class="stat-sub">${sub}</div>` : ''}</div>`;

  root.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      <div class="grid grid-6">
        ${stat('席位总数', o.seatTotal)}
        ${stat('已占用', o.occupied)}
        ${stat('剩余可用', o.remaining, '', o.remaining < 0 ? 'danger' : '')}
        ${stat('占用率', pct(o.occupancyRate),
          live && o.oversold ? '超卖' : '', live && o.oversold ? 'danger' : o.occupancyRate >= 0.9 ? 'warn' : '')}
        ${stat('30 天内到期', o.expiringSoon, '', o.expiringSoon > 0 ? 'warn' : '')}
        ${stat('宽限期内', o.inGrace, '', o.inGrace > 0 ? 'warn' : '')}
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">席位授予单</div>
          <div class="card-note">扩容一律新建授予单，每批到期时间互相独立</div>
          <div class="card-actions"><button class="btn btn-sm btn-cta" data-act="seat.grant">分发席位</button></div>
        </div>
        <div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>授予单号</th><th class="num">席位数</th><th>来源</th><th>生效</th><th>到期</th>
            <th>状态</th><th>合同号</th><th>操作人</th><th></th>
          </tr></thead><tbody>
            ${d.seat.grants.length ? d.seat.grants.map(seatGrantRow).join('')
              : '<tr><td colspan="9"><div class="empty">暂无席位授予单</div></td></tr>'}
          </tbody></table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">占用明细</div>
          <div class="card-note">停用成员仍占席位，需删除或强制释放才回收</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-act="seat.export">导出明细</button>
          </div>
        </div>
        <div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>成员</th><th>邮箱</th><th>团队</th><th>角色</th><th>绑定时间</th>
            <th>最后活跃</th><th>状态</th><th></th>
          </tr></thead><tbody>
            ${d.seat.assignments.length ? d.seat.assignments.map(assignmentRow).join('')
              : '<tr><td colspan="8"><div class="empty">暂无占用</div></td></tr>'}
          </tbody></table>
        </div>
      </div>
    </div>`;
}

function seatGrantRow(g) {
  const s = SEAT_GRANT_STATUS[g.status];
  const pending = g.pendingReduceTo !== null
    ? badge(`待缩容至 ${g.pendingReduceTo}`, 'warn') : '';
  const canEdit = g.status === 'active';
  return `<tr>
    <td class="mono">${esc(g.no)}</td>
    <td class="num">${g.seatCount}</td>
    <td>${SEAT_SOURCE[g.source] ?? g.source}</td>
    <td>${day(g.effectiveAt)}</td>
    <td>${day(g.expireAt)}</td>
    <td>${badge(s.label, s.tone)} ${pending}</td>
    <td class="mono">${esc(g.contractNo ?? '')}</td>
    <td>${esc(g.operatorId)}</td>
    <td><div class="cell-actions">
      ${canEdit ? `<button class="btn-link" data-act="seat.reduce" data-id="${g.id}" data-count="${g.seatCount}" data-no="${esc(g.no)}">缩容</button>
      <button class="btn-link" data-act="seat.renew" data-id="${g.id}" data-no="${esc(g.no)}" data-expire="${g.expireAt ?? ''}">续期</button>
      <button class="btn-link danger" data-act="seat.revoke" data-id="${g.id}" data-no="${esc(g.no)}">回收</button>` : ''}
    </div></td></tr>`;
}

function assignmentRow(a) {
  const released = a.releasedAt !== null;
  return `<tr>
    <td>${esc(a.memberName)}</td>
    <td class="mono">${esc(a.memberEmail)}</td>
    <td>${esc(a.teamId ?? '—')}</td>
    <td>${a.isAdmin ? badge('企业管理员', 'info') : '成员'}</td>
    <td>${dt(a.boundAt)}</td>
    <td>${a.lastActiveAt ? dt(a.lastActiveAt) : badge('从未登录', 'warn')}</td>
    <td>${released ? badge(RELEASE_REASON[a.releaseReason] ?? '已释放', 'mute')
        : a.memberStatus === 'disabled' ? badge('已冻结', 'warn') : badge('占用中', 'ok')}</td>
    <td><div class="cell-actions">
      ${!released && !a.isAdmin
        ? `<button class="btn-link danger" data-act="seat.forceRelease" data-mid="${esc(a.memberId)}" data-name="${esc(a.memberName)}">强制释放</button>`
        : ''}
    </div></td></tr>`;
}

// ── Tab 3：额度 ───────────────────────────────────────────────────────

function tabQuota(root, d) {
  const b = d.quota.balance;
  const granted = d.quota.grants
    .filter((g) => g.status === 'active' || g.status === 'expired')
    .reduce((s, g) => s + g.amountCredit, 0);
  const consumed = d.quota.grants.reduce((s, g) => s + g.consumedCredit, 0);
  const t = d.tenant;

  const stat = (label, credit, cls = '') =>
    `<div class="card stat"><div class="stat-label">${label}</div>
     <div class="stat-value sm ${cls}">${usd(credit)}</div><div class="stat-sub">${creditText(credit)}</div></div>`;

  root.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      <div class="grid grid-6">
        ${stat('可用余额', b.availableCredit, b.availableCredit <= 0 ? 'danger' : '')}
        ${stat('购买额度', b.purchasedCredit)}
        ${stat('赠送额度', b.giftCredit)}
        ${stat('累计发放', granted)}
        ${stat('累计消耗', consumed)}
        <div class="card stat">
          <div class="stat-label">团队已分配</div>
          <div class="stat-value sm">${usd(d.quota.totalAllocated)}</div>
          <div class="stat-sub">不得超过可用余额</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">额度策略</div>
          <div class="card-note">
            耗尽策略 ${EXHAUST_POLICY[t.exhaustPolicy]}
            ${t.exhaustPolicy === 'overdraft' ? ` · 透支上限 ${usd(t.overdraftLimitCredit)}` : ''}
            · 预警 ${fmtThreshold(t.quotaWarnThresholds)}
            ${t.overdraftUsedCredit > 0 ? ` · 已透支 ${usd(t.overdraftUsedCredit)}` : ''}
          </div>
          <div class="card-actions"><button class="btn btn-sm" data-act="quota.config">调整策略</button></div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">额度授予单</div>
          <div class="card-note">购买额度不清零，赠送额度按月清零，两类分开记账</div>
          <div class="card-actions">
            <button class="btn btn-sm btn-cta" data-act="quota.grant">发放额度</button>
            <button class="btn btn-sm" data-act="quota.gift">赠送额度</button>
            <button class="btn btn-sm" data-act="quota.adjust">额度调账</button>
          </div>
        </div>
        <div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>充值单号</th><th>类型</th><th class="num">金额</th><th class="num">已消耗</th><th class="num">剩余</th>
            <th>到账时间</th><th>到期</th><th>状态</th><th></th>
          </tr></thead><tbody>
            ${d.quota.grants.length ? d.quota.grants.map(quotaGrantRow).join('')
              : '<tr><td colspan="9"><div class="empty">暂无授予单</div></td></tr>'}
          </tbody></table>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">额度流水</div>
          <div class="card-note">共 ${d.quota.ledger.length} 条</div>
          <div class="card-actions">
            <button class="btn btn-sm" data-act="quota.close">账期出账</button>
            <button class="btn btn-sm" data-act="quota.reconcile">对账</button>
            <button class="btn btn-sm" data-act="quota.export">导出流水</button>
          </div>
        </div>
        <div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>发生时间</th><th>账期</th><th>业务类型</th><th>账本</th>
            <th class="num">金额</th><th class="num">变动后余额</th><th>团队</th><th>模型</th><th>备注</th>
          </tr></thead><tbody>
            ${d.quota.ledger.length
              ? [...d.quota.ledger].reverse().slice(0, 60).map(ledgerRow).join('')
              : '<tr><td colspan="9"><div class="empty">暂无流水</div></td></tr>'}
          </tbody></table>
        </div>
      </div>
    </div>`;
}

function fmtThreshold(t) {
  const parts = [];
  if (t.notice !== null) parts.push(`提醒 ${pct(t.notice)}`);
  if (t.alert !== null) parts.push(`告警 ${pct(t.alert)}`);
  if (t.exhausted !== null) parts.push(`耗尽 ${pct(t.exhausted)}`);
  return parts.length ? parts.join(' / ') : '已全部关闭';
}

function quotaGrantRow(g) {
  const s = QUOTA_GRANT_STATUS[g.status];
  const remaining = g.amountCredit - g.consumedCredit - g.revokedCredit - g.expiredCredit;
  return `<tr>
    <td class="mono">${esc(g.no)}</td>
    <td>${BOOK[g.book]}</td>
    <td class="num">${dual(g.amountCredit)}</td>
    <td class="num">${usd(g.consumedCredit)}</td>
    <td class="num">${usd(remaining)}</td>
    <td>${dt(g.effectiveAt)}</td>
    <td>${day(g.expireAt)}</td>
    <td>${badge(s.label, s.tone)}</td>
    <td><div class="cell-actions">
      ${g.status === 'pending'
        ? `<button class="btn-link" data-act="quota.confirm" data-id="${g.id}" data-no="${esc(g.no)}">确认到账</button>` : ''}
      ${g.status === 'active' && remaining > 0
        ? `<button class="btn-link danger" data-act="quota.revoke" data-id="${g.id}" data-no="${esc(g.no)}" data-remaining="${remaining}">回收</button>` : ''}
    </div></td></tr>`;
}

function ledgerRow(e) {
  const sign = e.direction === 'in' ? '+' : '−';
  return `<tr>
    <td>${dt(e.occurredAt)}</td>
    <td class="mono">${esc(e.period)}</td>
    <td>${badge(BIZ_TYPE[e.bizType] ?? e.bizType, e.direction === 'in' ? 'ok' : '')}</td>
    <td>${BOOK[e.book]}</td>
    <td class="num">${sign}${usd(e.amountCredit).replace('$', '$')}</td>
    <td class="num">${usd(e.balanceAfterCredit)}</td>
    <td>${esc(e.teamId ?? '—')}</td>
    <td class="mono">${esc(e.modelCode ?? '—')}</td>
    <td class="wrap">${esc(e.remark ?? '')}${e.ticketNo ? ` <span class="mono">${esc(e.ticketNo)}</span>` : ''}</td>
  </tr>`;
}

// ── Tab 4：模型 ───────────────────────────────────────────────────────

function tabModel(root, d) {
  const m = d.model;
  root.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      <div class="grid grid-4">
        <div class="card stat"><div class="stat-label">已授权模型</div><div class="stat-value sm">${m.grants.length}</div></div>
        <div class="card stat"><div class="stat-label">默认模型</div>
          <div class="stat-value sm" style="font-size:var(--pc-text-md)">${esc(m.defaultModel ?? '未设置')}</div></div>
        <div class="card stat"><div class="stat-label">跟随分组</div>
          <div class="stat-value sm" style="font-size:var(--pc-text-md)">${m.followedGroups.length ? esc(m.followedGroups.join('、')) : '无'}</div></div>
        <div class="card stat"><div class="stat-label">自建渠道</div>
          <div class="stat-value sm" style="font-size:var(--pc-text-md)">${m.allowSelfHostedChannel ? '已开启' : '已关闭'}</div>
          <div class="stat-sub"><button class="btn-link" data-act="model.selfHosted" data-allowed="${m.allowSelfHostedChannel}">切换</button></div></div>
      </div>

      <div class="card">
        <div class="card-head">
          <div class="card-title">模型授权</div>
          <div class="card-note">平台授权是白名单上限，租户侧只能在白名单内配置路由</div>
          <div class="card-actions">
            <button class="btn btn-sm btn-cta" data-act="model.grant">授权模型</button>
            <button class="btn btn-sm" data-act="model.grantGroup">按分组授权</button>
            <button class="btn btn-sm" data-act="model.tenantLimits">租户级限速</button>
            ${m.followedGroups.length ? `<button class="btn btn-sm" data-act="model.revokeGroup">解除分组</button>` : ''}
          </div>
        </div>
        <div class="card-body flush table-wrap">
          <table><thead><tr>
            <th>模型</th><th>授权方式</th><th>默认</th><th class="num">TPM</th><th class="num">RPM</th>
            <th class="num">并发</th><th class="num">单模型额度上限</th><th class="num">本期已用</th><th>到期</th><th></th>
          </tr></thead><tbody>
            ${m.grants.length ? m.grants.map((g) => modelGrantRow(g, m)).join('')
              : '<tr><td colspan="10"><div class="empty">尚未授权任何模型</div></td></tr>'}
          </tbody></table>
        </div>
      </div>
    </div>`;
}

function modelGrantRow(g, m) {
  const followed = g.grantMode === 'group';
  return `<tr>
    <td class="mono">${esc(g.modelCode)}</td>
    <td>${followed ? badge(`跟随「${g.group}」`, 'info') : '单独授权'}</td>
    <td>${g.isDefault ? badge('默认', 'ok')
      : `<button class="btn-link" data-act="model.setDefault" data-code="${esc(g.modelCode)}">设为默认</button>`}</td>
    <td class="num">${g.tpm ?? '不限'}</td>
    <td class="num">${g.rpm ?? '不限'}</td>
    <td class="num">${g.concurrency ?? '不限'}</td>
    <td class="num">${g.modelQuotaCapCredit === null ? '不限' : usd(g.modelQuotaCapCredit)}</td>
    <td class="num">${usd(g.periodUsedCredit)}</td>
    <td>${day(g.expireAt)}</td>
    <td><div class="cell-actions">
      <button class="btn-link" data-act="model.limits" data-code="${esc(g.modelCode)}"
        data-tpm="${g.tpm ?? ''}" data-rpm="${g.rpm ?? ''}" data-cc="${g.concurrency ?? ''}"
        data-cap="${g.modelQuotaCapCredit ?? ''}">限额</button>
      ${followed ? '' : `<button class="btn-link danger" data-act="model.revoke" data-code="${esc(g.modelCode)}">撤销</button>`}
    </div></td></tr>`;
}

// ── Tab 5：审计 ───────────────────────────────────────────────────────

async function tabAudit(root, d) {
  root.innerHTML = '<div class="loading">加载中</div>';
  const logs = await api('GET', `/audit-logs?tenantId=${encodeURIComponent(d.tenant.id)}`);
  root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <div class="card-title">操作审计</div>
        <div class="card-note">共 ${logs.length} 条，与凭证类数据一同长期留存</div>
        <div class="card-actions"><button class="btn btn-sm" data-act="audit.export">导出日志</button></div>
      </div>
      <div class="card-body flush table-wrap">
        <table><thead><tr>
          <th>时间</th><th>操作人</th><th>角色</th><th>对象</th><th>操作</th><th>变更摘要</th><th>来源</th><th>理由</th>
        </tr></thead><tbody>
          ${logs.length ? logs.map((l) => `<tr>
            <td>${dt(l.at)}</td><td>${esc(l.actorId)}</td><td>${esc(l.actorRole)}</td>
            <td class="mono">${esc(l.objectType)}</td><td class="mono">${esc(l.action)}</td>
            <td class="wrap">${esc(l.summary)}</td>
            <td>${badge(l.source, l.source === 'system' ? 'mute' : '')}</td>
            <td>${esc(l.reason ?? '')}</td></tr>`).join('')
            : '<tr><td colspan="8"><div class="empty">暂无日志</div></td></tr>'}
        </tbody></table>
      </div>
    </div>`;
  root.querySelector('[data-act="audit.export"]')?.addEventListener('click', () => ACTIONS['audit.export'](d));
}

// ── 操作 ──────────────────────────────────────────────────────────────

const ACTIONS = {
  // 租户
  'tenant.edit': (d) => {
    const t = d.tenant;
    openForm({
      title: '编辑租户资料',
      desc: '逐字段变更会写入审计日志。租户编码不可修改。',
      wide: true,
      fields: [
        { name: 'name', label: '企业全称', type: 'text', value: t.name, required: true },
        { name: 'shortName', label: '简称', type: 'text', value: t.shortName ?? '' },
        { name: 'industry', label: '所属行业', type: 'text', value: t.industry ?? '' },
        { name: 'level', label: '客户等级', type: 'select', value: t.level ?? '',
          options: [{ value: '', label: '未分级' }, ...Object.entries(LEVEL).map(([v, l]) => ({ value: v, label: l }))] },
        { name: 'ownerSalesId', label: '归属销售', type: 'text', value: t.ownerSalesId ?? '' },
        { name: 'contactName', label: '联系人', type: 'text', value: t.contactName, required: true },
        { name: 'contactEmail', label: '联系邮箱', type: 'text', value: t.contactEmail, required: true },
        { name: 'contactPhone', label: '联系电话', type: 'text', value: t.contactPhone ?? '' },
        { name: 'contractNo', label: '合同编号', type: 'text', value: t.contractNo ?? '' },
        { name: 'contractEndAt', label: '合同到期', type: 'date', value: t.contractEndAt?.slice(0, 10) ?? '' },
        { name: 'seatGraceDays', label: '席位宽限期（天）', type: 'number', min: 0, value: t.seatGraceDays },
        { name: 'seatReduceStrategy', label: '缩容冲突策略', type: 'select', value: t.seatReduceStrategy,
          options: Object.entries(REDUCE_STRATEGY).map(([v, l]) => ({ value: v, label: l })) },
      ],
      submitLabel: '保存',
      onSubmit: async (v) => {
        const body = { ...v };
        if (!body.level) delete body.level;
        if (body.contractEndAt) body.contractEndAt = new Date(body.contractEndAt).toISOString();
        else delete body.contractEndAt;
        await api('PATCH', `/tenants/${d.tenant.id}`, body);
        toast('资料已更新');
        reload();
      },
    });
  },

  'tenant.setAdmin': (d) => {
    openForm({
      title: '变更企业管理员',
      desc: '原管理员降级为普通成员，<strong>不自动释放其席位</strong>。新管理员若尚未占位会占用一个席位。',
      fields: [
        { name: 'memberId', label: '成员标识', type: 'text', required: true, placeholder: 'm_xxx' },
        { name: 'name', label: '姓名', type: 'text', required: true },
        { name: 'email', label: '邮箱', type: 'text', required: true },
      ],
      submitLabel: '确认变更',
      onSubmit: async (v) => {
        await api('PUT', `/tenants/${d.tenant.id}/admin`, v);
        toast('管理员已变更');
        reload();
      },
    });
  },

  'tenant.remark': (d) => {
    openForm({
      title: '添加备注',
      fields: [{ name: 'text', label: '备注内容', type: 'textarea', required: true }],
      submitLabel: '添加',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/remarks`, { text: v.text });
        toast('备注已添加');
        reload();
      },
    });
  },

  'tenant.suspend': (d) => {
    openForm({
      title: '停用租户',
      desc: '停用后成员仍可登录，但所有模型调用会被拒绝，租户侧管理中心转为只读。',
      danger: true,
      fields: [
        { name: 'reasonCode', label: '停用原因', type: 'select', value: 'manual',
          options: [{ value: 'manual', label: '人工冻结' }, { value: 'violation', label: '违规' }] },
        reasonField('停用理由'),
      ],
      submitLabel: '确认停用',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/suspend`, v);
        toast('租户已停用');
        reload();
      },
    });
  },

  'tenant.resume': async (d) => {
    try {
      await api('POST', `/tenants/${d.tenant.id}/resume`, {});
      toast('租户已恢复');
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'tenant.deregister': (d) => {
    const t = d.tenant;
    openForm({
      title: '发起注销',
      desc: `进入 ${t.retentionDays} 天保留期：成员会话立即失效、席位授予单回收、额度冻结、模型授权撤销。保留期内可撤销。`,
      danger: true,
      fields: [
        { name: 'impact', label: '影响范围', type: 'static',
          value: `<div class="notice danger">
            成员 ${d.seat.assignments.filter((a) => !a.releasedAt).length} 人 ·
            占用席位 ${d.seat.overview.occupied} 个 ·
            未消耗购买额度 ${usd(d.quota.balance.purchasedCredit)} ·
            未消耗赠送额度 ${usd(d.quota.balance.giftCredit)} ·
            已授权模型 ${d.model.grants.length} 个
          </div>` },
        confirmName(t.name),
        reasonField('注销理由'),
      ],
      submitLabel: '确认注销',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${t.id}/deregister`, { confirmName: v.confirmName, reason: v.reason });
        toast('已进入注销保留期');
        reload();
      },
    });
  },

  'tenant.restore': async (d) => {
    try {
      await api('POST', `/tenants/${d.tenant.id}/restore`, {});
      toast('已撤销注销，资源按快照还原');
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'tenant.purge': (d) => {
    const t = d.tenant;
    openForm({
      title: '立即清除租户数据',
      desc: '不可恢复。业务数据将被清除，授予单、流水、账单与审计日志作为凭证保留。',
      danger: true,
      fields: [
        { name: 'warn', label: '', type: 'static',
          value: '<div class="notice danger">清除后租户进入终态，无法再恢复。同一企业需要重新合作时只能新建租户。</div>' },
        confirmName(t.name),
        reasonField('清除理由'),
      ],
      submitLabel: '确认清除',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${t.id}/purge`, { confirmName: v.confirmName, reason: v.reason });
        toast('租户数据已清除');
        reload();
      },
    });
  },

  // 试用
  'trial.open': async (d) => {
    const plans = await api('GET', '/trial-plans');
    if (!plans.length) return toast('没有可用的试用套餐', 'err');
    openForm({
      title: '开通试用',
      desc: '按套餐一次性下发席位、赠送额度与模型授权，到期时间三者一致。',
      fields: [
        { name: 'planId', label: '试用套餐', type: 'select', required: true, value: plans[0].id,
          options: plans.map((p) => ({ value: p.id, label: `${p.name} · ${p.seatCount} 席位 / ${usd(p.giftCredit)} / ${p.durationDays} 天` })) },
      ],
      submitLabel: '确认开通',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/trial/open`, v);
        toast('试用已开通');
        reload();
      },
    });
  },

  'trial.extend': (d) => {
    openForm({
      title: '试用延期',
      desc: '席位、额度、模型授权的到期时间同步顺延。单个租户试用总时长不得超过 90 天。',
      fields: [
        { name: 'days', label: '延长天数', type: 'number', min: 1, value: 7, required: true,
          help: `当前累计试用 ${d.tenant.trialTotalDays} 天。` },
        { name: 'extraGiftCredit', label: '补发赠送额度（美元）', type: 'usd', min: 0,
          help: '留空表示不补发。补发的额度到期时间跟随新的试用到期日。' },
        reasonField('延期理由'),
      ],
      submitLabel: '确认延期',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/trial/extend`, {
          days: v.days, reason: v.reason,
          extraGiftCredit: v.extraGiftCredit || undefined,
        });
        toast('试用已延期');
        reload();
      },
    });
  },

  'trial.convert': (d) => {
    openForm({
      title: '试用转正式',
      desc: '试用席位保留至原到期时间并与正式席位叠加，转换瞬间不掉席位。',
      wide: true,
      fields: [
        { name: 'warn', label: '', type: 'static',
          value: `<div class="notice warn">当前试用剩余赠送额度 <strong>${usd(d.quota.balance.giftCredit)}</strong>，转正式后立即作废，不结转。</div>` },
        { name: 'seatCount', label: '正式席位数', type: 'number', min: 1, value: 50, required: true },
        { name: 'purchasedCredit', label: '正式购买额度（美元）', type: 'usd', min: 0, value: 5000, required: true },
        { name: 'contractNo', label: '合同编号', type: 'text' },
        { name: 'contractEndAt', label: '合同到期', type: 'date' },
      ],
      submitLabel: '确认转正式',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/trial/convert`, {
          seatCount: v.seatCount,
          purchasedCredit: v.purchasedCredit,
          contractNo: v.contractNo || null,
          contractEndAt: v.contractEndAt ? new Date(v.contractEndAt).toISOString() : null,
        });
        toast('已转为正式租户');
        reload();
      },
    });
  },

  'trial.terminate': (d) => {
    openForm({
      title: '提前终止试用',
      desc: '立即回收席位、作废赠送额度、撤销模型授权，租户转为停用。',
      danger: true,
      fields: [reasonField('终止理由')],
      submitLabel: '确认终止',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/trial/terminate`, v);
        toast('试用已终止');
        reload();
      },
    });
  },

  // 席位
  'seat.grant': (d) => {
    openForm({
      title: '分发席位',
      desc: '扩容一律新建授予单，不修改已有单，这样每批席位的到期时间互相独立。',
      fields: [
        { name: 'seatCount', label: '席位数量', type: 'number', min: 1, value: 10, required: true },
        { name: 'source', label: '来源', type: 'select', value: 'contract',
          options: Object.entries(SEAT_SOURCE).map(([v, l]) => ({ value: v, label: l })) },
        { name: 'expireAt', label: '到期时间', type: 'date',
          help: '留空表示永久有效，仅「合同采购」来源允许永久。' },
        { name: 'contractNo', label: '关联合同号', type: 'text' },
        { name: 'remark', label: '备注', type: 'text' },
      ],
      submitLabel: '确认分发',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/seat-grants`, {
          seatCount: v.seatCount,
          source: v.source,
          expireAt: v.expireAt ? new Date(v.expireAt).toISOString() : null,
          contractNo: v.contractNo || null,
          remark: v.remark || null,
        }, { idempotencyKey: `seat-${d.tenant.id}-${Date.now()}` });
        toast('席位已分发');
        reload();
      },
    });
  },

  'seat.reduce': (d, ds) => {
    openForm({
      title: `缩容席位 ${ds.no}`,
      desc: '目标数低于当前占用时按所选策略处理。默认拒绝并返回需要先释放的数量。',
      danger: true,
      fields: [
        { name: 'targetCount', label: '缩容目标', type: 'number', min: 0, value: Math.max(0, Number(ds.count) - 1), required: true,
          help: `当前 ${ds.count} 个席位，租户已占用 ${d.seat.overview.occupied} 个。` },
        { name: 'strategy', label: '冲突策略', type: 'select', value: d.tenant.seatReduceStrategy,
          options: Object.entries(REDUCE_STRATEGY).map(([v, l]) => ({ value: v, label: l })) },
        { name: 'forceWarn', label: '', type: 'static',
          when: (v) => v.strategy === 'force',
          value: '<div class="notice danger">强制回收会按「从未登录 → 最早活跃 → 最晚创建」顺序自动解绑成员席位。企业管理员永不被回收。</div>' },
        reasonField('缩容理由'),
      ],
      submitLabel: '确认缩容',
      onSubmit: async (v) => {
        await api('POST', `/seat-grants/${ds.id}/reduce`, v);
        toast('席位已缩容');
        reload();
      },
    });
  },

  'seat.revoke': (d, ds) => {
    openForm({
      title: `回收授予单 ${ds.no}`,
      desc: '等价于缩容到 0。若仍有占用，按所选策略处理。',
      danger: true,
      fields: [
        { name: 'strategy', label: '冲突策略', type: 'select', value: 'reject',
          options: Object.entries(REDUCE_STRATEGY).map(([v, l]) => ({ value: v, label: l })) },
        reasonField('回收理由'),
      ],
      submitLabel: '确认回收',
      onSubmit: async (v) => {
        await api('POST', `/seat-grants/${ds.id}/revoke`, v);
        toast('授予单已回收');
        reload();
      },
    });
  },

  'seat.renew': (d, ds) => {
    openForm({
      title: `续期授予单 ${ds.no}`,
      desc: '只能往后延。提前到期请使用缩容或回收。',
      fields: [
        { name: 'expireAt', label: '新的到期时间', type: 'date', value: ds.expire ? ds.expire.slice(0, 10) : '',
          help: '留空表示永久有效，仅「合同采购」来源允许。' },
      ],
      submitLabel: '确认续期',
      onSubmit: async (v) => {
        await api('POST', `/seat-grants/${ds.id}/renew`, {
          expireAt: v.expireAt ? new Date(v.expireAt).toISOString() : null,
        });
        toast('授予单已续期');
        reload();
      },
    });
  },

  'seat.forceRelease': (d, ds) => {
    openForm({
      title: '强制释放席位',
      desc: `将解绑成员 <strong>${esc(ds.name)}</strong> 的席位，该成员会立即失去访问权，需由租户侧重新分配。`,
      danger: true,
      fields: [reasonField('释放理由')],
      submitLabel: '确认释放',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/seat-assignments/${encodeURIComponent(ds.mid)}/force-release`, v);
        toast('席位已释放');
        reload();
      },
    });
  },

  'seat.export': async (d) => {
    try {
      downloadCsv(await api('POST', '/exports/seat-assignments', { tenantId: d.tenant.id }));
    } catch (error) {
      toastError(error);
    }
  },

  // 额度
  'quota.grant': (d) => openQuotaGrant(d, 'purchased'),
  'quota.gift': (d) => openQuotaGrant(d, 'gift'),

  'quota.confirm': async (d, ds) => {
    try {
      await api('POST', `/quota-grants/${ds.id}/confirm`, {});
      toast(`${ds.no} 已确认到账`);
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'quota.revoke': (d, ds) => {
    openForm({
      title: `回收额度 ${ds.no}`,
      desc: '只能回收未消耗的部分。回收不修改原授予单金额，只生成一条反向流水。',
      danger: true,
      fields: [
        { name: 'amountCredit', label: '回收金额（美元）', type: 'usd', min: 0.01, required: true,
          value: (Number(ds.remaining) / 100).toFixed(2),
          help: `该授予单当前未消耗余额 ${usd(ds.remaining)}。` },
        reasonField('回收理由'),
      ],
      submitLabel: '确认回收',
      onSubmit: async (v) => {
        await api('POST', `/quota-grants/${ds.id}/revoke`, v);
        toast('额度已回收');
        reload();
      },
    });
  },

  'quota.adjust': (d) => {
    openForm({
      title: '额度调账',
      desc: '兜底手段，用于修正系统故障导致的错账。调账流水在账单中单列，不混入充值与消耗。',
      danger: true,
      fields: [
        { name: 'direction', label: '调账方向', type: 'select', value: 'in',
          options: [{ value: 'in', label: '调增' }, { value: 'out', label: '调减' }] },
        { name: 'book', label: '账本', type: 'select', value: 'purchased',
          options: Object.entries(BOOK).map(([v, l]) => ({ value: v, label: l })) },
        { name: 'amountCredit', label: '金额（美元）', type: 'usd', min: 0.01, required: true },
        { name: 'ticketNo', label: '工单号 / 事故编号', type: 'text', required: true, placeholder: 'INC-2026-031' },
        reasonField('调账理由'),
      ],
      submitLabel: '确认调账',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/quota-adjustments`, v);
        toast('调账已入账');
        reload();
      },
    });
  },

  'quota.config': (d) => {
    const t = d.tenant;
    openForm({
      title: '额度策略',
      desc: '预警阈值按可用余额占累计发放的比例判定，每档在同一账期内只触发一次。',
      fields: [
        { name: 'notice', label: '提醒阈值（%）', type: 'number', min: 0, value: t.quotaWarnThresholds.notice === null ? '' : t.quotaWarnThresholds.notice * 100, help: '留空表示关闭该档。' },
        { name: 'alert', label: '告警阈值（%）', type: 'number', min: 0, value: t.quotaWarnThresholds.alert === null ? '' : t.quotaWarnThresholds.alert * 100 },
        { name: 'exhausted', label: '耗尽阈值（%）', type: 'number', min: 0, value: t.quotaWarnThresholds.exhausted === null ? '' : t.quotaWarnThresholds.exhausted * 100 },
        { name: 'exhaustPolicy', label: '耗尽策略', type: 'select', value: t.exhaustPolicy,
          options: Object.entries(EXHAUST_POLICY).map(([v, l]) => ({ value: v, label: l })) },
        { name: 'overdraftLimitCredit', label: '透支上限（美元）', type: 'usd', min: 0,
          value: (t.overdraftLimitCredit / 100).toFixed(2),
          when: (v) => v.exhaustPolicy === 'overdraft',
          help: '仅「允许透支」策略可设置。' },
      ],
      submitLabel: '保存策略',
      onSubmit: async (v) => {
        await api('PATCH', `/tenants/${d.tenant.id}/quota-config`, {
          quotaWarnThresholds: {
            notice: v.notice === null ? null : v.notice / 100,
            alert: v.alert === null ? null : v.alert / 100,
            exhausted: v.exhausted === null ? null : v.exhausted / 100,
          },
          exhaustPolicy: v.exhaustPolicy,
          overdraftLimitCredit: v.exhaustPolicy === 'overdraft' ? (v.overdraftLimitCredit ?? 0) : 0,
        });
        toast('额度策略已更新');
        reload();
      },
    });
  },

  'quota.close': (d) => {
    const now = new Date();
    const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const period = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
    openForm({
      title: '账期出账',
      desc: '出账后该账期数据冻结，后续调账只能计入当前账期。闭合公式：期初 + 充值 − 消耗 − 过期 + 调账 − 回收 = 期末。',
      fields: [{ name: 'period', label: '账期', type: 'text', value: period, required: true, placeholder: 'YYYY-MM' }],
      submitLabel: '确认出账',
      onSubmit: async (v) => {
        const bp = await api('POST', `/tenants/${d.tenant.id}/billing-periods/${v.period}/close`, {});
        toast(`账期 ${bp.period} 已出账，期末 ${usd(bp.closingCredit)}`);
        reload();
      },
    });
  },

  'quota.reconcile': (d) => {
    const now = new Date();
    const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    openForm({
      title: '对账',
      desc: '核对平台侧授予单、账本流水与期末余额三组数是否一致。',
      fields: [{ name: 'period', label: '账期', type: 'text', value: period, required: true }],
      submitLabel: '开始对账',
      onSubmit: async (v) => {
        const r = await api('GET', `/tenants/${d.tenant.id}/reconciliation/${v.period}`);
        closeModal();
        openForm({
          title: `对账结果 ${r.period}`,
          desc: r.ok ? '<span style="color:var(--pc-teal-600)">三组数一致</span>' : '<span style="color:var(--pc-danger-fg)">存在差异，需人工核查</span>',
          fields: [{ name: 'result', label: '', type: 'static', value: `
            <table><thead><tr><th>核对项</th><th class="num">平台侧</th><th class="num">账本侧</th><th class="num">差异</th><th></th></tr></thead>
            <tbody>${r.checks.map((c) => `<tr><td>${esc(c.name)}</td>
              <td class="num">${c.platform.toLocaleString()}</td>
              <td class="num">${c.ledger.toLocaleString()}</td>
              <td class="num">${c.diff.toLocaleString()}</td>
              <td>${badge(c.ok ? '一致' : '差异', c.ok ? 'ok' : 'danger')}</td></tr>`).join('')}</tbody></table>` }],
          submitLabel: '知道了',
          onSubmit: async () => {},
        });
      },
    });
  },

  'quota.export': async (d) => {
    try {
      downloadCsv(await api('POST', '/exports/quota-ledger', { tenantId: d.tenant.id }));
    } catch (error) {
      toastError(error);
    }
  },

  // 模型
  'model.grant': async (d) => {
    const catalog = await api('GET', '/model-catalog?status=published');
    const granted = new Set(d.model.grants.map((g) => g.modelCode));
    const available = catalog.filter((m) => !granted.has(m.code));
    if (!available.length) return toast('已上架模型均已授权');
    openForm({
      title: '授权模型',
      desc: '平台授权是白名单上限。租户侧只能在白名单内启用与排序，不能放宽。',
      fields: [
        { name: 'modelCode', label: '模型', type: 'select', required: true, value: available[0].code,
          options: available.map((m) => ({ value: m.code, label: `${m.displayName}（${m.code}）· ${m.group}` })) },
        { name: 'tpm', label: 'TPM 上限', type: 'number', min: 1, help: '留空表示不限制。与租户级配置取最严。' },
        { name: 'rpm', label: 'RPM 上限', type: 'number', min: 1 },
        { name: 'concurrency', label: '并发上限', type: 'number', min: 1 },
        { name: 'modelQuotaCapCredit', label: '单模型额度上限（美元）', type: 'usd', min: 0,
          help: '该模型在当前账期内最多消耗多少额度，账期切换后清零。' },
      ],
      submitLabel: '确认授权',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/model-grants`, v);
        toast('模型已授权');
        reload();
      },
    });
  },

  'model.grantGroup': (d) => {
    openForm({
      title: '按分组授权',
      desc: '跟随分组后，该分组内新上架的模型会自动授权，单个模型不可单独取消。',
      fields: [
        { name: 'group', label: '模型分组', type: 'select', required: true, value: MODEL_GROUPS[0],
          options: MODEL_GROUPS.map((g) => ({ value: g, label: g })) },
      ],
      submitLabel: '确认授权',
      onSubmit: async (v) => {
        await api('POST', `/tenants/${d.tenant.id}/model-grants`, v);
        toast('分组已授权');
        reload();
      },
    });
  },

  'model.revokeGroup': (d) => {
    openForm({
      title: '解除分组授权',
      desc: '解除后该分组内的模型授权一并撤销。若撤销后没有任何可用模型，操作会被拒绝。',
      danger: true,
      fields: [
        { name: 'group', label: '已跟随的分组', type: 'select', required: true, value: d.model.followedGroups[0],
          options: d.model.followedGroups.map((g) => ({ value: g, label: g })) },
      ],
      submitLabel: '确认解除',
      onSubmit: async (v) => {
        await api('DELETE', `/tenants/${d.tenant.id}/model-groups/${encodeURIComponent(v.group)}`);
        toast('分组授权已解除');
        reload();
      },
    });
  },

  'model.revoke': async (d, ds) => {
    try {
      await api('DELETE', `/tenants/${d.tenant.id}/model-grants/${encodeURIComponent(ds.code)}`);
      toast('模型授权已撤销');
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'model.setDefault': async (d, ds) => {
    try {
      await api('POST', `/tenants/${d.tenant.id}/model-grants/${encodeURIComponent(ds.code)}/default`, {});
      toast('默认模型已切换');
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'model.limits': (d, ds) => {
    openForm({
      title: `调整 ${ds.code} 的限额`,
      desc: '与租户级限制取最严。留空表示该项不限制。',
      fields: [
        { name: 'tpm', label: 'TPM 上限', type: 'number', min: 1, value: ds.tpm },
        { name: 'rpm', label: 'RPM 上限', type: 'number', min: 1, value: ds.rpm },
        { name: 'concurrency', label: '并发上限', type: 'number', min: 1, value: ds.cc },
        { name: 'modelQuotaCapCredit', label: '单模型额度上限（美元）', type: 'usd', min: 0,
          value: ds.cap ? (Number(ds.cap) / 100).toFixed(2) : '' },
      ],
      submitLabel: '保存',
      onSubmit: async (v) => {
        await api('PATCH', `/tenants/${d.tenant.id}/model-grants/${encodeURIComponent(ds.code)}`, v);
        toast('限额已更新');
        reload();
      },
    });
  },

  'model.tenantLimits': (d) => {
    const l = d.tenant.modelLimits;
    openForm({
      title: '租户级限速',
      desc: '作用于该租户的全部模型，与单模型配置取最严。',
      fields: [
        { name: 'tpm', label: 'TPM 上限', type: 'number', min: 1, value: l.tpm ?? '' },
        { name: 'rpm', label: 'RPM 上限', type: 'number', min: 1, value: l.rpm ?? '' },
        { name: 'concurrency', label: '并发上限', type: 'number', min: 1, value: l.concurrency ?? '' },
      ],
      submitLabel: '保存',
      onSubmit: async (v) => {
        await api('PATCH', `/tenants/${d.tenant.id}/model-limits`, v);
        toast('租户级限速已更新');
        reload();
      },
    });
  },

  'model.selfHosted': async (d, ds) => {
    try {
      const next = ds.allowed !== 'true';
      await api('PUT', `/tenants/${d.tenant.id}/self-hosted-channel`, { allowed: next });
      toast(next ? '已开启自建渠道' : '已关闭自建渠道');
      reload();
    } catch (error) {
      toastError(error);
    }
  },

  'audit.export': async (d) => {
    try {
      downloadCsv(await api('POST', '/exports/audit-logs', { tenantId: d.tenant.id }));
    } catch (error) {
      toastError(error);
    }
  },
};

function openQuotaGrant(d, book) {
  openForm({
    title: book === 'gift' ? '赠送额度' : '发放购买额度',
    desc: book === 'gift'
      ? '赠送额度按月清零，到期时间会被强制设为当月月末。'
      : '购买额度不清零。1 credit = $0.01，金额需为两位小数。',
    fields: [
      { name: 'amountCredit', label: '金额（美元）', type: 'usd', min: 0.01, required: true, value: book === 'gift' ? 100 : 5000 },
      { name: 'source', label: '来源', type: 'select', value: book === 'gift' ? 'gift' : 'contract',
        options: [
          { value: 'contract', label: '合同采购' },
          { value: 'gift', label: '赠送' },
          { value: 'compensation', label: '补偿' },
        ] },
      { name: 'contractNo', label: '关联合同号', type: 'text' },
      { name: 'pending', label: '标记为待确认（合同已签、款未到）', type: 'checkbox',
        help: '待确认的授予单不计入余额，确认到账后才可用。' },
      { name: 'reason', label: '备注', type: 'text' },
    ],
    submitLabel: '确认发放',
    onSubmit: async (v) => {
      await api('POST', `/tenants/${d.tenant.id}/quota-grants`, {
        book,
        amountCredit: v.amountCredit,
        source: v.source,
        contractNo: v.contractNo || null,
        pending: v.pending,
        reason: v.reason || null,
      }, { idempotencyKey: `quota-${d.tenant.id}-${Date.now()}` });
      toast('额度已发放');
      reload();
    },
  });
}

export { cache };
