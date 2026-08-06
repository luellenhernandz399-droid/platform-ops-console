// 控制台基础设施：API 客户端、字典、格式化、提示条、弹层表单。

// ── 身份 ──────────────────────────────────────────────────────────────

export const ROLES = {
  super_admin: '平台超级管理员',
  operator: '平台运营',
  sales: '平台商务',
  auditor: '平台只读审计',
};

const STORE_KEY = 'platform-console-actor';

export const actor = loadActor();

function loadActor() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* 忽略损坏的本地存储 */
  }
  return { id: 'u_super', role: 'super_admin' };
}

export function setRole(role) {
  actor.role = role;
  actor.id = { super_admin: 'u_super', operator: 'u_ops', sales: 'u_sales', auditor: 'u_audit' }[role];
  localStorage.setItem(STORE_KEY, JSON.stringify(actor));
}

// ── API ───────────────────────────────────────────────────────────────

export class ApiError extends Error {
  constructor(status, payload) {
    super(payload?.message || `请求失败（${status}）`);
    this.status = status;
    this.code = payload?.code || 'UNKNOWN';
    this.details = payload?.details || null;
  }
}

export async function api(method, path, body, opts = {}) {
  const headers = {
    'x-actor-id': actor.id,
    'x-actor-role': actor.role,
  };
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (opts.idempotencyKey) headers['idempotency-key'] = opts.idempotencyKey;

  const res = await fetch(`/platform/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  const payload = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, payload);
  return payload;
}

// ── 导航 ──────────────────────────────────────────────────────────────
// 同时支持 /tenants/xxx 真实路径与 #/tenants/xxx 哈希，
// 服务端已把未命中路径回落到 index.html，因此深链与刷新都可用。

export function currentPath() {
  const h = location.hash.replace(/^#\/?/, '');
  if (h) return h;
  return location.pathname.replace(/^\/+/, '');
}

export function go(path) {
  const clean = String(path).replace(/^#?\/?/, '');
  history.pushState({}, '', '/' + clean);
  window.dispatchEvent(new Event('app:navigate'));
}

// ── 字典 ──────────────────────────────────────────────────────────────

export const STATUS = {
  pending: { label: '待开通', tone: 'mute' },
  trialing: { label: '试用中', tone: 'info' },
  active: { label: '正式', tone: 'ok' },
  suspended: { label: '已停用', tone: 'danger' },
  deregistering: { label: '注销中', tone: 'warn' },
  deregistered: { label: '已注销', tone: 'mute' },
};

export const SUSPEND_REASON = {
  trial_expired: '试用到期',
  arrears: '额度耗尽',
  manual: '人工冻结',
  violation: '违规',
};

export const LEVEL = { strategic: '战略', key: '重点', normal: '普通', longtail: '长尾' };

export const SEAT_SOURCE = {
  contract: '合同采购',
  trial: '试用',
  gift: '赠送',
  compensation: '补偿',
};

export const SEAT_GRANT_STATUS = {
  active: { label: '生效中', tone: 'ok' },
  expired: { label: '已过期', tone: 'mute' },
  revoked: { label: '已回收', tone: 'mute' },
};

export const QUOTA_GRANT_STATUS = {
  pending: { label: '待确认', tone: 'warn' },
  active: { label: '已到账', tone: 'ok' },
  expired: { label: '已过期', tone: 'mute' },
  revoked: { label: '已回收', tone: 'mute' },
};

export const BOOK = { purchased: '购买额度', gift: '赠送额度' };

export const BIZ_TYPE = {
  grant: '发放',
  gift: '赠送',
  consume: '消耗',
  revoke: '回收',
  adjustment: '调账',
  expire: '过期',
};

export const MODEL_STATUS = {
  draft: { label: '草稿', tone: 'mute' },
  published: { label: '已上架', tone: 'ok' },
  deprecated: { label: '已弃用', tone: 'warn' },
  offline: { label: '已下线', tone: 'danger' },
};

export const VENDOR = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  azure: 'Azure',
  deepseek: 'DeepSeek',
  google: 'Google',
  self_hosted: '自建',
};

export const RELEASE_REASON = {
  member_deleted: '成员删除',
  member_resigned: '离职同步',
  force_released: '平台强制释放',
  tenant_purged: '租户清除',
  trial_revoked: '试用回收',
};

export const EXHAUST_POLICY = {
  hard_stop: '硬停（余额耗尽即停服）',
  overdraft: '允许透支',
  degrade: '降级到基础模型集',
};

export const REDUCE_STRATEGY = {
  reject: '拒绝（返回冲突明细）',
  defer: '延期生效（到期再评估）',
  force: '强制回收（需超管）',
};

export const MODEL_GROUPS = ['基础模型集', '高级模型集', '实验模型集'];

// ── 格式化 ────────────────────────────────────────────────────────────

export function esc(v) {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** credit 整数转美元展示串，1 credit = $0.01 */
export function usd(credit) {
  const n = Number(credit ?? 0);
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  return `${sign}$${Math.floor(abs / 100).toLocaleString('en-US')}.${String(abs % 100).padStart(2, '0')}`;
}

export function creditText(credit) {
  return `${Number(credit ?? 0).toLocaleString('en-US')} credit`;
}

/** 主行美元 + 副行 credit 真值，与租户侧管理中心一致 */
export function dual(credit) {
  return `<div class="dual-main">${usd(credit)}</div><div class="dual-sub">${creditText(credit)}</div>`;
}

export function dt(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function day(iso) {
  if (!iso) return '永久';
  return new Date(iso).toISOString().slice(0, 10);
}

export function pct(v) {
  return `${Math.round((Number(v) || 0) * 1000) / 10}%`;
}

export function badge(label, tone = '') {
  return `<span class="badge ${tone}">${esc(label)}</span>`;
}

export function statusBadge(row) {
  const s = STATUS[row.status] ?? { label: row.status, tone: '' };
  const reason = row.suspendReason ? `·${SUSPEND_REASON[row.suspendReason] ?? row.suspendReason}` : '';
  return badge(s.label + reason, s.tone);
}

export function meter(rate, oversold) {
  const tone = oversold ? 'danger' : rate >= 0.9 ? 'warn' : '';
  const w = Math.min(100, Math.round((Number(rate) || 0) * 100));
  return `<div class="meter ${tone}"><i style="width:${w}%"></i></div>`;
}

export function daysUntil(iso) {
  if (!iso) return null;
  return Math.ceil((new Date(iso).getTime() - Date.now()) / 86400000);
}

// ── 提示条 ────────────────────────────────────────────────────────────

export function toast(message, kind = '') {
  const root = document.getElementById('toasts');
  const node = document.createElement('div');
  node.className = `toast ${kind}`;
  node.innerHTML = message;
  root.appendChild(node);
  setTimeout(() => node.remove(), kind === 'err' ? 7000 : 3600);
}

export function toastError(error) {
  if (!(error instanceof ApiError)) {
    toast(esc(error?.message ?? String(error)), 'err');
    return;
  }
  const details = error.details && Object.keys(error.details).length
    ? `<div class="toast-detail">${esc(JSON.stringify(error.details))}</div>`
    : '';
  toast(
    `<div class="toast-code">${esc(error.code)} · HTTP ${error.status}</div>${esc(error.message)}${details}`,
    'err',
  );
}

// ── 弹层 ──────────────────────────────────────────────────────────────

export function closeModal() {
  document.getElementById('modal-root').innerHTML = '';
}

/**
 * 表单弹层。fields 元素形如
 * { name, label, type, options, value, required, help, placeholder, span, when }
 * type: text | number | usd | select | multiselect | textarea | checkbox | date | static
 */
export function openForm({ title, desc, fields, submitLabel = '提交', danger = false, wide = false, onSubmit }) {
  const root = document.getElementById('modal-root');
  const rows = fields.map(renderField).join('');

  root.innerHTML = `
    <div class="overlay" data-close="1">
      <div class="modal ${wide ? 'wide' : ''}">
        <div class="modal-head">
          <div class="modal-title">${esc(title)}</div>
          ${desc ? `<div class="modal-desc">${desc}</div>` : ''}
        </div>
        <form class="modal-body" id="modal-form">${rows}</form>
        <div class="modal-foot">
          <button class="btn" type="button" data-close="1">取消</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-cta'}" type="submit" form="modal-form" id="modal-submit">
            ${esc(submitLabel)}
          </button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach((n) =>
    n.addEventListener('click', (e) => {
      if (e.target === n) closeModal();
    }),
  );

  // 依赖字段：当 when 指定的控件变化时切换可见性
  const form = root.querySelector('#modal-form');
  const applyVisibility = () => {
    const values = readForm(form, fields);
    for (const f of fields) {
      if (!f.when) continue;
      const row = form.querySelector(`[data-row="${f.name}"]`);
      if (row) row.style.display = f.when(values) ? '' : 'none';
    }
  };
  form.addEventListener('change', applyVisibility);
  applyVisibility();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = root.querySelector('#modal-submit');
    btn.disabled = true;
    try {
      const values = readForm(form, fields);
      for (const f of fields) {
        if (!f.required) continue;
        if (f.when && !f.when(values)) continue;
        const v = values[f.name];
        if (v === '' || v === null || v === undefined) {
          throw new Error(`「${f.label}」为必填项`);
        }
      }
      await onSubmit(values);
      closeModal();
    } catch (error) {
      toastError(error);
      btn.disabled = false;
    }
  });

  const first = form.querySelector('input:not([type=checkbox]), select, textarea');
  if (first) first.focus();
}

function renderField(f) {
  const id = `f_${f.name}`;
  const req = f.required ? '<span class="req">*</span>' : '';
  const help = f.help ? `<div class="form-help">${f.help}</div>` : '';
  let control = '';

  switch (f.type) {
    case 'select':
      control = `<select id="${id}" name="${f.name}">${(f.options || [])
        .map((o) => `<option value="${esc(o.value)}"${o.value === f.value ? ' selected' : ''}>${esc(o.label)}</option>`)
        .join('')}</select>`;
      break;
    case 'multiselect':
      control = `<div>${(f.options || [])
        .map((o, i) => `<label class="form-check"><input type="checkbox" name="${f.name}" value="${esc(o.value)}"
          ${(f.value || []).includes(o.value) ? 'checked' : ''} id="${id}_${i}" />${esc(o.label)}</label>`)
        .join('')}</div>`;
      break;
    case 'textarea':
      control = `<textarea id="${id}" name="${f.name}" placeholder="${esc(f.placeholder ?? '')}">${esc(f.value ?? '')}</textarea>`;
      break;
    case 'checkbox':
      return `<div class="form-row" data-row="${f.name}"><label class="form-check">
        <input type="checkbox" id="${id}" name="${f.name}" ${f.value ? 'checked' : ''} />${esc(f.label)}
      </label>${help}</div>`;
    case 'static':
      return `<div class="form-row" data-row="${f.name}"><label>${esc(f.label)}</label>
        <div class="field-value">${f.value ?? ''}</div>${help}</div>`;
    case 'number':
    case 'usd':
      control = `<input id="${id}" name="${f.name}" type="number" step="${f.type === 'usd' ? '0.01' : (f.step ?? '1')}"
        ${f.min !== undefined ? `min="${f.min}"` : ''} value="${f.value ?? ''}" placeholder="${esc(f.placeholder ?? '')}" />`;
      break;
    case 'date':
      control = `<input id="${id}" name="${f.name}" type="date" value="${f.value ?? ''}" />`;
      break;
    default:
      control = `<input id="${id}" name="${f.name}" type="text" value="${esc(f.value ?? '')}" placeholder="${esc(f.placeholder ?? '')}" />`;
  }

  return `<div class="form-row" data-row="${f.name}"><label for="${id}">${esc(f.label)}${req}</label>${control}${help}</div>`;
}

function readForm(form, fields) {
  const out = {};
  for (const f of fields) {
    if (f.type === 'static') continue;
    if (f.type === 'multiselect') {
      out[f.name] = [...form.querySelectorAll(`input[name="${f.name}"]:checked`)].map((n) => n.value);
      continue;
    }
    const node = form.querySelector(`[name="${f.name}"]`);
    if (!node) continue;
    if (f.type === 'checkbox') out[f.name] = node.checked;
    else if (f.type === 'number') out[f.name] = node.value === '' ? null : Number(node.value);
    else if (f.type === 'usd') out[f.name] = node.value === '' ? null : Math.round(Number(node.value) * 100);
    else out[f.name] = node.value.trim();
  }
  return out;
}

/** 危险操作的二次确认：必须输入完整租户名称 */
export function confirmName(tenantName, extraNotice = '') {
  return {
    name: 'confirmName',
    label: `输入租户名称以确认：${tenantName}`,
    type: 'text',
    required: true,
    placeholder: tenantName,
    help: extraNotice || '需完全匹配，含大小写与空格。',
  };
}

export const reasonField = (label = '理由') => ({
  name: 'reason',
  label,
  type: 'textarea',
  required: true,
  placeholder: '不少于 10 个字符，将写入审计日志',
  help: '危险操作的理由会随审计日志长期留存。',
});

/** 触发 CSV 下载 */
export function downloadCsv(result) {
  const blob = new Blob([result.csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = result.filename;
  a.click();
  URL.revokeObjectURL(url);
  toast(`已导出 ${result.rowCount} 行`);
}
