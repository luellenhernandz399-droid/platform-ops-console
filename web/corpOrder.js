// 对公权益支付下单：容器页 + 创建/历史两个 tab + 订单详情页。
// 挂在租户详情页「基本信息」tab 的入口按钮之下，复用既有席位/额度体系与导出管线。
// 席位行、额度包行的名称/单价/额度不再自由填写，改为从商品目录（PRD-席位与额度包商品化）选择。

import {
  api, badge, closeModal, cny, CORP_GRANT_OWNER, CORP_GRANT_TYPE, CORP_ORDER_LIFECYCLE,
  day, downloadCsv, dt, esc, go, statusBadge, toast, toastError,
} from './core.js';

const MAX_SEAT_LINES = 20;
const MAX_PACKAGE_LINES = 20;

const UNIT = { seat: '/席位·月', package: '/个' };
const CUNIT = { seat: ' credits/月', package: ' credits/个' };
const CATNAME = { seat: '席位', package: '额度包' };

let mountEl = null;
let state = null;

export async function renderCorpOrder(root, tenantId, section = 'create', orderId = null) {
  if (section === 'detail' && orderId) {
    return renderOrderDetail(root, tenantId, orderId);
  }

  mountEl = root;
  root.innerHTML = '<div class="loading">加载中</div>';

  let tenantDetail;
  let seatProducts;
  let packageProducts;
  try {
    [tenantDetail, seatProducts, packageProducts] = await Promise.all([
      api('GET', `/tenants/${encodeURIComponent(tenantId)}`),
      api('GET', `/tenants/${encodeURIComponent(tenantId)}/products?category=seat`),
      api('GET', `/tenants/${encodeURIComponent(tenantId)}/products?category=package`),
    ]);
  } catch (error) {
    toastError(error);
    root.innerHTML = `<div class="page"><div class="card"><div class="empty">${esc(error.message)}</div></div></div>`;
    return;
  }

  state = {
    tenantId,
    tenant: tenantDetail.tenant,
    section: section === 'history' ? 'history' : 'create',
    historySub: 'orders',
    draft: null,
    dirty: false,
    idempotencyKey: null,
    products: { seat: seatProducts, package: packageProducts },
    openPicker: null,
    showOff: { seat: false, package: false },
  };
  state.draft = freshDraft();

  paintContainer();
}

function freshDraft() {
  return {
    voucher: null,
    lines: [emptyLine()],
    pkgs: [],
  };
}

function emptyLine() {
  return {
    productId: null,
    seatCount: '1',
    effectiveAt: todayStr(),
    termMonths: '12',
    poolPercent: '0',
  };
}

function emptyPkgLine() {
  return {
    productId: null,
    count: '1',
    effectiveAt: todayStr(),
    termMonths: '6',
  };
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function previewAddCalendarMonths(dateStr, months) {
  const d = new Date(`${dateStr}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime()) || !(Number(months) > 0)) return null;
  const day0 = d.getUTCDate();
  const t = new Date(d.getTime());
  t.setUTCMonth(t.getUTCMonth() + Number(months));
  if (t.getUTCDate() !== day0) t.setUTCDate(0);
  return t;
}

// ── 商品目录：查找、展示文案、锁定单元格 ───────────────────────────────────

function listOf(kind) {
  return kind === 'seat' ? state.draft.lines : state.draft.pkgs;
}

function productOf(kind, id) {
  if (!id) return null;
  return state.products[kind].find((p) => p.id === id) || null;
}

function productLabel(product, kind) {
  return product.note?.trim() ? product.note.trim() : `${CATNAME[kind]}商品`;
}

function specOf(product, kind) {
  return `${cny(product.unitPriceFen)}${UNIT[kind]} · ${Number(product.creditAmount).toLocaleString('en-US')}${CUNIT[kind]}`;
}

function visibleProducts(kind, includeOff) {
  return state.products[kind].filter((p) => includeOff || p.active);
}

function upsertProduct(kind, product) {
  const list = state.products[kind];
  const i = list.findIndex((p) => p.id === product.id);
  if (i >= 0) list[i] = product;
  else list.push(product);
}

function lockedCell(txt, blank) {
  return blank ? '<div class="locked blank">—</div>' : `<div class="locked">${txt}</div>`;
}

// ── 容器：头部 + tab 切换 ────────────────────────────────────────────────

function paintContainer() {
  const t = state.tenant;
  mountEl.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="tenant-head">
            <span class="tenant-name">${esc(t.name)}</span>
            ${statusBadge(t)}
          </div>
          <div class="page-desc"><span class="tenant-code">${esc(t.code)}</span> · 对公权益支付下发</div>
        </div>
        <div class="page-actions"><button class="btn" id="corp-back">← 返回租户详情</button></div>
      </div>

      <div class="tabs">
        <div class="tab ${state.section === 'create' ? 'active' : ''}" data-sec="create">创建订单</div>
        <div class="tab ${state.section === 'history' ? 'active' : ''}" data-sec="history">历史订单</div>
      </div>
      <div id="corp-body"></div>
    </div>`;

  mountEl.querySelector('#corp-back').addEventListener('click', () => {
    if (state.dirty && !window.confirm('创建订单的草稿尚未提交，返回后草稿将丢失，确认离开？')) return;
    go(`tenants/${state.tenantId}`);
  });
  mountEl.querySelectorAll('[data-sec]').forEach((n) =>
    n.addEventListener('click', () => switchSection(n.dataset.sec)));

  paintSection();
}

function switchSection(sec) {
  if (sec === state.section) return;
  state.section = sec;
  history.replaceState({}, '', `/tenants/${state.tenantId}/corp-order/${sec}`);
  mountEl.querySelectorAll('[data-sec]').forEach((n) => n.classList.toggle('active', n.dataset.sec === sec));
  paintSection();
}

function paintSection() {
  const body = mountEl.querySelector('#corp-body');
  if (state.section === 'history') paintHistory(body);
  else paintCreate(body);
}

// ── 创建 tab ─────────────────────────────────────────────────────────────

function paintCreate(body) {
  body.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      ${voucherCardHtml()}
      ${seatLinesCardHtml()}
      ${pkgLinesCardHtml()}
    </div>
    ${summaryBarHtml()}`;
  wireCreate(body);
}

function voucherCardHtml() {
  const v = state.draft.voucher;
  return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">付款凭证</div>
        <div class="card-note">支持 PDF / JPG / PNG，最大 10MB，每次创建订单需重新上传；未上传不能提交订单</div>
      </div>
      <div class="card-body">
        ${v
          ? `<div class="notice info" style="display:flex;align-items:center;gap:var(--pc-space-4)">
              <span>已选择 <strong>${esc(v.fileName)}</strong>（${v.sizeLabel}）</span>
              <button class="btn-link" id="corp-voucher-reset">重新选择</button>
            </div>`
          : `<label class="btn" for="corp-voucher-input" style="display:inline-flex;cursor:pointer">选择凭证文件</label>
             <input type="file" id="corp-voucher-input" accept=".pdf,.jpg,.jpeg,.png" style="display:none" />`}
      </div>
    </div>`;
}

function seatLinesCardHtml() {
  const disabledAdd = state.draft.lines.length >= MAX_SEAT_LINES ? 'disabled' : '';
  const hasLines = state.draft.lines.length > 0;
  return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">席位权益明细</div>
        <div class="card-note">从商品目录选择席位商品，单价与月额度由商品决定，可新增多行支持一次购买多种权益；不需要席位权益时可删至 0 行，仅购买额度包；池化额度为 0 表示不赠送，最多 ${MAX_SEAT_LINES} 行</div>
        <div class="card-actions"><button class="btn btn-sm" id="corp-line-add" ${disabledAdd}>+ 新增一行</button></div>
      </div>
      ${hasLines ? `
      <div class="card-body flush table-wrap">
        <table><thead>
          <tr class="grp">
            <th colspan="3">商品</th>
            <th colspan="3" class="g">本单用量</th>
            <th colspan="3" class="g">周期</th>
            <th class="g"></th><th></th>
          </tr>
          <tr>
            <th style="width:250px">商品</th><th class="num">单价(元/席位·月)</th><th class="num">月额度(credit)</th>
            <th class="num g">席位数</th><th class="num">池化额度(%)</th><th class="num">可赠送(credit/月)</th>
            <th class="g">生效日期</th><th class="num">有效期(月)</th><th>到期日</th>
            <th class="num g">行金额</th><th></th>
          </tr>
        </thead><tbody id="corp-lines-body">
          ${state.draft.lines.map((l, i) => lineRowHtml(l, i)).join('')}
        </tbody></table>
      </div>` : `
      <div class="card-body"><div class="empty" id="corp-lines-body">本单不含席位权益，点击「+ 新增一行」可添加；仅购买额度包时无需添加</div></div>`}
    </div>`;
}

function pickerHtml(kind, idx, r) {
  const product = productOf(kind, r.productId);
  const open = state.openPicker && state.openPicker.kind === kind && state.openPicker.idx === idx;
  const label = product
    ? `${esc(productLabel(product, kind))}<span class="spec">${specOf(product, kind)}</span>`
    : '选择商品';
  return `<div class="pk ${open ? 'open' : ''}" data-kind="${kind}" data-idx="${idx}">
    <button class="pk-btn ${product ? '' : 'empty'}" data-open="1">${label}</button>
    <span class="pk-caret">▼</span>
    ${open ? popHtml(kind) : ''}
  </div>`;
}

function popHtml(kind) {
  const all = visibleProducts(kind, state.showOff[kind]);
  const offCount = state.products[kind].filter((p) => !p.active).length;

  const items = all.map((p) => `
    <div class="pk-item ${p.active ? '' : 'disabled'}" data-pick="${p.id}">
      <div class="pk-item-main">
        <div class="pk-item-name">${p.note?.trim() ? esc(p.note.trim()) : '<span class="muted">未填备注</span>'}${p.active ? '' : ' · 已停用'}</div>
        <div class="pk-item-meta">${specOf(p, kind)}</div>
      </div>
      <div class="pk-item-use">用过 ${p.useCount} 次<br/><span style="opacity:.7">${p.lastUsedAt ? day(p.lastUsedAt) : '未用过'}</span></div>
      <button class="pk-item-off" data-toggle="${p.id}">${p.active ? '停用' : '启用'}</button>
    </div>`).join('');

  const empty = !all.length
    ? `<div class="pk-empty">该客户还没有${CATNAME[kind]}商品<br/>先新建一个，才能下单</div>` : '';

  return `<div class="pk-pop">
    ${all.length ? `<div class="pk-group">${esc(state.tenant.name)} · ${CATNAME[kind]}商品</div>` : ''}
    ${items}${empty}
    ${offCount ? `<div class="pk-foot"><span>已停用 ${offCount} 个</span><button data-showoff="1">${state.showOff[kind] ? '隐藏' : '显示'}</button></div>` : ''}
    <div class="pk-item pk-new" data-new="1">
      <div class="pk-item-main">
        <div class="pk-item-name">+ 新建${CATNAME[kind]}商品</div>
      </div>
    </div>
  </div>`;
}

function lineRowHtml(l, i) {
  const derived = deriveLine(l);
  const product = productOf('seat', l.productId);
  return `<tr data-idx="${i}">
    <td>${pickerHtml('seat', i, l)}</td>
    <td class="num">${lockedCell(product ? cny(product.unitPriceFen) : '', !product)}</td>
    <td class="num">${lockedCell(product ? Number(product.creditAmount).toLocaleString('en-US') : '', !product)}</td>
    <td class="num g"><input class="ln-seats" type="number" min="1" step="1" value="${esc(l.seatCount)}" style="width:64px" /></td>
    <td class="num"><input class="ln-pool" type="number" min="0" max="100" step="1" value="${esc(l.poolPercent)}" style="width:64px" /></td>
    <td class="num ln-gift">${lockedCell(product ? Number(derived.giftCredit).toLocaleString('en-US') : '', !product)}</td>
    <td class="g"><input class="ln-eff" type="date" value="${esc(l.effectiveAt)}" style="width:140px" /></td>
    <td class="num"><input class="ln-term" type="number" min="1" step="1" value="${esc(l.termMonths)}" style="width:64px" /></td>
    <td class="ln-expire mono">${derived.expireLabel}</td>
    <td class="ln-amount num g">${cny(derived.amountFen)}</td>
    <td><button class="btn-link danger" data-act="line.remove">删除</button></td>
  </tr>`;
}

function deriveLine(l) {
  const product = productOf('seat', l.productId);
  const seats = Number(l.seatCount || 0);
  const term = Number(l.termMonths || 0);
  const pool = Number(l.poolPercent || 0);
  const amountFen = product && seats > 0 && term > 0 ? product.unitPriceFen * seats * term : 0;
  // 展示列用 Math.floor 向下取整；后端真实赠送发放仍用 Math.round，两者独立，互不影响。
  const giftCredit = product ? Math.floor((product.creditAmount * seats * pool) / 100) : 0;
  const expire = l.effectiveAt ? previewAddCalendarMonths(l.effectiveAt, term) : null;
  return { amountFen, giftCredit, expireLabel: expire ? expire.toISOString().slice(0, 10) : '—' };
}

function pkgLinesCardHtml() {
  const disabledAdd = state.draft.pkgs.length >= MAX_PACKAGE_LINES ? 'disabled' : '';
  const hasPkgs = state.draft.pkgs.length > 0;
  return `
    <div class="card">
      <div class="card-head">
        <div class="card-title">额度包</div>
        <div class="card-note">从商品目录选择额度包商品，单价与单个额度由商品决定，可新增多行支持同时购买多种类型的额度包；不需要额度包时可删至 0 行，仅购买席位权益；最多 ${MAX_PACKAGE_LINES} 行</div>
        <div class="card-actions"><button class="btn btn-sm" id="corp-pkg-add" ${disabledAdd}>+ 新增一行</button></div>
      </div>
      ${hasPkgs ? `
      <div class="card-body flush table-wrap">
        <table><thead>
          <tr class="grp">
            <th colspan="3">商品</th>
            <th class="g">本单用量</th>
            <th colspan="3" class="g">周期</th>
            <th class="g"></th><th></th>
          </tr>
          <tr>
            <th style="width:250px">商品</th><th class="num">单价(元/个)</th><th class="num">单个额度(credit)</th>
            <th class="num g">个数</th>
            <th class="g">生效日期</th><th class="num">有效期(月)</th><th>到期日</th>
            <th class="num g">行金额</th><th></th>
          </tr>
        </thead><tbody id="corp-pkgs-body">
          ${state.draft.pkgs.map((p, i) => pkgLineRowHtml(p, i)).join('')}
        </tbody></table>
      </div>` : `
      <div class="card-body"><div class="empty" id="corp-pkgs-body">本单不含额度包，点击「+ 新增一行」可添加；仅购买席位权益时无需添加</div></div>`}
    </div>`;
}

function pkgLineRowHtml(p, i) {
  const derived = derivePkgLine(p);
  const product = productOf('package', p.productId);
  return `<tr data-idx="${i}">
    <td>${pickerHtml('package', i, p)}</td>
    <td class="num">${lockedCell(product ? cny(product.unitPriceFen) : '', !product)}</td>
    <td class="num">${lockedCell(product ? Number(product.creditAmount).toLocaleString('en-US') : '', !product)}</td>
    <td class="num g"><input class="pl-count" type="number" min="1" step="1" value="${esc(p.count)}" style="width:64px" /></td>
    <td class="g"><input class="pl-eff" type="date" value="${esc(p.effectiveAt)}" style="width:140px" /></td>
    <td class="num"><input class="pl-term" type="number" min="1" step="1" value="${esc(p.termMonths)}" style="width:64px" /></td>
    <td class="pl-expire mono">${derived.expireLabel}</td>
    <td class="pl-amount num g">${cny(derived.amountFen)}</td>
    <td><button class="btn-link danger" data-act="pkg.remove">删除</button></td>
  </tr>`;
}

function derivePkgLine(p) {
  const product = productOf('package', p.productId);
  const count = Number(p.count || 0);
  const term = Number(p.termMonths || 0);
  const amountFen = product && count > 0 ? product.unitPriceFen * count : 0;
  const expire = p.effectiveAt ? previewAddCalendarMonths(p.effectiveAt, term) : null;
  return { amountFen, expireLabel: expire ? expire.toISOString().slice(0, 10) : '—' };
}

function summaryBarHtml() {
  const s = computeSummary();
  return `
    <div class="corp-summary-bar">
      <div class="corp-summary-bar-fields">
        <div><div class="field-label">本单总金额</div><div class="stat-value sm" id="corp-sum-amount">${cny(s.totalAmountFen)}</div></div>
        <div><div class="field-label">预计发放额度</div><div class="stat-value sm" id="corp-sum-credit">${s.totalCredit.toLocaleString('en-US')} credit</div></div>
      </div>
      <button class="btn btn-cta" id="corp-submit">核对并提交</button>
    </div>`;
}

function computeSummary() {
  let totalAmountFen = 0;
  let totalCredit = 0;
  for (const l of state.draft.lines) {
    const product = productOf('seat', l.productId);
    if (!product) continue;
    const seats = Number(l.seatCount || 0);
    const term = Number(l.termMonths || 0);
    const pool = Number(l.poolPercent || 0);
    totalAmountFen += product.unitPriceFen * seats * term;
    totalCredit += product.creditAmount * seats * term;
    if (pool > 0) totalCredit += Math.floor((product.creditAmount * seats * pool) / 100) * term;
  }
  for (const p of state.draft.pkgs) {
    const product = productOf('package', p.productId);
    if (!product) continue;
    const count = Number(p.count || 0);
    totalAmountFen += product.unitPriceFen * count;
    totalCredit += product.creditAmount * count;
  }
  return { totalAmountFen, totalCredit };
}

function patchSummary(body) {
  const s = computeSummary();
  const a = body.querySelector('#corp-sum-amount');
  const c = body.querySelector('#corp-sum-credit');
  if (a) a.textContent = cny(s.totalAmountFen);
  if (c) c.textContent = `${s.totalCredit.toLocaleString('en-US')} credit`;
}

function patchLineRow(tr, l) {
  const derived = deriveLine(l);
  const product = productOf('seat', l.productId);
  tr.querySelector('.ln-expire').textContent = derived.expireLabel;
  tr.querySelector('.ln-amount').textContent = cny(derived.amountFen);
  tr.querySelector('.ln-gift').innerHTML =
    lockedCell(product ? Number(derived.giftCredit).toLocaleString('en-US') : '', !product);
}

function patchPkgLineRow(tr, p) {
  const derived = derivePkgLine(p);
  tr.querySelector('.pl-expire').textContent = derived.expireLabel;
  tr.querySelector('.pl-amount').textContent = cny(derived.amountFen);
}

function wireCreate(body) {
  body.querySelector('#corp-voucher-input')?.addEventListener('change', onVoucherChange);
  body.querySelector('#corp-voucher-reset')?.addEventListener('click', () => {
    state.draft.voucher = null;
    state.dirty = true;
    paintCreate(body);
  });

  body.querySelector('#corp-line-add')?.addEventListener('click', () => {
    if (state.draft.lines.length >= MAX_SEAT_LINES) return;
    state.draft.lines.push(emptyLine());
    state.dirty = true;
    state.openPicker = null;
    paintCreate(body);
  });

  const linesBody = body.querySelector('#corp-lines-body');

  linesBody?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="line.remove"]');
    if (!btn) return;
    const idx = Number(btn.closest('tr').dataset.idx);
    const l = state.draft.lines[idx];
    const product = productOf('seat', l.productId);
    if (!window.confirm(`删除第 ${idx + 1} 行（${product ? productLabel(product, 'seat') : '未选择商品'} · ${l.seatCount || 0} 席位）？`)) return;
    state.draft.lines.splice(idx, 1);
    state.dirty = true;
    state.openPicker = null;
    paintCreate(body);
  });

  const lineFieldMap = {
    'ln-seats': 'seatCount', 'ln-pool': 'poolPercent', 'ln-eff': 'effectiveAt', 'ln-term': 'termMonths',
  };
  linesBody?.addEventListener('input', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    const l = state.draft.lines[idx];
    for (const [cls, field] of Object.entries(lineFieldMap)) {
      if (e.target.classList.contains(cls)) { l[field] = e.target.value; break; }
    }
    state.dirty = true;
    patchLineRow(tr, l);
    patchSummary(body);
  });

  body.querySelector('#corp-pkg-add')?.addEventListener('click', () => {
    if (state.draft.pkgs.length >= MAX_PACKAGE_LINES) return;
    state.draft.pkgs.push(emptyPkgLine());
    state.dirty = true;
    state.openPicker = null;
    paintCreate(body);
  });

  const pkgsBody = body.querySelector('#corp-pkgs-body');

  pkgsBody?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act="pkg.remove"]');
    if (!btn) return;
    const idx = Number(btn.closest('tr').dataset.idx);
    const p = state.draft.pkgs[idx];
    const product = productOf('package', p.productId);
    if (!window.confirm(`删除第 ${idx + 1} 行额度包（${product ? productLabel(product, 'package') : '未选择商品'} · ${p.count || 0} 个）？`)) return;
    state.draft.pkgs.splice(idx, 1);
    state.dirty = true;
    state.openPicker = null;
    paintCreate(body);
  });

  const pkgFieldMap = {
    'pl-count': 'count', 'pl-eff': 'effectiveAt', 'pl-term': 'termMonths',
  };
  pkgsBody?.addEventListener('input', (e) => {
    const tr = e.target.closest('tr');
    if (!tr) return;
    const idx = Number(tr.dataset.idx);
    const p = state.draft.pkgs[idx];
    for (const [cls, field] of Object.entries(pkgFieldMap)) {
      if (e.target.classList.contains(cls)) { p[field] = e.target.value; break; }
    }
    state.dirty = true;
    patchPkgLineRow(tr, p);
    patchSummary(body);
  });

  body.querySelector('#corp-submit')?.addEventListener('click', () => openReviewModal());

  // 商品选择器：开合、选中、停用/启用、显示已停用、新建商品、点击外部收起
  body.addEventListener('click', (e) => {
    const opener = e.target.closest('[data-open]');
    if (opener) {
      const box = opener.closest('.pk');
      const kind = box.dataset.kind;
      const idx = Number(box.dataset.idx);
      state.openPicker = state.openPicker && state.openPicker.kind === kind && state.openPicker.idx === idx
        ? null : { kind, idx };
      paintCreate(body);
      return;
    }

    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      e.stopPropagation();
      onToggleProduct(body, state.openPicker.kind, toggle.dataset.toggle);
      return;
    }

    const showoff = e.target.closest('[data-showoff]');
    if (showoff) {
      e.stopPropagation();
      state.showOff[state.openPicker.kind] = !state.showOff[state.openPicker.kind];
      paintCreate(body);
      return;
    }

    const pick = e.target.closest('[data-pick]');
    if (pick) {
      const { kind, idx } = state.openPicker;
      const product = productOf(kind, pick.dataset.pick);
      if (!product || !product.active) {
        toast('该商品已停用，先启用再选', 'err');
        return;
      }
      listOf(kind)[idx].productId = product.id;
      state.openPicker = null;
      state.dirty = true;
      paintCreate(body);
      return;
    }

    if (e.target.closest('[data-new]')) {
      const { kind, idx } = state.openPicker;
      state.openPicker = null;
      openCreateProductModal(body, kind, idx);
      return;
    }

    if (!e.target.closest('.pk') && state.openPicker) {
      state.openPicker = null;
      paintCreate(body);
    }
  });
}

async function onToggleProduct(body, kind, productId) {
  const product = productOf(kind, productId);
  if (!product) return;

  if (product.active) {
    const used = [...state.draft.lines, ...state.draft.pkgs].some((r) => r.productId === product.id);
    const spec = specOf(product, kind);
    if (!window.confirm(
      `停用「${productLabel(product, kind)}」？\n${spec}\n\n停用后不再出现在下拉里，历史订单不受影响。${used ? '\n当前草稿里有行正在使用它，停用后该行会被清空。' : ''}`,
    )) return;
    try {
      const updated = await api('PATCH', `/tenants/${state.tenantId}/products/${product.id}`, { active: false });
      upsertProduct(kind, updated);
      for (const r of [...state.draft.lines, ...state.draft.pkgs]) {
        if (r.productId === product.id) r.productId = null;
      }
      state.dirty = true;
      toast('已停用');
    } catch (error) {
      toastError(error);
    }
  } else {
    try {
      const updated = await api('PATCH', `/tenants/${state.tenantId}/products/${product.id}`, { active: true });
      upsertProduct(kind, updated);
      toast('已启用');
    } catch (error) {
      toastError(error);
    }
  }
  paintCreate(body);
}

function openCreateProductModal(body, kind, idx) {
  const root = document.getElementById('modal-root');
  const isSeat = kind === 'seat';
  root.innerHTML = `
    <div class="overlay" data-close="1">
      <div class="modal">
        <div class="modal-head">
          <div class="modal-title">新建${CATNAME[kind]}商品</div>
          <div class="modal-desc">归属 ${esc(state.tenant.name)} · 保存后不可修改，需要其他价格请另建一个</div>
        </div>
        <div class="modal-body">
          <div class="form-grid">
            <div class="form-row">
              <label>${isSeat ? '单价（元/席位·月）' : '单价（元/个）'}<span class="req">*</span></label>
              <input id="np-price" type="number" step="0.01" min="0.01" placeholder="0.00" />
            </div>
            <div class="form-row">
              <label>${isSeat ? '每席位每月 credit' : '单个 credit 数量'}<span class="req">*</span></label>
              <input id="np-credit" type="number" step="1" min="1" placeholder="0" />
            </div>
          </div>
          <div class="form-row">
            <label>备注名（可选）</label>
            <input id="np-note" type="text" placeholder="${isSeat ? '如：专业版' : '如：年度算力包'}" />
            <div class="form-help">仅用于展示，不参与去重</div>
          </div>
          <div id="np-warn"></div>
        </div>
        <div class="modal-foot">
          <button class="btn" data-close="1">取消</button>
          <button class="btn btn-cta" id="np-save">保存并选中</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach((n) =>
    n.addEventListener('click', (e) => { if (e.target === n) closeModal(); }));

  const priceEl = root.querySelector('#np-price');
  const creditEl = root.querySelector('#np-credit');
  const noteEl = root.querySelector('#np-note');
  const warnEl = root.querySelector('#np-warn');
  priceEl.focus();

  function refresh() {
    const priceFen = Math.round(Number(priceEl.value || 0) * 100);
    const credit = Number(creditEl.value || 0);
    if (!(priceFen > 0) || !(credit > 0)) { warnEl.innerHTML = ''; return; }
    const dup = state.products[kind].find((p) => p.unitPriceFen === priceFen && p.creditAmount === credit);
    warnEl.innerHTML = dup
      ? `<div class="warn-box">已存在相同商品（${esc(productLabel(dup, kind))}）${dup.active ? '' : '，当前为停用状态'}，保存时直接选中它，不重复创建</div>`
      : `<div class="ok-box">将创建：${cny(priceFen)}${UNIT[kind]} · ${Number(credit).toLocaleString('en-US')}${CUNIT[kind]}</div>`;
  }
  priceEl.addEventListener('input', refresh);
  creditEl.addEventListener('input', refresh);

  root.querySelector('#np-save').addEventListener('click', async () => {
    const priceFen = Math.round(Number(priceEl.value || 0) * 100);
    const credit = Number(creditEl.value || 0);
    if (!(priceFen > 0) || !(credit > 0)) { toast('单价与额度都要填，且大于 0', 'err'); return; }
    try {
      const result = await api('POST', `/tenants/${state.tenantId}/products`, {
        category: kind,
        unitPriceFen: priceFen,
        creditAmount: credit,
        note: noteEl.value.trim(),
      });
      upsertProduct(kind, result.product);
      listOf(kind)[idx].productId = result.product.id;
      state.dirty = true;
      closeModal();
      paintCreate(body);
      toast(result.created
        ? `商品已创建并选中：${cny(priceFen)}${UNIT[kind]} · ${Number(credit).toLocaleString('en-US')}${CUNIT[kind]}`
        : '已存在相同商品，未重复创建，已为你选中');
    } catch (error) {
      toastError(error);
    }
  });
}

async function onVoucherChange(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    toast('凭证文件不能超过 10MB', 'err');
    e.target.value = '';
    return;
  }
  let dataUrl;
  try {
    dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('文件读取失败'));
      reader.readAsDataURL(file);
    });
  } catch (error) {
    toastError(error);
    return;
  }
  state.draft.voucher = {
    fileName: file.name,
    mime: file.type || 'application/octet-stream',
    dataBase64: String(dataUrl).split(',')[1] ?? '',
    sizeLabel: `${(file.size / 1024).toFixed(0)} KB`,
  };
  state.dirty = true;
  paintCreate(mountEl.querySelector('#corp-body'));
}

// ── 创建 tab：校验 + 三态提交弹窗 ─────────────────────────────────────────

function validateDraft() {
  const d = state.draft;
  if (!d.voucher) return ['请上传付款凭证'];
  if (d.lines.length === 0 && d.pkgs.length === 0) return ['至少需要一行席位权益，或至少一行额度包'];
  if (d.lines.length > MAX_SEAT_LINES) return [`席位行数不能超过 ${MAX_SEAT_LINES} 行`];
  if (d.pkgs.length > MAX_PACKAGE_LINES) return [`额度包行数不能超过 ${MAX_PACKAGE_LINES} 行`];

  for (let i = 0; i < d.lines.length; i += 1) {
    const l = d.lines[i];
    if (!l.productId) return [`第 ${i + 1} 行未选择商品`];
    if (!(Number(l.seatCount) > 0)) return [`第 ${i + 1} 行席位数量必须大于 0`];
    if (!l.effectiveAt) return [`第 ${i + 1} 行请选择生效日期`];
    if (!(Number(l.termMonths) > 0)) return [`第 ${i + 1} 行有效期(月)必须大于 0`];
    const pool = Number(l.poolPercent || 0);
    if (pool < 0 || pool > 100) return [`第 ${i + 1} 行赠送池化系数需在 0~100 之间`];
  }

  for (let i = 0; i < d.pkgs.length; i += 1) {
    const p = d.pkgs[i];
    if (!p.productId) return [`额度包第 ${i + 1} 行未选择商品`];
    if (!(Number(p.count) > 0)) return [`额度包第 ${i + 1} 行个数必须大于 0`];
    if (!p.effectiveAt) return [`额度包第 ${i + 1} 行请选择生效日期`];
    if (!(Number(p.termMonths) > 0)) return [`额度包第 ${i + 1} 行有效期(月)必须大于 0`];
  }
  return [];
}

function openReviewModal() {
  const errors = validateDraft();
  if (errors.length) {
    toast(errors[0], 'err');
    return;
  }
  renderReviewModal('review');
}

function renderReviewModal(phase, extra = {}) {
  const root = document.getElementById('modal-root');

  if (phase === 'success') {
    const order = extra.order;
    root.innerHTML = `
      <div class="overlay">
        <div class="modal wide">
          <div class="modal-head">
            <div class="modal-title">已下发对公权益订单</div>
            <div class="modal-desc">订单号 <span class="mono">${esc(order.orderNo)}</span>，发放记录已进入既有席位/额度体系</div>
          </div>
          <div class="modal-body">
            <div class="notice info">
              下单金额 ${cny(order.totalAmountFen)} · 发放额度 ${Number(order.totalCreditIssued).toLocaleString('en-US')} credit
              · 发放明细 ${order.grantDetailCount} 条
            </div>
          </div>
          <div class="modal-foot">
            <button class="btn" id="corp-review-toHistory">返回历史订单</button>
            <button class="btn btn-cta" id="corp-review-toDetail">查看订单详情</button>
          </div>
        </div>
      </div>`;
    root.querySelector('#corp-review-toHistory').addEventListener('click', () => {
      closeModal();
      state.draft = freshDraft();
      state.dirty = false;
      state.idempotencyKey = null;
      switchSection('history');
    });
    root.querySelector('#corp-review-toDetail').addEventListener('click', () => {
      closeModal();
      go(`tenants/${state.tenantId}/corp-order/detail/${order.id}`);
    });
    return;
  }

  const submitting = phase === 'submitting';
  const s = computeSummary();
  const lines = state.draft.lines;
  const shownLines = lines.slice(0, 8);
  const pkgs = state.draft.pkgs;
  const shownPkgs = pkgs.slice(0, 8);

  root.innerHTML = `
    <div class="overlay" ${submitting ? '' : 'data-close="1"'}>
      <div class="modal wide">
        <div class="modal-head">
          <div class="modal-title">核对订单信息</div>
          <div class="modal-desc">确认下发后立即调用席位/额度发放引擎，请仔细核对</div>
        </div>
        <div class="modal-body" style="max-height:60vh;overflow-y:auto">
          <div class="fields">
            <div><div class="field-label">客户</div><div class="field-value">${esc(state.tenant.name)}（${esc(state.tenant.code)}）</div></div>
            <div><div class="field-label">付款凭证</div><div class="field-value">${esc(state.draft.voucher.fileName)}</div></div>
            <div><div class="field-label">本单总金额</div><div class="field-value">${cny(s.totalAmountFen)}</div></div>
            <div><div class="field-label">预计发放额度</div><div class="field-value">${s.totalCredit.toLocaleString('en-US')} credit</div></div>
          </div>

          ${lines.length ? `
          <div class="section-title" style="margin-top:var(--pc-space-5)">
            席位权益（共 ${lines.length} 行${lines.length > 8 ? '，仅展示前 8 行，其余详见订单详情' : ''}）
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th>商品</th><th class="num">单价</th><th class="num">月额度</th><th class="num">席位数</th>
            <th>生效</th><th class="num">有效期(月)</th><th class="num">赠送池化</th>
          </tr></thead><tbody>
            ${shownLines.map((l) => {
              const product = productOf('seat', l.productId);
              return `<tr>
                <td>${product ? esc(productLabel(product, 'seat')) : '—'}</td>
                <td class="num">${product ? cny(product.unitPriceFen) : '—'}</td>
                <td class="num">${product ? Number(product.creditAmount).toLocaleString('en-US') : '—'}</td>
                <td class="num">${esc(l.seatCount)}</td>
                <td>${esc(l.effectiveAt)}</td>
                <td class="num">${esc(l.termMonths)}</td>
                <td class="num">${Number(l.poolPercent || 0)}%</td>
              </tr>`;
            }).join('')}
          </tbody></table></div>` : `
          <div class="section-title" style="margin-top:var(--pc-space-5)">席位权益</div>
          <div class="notice info">本单不含席位权益，仅下发额度包</div>`}

          ${pkgs.length ? `
          <div class="section-title" style="margin-top:var(--pc-space-5)">
            额度包（共 ${pkgs.length} 行${pkgs.length > 8 ? '，仅展示前 8 行，其余详见订单详情' : ''}）
          </div>
          <div class="table-wrap"><table><thead><tr>
            <th>商品</th><th class="num">单价</th><th class="num">个数</th><th class="num">credit数量</th>
            <th>生效</th><th class="num">有效期(月)</th>
          </tr></thead><tbody>
            ${shownPkgs.map((p) => {
              const product = productOf('package', p.productId);
              return `<tr>
                <td>${product ? esc(productLabel(product, 'package')) : '—'}</td>
                <td class="num">${product ? cny(product.unitPriceFen) : '—'}</td>
                <td class="num">${esc(p.count)}</td>
                <td class="num">${product ? Number(product.creditAmount).toLocaleString('en-US') : '—'}</td>
                <td>${esc(p.effectiveAt)}</td>
                <td class="num">${esc(p.termMonths)}</td>
              </tr>`;
            }).join('')}
          </tbody></table></div>` : `
          <div class="section-title" style="margin-top:var(--pc-space-5)">额度包</div>
          <div class="notice info">本单不含额度包</div>`}
        </div>
        <div class="modal-foot">
          <button class="btn" id="corp-review-back" ${submitting ? 'disabled' : ''}>返回修改</button>
          <button class="btn btn-cta" id="corp-review-confirm" ${submitting ? 'disabled' : ''}>${submitting ? '下发中…' : '确认下发'}</button>
        </div>
      </div>
    </div>`;

  root.querySelectorAll('[data-close]').forEach((n) =>
    n.addEventListener('click', (e) => { if (e.target === n) closeModal(); }));
  root.querySelector('#corp-review-back')?.addEventListener('click', () => closeModal());
  root.querySelector('#corp-review-confirm')?.addEventListener('click', () => submitOrder());
}

function buildCreatePayload() {
  const v = state.draft.voucher;
  const seatLines = state.draft.lines.map((l) => ({
    productId: l.productId,
    seatCount: Number(l.seatCount),
    effectiveAt: new Date(`${l.effectiveAt}T00:00:00.000Z`).toISOString(),
    termMonths: Number(l.termMonths),
    poolPercent: Number(l.poolPercent || 0),
  }));
  const quotaPackages = state.draft.pkgs.map((p) => ({
    productId: p.productId,
    count: Number(p.count),
    effectiveAt: new Date(`${p.effectiveAt}T00:00:00.000Z`).toISOString(),
    termMonths: Number(p.termMonths),
  }));
  return {
    voucherFileName: v.fileName,
    voucherMime: v.mime,
    voucherDataBase64: v.dataBase64,
    seatLines,
    quotaPackages,
  };
}

async function submitOrder() {
  renderReviewModal('submitting');
  if (!state.idempotencyKey) state.idempotencyKey = `corp-${state.tenantId}-${Date.now()}`;
  try {
    const order = await api('POST', `/tenants/${state.tenantId}/corp-orders`, buildCreatePayload(), {
      idempotencyKey: state.idempotencyKey,
    });
    renderReviewModal('success', { order });
  } catch (error) {
    toastError(error);
    renderReviewModal('review');
  }
}

// ── 历史 tab ─────────────────────────────────────────────────────────────

function paintHistory(body) {
  body.innerHTML = `
    <div class="grid" style="gap:var(--pc-space-5)">
      <div class="chips">
        <span class="chip ${state.historySub === 'orders' ? 'active' : ''}" data-sub="orders">订单记录</span>
        <span class="chip ${state.historySub === 'grantDetails' ? 'active' : ''}" data-sub="grantDetails">额度明细</span>
      </div>
      <div class="card">
        <div class="card-head">
          <div class="card-title">${state.historySub === 'orders' ? '订单记录' : '额度发放明细'}</div>
          <div class="card-actions">
            <input type="text" id="corp-hist-q" placeholder="订单号 / 名称搜索" style="width:200px" />
            <button class="btn btn-sm" id="corp-hist-search">搜索</button>
            <button class="btn btn-sm" id="corp-hist-export">导出</button>
          </div>
        </div>
        <div class="card-body flush table-wrap" id="corp-hist-body"><div class="loading">加载中</div></div>
      </div>
    </div>`;

  body.querySelectorAll('[data-sub]').forEach((n) =>
    n.addEventListener('click', () => {
      if (state.historySub === n.dataset.sub) return;
      state.historySub = n.dataset.sub;
      paintHistory(body);
    }));
  body.querySelector('#corp-hist-search').addEventListener('click', () => loadHistory(body));
  body.querySelector('#corp-hist-q').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') loadHistory(body);
  });
  body.querySelector('#corp-hist-export').addEventListener('click', () => exportHistory());

  loadHistory(body);
}

async function loadHistory(body) {
  const q = body.querySelector('#corp-hist-q').value.trim();
  const target = body.querySelector('#corp-hist-body');
  target.innerHTML = '<div class="loading">加载中</div>';
  const qs = q ? `?q=${encodeURIComponent(q)}` : '';
  try {
    if (state.historySub === 'orders') {
      const rows = await api('GET', `/tenants/${state.tenantId}/corp-orders${qs}`);
      target.innerHTML = rows.length
        ? `<table><thead><tr>
            <th>订单号</th><th>创建时间</th><th>经办人</th><th>状态</th>
            <th class="num">金额</th><th class="num">发放额度</th><th class="num">发放条数</th><th></th>
          </tr></thead><tbody>${rows.map(orderRow).join('')}</tbody></table>`
        : '<div class="empty">暂无订单</div>';
      target.querySelectorAll('[data-act="order.detail"]').forEach((n) =>
        n.addEventListener('click', () => go(`tenants/${state.tenantId}/corp-order/detail/${n.dataset.id}`)));
    } else {
      const rows = await api('GET', `/tenants/${state.tenantId}/corp-grant-details${qs}`);
      target.innerHTML = rows.length
        ? `<table><thead><tr>
            <th>类型</th><th>归属</th><th>关联行</th><th class="num">额度</th><th>生效</th><th>到期</th>
            <th>关联席位单</th><th>关联额度单</th>
          </tr></thead><tbody>${rows.map(grantDetailRow).join('')}</tbody></table>`
        : '<div class="empty">暂无发放明细</div>';
    }
  } catch (error) {
    toastError(error);
    target.innerHTML = `<div class="empty">${esc(error.message)}</div>`;
  }
}

function orderRow(o) {
  const lc = CORP_ORDER_LIFECYCLE[o.lifecycleStatus] ?? { label: o.lifecycleStatus, tone: '' };
  return `<tr>
    <td class="mono">${esc(o.orderNo)}</td>
    <td>${dt(o.createdAt)}</td>
    <td>${esc(o.salesActorId)}</td>
    <td>${badge(lc.label, lc.tone)}</td>
    <td class="num">${cny(o.totalAmountFen)}</td>
    <td class="num">${Number(o.totalCreditIssued).toLocaleString('en-US')}</td>
    <td class="num">${o.grantDetailCount}</td>
    <td><button class="btn-link" data-act="order.detail" data-id="${o.id}">查看详情</button></td>
  </tr>`;
}

function grantDetailRow(g) {
  return `<tr>
    <td>${CORP_GRANT_TYPE[g.grantType] ?? g.grantType}</td>
    <td>${CORP_GRANT_OWNER[g.owner] ?? g.owner}</td>
    <td>${esc(g.sourceLineLabel)}</td>
    <td class="num">${Number(g.creditAmount).toLocaleString('en-US')}</td>
    <td>${day(g.effectiveAt)}</td>
    <td>${day(g.expireAt)}</td>
    <td class="mono">${esc(g.linkedSeatGrantId ?? '—')}</td>
    <td class="mono">${esc(g.linkedQuotaGrantId ?? '—')}</td>
  </tr>`;
}

async function exportHistory() {
  try {
    if (state.historySub === 'orders') {
      downloadCsv(await api('POST', '/exports/corp_order_records', { tenantId: state.tenantId }));
    } else {
      downloadCsv(await api('POST', '/exports/corp_grant_details', { tenantId: state.tenantId }));
    }
  } catch (error) {
    toastError(error);
  }
}

// ── 订单详情页（只读） ────────────────────────────────────────────────────

function orderLineLabel(line, kind) {
  const note = (line.productNote || '').trim();
  return note || `${CATNAME[kind]}商品`;
}

async function renderOrderDetail(root, tenantId, orderId) {
  mountEl = root;
  root.innerHTML = '<div class="loading">加载中</div>';
  let detail;
  try {
    detail = await api('GET', `/corp-orders/${encodeURIComponent(orderId)}`);
  } catch (error) {
    toastError(error);
    root.innerHTML = `<div class="page"><div class="card"><div class="empty">${esc(error.message)}</div></div></div>`;
    return;
  }

  root.innerHTML = `
    <div class="page">
      <div class="page-head">
        <div>
          <div class="tenant-head"><span class="tenant-name">订单 ${esc(detail.orderNo)}</span></div>
          <div class="page-desc">
            金额 ${cny(detail.totalAmountFen)} · 发放额度 ${Number(detail.totalCreditIssued).toLocaleString('en-US')} credit
            · 发放明细 ${detail.grantDetailCount} 条
          </div>
        </div>
        <div class="page-actions">
          <button class="btn" id="corp-detail-export">导出本单</button>
          <button class="btn" id="corp-detail-back">← 返回</button>
        </div>
      </div>

      <div class="grid" style="gap:var(--pc-space-5)">
        <div class="card">
          <div class="card-head"><div class="card-title">订单留痕</div></div>
          <div class="card-body">
            <div class="fields">
              <div><div class="field-label">订单号</div><div class="field-value mono">${esc(detail.orderNo)}</div></div>
              <div><div class="field-label">所属租户</div><div class="field-value mono">${esc(detail.tenantId)}</div></div>
              <div><div class="field-label">经办人</div><div class="field-value">${esc(detail.salesActorId)}</div></div>
              <div><div class="field-label">创建时间</div><div class="field-value">${dt(detail.createdAt)}</div></div>
              <div><div class="field-label">付款凭证</div><div class="field-value">${esc(detail.voucherFileName)}</div></div>
              <div><div class="field-label">凭证上传</div><div class="field-value">${esc(detail.voucherUploadedBy)} · ${dt(detail.voucherUploadedAt)}</div></div>
            </div>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">席位授权（共 ${detail.seatLines.length} 行）</div></div>
          <div class="card-body flush table-wrap">
            <table><thead><tr>
              <th>商品</th><th class="num">单价</th><th class="num">月额度</th><th class="num">席位数</th>
              <th>生效</th><th class="num">有效期(月)</th><th>到期</th><th class="num">赠送池化</th><th class="num">行金额</th>
            </tr></thead><tbody>
              ${detail.seatLines.length ? detail.seatLines.map((l) => `<tr>
                <td>${esc(orderLineLabel(l, 'seat'))}</td>
                <td class="num">${cny(l.unitPriceFen)}</td>
                <td class="num">${Number(l.monthlyCredit).toLocaleString('en-US')}</td>
                <td class="num">${l.seatCount}</td>
                <td>${day(l.effectiveAt)}</td>
                <td class="num">${l.termMonths}</td>
                <td>${day(l.expireAt)}</td>
                <td class="num">${l.poolPercent}%</td>
                <td class="num">${cny(l.lineAmountFen)}</td>
              </tr>`).join('') : '<tr><td colspan="9"><div class="empty">本单未包含席位权益</div></td></tr>'}
            </tbody></table>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">额度包（共 ${detail.quotaPackages.length} 行）</div></div>
          <div class="card-body flush table-wrap">
            <table><thead><tr>
              <th>商品</th><th class="num">单价</th><th class="num">个数</th><th class="num">credit数量</th>
              <th>生效</th><th class="num">有效期(月)</th><th>到期</th><th class="num">行金额</th>
            </tr></thead><tbody>
              ${detail.quotaPackages.length ? detail.quotaPackages.map((p) => `<tr>
                <td>${esc(orderLineLabel(p, 'package'))}</td>
                <td class="num">${cny(p.unitPriceFen)}</td>
                <td class="num">${p.count}</td>
                <td class="num">${Number(p.creditAmount).toLocaleString('en-US')}</td>
                <td>${day(p.effectiveAt)}</td>
                <td class="num">${p.termMonths}</td>
                <td>${day(p.expireAt)}</td>
                <td class="num">${cny(p.lineAmountFen)}</td>
              </tr>`).join('') : '<tr><td colspan="8"><div class="empty">本单未包含额度包</div></td></tr>'}
            </tbody></table>
          </div>
        </div>

        <div class="card">
          <div class="card-head"><div class="card-title">额度下发明细（全量 ${detail.grantDetails.length} 条）</div></div>
          <div class="card-body flush table-wrap">
            <table><thead><tr>
              <th>类型</th><th>归属</th><th>关联行</th><th class="num">额度</th><th>生效</th><th>到期</th>
              <th>关联席位单</th><th>关联额度单</th>
            </tr></thead><tbody>
              ${detail.grantDetails.length ? detail.grantDetails.map(grantDetailRow).join('')
                : '<tr><td colspan="8"><div class="empty">暂无发放明细</div></td></tr>'}
            </tbody></table>
          </div>
        </div>
      </div>
    </div>`;

  root.querySelector('#corp-detail-back').addEventListener('click', () => history.back());
  root.querySelector('#corp-detail-export').addEventListener('click', async () => {
    try {
      downloadCsv(await api('POST', '/exports/corp_order_detail', { orderId }));
    } catch (error) {
      toastError(error);
    }
  });
}
