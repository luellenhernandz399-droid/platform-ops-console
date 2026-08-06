# 平台运营后台 Spec：租户席位 / 额度 / 模型 / 生命周期 / 试用

最后更新：2026-08-04

覆盖需求：

- 平台运营后台 - 租户席位管理与分发
- 平台运营后台 - 平台向租户的额度分发
- 平台运营后台 - 平台向租户的模型管理
- 平台运营后台 - 租户生命周期：创建、管理、注销
- 试用管理标准化（最小集）

参考资料：

- 格式范本：`Desktop/管理中心-后台/第三方IDP-OAuth2登录集成Spec_final.md`
- 权限点编码约定：`Downloads/组织管理_权限点清单.xlsx`
- 租户侧额度语义：`Downloads/tokenhub-额度管理-三个子tab.html`
- 租户侧渠道/模型语义：`Downloads/model_management_with_test_dropdown.html`
- 租户侧管理日志字段：`Downloads/tokenhub_audit_log.html`
- 批量操作交互范式：`Downloads/批量导入成员.html`

---

## 1. 背景

当前已经有一套**租户侧管理中心**，服务对象是企业管理员：

1. 额度管理：额度分配（按团队）、额度充值（购买/赠送）、企业账单（按账期出账）。
2. 渠道管理：配置上游渠道与模型，按优先级和权重路由。
3. 用户管理 / 角色管理 / 权限设置：成员、角色、权限集。
4. 组织架构管理、批量导入成员、身份源同步（LDAP/AD）。
5. 管理日志：记录租户内部的管理操作。

但**平台方自己没有后台**。今天平台侧的运营动作依赖以下方式完成：

1. 新客户开通：人工建库/改配置/手动写数据。
2. 席位数控制：无统一出口，靠约定和事后核对。
3. 额度发放：直接操作租户侧的「额度充值」，平台方没有自己的发放记录和对账口径。
4. 模型开放范围：靠逐租户手工配渠道，没有平台级的模型白名单。
5. 试用：每次谈单临时拍一组「给多少席位、给多少额度、给多久」，无标准套餐，到期无人跟进。

由此产生的问题：

1. **无资源上限管控**：租户能用多少席位、多少额度、哪些模型，没有平台侧的强约束，全靠租户侧自觉。
2. **无平台侧账实相符**：平台发了多少、租户用了多少，两套数据没有对账关系。
3. **无生命周期**：租户从创建到注销没有状态定义，欠费停用、注销后数据怎么处理都没有规则。
4. **试用不可控**：试用到期不会自动收口，试用客户和正式客户在系统里长得一样。
5. **无审计**：平台侧的运营操作（尤其是发额度、调额度）没有留痕，出问题无法追责。

本 Spec 定义平台运营后台，把上述五件事收敛成一套统一的**平台 → 租户资源下发模型**。

---

## 2. 目标

### 2.1 平台侧目标

1. 建立**租户**作为平台侧一等实体，具备完整的生命周期状态机。
2. 席位、额度、模型三类资源统一走「平台授予（grant）→ 租户消费」的模型，平台侧的授予记录是唯一权威来源。
3. 平台侧对三类资源都能做：分发、扩容、缩容、回收、续期，且每次操作可追溯、可对账。
4. 试用标准化为**试用套餐模板**，开通即按模板下发，到期自动收口。
5. 提供租户总览与单租户详情（席位/额度/模型三视图），支撑父需求「租户席位/额度/模型查询」。
6. 所有平台侧写操作强制审计留痕，敏感操作（额度调账、强制回收席位、注销租户）必须填写理由。

### 2.2 与租户侧的分工

平台侧只管**上限和可用范围**，租户侧管**内部怎么分**。二者不重叠：

| 维度 | 平台运营后台（本 Spec） | 租户侧管理中心（已有，不改） |
|---|---|---|
| 席位 | 授予租户席位总数、有效期 | 把席位分配给具体成员 |
| 额度 | 向租户发放/回收额度总量 | 把额度分配给团队、查看企业账单 |
| 模型 | 授权租户可用的模型白名单、限速 | 在白名单内配置渠道、优先级、权重 |
| 用户 | 只创建首个租户管理员 | 成员增删改、角色、权限集、组织架构 |

### 2.3 非侵入约束

1. 不改租户侧管理中心已有的页面与交互。
2. 不改现有 credit 语义（`1 credit = $0.01`）、购买/赠送双账本、账期闭合公式。
3. 不改租户侧「渠道管理」的优先级 + 权重路由逻辑。
4. 租户侧新增的只有「只读展示平台授予的上限」，以及超限时的拦截提示。

---

## 3. 非目标

1. **不做计费与收款**。本期只做额度的发放与核销，不做定价、开票、支付、催收。充值单在平台侧表现为一条发放记录，其对应的合同与收款在 CRM/财务系统完成。
2. **不做租户侧功能的远程代操作**。平台运营人员不能通过运营后台直接修改租户内部的团队额度分配、成员角色、渠道配置。需要协助时走「模拟登录」，属于后续需求，本期不做。
3. **不做多级分销/代理商体系**。本期只有「平台 → 租户」两层，不支持代理商作为中间层再分发。
4. **不做用量实时计量与限流的实现**。本 Spec 定义限额与限速的配置项和语义，实际的计量、扣减、限流由现有网关链路承担。
5. **不做租户数据的物理隔离改造**。本期按逻辑隔离设计（所有表带 `tenant_id`），物理隔离列为开放问题。
6. **不做试用申请的自助注册入口**。本期试用由平台运营人员在后台开通，自助申请表单属于官网需求。

---

## 4. 现状与概念对齐

### 4.1 租户侧管理中心已有能力

从现有原型确认的语义，本 Spec 全部沿用：

**额度（`tokenhub-额度管理-三个子tab.html`）**

1. 计量单位为 credit，`1 credit = $0.01`。界面主行展示美元，副行展示 credit 真值。
2. 两类额度分开记账：
   - 购买额度：不清零。
   - 赠送额度：按月清零（当月清零）。
3. 充值记录字段：充值单号、金额、类型（购买额度/赠送额度）、到账时间、状态（已到账/待确认）。
4. 团队级视图字段：团队名、成员数、已使用、总额度、消耗率。
5. 企业账单按账期出账，必须闭合：`期初 + 充值 − 消耗 = 期末`。账期状态有「出账中/已出账」，可下钻到团队和模型维度。

**模型与渠道（`model_management_with_test_dropdown.html`）**

1. 组织形式为「渠道 → 模型」，一个渠道下挂多个模型（如 `Anthropic-Prod` 下挂 `Claude Opus 4.7 · Sonnet 4.6`）。
2. 渠道字段：状态（启用/禁用）、响应时间、成功率、已使用、总额度、优先级（P1/P2/P3）、权重。
3. 存在自建渠道（如 `Local-vLLM`），标记为「自建 · 无额度限制」。

**用户与权限**

1. 角色是权限点的集合；系统角色与业务角色为预制模板，可复制；支持自定义角色。
2. 权限集是可复用的权限点分组，可下发至角色；取消勾选即撤销。
3. 权限点编码约定为 `模块.资源.操作`，例如 `org.member_import.import`、`org.dept.create`。
4. 批量导入成员：下载模板 → 上传 → 导入历史（成功 N / 跳过 M / 下载报告）。

**管理日志（`tokenhub_audit_log.html`）**

字段：时间、角色、操作人、操作对象、操作类型、变更摘要、来源、状态。支持按时间范围、日志类型、操作人、操作对象、操作类型、状态筛选，支持导出与清除历史日志。

### 4.2 概念定义

| 概念 | 定义 | 归属 |
|---|---|---|
| 平台 | 服务提供方，本后台的使用者。本 Spec 描述的就是它的运营后台 | — |
| 租户（Tenant） | 一个企业客户，独立的资源边界与数据边界。平台的资源授予对象 | 平台侧 |
| 团队（Team） | 租户内部的分组，租户侧额度分配的粒度 | 租户侧 |
| 成员（Member） | 租户内的用户账号 | 租户侧 |
| 席位（Seat） | 一个成员使用产品的授权位。租户的席位总数由平台授予，占用由租户侧绑定 | 双层 |
| 额度（Credit） | 用量计价单位，`1 credit = $0.01`。分购买额度与赠送额度两个账本 | 双层 |
| 授予单（Grant） | 平台的一次资源下发记录，是席位/额度/模型授权的权威来源 | 平台侧 |
| 渠道（Channel） | 上游模型供应商的接入配置 | 双层 |
| 模型（Model） | 渠道下可调用的具体模型 | 双层 |
| 试用套餐（Trial Plan） | 席位数 + 额度 + 模型集 + 时长的预置组合 | 平台侧 |

### 4.3 两层管控模型

```
平台运营后台
   │
   ├── 席位授予单  seat_grant     ──►  租户席位总数（上限）
   │                                      │
   │                                      └──► 租户侧：成员绑定席位（占用）
   │
   ├── 额度授予单  quota_grant    ──►  租户额度余额（购买账本 / 赠送账本）
   │                                      │
   │                                      └──► 租户侧：团队额度分配 → 实际消耗
   │
   └── 模型授权    model_grant    ──►  租户可用模型白名单 + 限速
                                          │
                                          └──► 租户侧：渠道配置、优先级、权重
```

必须始终成立的三条不变式：

1. **席位不变式**：`count(占用中的席位) ≤ Σ(有效席位授予单的数量)`
2. **额度不变式**：`Σ(租户内各团队已分配额度) ≤ 购买额度余额 + 赠送额度余额`
3. **模型不变式**：`租户实际可调用的模型集合 ⊆ 平台授权的模型白名单`（自建渠道见 9.4 的例外）

冲突处理原则：

1. 平台侧的授予变更**立即生效**，不等待租户侧确认。
2. 变更后若破坏不变式（例如缩容席位后占用数超限），按各章定义的冲突策略处理，**默认拒绝操作并提示冲突明细**，而非静默截断。
3. 租户侧的任何分配动作在提交时校验不变式，超限则拦截，提示「已达平台授予上限，请联系服务方扩容」。

---

## 5. 角色与权限

### 5.1 平台侧角色

平台运营后台是**独立的登录入口与账号体系**，与租户侧账号不互通。预置四个角色：

| 角色 | 说明 | 典型操作 |
|---|---|---|
| 平台超级管理员 | 全部权限，含平台账号管理与危险操作 | 注销租户、强制回收席位、额度调账 |
| 平台运营 | 日常运营，可下发资源，不可注销租户 | 创建租户、发席位、发额度、配模型 |
| 平台商务 | 面向签单，可开通试用与查看，不可直接发正式额度 | 开通试用、转正式、查看租户 |
| 平台只读审计 | 只读全部数据 + 审计日志，无任何写操作 | 查询、导出、看日志 |

危险操作（注销租户、额度回收/调账、席位强制回收）额外要求：

1. 仅平台超级管理员可执行，或由超管授予了对应权限点的角色执行。
2. 必须填写理由（≥10 字符），理由写入审计日志。
3. 二次确认弹窗需要输入租户名称完全匹配才能提交。

### 5.2 权限点清单

沿用 `组织管理_权限点清单.xlsx` 的列结构与 `模块.资源.操作` 编码格式，平台侧统一使用 `platform.` 前缀。可直接粘回 Excel。

| 序号 | 所属模块 | 资源(对象) | 操作 | 权限点编码 | 权限点名称 |
|---|---|---|---|---|---|
| 1 | 平台运营 | 租户 | 查看 | `platform.tenant.view` | 查看租户列表与详情 |
| 2 | 平台运营 | 租户 | 新增 | `platform.tenant.create` | 创建租户 |
| 3 | 平台运营 | 租户 | 编辑 | `platform.tenant.edit` | 编辑租户基本信息 |
| 4 | 平台运营 | 租户 | 停用 | `platform.tenant.suspend` | 停用 / 恢复租户 |
| 5 | 平台运营 | 租户 | 注销 | `platform.tenant.deregister` | 发起租户注销 |
| 6 | 平台运营 | 租户 | 恢复 | `platform.tenant.restore` | 保留期内恢复已注销租户 |
| 7 | 平台运营 | 租户 | 清除 | `platform.tenant.purge` | 提前彻底清除租户数据 |
| 8 | 平台运营 | 租户管理员 | 配置 | `platform.tenant_admin.config` | 设置 / 变更租户首个管理员 |
| 9 | 平台运营 | 席位 | 查看 | `platform.seat.view` | 查看租户席位与占用明细 |
| 10 | 平台运营 | 席位 | 分发 | `platform.seat.grant` | 向租户分发 / 扩容席位 |
| 11 | 平台运营 | 席位 | 缩容 | `platform.seat.reduce` | 缩容席位授予 |
| 12 | 平台运营 | 席位 | 回收 | `platform.seat.revoke` | 回收席位授予单 |
| 13 | 平台运营 | 席位 | 强制释放 | `platform.seat.force_release` | 强制解绑已占用席位 |
| 14 | 平台运营 | 席位 | 续期 | `platform.seat.renew` | 席位授予单续期 |
| 15 | 平台运营 | 席位 | 导出 | `platform.seat.export` | 导出席位明细 |
| 16 | 平台运营 | 额度 | 查看 | `platform.quota.view` | 查看租户额度与流水 |
| 17 | 平台运营 | 额度 | 发放 | `platform.quota.grant` | 向租户发放购买额度 |
| 18 | 平台运营 | 额度 | 赠送 | `platform.quota.gift` | 向租户发放赠送额度 |
| 19 | 平台运营 | 额度 | 回收 | `platform.quota.revoke` | 回收未消耗额度 |
| 20 | 平台运营 | 额度 | 调账 | `platform.quota.adjust` | 额度人工调账（增减） |
| 21 | 平台运营 | 额度 | 配置 | `platform.quota.config` | 配置预警阈值与耗尽策略 |
| 22 | 平台运营 | 额度 | 导出 | `platform.quota.export` | 导出额度流水 |
| 23 | 平台运营 | 模型目录 | 查看 | `platform.model_catalog.view` | 查看平台模型目录 |
| 24 | 平台运营 | 模型目录 | 新增 | `platform.model_catalog.create` | 新增模型 / 渠道到目录 |
| 25 | 平台运营 | 模型目录 | 编辑 | `platform.model_catalog.edit` | 编辑模型目录条目 |
| 26 | 平台运营 | 模型目录 | 上下架 | `platform.model_catalog.publish` | 模型上架 / 下架 |
| 27 | 平台运营 | 模型授权 | 查看 | `platform.model_grant.view` | 查看租户模型授权 |
| 28 | 平台运营 | 模型授权 | 授权 | `platform.model_grant.grant` | 向租户授权模型 |
| 29 | 平台运营 | 模型授权 | 撤销 | `platform.model_grant.revoke` | 撤销租户模型授权 |
| 30 | 平台运营 | 模型授权 | 限额 | `platform.model_grant.limit` | 配置租户级限速与限额 |
| 31 | 平台运营 | 试用套餐 | 查看 | `platform.trial_plan.view` | 查看试用套餐模板 |
| 32 | 平台运营 | 试用套餐 | 新增 | `platform.trial_plan.create` | 新建试用套餐模板 |
| 33 | 平台运营 | 试用套餐 | 编辑 | `platform.trial_plan.edit` | 编辑试用套餐模板 |
| 34 | 平台运营 | 试用套餐 | 停用 | `platform.trial_plan.disable` | 停用试用套餐模板 |
| 35 | 平台运营 | 试用 | 开通 | `platform.trial.open` | 为租户开通试用 |
| 36 | 平台运营 | 试用 | 延期 | `platform.trial.extend` | 试用延期 |
| 37 | 平台运营 | 试用 | 转正式 | `platform.trial.convert` | 试用转正式 |
| 38 | 平台运营 | 试用 | 终止 | `platform.trial.terminate` | 提前终止试用 |
| 39 | 平台运营 | 运营看板 | 查看 | `platform.dashboard.view` | 查看租户总览看板 |
| 40 | 平台运营 | 审计日志 | 查看 | `platform.audit.view` | 查看平台操作审计日志 |
| 41 | 平台运营 | 审计日志 | 导出 | `platform.audit.export` | 导出平台操作审计日志 |
| 42 | 平台运营 | 平台账号 | 管理 | `platform.account.manage` | 管理平台侧账号与角色 |

角色与权限点的默认映射：

| 权限点范围 | 超管 | 运营 | 商务 | 只读审计 |
|---|:---:|:---:|:---:|:---:|
| `platform.*.view` / `.export` | ✓ | ✓ | ✓ | ✓ |
| `platform.tenant.create` / `.edit` | ✓ | ✓ | ✓ | — |
| `platform.tenant.suspend` | ✓ | ✓ | — | — |
| `platform.tenant.deregister` / `.restore` / `.purge` | ✓ | — | — | — |
| `platform.seat.grant` / `.renew` | ✓ | ✓ | — | — |
| `platform.seat.reduce` / `.revoke` | ✓ | ✓ | — | — |
| `platform.seat.force_release` | ✓ | — | — | — |
| `platform.quota.grant` / `.gift` | ✓ | ✓ | — | — |
| `platform.quota.revoke` / `.adjust` | ✓ | — | — | — |
| `platform.model_catalog.*` | ✓ | ✓ | — | — |
| `platform.model_grant.*` | ✓ | ✓ | — | — |
| `platform.trial_plan.*` | ✓ | ✓ | — | — |
| `platform.trial.open` / `.extend` / `.convert` | ✓ | ✓ | ✓ | — |
| `platform.trial.terminate` | ✓ | ✓ | — | — |
| `platform.account.manage` | ✓ | — | — | — |

---

## 6. 租户生命周期

### 6.1 租户状态机

```
                    ┌──────────────┐
                    │   pending    │  待开通（已创建，未下发资源）
                    └──────┬───────┘
              开通试用      │      直接开通正式
        ┌──────────────────┴──────────────────┐
        ▼                                     ▼
  ┌───────────┐        转正式            ┌──────────┐
  │  trialing │ ──────────────────────► │  active  │  正式
  │  试用中    │                         └────┬─────┘
  └─────┬─────┘                              │
        │ 试用到期 / 提前终止                   │ 欠费 / 人工冻结
        ▼                                     ▼
  ┌─────────────────────────────────────────────────┐
  │                   suspended                     │  已停用
  │  reason: trial_expired | arrears | manual       │
  └──────┬──────────────────────────────┬───────────┘
         │ 恢复（补额度 / 解冻 / 转正式）   │
         ▼                              │
      active ◄──────────────────────────┘
         │
         │ 发起注销
         ▼
  ┌────────────────┐   保留期内恢复    ┌──────────┐
  │ deregistering  │ ───────────────► │  active  │
  │  注销中（保留期）│                  └──────────┘
  └───────┬────────┘
          │ 保留期届满 / 提前清除
          ▼
  ┌────────────────┐
  │  deregistered  │  已注销（数据已清除，仅留存审计与账单归档）
  └────────────────┘
```

状态与能力的对应关系：

| 状态 | 成员可登录 | 可调用模型 | 可消耗额度 | 租户侧管理中心 | 平台侧可下发资源 |
|---|:---:|:---:|:---:|:---:|:---:|
| `pending` | ✗ | ✗ | ✗ | ✗ | ✓ |
| `trialing` | ✓ | ✓（试用模型集） | ✓（赠送额度） | ✓（受限，见 10.3） | ✓ |
| `active` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `suspended` | ✓ | ✗ | ✗ | 只读 | ✓（补额度即可恢复） |
| `deregistering` | ✗ | ✗ | ✗ | ✗ | ✗ |
| `deregistered` | ✗ | ✗ | ✗ | ✗ | ✗ |

状态流转规则：

1. 所有流转都写入 `tenant_lifecycle_event` 表，含前后状态、操作人、理由、时间。
2. `suspended` 必须带 `reason`，取值：`trial_expired`（试用到期）、`arrears`（额度耗尽）、`manual`（人工冻结）、`violation`（违规）。
3. `arrears` 停用是**自动触发**的：额度余额降到耗尽策略的阈值时由系统流转，不需要人工操作；补足额度后自动恢复为 `active`。
4. `manual` / `violation` 停用只能由人工恢复。
5. 从 `deregistering` 恢复只能回到 `active`，不能回到 `trialing`。

### 6.2 创建租户

创建表单字段：

| 字段 | 必填 | 说明 |
|---|:---:|---|
| 租户名称 | ✓ | 企业全称，全局唯一，用于注销时的二次确认输入 |
| 租户简称 | — | 列表展示用 |
| 租户编码 | ✓ | 系统生成，格式 `T` + 8 位数字，不可修改 |
| 所属行业 | — | 枚举，用于运营分层 |
| 客户等级 | — | 枚举：战略/重点/普通/长尾 |
| 归属销售 | — | 平台侧账号，用于筛选与提醒路由 |
| 联系人 / 联系方式 | ✓ | 用于额度预警、试用到期等通知 |
| 邮箱域名 | — | 可填多个。填写后成员邮箱必须匹配其一 |
| 合同编号 | — | 关联外部 CRM，仅记录不校验 |
| 合同起止日期 | — | 影响席位与额度授予单的默认有效期 |
| 备注 / 标签 | — | 自由文本 + 多选标签 |
| 开通方式 | ✓ | 单选：`开通试用`（选试用套餐）/ `直接开通正式`（填初始资源）/ `仅创建不开通` |
| 首个租户管理员 | ✓ | 姓名、邮箱、手机号。创建后向该邮箱发送激活链接 |

创建行为：

1. 三种开通方式对应的落库结果：
   - `仅创建不开通` → 状态 `pending`，不生成任何授予单。
   - `开通试用` → 状态 `trialing`，按所选试用套餐一次性生成席位授予单、赠送额度授予单、模型授权（见第 10 章）。
   - `直接开通正式` → 状态 `active`，按表单填写的初始席位数与初始额度生成授予单，模型授权默认给「基础模型集」。
2. 首个租户管理员在租户侧自动获得「企业管理员」角色，且**默认占用一个席位**。若初始席位数为 0，创建接口返回校验错误。
3. 创建成功后返回租户侧管理中心的访问地址与激活链接，供运营人员发给客户。
4. 租户名称与租户编码创建后均不可修改。名称如需变更，走「编辑」并记录变更历史（客户改名场景）—— 此处例外：名称可改但需 `platform.tenant.edit` 权限并留痕，注销二次确认以**当前名称**为准。

批量创建：沿用 `批量导入成员.html` 的交互范式 —— 下载模板 → 上传 xlsx → 展示导入结果（成功 N / 跳过 M / 失败 K）→ 下载报告。批量创建只支持 `仅创建不开通` 与 `开通试用` 两种方式。

### 6.3 管理

租户详情页的「基本信息」tab 支持：

1. 编辑除租户编码外的全部基本信息字段。
2. 变更归属销售（影响通知路由）。
3. 变更租户管理员：指定租户内的另一个成员为企业管理员，或新建一个。原管理员降级为普通成员，**不自动释放其席位**。
4. 打标签、写备注（备注为追加式，带操作人与时间，不可编辑历史条目）。
5. 查看生命周期事件时间线（来自 `tenant_lifecycle_event`）。

所有编辑操作走 `platform.tenant.edit`，逐字段 diff 写入审计日志。

### 6.4 停用、注销与清除

**停用（suspend）**

1. 人工停用需选择原因（`manual` / `violation`）并填写理由。
2. 停用即时生效：成员仍可登录，但所有模型调用返回 `TENANT_SUSPENDED`，租户侧管理中心切换为只读。
3. 停用期间平台侧仍可下发资源。这是为了支持「先补额度后恢复」的场景。
4. 停用不影响席位占用关系，恢复后原样可用。

**注销（deregister）**

1. 发起注销后进入 `deregistering`，开始**保留期**，默认 30 天，创建租户时可按合同调整（范围 7 ~ 180 天）。
2. 进入保留期立即执行：
   - 所有成员会话失效，禁止登录。
   - 所有席位授予单置为 `revoked`，席位占用关系保留（用于恢复）。
   - 所有额度授予单冻结，余额快照写入注销记录。
   - 所有模型授权撤销。
3. 保留期内可由超管执行「恢复」，回到 `active`，席位、额度、模型授权按快照原样恢复。
4. 保留期届满，或超管执行「提前清除」，进入 `deregistered`：
   - 清除租户业务数据：成员、团队、会话、令牌、使用日志、渠道配置。
   - **保留**：租户主记录（脱敏后）、全部授予单、额度流水、账单归档、审计日志。这些是财务与合规凭证，不随注销清除。
5. 注销时的余额处置：注销记录中固化「未消耗购买额度」与「未消耗赠送额度」两个数字，赠送额度直接作废，购买额度是否退款不在本系统处理（见第 18 章开放问题）。
6. `deregistered` 是终态，不可恢复。同一企业需要重新合作时，创建新租户。

**二次确认**

注销与提前清除的确认弹窗要求：

1. 展示影响范围：成员数、占用席位数、未消耗额度（购买/赠送分列）、已授权模型数。
2. 输入框需完整输入租户名称，完全匹配（含大小写与空格）才能提交。
3. 必填理由 ≥10 字符。

---

## 7. 租户席位管理与分发

本章是本次需求的重点。

### 7.1 席位模型

**席位授予单（seat_grant）**

平台每次向租户下发席位都生成一条授予单，这是席位总量的唯一来源。租户的席位总数是**有效授予单数量之和**，不是一个可以直接编辑的数字。这样做的原因：席位往往分批采购、分批到期（如首签 50 个到 2027-06，Q3 加购 20 个到 2027-12），单一数字无法表达到期差异。

授予单字段：

| 字段 | 说明 |
|---|---|
| 授予单号 | `SG-` + 年月 + 序号，如 `SG-2608-001` |
| 席位数量 | 正整数 |
| 来源 | `contract`（合同采购）/ `trial`（试用）/ `gift`（赠送）/ `compensation`（补偿） |
| 生效时间 | 默认即时生效 |
| 到期时间 | 空表示永久（仅 `contract` 允许永久） |
| 状态 | `active` / `expired` / `revoked` |
| 关联合同号 | 选填 |
| 备注 | 选填 |

**席位类型**

本期只做**单一席位类型**（标准席位）。数据模型预留 `seat_type` 字段，默认值 `standard`，为后续区分开发者席位/只读席位留出扩展位。是否要在本期就区分，见第 18 章开放问题。

**计费口径**

席位按**已绑定账号数**计算占用，不按活跃数。理由：席位是授权位而非并发位，客户预期是「买了 50 个位子就能建 50 个账号」，按活跃数计会导致占用数波动，无法做硬限。

停用状态的成员**仍占用席位**。要释放席位必须显式解绑或删除成员。这一点需要在租户侧的成员列表上明确提示，否则客户会认为「停用了就不占位」。

**有效席位总数计算**

```
seat_total(tenant, t) = Σ  grant.seat_count
                        where grant.tenant_id = tenant
                          and grant.status = 'active'
                          and grant.effective_at <= t
                          and (grant.expire_at is null or grant.expire_at > t)
```

### 7.2 平台侧操作

| 操作 | 语义 | 权限点 |
|---|---|---|
| 分发 | 新建一条授予单 | `platform.seat.grant` |
| 扩容 | 新建一条授予单（不修改已有单） | `platform.seat.grant` |
| 缩容 | 减少某条授予单的 `seat_count` | `platform.seat.reduce` |
| 回收 | 将某条授予单置为 `revoked` | `platform.seat.revoke` |
| 续期 | 延长某条授予单的 `expire_at` | `platform.seat.renew` |
| 强制释放 | 解绑指定成员的席位占用 | `platform.seat.force_release` |

设计要点：

1. **扩容永远是新建授予单，不是修改已有单**。这样每批席位的到期时间独立，历史可追溯。
2. 缩容只能减少 `seat_count`，不能增加（增加走扩容）。缩容到 0 等价于回收。
3. 缩容与回收都会触发不变式校验，见 7.4。
4. 续期只能往后延，不能提前到期（提前到期走缩容/回收）。
5. 所有操作要求填写理由，写入审计日志。

### 7.3 席位占用与释放

席位占用记录（`tenant_seat_assignment`）由**租户侧**创建，平台侧只读 + 强制释放。

占用触发时机：

1. 租户侧创建成员并激活时占用。
2. 批量导入成员时按导入顺序占用，超出总数的行标记为「跳过：席位不足」并计入导入报告。
3. 首个租户管理员在租户创建时自动占用。

释放触发时机：

| 场景 | 是否释放席位 | 说明 |
|---|:---:|---|
| 成员被删除 | ✓ | 立即释放 |
| 成员被停用 | ✗ | 仍占用，界面需明确提示 |
| 成员主动离职（身份源同步标记为离职） | ✓ | 由 LDAP/AD 同步触发，需租户侧开启「离职自动释放」开关 |
| 租户被停用 | ✗ | 保留占用关系，恢复后原样可用 |
| 租户注销进入保留期 | ✗ | 保留占用关系用于恢复；清除时一并删除 |
| 平台强制释放 | ✓ | 仅超管，需填理由，被释放的成员在租户侧显示为「席位已回收」 |

释放后席位立即可被新成员占用，无冷却期。

### 7.4 缩容与回收的冲突处理

当 `缩容/回收后的 seat_total < 当前占用数` 时触发冲突。三种策略，在操作弹窗中选择：

**策略 A：拒绝（默认）**

直接拒绝操作，返回冲突明细：目标总数、当前占用数、需要先释放的数量，并给出「占用明细」链接。运营人员联系客户在租户侧自行释放后再操作。

**策略 B：延期生效**

不立即改变 `seat_count`，而是给授予单打上 `pending_reduce_to = N` 与 `pending_reduce_at = 到期时间`。到期时若占用数仍超限，自动降级为策略 C 或 A（按开关配置）。适用于「合同到期不续，但让客户自然消化」的场景。

**策略 C：强制回收**

系统按规则自动解绑超出的席位，直到满足不变式。回收顺序（依次比较，前者相同再比后者）：

1. 最后活跃时间最早的成员优先
2. 从未登录过的成员优先于登录过的
3. 非管理员优先于管理员
4. 创建时间最晚的优先

强制回收要求：

1. 仅超管可选，需填理由。
2. 执行前弹出**将被回收的成员名单**（姓名、邮箱、最后活跃时间），需勾选确认。
3. 执行后向租户管理员发送通知，列出被回收成员。
4. 企业管理员账号**永不被自动回收**。若回收后仍超限且只剩管理员，操作失败并提示。

### 7.5 超卖与到期宽限

**超卖控制**

默认**硬限**：占用数达到 `seat_total` 后，租户侧创建成员直接拦截。

按租户可开启**软限**：允许超出 `X%`（默认 10%，上限 20%）。超出部分正常可用，但平台侧租户列表标红提示「席位超卖」，并给归属销售发通知。软限用于「客户已确认加购但合同未走完」的过渡期。

**到期宽限期**

授予单到期后进入宽限期，默认 7 天，可按租户配置（0 ~ 30 天）：

1. 宽限期内该批席位仍计入 `seat_total`，成员可正常使用。
2. 平台侧列表与详情显著提示「N 个席位已过期，宽限期剩余 X 天」。
3. 宽限期届满，授予单转 `expired`，退出总数计算。此时若占用数超限，按该租户配置的冲突策略处理（默认策略 A 的降级版本：不强制回收，但**冻结超出部分的成员登录**，并置租户为 `suspended(reason=manual)` 需人工介入）。

宽限期届满的处理是自动任务，每日执行一次。

### 7.6 页面与字段

**入口**：租户详情 → 席位 tab

**区块 1：席位总览卡片**

| 指标 | 说明 |
|---|---|
| 席位总数 | 有效授予单之和 |
| 已占用 | 当前占用数 |
| 剩余可用 | 总数 − 已占用 |
| 占用率 | 已占用 / 总数，≥90% 标黄，=100% 标红，>100% 标红并注「超卖」 |
| 即将到期 | 30 天内到期的席位数，点击下钻 |

**区块 2：授予单列表**

字段：授予单号、席位数量、来源、生效时间、到期时间、状态、关联合同号、操作人、操作时间、操作（缩容 / 回收 / 续期 / 详情）。

支持按状态、来源筛选，默认只显示 `active`。

**区块 3：占用明细列表**（只读 + 强制释放）

字段：成员姓名、邮箱、所属团队、角色、绑定时间、最后活跃时间、成员状态、操作（强制释放）。

支持按团队、成员状态、活跃时间筛选与排序。支持导出 xlsx（`platform.seat.export`）。

**批量操作**

支持批量向多个租户分发席位：选择租户（或上传租户编码清单）→ 填写统一的席位数、来源、有效期 → 预览影响 → 提交。结果沿用导入报告形式（成功 N / 失败 K / 下载报告）。

---

## 8. 平台向租户的额度分发

### 8.1 额度模型

**沿用租户侧已有语义，不新增概念**：

1. 计量单位 credit，`1 credit = $0.01`。
2. 两个独立账本：
   - **购买额度**（`purchased`）：不清零，长期有效（或按授予单的到期时间失效）。
   - **赠送额度**（`gift`）：按月清零，每月 1 日 00:00（租户时区）清零当月未用完的赠送余额。
3. 界面展示：主行美元、副行 credit 真值，与租户侧一致。

**精度与舍入**

1. 存储一律用 credit 的整数（`bigint`），不存浮点。
2. 展示为美元时 `amount_credit / 100`，保留 2 位小数。
3. 发放表单允许输入美元，提交时 `× 100` 转 credit，非整数 credit 直接拒绝（例如 `$10.005` 报错）。
4. 消耗侧如果产生小数 credit，按**向上取整**记账，理由是宁可多扣平台不亏，且避免长期累积误差。

**额度授予单（quota_grant）**

| 字段 | 说明 |
|---|---|
| 授予单号 | `QG-` + 年月 + 序号，如 `QG-2608-014`。对应租户侧看到的「充值单号」 |
| 账本类型 | `purchased` / `gift` |
| 金额 | credit 整数 |
| 来源 | `contract` / `trial` / `gift` / `compensation` / `adjustment` |
| 生效时间 | 默认即时 |
| 到期时间 | `gift` 强制为当月月末；`purchased` 可空（永久）或按合同 |
| 状态 | `pending`（待确认）/ `active`（已到账）/ `expired` / `revoked` |
| 关联合同号 | 选填 |
| 理由 | `revoke` / `adjustment` 类型必填 |

`pending` 状态对应租户侧「待确认」的充值记录，用于「合同已签、款未到」的场景：额度可见但不可用。确认到账后转 `active` 才计入余额。

**余额计算**

```
purchased_balance = Σ active purchased grants − Σ purchased 消耗 − Σ purchased 回收
gift_balance      = Σ active gift grants（未过期） − Σ gift 消耗
available_balance = purchased_balance + gift_balance
```

### 8.2 平台侧操作

| 操作 | 语义 | 权限点 |
|---|---|---|
| 发放 | 新建 `purchased` 授予单 | `platform.quota.grant` |
| 赠送 | 新建 `gift` 授予单 | `platform.quota.gift` |
| 确认到账 | `pending` → `active` | `platform.quota.grant` |
| 回收 | 撤销未消耗的授予单额度 | `platform.quota.revoke` |
| 调账 | 人工增减余额，产生一条 `adjustment` 流水 | `platform.quota.adjust` |
| 配置 | 预警阈值、耗尽策略 | `platform.quota.config` |

**回收规则**

1. 只能回收**未消耗**的部分。若授予单 100,000 credit 已消耗 30,000，最多回收 70,000。
2. 回收不修改原授予单金额，而是生成一条反向流水（`direction=out, biz_type=revoke`），保证授予单本身不可变。
3. 回收必须填理由 ≥10 字符。

**调账规则**

调账是兜底手段，用于修正系统故障导致的错账。要求：

1. 仅超管可用。
2. 必须选择调账方向（增/减）、金额、账本类型、理由（≥10 字符）。
3. 必须关联一个工单号或事故编号（自由文本，必填）。
4. 调账流水在租户侧的账单中单列，不混入正常充值/消耗，避免破坏账期闭合的可解释性。

### 8.3 清零、结转与账期归属

**扣减顺序**

消耗时按以下顺序扣减，保证客户利益最大化（先花快过期的）：

1. 赠送额度（按到期时间升序，早到期的先扣）
2. 购买额度（按到期时间升序，永久的最后扣）

**赠送额度清零**

1. 每月 1 日 00:00（租户时区）执行清零任务，将上月未消耗的 `gift` 余额置为 0，并写入一条 `expire` 流水，保证账本可解释。
2. 清零流水在租户侧账单中体现为「赠送额度过期」，不计入「本期消耗」，单列展示。因此账期闭合公式扩展为：
   ```
   期初 + 本期充值 − 本期消耗 − 本期过期 = 期末
   ```
   这是对现有公式的**兼容扩展**：当期无过期额度时，退化为原公式 `期初 + 充值 − 消耗 = 期末`，租户侧现有账单不受影响。
3. 清零只针对 `gift`，`purchased` 永不因跨月清零。

**结转**

1. 购买额度自然结转到下一账期。
2. 赠送额度不结转。
3. 试用期结束转正式时，试用发放的赠送额度**不结转**（见 10.3）。

**账期归属**

1. 账期按自然月划分，以**租户时区**为准（创建租户时设置，默认 `Asia/Shanghai`）。
2. 一笔流水的账期归属以其 `occurred_at` 落在哪个自然月为准，不以入库时间为准。
3. 账期在次月 1 日 02:00 触发出账，出账期间状态为「出账中」，完成后转「已出账」。已出账的账期数据冻结，后续调账只能计入当前账期，不能回改历史账期。

### 8.4 预警与耗尽策略

**阈值预警**

按租户配置，默认三级：

| 阈值 | 触发条件 | 通知对象 | 渠道 |
|---|---|---|---|
| 提醒 | 可用余额 ≤ 初始总额的 20% | 租户管理员 + 归属销售 | 邮件 |
| 告警 | 可用余额 ≤ 初始总额的 5% | 租户管理员 + 归属销售 + 平台运营 | 邮件 + 站内信 |
| 耗尽 | 可用余额 ≤ 0 | 同上 | 邮件 + 站内信 |

每个阈值在同一账期内只触发一次，避免余额在阈值附近抖动导致重复通知。

**耗尽策略**

按租户配置，三选一：

| 策略 | 行为 | 适用 |
|---|---|---|
| `hard_stop`（默认） | 余额 ≤ 0 立即拒绝所有模型调用，租户转 `suspended(reason=arrears)` | 试用客户、长尾客户 |
| `overdraft` | 允许透支到 `−X` credit（X 按租户配置），透支期间正常服务，超出后 `hard_stop` | 战略/重点客户，避免业务中断 |
| `degrade` | 余额 ≤ 0 后只允许调用「基础模型集」，高价模型拒绝 | 需要保底可用性的客户 |

补足额度后：`arrears` 停用的租户自动恢复 `active`，无需人工操作。

### 8.5 与租户侧的衔接与对账

**衔接**

1. 平台侧的额度授予单 = 租户侧「额度充值」tab 看到的充值记录。字段一一对应：授予单号→充值单号，金额→金额，账本类型→类型，生效时间→到账时间，状态→状态。
2. 租户侧「额度分配」把额度分到团队，提交时校验额度不变式（4.3 第 2 条），超限拦截。
3. 租户侧「企业账单」的数据源不变，只是「本期充值」的来源从人工操作变为平台侧授予单。

**对账口径**

平台侧提供对账视图，逐租户逐账期核对以下三组数必须相等：

```
1. 平台已发放      Σ quota_grant(active, 该账期)        = 租户侧「本期充值」
2. 平台记录的消耗  Σ quota_ledger(direction=out, 该账期) = 租户侧「本期消耗」
3. 平台侧期末余额                                        = 租户侧「期末余额」
```

任一组不等，在对账视图中标红并给出差异明细，支持导出。对账任务在出账完成后自动执行。

### 8.6 页面与字段

**入口**：租户详情 → 额度 tab

**区块 1：余额卡片**（对齐租户侧展示形式，主行美元 + 副行 credit）

可用余额（购买 / 赠送分列）、累计发放、累计消耗、本月消耗、预计可用天数（按近 7 日均耗算）。

**区块 2：授予单列表**

字段：授予单号、账本类型、金额、来源、生效时间、到期时间、状态、已消耗、剩余、关联合同号、操作人、操作时间、操作（确认到账 / 回收 / 详情）。

**区块 3：额度流水**

字段：时间、方向（增/减）、业务类型（发放/赠送/消耗/回收/调账/过期）、金额、变动后余额、账本类型、关联对象（团队/模型/授予单号）、操作人、备注。

支持按时间范围、方向、业务类型、账本类型筛选，支持导出（`platform.quota.export`）。

**区块 4：配置**

预警阈值（三级，可关闭单级）、耗尽策略（含透支额度）、租户时区、账期起止日。

**批量发放**

支持批量向多个租户发放额度，交互与批量分发席位一致。批量操作**不支持**回收与调账 —— 这两类风险太高，只能逐租户执行。

---

## 9. 平台向租户的模型管理

### 9.1 平台模型目录

平台维护一份全局的模型目录，是所有租户可见模型的全集。

**层级**：`渠道（channel）→ 模型（model）→ 版本`

沿用租户侧渠道-模型的组织形式，但平台目录管的是「有哪些」，租户侧渠道管理管的是「怎么路由」。

模型目录条目字段：

| 字段 | 说明 |
|---|---|
| 模型编码 | 全局唯一，如 `claude-opus-4-7` |
| 展示名称 | 如 `Claude Opus 4.7` |
| 所属渠道 | 如 `Anthropic-Prod` |
| 供应商 | `anthropic` / `openai` / `azure` / `deepseek` / `google` / `self_hosted` |
| 模型能力标签 | 多选：`chat` / `code` / `vision` / `reasoning` / `embedding` |
| 计价倍率 | 相对基准的倍率，用于消耗折算 |
| 上下架状态 | `draft` / `published` / `deprecated` / `offline` |
| 分组 | `基础模型集` / `高级模型集` / `实验模型集`，用于批量授权 |
| 上线时间 / 下线时间 | 下线时间用于提前通知租户 |

**上下架规则**

1. `draft` → `published`：上架，此后可授权给租户。
2. `published` → `deprecated`：标记弃用。已授权的租户**继续可用**，但平台侧和租户侧都展示「即将下线」提示，新授权被禁止。
3. `deprecated` → `offline`：正式下线。所有租户的该模型授权自动撤销，调用返回 `MODEL_OFFLINE`。
4. 下线前必须设置 `下线时间` 且距今 ≥30 天，系统在下线前 30/7/1 天向所有已授权租户的管理员发通知。这条是硬约束，防止上游模型突然下线导致客户无感知中断。

### 9.2 授权给租户

租户可用的模型 = 平台授权的白名单。授权粒度为**单个模型**，但支持按分组批量授权。

授权记录（`tenant_model_grant`）字段：

| 字段 | 说明 |
|---|---|
| 模型编码 | 关联模型目录 |
| 是否启用 | 平台侧总开关。关闭后租户侧不可见 |
| 是否默认模型 | 每个租户至多一个，租户侧新建会话的默认选择 |
| 生效时间 / 到期时间 | 到期后自动撤销 |
| 限速配置 | 见 9.3 |
| 单模型额度上限 | 见 9.3 |

**批量授权**

1. 按分组授权：勾选「基础模型集」即授权该组下所有 `published` 模型，且**后续新增到该组的模型自动授权**（跟随分组）。
2. 按模型授权：逐个勾选，不跟随分组变化。
3. 两种方式可混用，界面上分组授权的模型标记为「跟随分组」，不可单独取消（要取消需先解除分组授权）。

**撤销授权**

1. 撤销即时生效，租户侧该模型立即不可见、不可调用。
2. 若被撤销的是租户的默认模型，系统自动将默认模型改为该租户仍可用模型中优先级最高的一个；若无可用模型，则拒绝撤销并提示。
3. 撤销不影响历史使用日志与账单。

### 9.3 租户级限额与限速

三类限制，均可按「租户全局」或「租户 + 单模型」两个粒度配置，取最严格者生效：

| 限制项 | 单位 | 说明 |
|---|---|---|
| TPM | tokens / 分钟 | 令牌速率上限 |
| RPM | requests / 分钟 | 请求速率上限 |
| 并发数 | 并发请求数 | 同时进行的请求上限 |
| 单模型额度上限 | credit | 该模型在当前账期内最多消耗多少额度 |

规则：

1. 未配置表示不限制（受平台全局默认值约束）。
2. 触发限速返回 `RATE_LIMITED`，触发额度上限返回 `MODEL_QUOTA_EXCEEDED`，两者错误码区分开，便于客户自查。
3. 单模型额度上限**不是额外发放的额度**，只是对总额度消耗的分项封顶。防止客户在贵模型上不受控地烧完全部额度。
4. 账期切换时单模型额度上限的已用量清零。

### 9.4 与租户侧渠道管理的关系

这是最容易产生歧义的地方，明确规则：

| 事项 | 平台侧 | 租户侧 | 谁说了算 |
|---|---|---|---|
| 有哪些模型可用 | 授权白名单 | 只能在白名单内选 | **平台** |
| 模型的路由优先级与权重 | 不管 | 自由配置 | **租户** |
| 渠道的启用/禁用 | 不管 | 自由配置 | **租户** |
| 限速与限额 | 设上限 | 可设更严的值，不能放宽 | **平台设上限，租户可收紧** |
| 自建渠道（如 `Local-vLLM`） | 提供「允许自建渠道」总开关 | 开关打开后自由添加 | **平台开关，租户内容** |

自建渠道的例外说明：租户自建渠道调用的是客户自己的算力，不消耗平台额度（租户侧已标记为「自建 · 无额度限制」）。因此自建渠道**不受模型白名单约束**，但受平台侧「允许自建渠道」总开关控制。关闭该开关时，租户侧已有的自建渠道被禁用但保留配置。

### 9.5 页面与字段

**入口 1：平台模型目录**（全局，非租户级）

列表字段：模型编码、展示名称、所属渠道、供应商、能力标签、计价倍率、分组、状态、已授权租户数、上线时间、操作（编辑 / 上架 / 下架 / 详情）。

支持按供应商、分组、状态筛选。下架操作需填下线时间与理由，并展示「将影响 N 个租户」。

**入口 2：租户详情 → 模型 tab**

区块 1：授权总览 —— 已授权模型数、默认模型、是否允许自建渠道、本月各模型消耗 Top 5。

区块 2：授权列表 —— 模型名称、所属渠道、授权方式（跟随分组/单独授权）、启用状态、是否默认、TPM、RPM、并发、单模型额度上限、本期已消耗、到期时间、操作（编辑限额 / 撤销）。

区块 3：批量授权面板 —— 左侧模型目录树（按分组/供应商），右侧已授权列表，中间穿梭框。分组节点勾选即为跟随分组授权。

---

## 10. 试用管理标准化（最小集）

### 10.1 试用套餐模板

试用不再逐单拍脑袋，改为选择预置模板。模板字段：

| 字段 | 必填 | 说明 |
|---|:---:|---|
| 套餐名称 | ✓ | 如「标准试用 14 天」 |
| 席位数 | ✓ | 生成一条 `source=trial` 的席位授予单 |
| 赠送额度 | ✓ | 生成一条 `type=gift, source=trial` 的额度授予单 |
| 模型集 | ✓ | 选择模型分组或具体模型，生成模型授权 |
| 试用时长 | ✓ | 天数。决定席位、额度、模型授权的到期时间 |
| 是否允许充值 | ✓ | 默认否 |
| 是否允许自建渠道 | ✓ | 默认否 |
| 并发上限 | — | 覆盖默认并发数 |
| 到期后动作 | ✓ | `suspend`（默认）/ `keep_readonly` |
| 状态 | ✓ | `enabled` / `disabled` |

模板停用后不影响已开通的试用，只是不能再用于新开通。

预置三个模板供参考，可编辑：

| 模板 | 席位 | 赠送额度 | 模型集 | 时长 |
|---|---|---|---|---|
| 轻量试用 | 3 | $50（5,000 credit） | 基础模型集 | 7 天 |
| 标准试用 | 10 | $200（20,000 credit） | 基础模型集 | 14 天 |
| POC 试用 | 30 | $1,000（100,000 credit） | 基础 + 高级模型集 | 30 天 |

### 10.2 试用流程

```
创建租户（开通方式=开通试用）
        │
        ├─ 选择试用套餐模板
        ▼
   按模板一次性下发：席位授予单 + 赠送额度授予单 + 模型授权
        │
        ▼
   租户状态 = trialing，到期时间 = 开通时间 + 套餐时长
        │
   ┌────┼────────────────────┬──────────────────┐
   │    │                    │                  │
   ▼    ▼                    ▼                  ▼
 延期  转正式              到期               提前终止
   │    │                    │                  │
   │    ▼                    ▼                  ▼
   │  active           按模板「到期后动作」    suspended
   │  （见 10.3）        suspend / readonly    (trial_expired)
   └──► 重新计算到期时间（累计不超过 90 天）
```

**转正式**

1. 操作入口在租户详情页顶部的状态区，需 `platform.trial.convert`。
2. 转正式表单：正式席位数、正式购买额度、模型授权（默认继承试用授权，可调整）、合同号、合同起止日期。
3. 转正式时的资源处理：
   - 试用的席位授予单**保留至其原到期时间**，与新的正式席位授予单叠加。这样客户不会在转换瞬间掉席位。
   - 试用的赠送额度**立即失效**，不结转到正式（写入一条 `expire` 流水）。这一点必须在转正式确认弹窗中明示剩余赠送额度将作废。
   - 试用的模型授权转为正式授权，去掉试用限制（并发上限、不可充值、不可自建渠道）。
4. 转正式后租户状态 `trialing` → `active`，写入生命周期事件。

**延期**

1. 需 `platform.trial.extend`，填写延长天数与理由。
2. 席位、额度、模型授权的到期时间同步顺延。是否补发额度由操作人勾选决定（默认不补）。
3. 单个租户的试用总时长（含所有延期）**不得超过 90 天**，超出需超管审批。这条是防止「永久试用」的口子。

**提前终止**

需 `platform.trial.terminate`，填理由。立即回收席位、作废赠送额度、撤销模型授权，租户转 `suspended(reason=trial_expired)`。

### 10.3 试用期限制

| 限制 | 默认 | 说明 |
|---|---|---|
| 不可充值 | ✓ | 租户侧「额度充值」tab 隐藏，展示「试用期不支持充值，如需扩容请联系服务方」 |
| 不可自建渠道 | ✓ | 租户侧渠道管理隐藏「新建渠道」按钮 |
| 并发上限 | 按模板 | 默认低于正式客户 |
| 赠送额度不结转 | ✓ | 转正式或到期时作废 |
| 席位不可自行扩容 | ✓ | 租户侧无扩容入口 |

以上限制均由平台侧模板控制，租户侧只做展示与拦截。

### 10.4 到期提醒与自动处理

**提醒**

试用到期前 7 / 3 / 1 天各发一次，收件人为租户管理员 + 归属销售 + 平台运营。到期当天再发一次「已到期」通知。

**自动处理**

每日 00:30 执行到期检查任务：

1. 找出 `trialing` 且 `trial_expire_at <= now` 的租户。
2. 按模板的「到期后动作」处理：
   - `suspend`：转 `suspended(reason=trial_expired)`，回收席位授予单，作废赠送额度，撤销模型授权。
   - `keep_readonly`：转 `suspended(reason=trial_expired)`，但保留租户侧管理中心的只读访问，成员可导出自己的数据。
3. 写入生命周期事件与审计日志（操作人记为 `system`）。
4. 到期后数据保留 30 天，之后如未转正式，由运营决定是否发起注销（**不自动注销** —— 自动注销风险过高）。

### 10.5 最小集边界

本期**做**：

1. 试用套餐模板的增删改查。
2. 按模板开通试用、延期、转正式、提前终止。
3. 到期提醒与到期自动处理。
4. 试用租户在总览中的独立筛选与试用看板（在试数、本周到期数、转化率）。

本期**不做**：

1. 官网自助申请试用的表单与审批流。
2. 试用客户的自动化培育（邮件序列、使用引导）。
3. 试用期用量的深度分析报告。
4. 同一企业重复试用的自动判重（见第 18 章开放问题）。

---

## 11. 查询与看板

对应父需求「平台运营后台：租户席位/额度/模型查询」。

### 11.1 租户总览列表

**筛选**：租户状态、客户等级、归属销售、行业、标签、试用/正式、创建时间范围、到期时间范围、关键字（名称/编码/联系人）。

**列表字段**：

| 字段 | 说明 |
|---|---|
| 租户名称 / 编码 | 点击进详情 |
| 状态 | 带颜色标识，`suspended` 展示原因 |
| 客户等级 | |
| 席位（已占用/总数） | 占用率 ≥90% 标黄，超卖标红 |
| 可用额度 | 美元主行 + credit 副行 |
| 本月消耗 | |
| 消耗率 | 本月消耗 / 当前总额度 |
| 已授权模型数 | |
| 到期时间 | 试用取试用到期，正式取合同到期；30 天内到期标黄 |
| 归属销售 | |
| 最后活跃时间 | 租户内任一成员的最后调用时间 |

**排序**：默认按最后活跃时间倒序。支持按可用额度、消耗率、占用率、到期时间排序。

**风险视图**（预置筛选器，一键切换）：

1. 额度告警：可用余额 ≤ 5%
2. 席位超卖：占用数 > 总数
3. 即将到期：30 天内到期
4. 长期不活跃：30 天无调用
5. 试用即将到期：7 天内到期

### 11.2 单租户详情

顶部为租户信息条（名称、编码、状态、等级、归属销售、到期时间）+ 状态操作区（停用/恢复/转正式/注销）。

下方 5 个 tab：

| Tab | 内容 | 章节 |
|---|---|---|
| 基本信息 | 基本信息、管理员、生命周期时间线 | 6.3 |
| 席位 | 总览卡片、授予单列表、占用明细 | 7.6 |
| 额度 | 余额卡片、授予单列表、流水、配置 | 8.6 |
| 模型 | 授权总览、授权列表、批量授权 | 9.5 |
| 审计 | 该租户相关的平台侧操作日志 | 15 |

### 11.3 平台看板

首页看板指标：

1. 租户数（总数 / 正式 / 试用 / 停用）
2. 席位总量（已授予 / 已占用 / 占用率）
3. 额度（累计发放 / 累计消耗 / 当前在途余额）
4. 本月新增租户、本月转化（试用→正式）数与转化率
5. 风险清单：额度告警、席位超卖、即将到期、试用即将到期（各展示 Top 10，点击跳转对应风险视图）
6. 模型使用分布：按模型的租户数与消耗占比

### 11.4 导出

支持导出的场景与权限点：

| 导出内容 | 权限点 |
|---|---|
| 租户总览列表（当前筛选结果） | `platform.tenant.view` |
| 席位占用明细 | `platform.seat.export` |
| 额度流水 | `platform.quota.export` |
| 审计日志 | `platform.audit.export` |

导出统一为 xlsx，异步生成，完成后站内信通知并提供下载链接，链接有效期 7 天。单次导出上限 10 万行，超出需缩小筛选范围。

---

## 12. 数据模型

以下为参考实现中真实落地的 13 张表（`src/domain/types.ts` + `src/store/store.ts`），字段名与代码一致。类型用中性写法，不绑定具体数据库方言。

### 12.1 tenant（租户主表）

```
id              string   PK
code            string   UK  租户编码 T+8 位数字，创建后不可变
name            string   UK  企业全称，注销二次确认以当前值为准
shortName       string?      简称
industry        string?
level           enum?        strategic | key | normal | longtail
ownerSalesId    string?      归属销售，通知路由依据
contactName     string       预警与到期通知收件人
contactEmail    string
contactPhone    string?
emailDomains    string[]     成员邮箱域名白名单
contractNo      string?
contractStartAt timestamp?
contractEndAt   timestamp?   影响授予单默认有效期与「即将到期」判定
remarks         json[]       追加式备注 {at, operatorId, text}
tags            string[]

status          enum         pending|trialing|active|suspended|deregistering|deregistered
suspendReason   enum?        trial_expired|arrears|manual|violation

timezone        string       账期与清零任务基准，默认 Asia/Shanghai
retentionDays   int          注销保留期，7~180，默认 30

seatOversellPercent int?     null=硬限；数字=允许超卖百分比，上限 20
seatGraceDays       int      席位到期宽限天数，0~30，默认 7
seatReduceStrategy  enum     reject | defer | force，默认 reject

quotaWarnThresholds json     {notice, alert, exhausted}，null 表示关闭该档
exhaustPolicy       enum     hard_stop | overdraft | degrade
overdraftLimitCredit int     overdraft 下允许透支的 credit
overdraftUsedCredit  int     已透支 credit，下次发放优先偿还
firedWarnings        json     {账期: [已触发档位]}，防抖动重复通知

allowSelfHostedChannel bool  自建渠道总开关
modelLimits            json  租户级 {tpm, rpm, concurrency}

trialPlanId     string?
trialExpireAt   timestamp?
trialTotalDays  int          累计试用天数（含延期），上限 90
allowRecharge   bool         试用期是否允许充值

deregisterAt       timestamp?
purgeAt            timestamp?  = deregisterAt + retentionDays
deregisterSnapshot json?       恢复用快照，含三组待还原 id

createdAt, updatedAt timestamp
```

索引：`UK(name)`、`UK(code)`、`IDX(status, level)`、`IDX(ownerSalesId)`、`IDX(purgeAt)` 供每日任务扫描。

### 12.2 tenant_seat_grant（席位授予单）

```
id            string  PK
no            string  UK   SG-YYMM-NNN
tenantId      string  FK
seatCount     int          正整数
seatType      enum         standard（本期单一类型，字段预留）
source        enum         contract|trial|gift|compensation
effectiveAt   timestamp
expireAt      timestamp?   null=永久，仅 contract 允许
status        enum         active|expired|revoked
contractNo    string?
remark        string?
pendingReduceTo int?       策略 B 延期缩容目标
pendingReduceAt timestamp?
operatorId    string
reason        string?
createdAt     timestamp
```

索引：`IDX(tenantId, status)`、`IDX(expireAt)` 供宽限期扫描。

**关键约束**：扩容一律 INSERT 新行，不 UPDATE 已有行。有效席位总数为查询派生值，不落库：

```
seatTotal(tenant, t) = Σ seatCount
  WHERE tenantId = ? AND status = 'active'
    AND effectiveAt <= t
    AND (expireAt IS NULL OR t < expireAt + seatGraceDays)
```

### 12.3 tenant_seat_assignment（席位占用）

```
id            string  PK
tenantId      string  FK
memberId      string
memberName    string
memberEmail   string
teamId        string?
isAdmin       bool         企业管理员永不被自动回收
boundAt       timestamp
lastActiveAt  timestamp?   null 视为从未登录，强制回收时排最前
memberStatus  enum         active|disabled（停用仍占席位）
releasedAt    timestamp?   null = 占用中
releaseReason enum?        member_deleted|member_resigned|force_released|tenant_purged|trial_revoked
```

索引：`UK(tenantId, memberId) WHERE releasedAt IS NULL`、`IDX(tenantId, releasedAt)`。

### 12.4 tenant_quota_grant（额度授予单）

```
id             string PK
no             string UK    QG-YYMM-NNN，对应租户侧「充值单号」
tenantId       string FK
book           enum         purchased | gift
amountCredit   int          原始金额，任何情况下不可变
source         enum         contract|trial|gift|compensation|adjustment
effectiveAt    timestamp
expireAt       timestamp?   gift 强制为当月月末
status         enum         pending|active|expired|revoked
contractNo     string?
reason         string?
operatorId     string
consumedCredit int          已扣减
revokedCredit  int          已回收
expiredCredit  int          已过期作废
createdAt      timestamp
```

余额派生：`remaining = amountCredit − consumedCredit − revokedCredit − expiredCredit`

### 12.5 quota_ledger（额度流水）

```
id                 string PK
tenantId           string FK
occurredAt         timestamp    业务发生时刻，非入库时刻
period             string       YYYY-MM，按租户时区归属
direction          enum         in | out
bizType            enum         grant|gift|consume|revoke|adjustment|expire
book               enum         purchased | gift
amountCredit       int
balanceAfterCredit int          变动后总可用余额快照
grantId            string?
teamId             string?      消耗下钻维度
modelCode          string?      消耗下钻维度
operatorId         string
remark             string?
ticketNo           string?      调账必填
```

索引：`IDX(tenantId, period)`、`IDX(tenantId, bizType)`。

### 12.6 billing_period（账期）

```
id               string PK
tenantId         string FK
period           string      YYYY-MM
openingCredit    int
rechargeCredit   int
consumeCredit    int
expireCredit     int
adjustmentCredit int         调账净额，可正可负，单列
revokeCredit     int
closingCredit    int
status           enum        billing | closed
closedAt         timestamp?
```

闭合公式（代码与测试共同保证）：

```
opening + recharge − consume − expire + adjustment − revoke = closing
```

当期无调账与回收时退化为租户侧现有的 `期初 + 充值 − 消耗 = 期末`。

### 12.7 team_allocation（团队分配，租户侧数据，平台侧只用于校验）

```
id              string PK
tenantId        string FK
teamId          string
teamName        string
allocatedCredit int
updatedAt       timestamp
```

### 12.8 model_catalog（平台模型目录，以 code 为主键）

```
code            string PK
displayName     string
channel         string
vendor          enum    anthropic|openai|azure|deepseek|google|self_hosted
capabilities    enum[]  chat|code|vision|reasoning|embedding
priceMultiplier number
group           string  用于分组授权
status          enum    draft|published|deprecated|offline
publishedAt     timestamp?
offlineAt       timestamp?   设置时距今必须 ≥30 天
createdAt       timestamp
```

### 12.9 tenant_model_grant（租户模型授权）

```
id                  string PK
tenantId            string FK
modelCode           string FK
enabled             bool
isDefault           bool        每租户至多一个
grantMode           enum        group（跟随分组，不可单独取消）| individual
group               string?
effectiveAt         timestamp
expireAt            timestamp?
tpm                 int?
rpm                 int?
concurrency         int?
modelQuotaCapCredit int?        账期内该模型消耗封顶
periodUsedCredit    int         账期切换时清零
periodKey           string?
revokedAt           timestamp?
```

索引：`UK(tenantId, modelCode) WHERE revokedAt IS NULL`。

### 12.10 model_group_follow（分组跟随）

```
id         string PK
tenantId   string FK
group      string
followedAt timestamp
```

模型上架时按此表反查跟随者，自动补授权。

### 12.11 trial_plan（试用套餐模板）

```
id                     string PK
name                   string
seatCount              int
giftCredit             int
modelGroups            string[]
modelCodes             string[]
durationDays           int      ≤90
allowRecharge          bool     默认 false
allowSelfHostedChannel bool     默认 false
concurrencyLimit       int?
expireAction           enum     suspend | keep_readonly
status                 enum     enabled | disabled
createdAt              timestamp
```

### 12.12 tenant_lifecycle_event（生命周期事件）

```
id         string PK
tenantId   string FK
fromStatus enum?
toStatus   enum
reason     string?
detail     string?
operatorId string
at         timestamp
```

### 12.13 platform_audit_log（平台审计日志）

字段结构对齐租户侧管理日志，便于复用同一套查询与导出组件：

```
id         string PK
at         timestamp
actorId    string
actorRole  string
tenantId   string?
objectType string      tenant|seat_grant|seat_assignment|quota_grant|quota_ledger|
                       model_catalog|model_grant|trial|trial_plan|billing_period|tenant_admin
objectId   string?
action     string
summary    string      变更摘要
source     enum        console | api | system
status     enum        success | failure
reason     string?     危险操作必填
diff       json?       逐字段 {from, to}
```

---

## 13. 接口清单

统一前缀 `/platform/v1`。鉴权在参考实现中用 `X-Actor-Id` / `X-Actor-Role` 请求头承载，真实部署替换为 JWT 解析，其余不变。写接口读取 `Idempotency-Key`。

共 45 个端点：

### 13.1 租户

| 方法 | 路径 | 权限点 | 说明 |
|---|---|---|---|
| GET | `/tenants` | `platform.tenant.view` | 总览列表，支持 status/level/keyword/sort 等 query |
| POST | `/tenants` | `platform.tenant.create` | 创建 + 按 `provisioning.mode` 开通 |
| GET | `/tenants/:id` | `platform.tenant.view` | 详情五视图 |
| PATCH | `/tenants/:id` | `platform.tenant.edit` | 逐字段 diff 留痕 |
| POST | `/tenants/:id/suspend` | `platform.tenant.suspend` | 需 reason ≥10 字符 |
| POST | `/tenants/:id/resume` | `platform.tenant.suspend` | trial_expired 不可走此接口 |
| POST | `/tenants/:id/deregister` | `platform.tenant.deregister` | 需 confirmName 完全匹配 |
| POST | `/tenants/:id/restore` | `platform.tenant.restore` | 保留期内恢复 |
| POST | `/tenants/:id/purge` | `platform.tenant.purge` | 提前清除 |

### 13.2 席位

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET | `/tenants/:id/seat-overview` | `platform.seat.view` |
| GET | `/tenants/:id/seat-grants` | `platform.seat.view` |
| POST | `/tenants/:id/seat-grants` | `platform.seat.grant` |
| POST | `/seat-grants/:gid/reduce` | `platform.seat.reduce`（force 另需 `force_release`） |
| POST | `/seat-grants/:gid/revoke` | `platform.seat.revoke` |
| POST | `/seat-grants/:gid/renew` | `platform.seat.renew` |
| GET | `/tenants/:id/seat-assignments` | `platform.seat.view` |
| POST | `/tenants/:id/seat-assignments/:mid/force-release` | `platform.seat.force_release` |

缩容请求体与冲突响应：

```jsonc
// POST /platform/v1/seat-grants/sg_000001/reduce
{ "targetCount": 5, "strategy": "reject", "reason": "合同缩减席位数量至五个" }

// 409 SEAT_REDUCE_CONFLICT
{
  "code": "SEAT_REDUCE_CONFLICT",
  "message": "缩容后席位总数 5 低于当前占用 8，需先释放 3 个席位",
  "details": { "targetCount": 5, "seatTotalAfter": 5, "occupied": 8, "mustRelease": 3 }
}
```

`strategy: "force"` 时可带 `confirmedMemberIds`，与系统计算的回收名单不一致则返回 `VALIDATION_ERROR`，防止前端展示的名单与实际执行的不同。

### 13.3 额度

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET | `/tenants/:id/quota` | `platform.quota.view` |
| GET | `/tenants/:id/quota-grants` | `platform.quota.view` |
| POST | `/tenants/:id/quota-grants` | `platform.quota.grant` / `.gift`（按 body.book 分派） |
| POST | `/quota-grants/:gid/confirm` | `platform.quota.grant` |
| POST | `/quota-grants/:gid/revoke` | `platform.quota.revoke` |
| POST | `/tenants/:id/quota-adjustments` | `platform.quota.adjust` |
| GET | `/tenants/:id/quota-ledger` | `platform.quota.view` |
| POST | `/tenants/:id/billing-periods/:period/close` | `platform.quota.view` + 出账权限 |
| GET | `/tenants/:id/reconciliation/:period` | `platform.quota.view` |

```jsonc
// POST /platform/v1/tenants/t_1/quota-grants
// Header: Idempotency-Key: rc-2608-0001
{ "amountCredit": 1000000, "book": "purchased", "source": "contract",
  "contractNo": "HT-2026-0421", "pending": true }

// POST /platform/v1/tenants/t_1/quota-adjustments
{ "direction": "in", "book": "purchased", "amountCredit": 5000,
  "reason": "网关重复计费导致多扣，按工单补偿", "ticketNo": "INC-2026-031" }
```

### 13.4 模型

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET | `/model-catalog` | `platform.model_catalog.view` |
| POST | `/model-catalog` | `platform.model_catalog.create` |
| POST | `/model-catalog/:code/publish` | `platform.model_catalog.publish` |
| POST | `/model-catalog/:code/schedule-offline` | `platform.model_catalog.publish` |
| POST | `/model-catalog/:code/offline` | `platform.model_catalog.publish` |
| GET | `/tenants/:id/model-grants` | `platform.model_grant.view` |
| POST | `/tenants/:id/model-grants` | `platform.model_grant.grant`（带 `group` 则为分组授权） |
| DELETE | `/tenants/:id/model-grants/:code` | `platform.model_grant.revoke` |
| DELETE | `/tenants/:id/model-groups/:group` | `platform.model_grant.revoke` |

### 13.5 试用

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET | `/trial-plans` | `platform.trial_plan.view` |
| POST | `/trial-plans` | `platform.trial_plan.create` |
| POST | `/tenants/:id/trial/open` | `platform.trial.open` |
| POST | `/tenants/:id/trial/extend` | `platform.trial.extend` |
| POST | `/tenants/:id/trial/convert` | `platform.trial.convert` |
| POST | `/tenants/:id/trial/terminate` | `platform.trial.terminate` |

### 13.6 看板、审计与任务

| 方法 | 路径 | 权限点 |
|---|---|---|
| GET | `/dashboard` | `platform.dashboard.view` |
| GET | `/risk-views/:view` | `platform.tenant.view` |
| GET | `/audit-logs` | `platform.audit.view` |
| POST | `/jobs/daily-run` | `platform.account.manage`（内部手动触发） |

---

## 14. 关键规则与边界

1. **幂等**：写接口支持 `Idempotency-Key`。同键同参返回首次结果，同键异参返回 `409 IDEMPOTENCY_CONFLICT`。幂等记录以 `key` 与 `key::参数指纹` 两条形式存储。
2. **金额精度**：一律以 credit 整数存储。美元入参必须是两位小数，换算时先按分四舍五入消除 IEEE754 误差再回比，`$10.005` 这类拒绝。消耗侧小数向上取整，取整前先抹掉 1e-6 以下噪声，避免 `3 × 1.1 = 3.3000000000000003` 多进一位。
3. **扣减顺序**：赠送账本优先（按到期升序），其次购买账本（按到期升序，永久最后）。保证客户先花快过期的。
4. **透支记账**：`overdraft` 策略的透支额记在 `tenant.overdraftUsedCredit`，可用余额真实为负；新额度到账时先偿还透支再计入可用。
5. **账期归属**：以 `occurredAt` 落在租户时区的哪个自然月为准，不以入库时间为准。已出账账期冻结，后续调账只能计入当前账期。
6. **缩容与回收冲突**：默认拒绝并返回冲突明细；`defer` 只登记意图不改数量；`force` 需超管、需确认名单、企业管理员永不入候选池。
7. **注销期的占用关系**：注销后席位授予单全部 `revoked`，但占用行保留作为恢复快照。因此 `deregistering` 状态下「占用数 > 席位总数」是设计如此，席位不变式只约束存活态。
8. **模型白名单**：租户可调用集合 ⊆ 平台授权集合。自建渠道是唯一例外，改由 `allowSelfHostedChannel` 总开关控制。
9. **限额取严**：租户级与单模型级配置同时存在时取 `min`，任一为 `null` 表示该级不限制。
10. **状态与权限的顺序**：所有入口固定为「权限校验 → 入参结构校验 → 业务规则校验」，避免缺字段时的异常把 403 盖成 500。

---

## 15. 审计与日志

1. 所有平台侧写操作强制写入 `platform_audit_log`，字段结构与租户侧管理日志一致。
2. 危险操作（注销、清除、额度回收、额度调账、席位强制回收/释放）额外要求 `reason ≥ 10` 字符，理由随日志落库。
3. 编辑类操作记录逐字段 `diff: {字段: {from, to}}`。
4. 系统任务产生的日志 `actorId = system`、`source = system`，与人工操作可区分。
5. 审计日志与账单、授予单、流水同属凭证类数据，**不随租户注销清除**。

---

## 16. 异常与错误码

共 42 个错误码，按前缀分组，HTTP 状态码在代码中集中映射：

| 分组 | 错误码 | HTTP |
|---|---|---|
| 通用 | `VALIDATION_ERROR` | 400 |
| | `REASON_REQUIRED` / `CONFIRM_NAME_MISMATCH` | 400 |
| | `PERMISSION_DENIED` | 403 |
| | `NOT_FOUND` | 404 |
| | `IDEMPOTENCY_CONFLICT` | 409 |
| 租户 | `TENANT_NOT_FOUND` | 404 |
| | `TENANT_NAME_DUPLICATE` / `TENANT_STATE_INVALID` | 409 |
| | `TENANT_SUSPENDED` | 403 |
| | `TENANT_DEREGISTERED` | 410 |
| 席位 | `SEAT_GRANT_NOT_FOUND` / `SEAT_ASSIGNMENT_NOT_FOUND` | 404 |
| | `SEAT_RENEW_BACKWARDS` | 400 |
| | `SEAT_INSUFFICIENT` / `SEAT_REDUCE_CONFLICT` / `SEAT_ALREADY_ASSIGNED` / `SEAT_ADMIN_PROTECTED` | 409 |
| 额度 | `QUOTA_GRANT_NOT_FOUND` | 404 |
| | `QUOTA_AMOUNT_INVALID` / `QUOTA_TICKET_REQUIRED` | 400 |
| | `RECHARGE_NOT_ALLOWED` | 403 |
| | `QUOTA_INSUFFICIENT` / `QUOTA_REVOKE_EXCEEDS_REMAINING` / `QUOTA_GRANT_NOT_PENDING` / `QUOTA_ALLOCATION_EXCEEDS_BALANCE` / `QUOTA_PERIOD_CLOSED` | 409 |
| 模型 | `MODEL_NOT_FOUND` / `MODEL_GRANT_NOT_FOUND` | 404 |
| | `MODEL_OFFLINE_NOTICE_TOO_SHORT` | 400 |
| | `MODEL_NOT_GRANTED` / `SELF_HOSTED_CHANNEL_DISABLED` | 403 |
| | `MODEL_NOT_PUBLISHED` / `MODEL_GROUP_FOLLOWED` / `MODEL_DEFAULT_REQUIRED` | 409 |
| | `MODEL_OFFLINE` | 410 |
| | `RATE_LIMITED` / `MODEL_QUOTA_EXCEEDED` | 429 |
| 试用 | `TRIAL_PLAN_NOT_FOUND` | 404 |
| | `TRIAL_PLAN_DISABLED` / `TRIAL_NOT_ACTIVE` / `TRIAL_MAX_DURATION_EXCEEDED` | 409 |

错误响应统一结构，`details` 承载前端展示冲突明细所需的数据：

```jsonc
{ "code": "SEAT_REDUCE_CONFLICT", "message": "……", "details": { "occupied": 8, "mustRelease": 3 } }
```

---

## 17. 验收标准

按五个子需求逐条给出可验证项。参考实现的自动化测试共 181 例，全部覆盖以下条目。

### 17.1 租户席位管理与分发

1. 席位总数等于有效授予单之和；扩容新建授予单，原授予单不被修改。
2. 每批席位到期时间互相独立，一批过期不影响另一批。
3. 停用成员仍占席位，删除才释放；离职同步释放并记录 `releaseReason`。
4. 缩容策略 A 拒绝并返回 `mustRelease`；策略 B 只登记不改数量，到点由每日任务生效；策略 C 按「从未登录 → 最早活跃 → 最晚创建」顺序回收并通知租户管理员。
5. 企业管理员永不被自动回收；候选不足时返回 `SEAT_ADMIN_PROTECTED`。
6. 硬限下占满即拒绝；软限允许超出配置比例，超卖时向销售与运营告警。
7. 宽限期内已过期席位仍计入总数，届满后退出；届满仍超限则冻结超出成员并置租户为停用。

### 17.2 平台向租户的额度分发

1. `1 credit = $0.01` 双向换算一致，非两位小数金额被拒绝。
2. 购买与赠送分账本；赠送到期时间被强制为当月月末。
3. 待确认授予单不计入余额，确认到账后计入。
4. 回收只能针对未消耗部分，且不修改原授予单金额，只生成反向流水。
5. 调账仅超管、必须带工单号与理由，流水单列不混入充值消耗。
6. 扣减顺序为赠送优先且早到期优先。
7. 账期闭合公式恒成立；上期期末结转为下期期初；已出账不可重复出账。
8. 三种耗尽策略行为正确：`hard_stop` 停用并在补额度后自动恢复、`overdraft` 余额真实为负且到账优先偿还、`degrade` 仅放行基础模型集。
9. 团队分配总额不得超过可用余额。

### 17.3 平台向租户的模型管理

1. 未上架模型不可授权；弃用后存量可用、增量禁止。
2. 下线时间距今不足 30 天被拒绝；安排下线时向全部已授权租户发通知。
3. 正式下线撤销所有授权，调用返回 `MODEL_OFFLINE`。
4. 分组授权后，该分组新上架模型自动授权；未跟随的租户不受影响。
5. 跟随分组的模型不能单独取消。
6. 撤销默认模型时自动接管；撤销后无可用模型则拒绝。
7. 租户级与单模型限额取最严；单模型额度上限用尽返回 `MODEL_QUOTA_EXCEEDED`，账期切换后清零。
8. 自建渠道受总开关控制且不受白名单约束。

### 17.4 租户生命周期

1. 六个状态的能力矩阵与 6.1 表格逐项一致。
2. 非法流转被拒绝；每次流转写入生命周期事件。
3. 人工停用需理由；停用后仍可下发资源以支持先补额度后恢复。
4. 试用到期停用只能通过转正式恢复。
5. 注销需名称完全匹配与理由；注销后授予单回收、模型授权撤销、占用关系保留。
6. 保留期内可恢复且按快照原样还原；届满自动清除。
7. 清除后业务数据消失，授予单、流水、账单、审计日志保留。
8. 已注销是终态。

### 17.5 试用管理标准化

1. 模板必须指定模型集，时长不超过 90 天；停用模板不影响存量试用。
2. 开通按模板一次性下发席位、赠送额度、模型授权，到期时间一致。
3. 试用期默认不可充值、不可自建渠道，模板可覆盖。
4. 延期同步顺延三类资源到期时间；累计超过 90 天被拒绝。
5. 转正式时试用席位保留叠加、赠送额度立即作废、模型授权解除到期限制。
6. 到期前 7/3/1 天各提醒一次；到期自动收口且不自动注销。

### 17.6 查询（父需求）

1. 总览行同时给出席位、额度、模型三个维度。
2. 五个风险视图筛选结果正确。
3. 看板给出租户数、席位、额度、转化率与模型消耗分布。
4. 详情页返回五个 tab 所需的全部数据。

---

## 18. 开放问题

以下五条在参考实现中已按默认方案落地，但属于需要业务侧拍板的决策，落地前请确认：

| # | 问题 | 当前默认 | 影响面 |
|---|---|---|---|
| 1 | 席位是否区分类型（开发者/只读席位） | 单一 `standard` 类型，`seatType` 字段已预留 | 影响计费口径与席位分发 UI |
| 2 | 注销后未消耗的购买额度是否退款 | 系统只固化余额快照，退款走线下财务流程 | 影响注销流程与合同条款 |
| 3 | 同一企业是否允许重复申请试用 | 不判重，由运营人工把关 | 影响试用滥用风险 |
| 4 | 租户之间是物理隔离还是逻辑隔离 | 逻辑隔离（全表带 `tenantId`） | 影响架构与合规承诺 |
| 5 | 平台模型授权与租户侧渠道配置冲突时以谁为准 | 平台设上限，租户只能收紧不能放宽 | 影响客户自主权预期 |

另有两项实现层面的已知简化，生产化时需替换：

1. 存储层为内存实现（`src/store/store.ts`），接口语义已按真实数据库设计，替换时保持读写语义即可。
2. 鉴权用 `X-Actor-Id` / `X-Actor-Role` 请求头承载，需替换为平台侧 JWT 解析。

---

## 12. 数据模型

以下给出字段、类型语义与约束，不写具体 DDL 方言。金额一律用 credit 整数存储。

### 12.1 tenant（租户主表）

```
id                  bigint        主键
tenant_code         string(16)    租户编码 T+8位数字，唯一索引
name                string(128)   租户全称，唯一索引
short_name          string(64)    简称
status              enum          pending|trialing|active|suspended|deregistering|deregistered
suspend_reason      enum          trial_expired|arrears|manual|violation，status=suspended 时非空
industry            string(32)
customer_level      enum          strategic|key|normal|longtail
owner_account_id    bigint        归属销售，关联 platform_account
contact_name        string(64)    非空
contact_email       string(128)   非空
contact_phone       string(32)
email_domains       json          字符串数组，成员邮箱域名白名单，空表示不限制
contract_no         string(64)
contract_start_at   datetime
contract_end_at     datetime
timezone            string(64)    默认 Asia/Shanghai，决定账期与清零时点
billing_day         tinyint       账期起始日，默认 1
seat_overflow_pct   tinyint       席位软限百分比，0 表示硬限，上限 20
seat_grace_days     smallint      席位到期宽限天数，默认 7，范围 0~30
quota_exhaust_policy enum         hard_stop|overdraft|degrade，默认 hard_stop
overdraft_limit     bigint        透支上限（credit），policy=overdraft 时有效
allow_self_channel  bool          是否允许租户自建渠道，默认 false
retention_days      smallint      注销保留期，默认 30，范围 7~180
trial_plan_id       bigint        当前试用套餐，非试用为空
trial_expire_at     datetime      试用到期时间
trial_total_days    smallint      累计试用天数（含延期），用于 90 天上限校验
tags                json          标签数组
remark              text
deregister_at       datetime      发起注销时间
purge_at            datetime      预计彻底清除时间 = deregister_at + retention_days
created_by          bigint
created_at          datetime
updated_at          datetime
```

索引：`status`、`owner_account_id`、`trial_expire_at`、`contract_end_at`、`purge_at`。

### 12.2 tenant_seat_grant（席位授予单）

```
id                  bigint        主键
grant_no            string(32)    SG-YYMM-NNN，唯一索引
tenant_id           bigint
seat_type           enum          standard（本期唯一取值，预留扩展）
seat_count          int           正整数
source              enum          contract|trial|gift|compensation
status              enum          active|expired|revoked
effective_at        datetime      非空
expire_at           datetime      空表示永久，仅 source=contract 允许
grace_until         datetime      = expire_at + tenant.seat_grace_days，冗余字段便于查询
pending_reduce_to   int           延期生效缩容的目标数，空表示无
pending_reduce_at   datetime      延期生效缩容的执行时间
contract_no         string(64)
reason              text          缩容/回收时必填
created_by          bigint
created_at          datetime
updated_at          datetime
```

索引：`(tenant_id, status)`、`expire_at`、`pending_reduce_at`。

约束：`seat_count > 0`；`expire_at is null or expire_at > effective_at`。

### 12.3 tenant_seat_assignment（席位占用）

```
id                  bigint        主键
tenant_id           bigint
member_id           bigint        租户侧成员 ID
seat_type           enum          standard
status              enum          occupied|released
assigned_at         datetime
released_at         datetime
release_reason      enum          member_deleted|member_resigned|force_released|tenant_purged
released_by         bigint        平台强制释放时记录操作人，否则为空
```

索引：唯一索引 `(tenant_id, member_id, status)` 且仅对 `status='occupied'` 生效（部分唯一索引），保证一个成员在一个租户内至多占一个席位。

`seat_occupied(tenant) = count(*) where tenant_id=? and status='occupied'`

### 12.4 tenant_quota_grant（额度授予单）

```
id                  bigint        主键
grant_no            string(32)    QG-YYMM-NNN，唯一索引，即租户侧「充值单号」
tenant_id           bigint
ledger_type         enum          purchased|gift
amount_credit       bigint        正整数，credit
consumed_credit     bigint        已从本单消耗的额度，冗余字段，用于回收时计算可回收上限
revoked_credit      bigint        已回收金额
source              enum          contract|trial|gift|compensation|adjustment
status              enum          pending|active|expired|revoked
effective_at        datetime
expire_at           datetime      gift 强制为当月月末 23:59:59；purchased 可空
contract_no         string(64)
reason              text          revoke/adjustment 必填
ticket_no           string(64)    调账必填的工单/事故编号
created_by          bigint
confirmed_by        bigint        确认到账的操作人
confirmed_at        datetime
created_at          datetime
updated_at          datetime
```

索引：`(tenant_id, ledger_type, status)`、`expire_at`。

约束：`amount_credit > 0`；`consumed_credit + revoked_credit <= amount_credit`。

### 12.5 tenant_quota_ledger（额度流水）

每一笔额度变动一条，是余额的唯一真相来源。**只追加，不更新，不删除**。

```
id                  bigint        主键
tenant_id           bigint
grant_id            bigint        关联授予单，消耗类流水指向被扣减的授予单
ledger_type         enum          purchased|gift
direction           enum          in|out
biz_type            enum          grant|gift|consume|revoke|adjust|expire
amount_credit       bigint        正整数，方向由 direction 表达
balance_after       bigint        该账本变动后的余额，用于对账与回溯
billing_period      string(7)     账期 YYYY-MM，按 tenant.timezone 计算
occurred_at         datetime      业务发生时间，决定账期归属
ref_type            enum          team|model|member|system，消耗类流水的关联维度
ref_id              bigint
operator_id         bigint        系统触发记 0
remark              text
created_at          datetime
```

索引：`(tenant_id, ledger_type, occurred_at)`、`(tenant_id, billing_period)`、`grant_id`。

约束：`amount_credit > 0`；同一 `(tenant_id, ledger_type)` 下按 `id` 递增时 `balance_after` 必须自洽。

### 12.6 platform_model_catalog（平台模型目录）

```
id                  bigint        主键
model_code          string(64)    唯一索引
display_name        string(128)
channel_name        string(64)    所属渠道
vendor              enum          anthropic|openai|azure|deepseek|google|self_hosted
capabilities        json          chat|code|vision|reasoning|embedding
price_ratio         decimal(8,4)  计价倍率
group_code          enum          basic|advanced|experimental
status              enum          draft|published|deprecated|offline
online_at           datetime
offline_at          datetime      下线时间，设置时必须距今 ≥30 天
created_by          bigint
created_at          datetime
updated_at          datetime
```

### 12.7 tenant_model_grant（租户模型授权）

```
id                  bigint        主键
tenant_id           bigint
model_code          string(64)
grant_mode          enum          by_group（跟随分组）|by_model（单独授权）
group_code          enum          grant_mode=by_group 时非空
enabled             bool          默认 true
is_default          bool          每租户至多一条为 true
effective_at        datetime
expire_at           datetime
tpm_limit           int           空表示不限
rpm_limit           int           空表示不限
concurrency_limit   int           空表示不限
model_quota_cap     bigint        单模型账期额度上限（credit），空表示不限
period_consumed     bigint        当前账期已消耗，账期切换时清零
created_by          bigint
created_at          datetime
updated_at          datetime
```

索引：唯一索引 `(tenant_id, model_code)`；`(tenant_id, is_default)` 保证唯一默认。

### 12.8 trial_plan（试用套餐模板）

```
id                  bigint        主键
name                string(64)    唯一
seat_count          int
gift_credit         bigint
model_scope_type    enum          group|models
model_groups        json          model_scope_type=group 时的分组数组
model_codes         json          model_scope_type=models 时的模型数组
duration_days       smallint
allow_recharge      bool          默认 false
allow_self_channel  bool          默认 false
concurrency_limit   int
expire_action       enum          suspend|keep_readonly，默认 suspend
status              enum          enabled|disabled
created_by          bigint
created_at          datetime
updated_at          datetime
```

### 12.9 tenant_lifecycle_event（生命周期事件）

```
id                  bigint        主键
tenant_id           bigint
event_type          enum          create|open_trial|extend_trial|convert|suspend|resume
                                  |terminate_trial|deregister|restore|purge
from_status         enum
to_status           enum
reason              text
snapshot            json          注销时固化的资源快照（席位数、两类余额、模型授权列表）
operator_id         bigint        系统触发记 0
occurred_at         datetime
```

索引：`(tenant_id, occurred_at)`。

### 12.10 platform_audit_log（平台审计日志）

字段结构对齐租户侧管理日志（`tokenhub_audit_log.html`），补平台侧维度：

```
id                  bigint        主键
occurred_at         datetime      时间
operator_id         bigint        操作人
operator_name       string(64)    冗余，操作人可能被删除
operator_role       string(64)    角色
target_type         enum          tenant|seat_grant|seat_assignment|quota_grant
                                  |model_catalog|model_grant|trial_plan|platform_account
target_id           bigint        操作对象
target_name         string(128)   操作对象名称，冗余
tenant_id           bigint        涉及的租户，非租户级操作为空
action              string(64)    操作类型，即权限点编码
change_summary      text          变更摘要，人类可读
change_detail       json          逐字段 diff：{field: {before, after}}
reason              text          危险操作的必填理由
source              enum          console|api|system
client_ip           string(64)
result              enum          success|failure
error_code          string(64)    失败时的错误码
```

索引：`occurred_at`、`(tenant_id, occurred_at)`、`operator_id`、`action`。

**审计日志不可删除、不可修改**。租户侧管理日志有「清除历史日志」功能，平台侧**不提供**该功能 —— 平台侧日志是合规凭证。归档策略见 15.3。

### 12.11 platform_account / platform_role（平台账号与角色）

复用租户侧已有的角色-权限集模型，只是数据隔离在平台侧：

```
platform_account:  id, username, display_name, email, phone, status, last_login_at, created_at
platform_role:     id, name, type(system|custom), description, created_at
platform_role_permission: role_id, permission_code
platform_account_role:    account_id, role_id
```

权限点取值来自 5.2 的清单。

---

## 13. 接口清单

统一前缀 `/platform/v1`。所有接口要求平台侧登录态，且校验对应权限点。

### 13.1 租户生命周期

| 方法 | 路径 | 说明 | 权限点 | 幂等 |
|---|---|---|---|:---:|
| GET | `/tenants` | 租户列表，支持 11.1 的全部筛选与排序 | `platform.tenant.view` | — |
| GET | `/tenants/{id}` | 租户详情 | `platform.tenant.view` | — |
| POST | `/tenants` | 创建租户 | `platform.tenant.create` | ✓ |
| PATCH | `/tenants/{id}` | 编辑基本信息 | `platform.tenant.edit` | — |
| POST | `/tenants/{id}/admin` | 设置/变更租户管理员 | `platform.tenant_admin.config` | — |
| POST | `/tenants/{id}/suspend` | 停用 | `platform.tenant.suspend` | ✓ |
| POST | `/tenants/{id}/resume` | 恢复 | `platform.tenant.suspend` | ✓ |
| POST | `/tenants/{id}/deregister` | 发起注销 | `platform.tenant.deregister` | ✓ |
| POST | `/tenants/{id}/restore` | 保留期内恢复 | `platform.tenant.restore` | ✓ |
| POST | `/tenants/{id}/purge` | 提前彻底清除 | `platform.tenant.purge` | ✓ |
| GET | `/tenants/{id}/lifecycle-events` | 生命周期时间线 | `platform.tenant.view` | — |
| POST | `/tenants/batch-import` | 批量创建 | `platform.tenant.create` | ✓ |

创建租户请求示例：

```json
{
  "name": "北京某某科技有限公司",
  "short_name": "某某科技",
  "customer_level": "key",
  "owner_account_id": 1024,
  "contact_name": "张三",
  "contact_email": "zhangsan@example.com",
  "contact_phone": "13800000000",
  "email_domains": ["example.com"],
  "timezone": "Asia/Shanghai",
  "open_mode": "trial",
  "trial_plan_id": 2,
  "first_admin": {
    "name": "张三",
    "email": "zhangsan@example.com",
    "phone": "13800000000"
  },
  "idempotency_key": "create-tenant-20260804-001"
}
```

响应：

```json
{
  "tenant_id": 8801,
  "tenant_code": "T00008801",
  "status": "trialing",
  "trial_expire_at": "2026-08-18T00:00:00+08:00",
  "console_url": "https://console.example.com/t/T00008801",
  "activation_url": "https://console.example.com/activate?token=...",
  "granted": {
    "seat_grant_no": "SG-2608-014",
    "seat_count": 10,
    "quota_grant_no": "QG-2608-031",
    "gift_credit": 20000,
    "model_codes": ["claude-opus-4-7", "claude-sonnet-4-6", "gpt-5"]
  }
}
```

### 13.2 席位

| 方法 | 路径 | 说明 | 权限点 | 幂等 |
|---|---|---|---|:---:|
| GET | `/tenants/{id}/seats` | 席位总览（总数/占用/剩余/即将到期） | `platform.seat.view` | — |
| GET | `/tenants/{id}/seat-grants` | 授予单列表 | `platform.seat.view` | — |
| POST | `/tenants/{id}/seat-grants` | 分发/扩容 | `platform.seat.grant` | ✓ |
| POST | `/seat-grants/{grantId}/reduce` | 缩容 | `platform.seat.reduce` | ✓ |
| POST | `/seat-grants/{grantId}/revoke` | 回收 | `platform.seat.revoke` | ✓ |
| POST | `/seat-grants/{grantId}/renew` | 续期 | `platform.seat.renew` | ✓ |
| GET | `/tenants/{id}/seat-assignments` | 占用明细 | `platform.seat.view` | — |
| POST | `/seat-assignments/{aid}/force-release` | 强制释放 | `platform.seat.force_release` | ✓ |
| POST | `/seat-grants/batch` | 批量分发 | `platform.seat.grant` | ✓ |
| POST | `/tenants/{id}/seat-assignments/export` | 导出占用明细 | `platform.seat.export` | — |

缩容请求与冲突响应示例：

```json
// 请求
{
  "target_seat_count": 30,
  "conflict_policy": "reject",
  "reason": "客户 Q3 合同缩减至 30 个席位",
  "idempotency_key": "reduce-SG-2608-014-v2"
}

// 冲突响应 409
{
  "error_code": "SEAT_REDUCE_CONFLICT",
  "message": "缩容后席位总数低于当前占用数",
  "detail": {
    "target_seat_total": 30,
    "current_occupied": 37,
    "must_release": 7,
    "assignments_url": "/platform/v1/tenants/8801/seat-assignments?status=occupied"
  }
}
```

`conflict_policy=force` 时的响应需回传被回收的成员名单：

```json
{
  "reduced_to": 30,
  "force_released": [
    {"member_id": 91021, "name": "李四", "email": "lisi@example.com", "last_active_at": "2026-05-02T10:11:00+08:00"},
    {"member_id": 91044, "name": "王五", "email": "wangwu@example.com", "last_active_at": null}
  ]
}
```

### 13.3 额度

| 方法 | 路径 | 说明 | 权限点 | 幂等 |
|---|---|---|---|:---:|
| GET | `/tenants/{id}/quota` | 余额总览（购买/赠送分列） | `platform.quota.view` | — |
| GET | `/tenants/{id}/quota-grants` | 授予单列表 | `platform.quota.view` | — |
| POST | `/tenants/{id}/quota-grants` | 发放/赠送 | `platform.quota.grant` / `.gift` | ✓ |
| POST | `/quota-grants/{gid}/confirm` | 确认到账 | `platform.quota.grant` | ✓ |
| POST | `/quota-grants/{gid}/revoke` | 回收 | `platform.quota.revoke` | ✓ |
| POST | `/tenants/{id}/quota-adjust` | 调账 | `platform.quota.adjust` | ✓ |
| GET | `/tenants/{id}/quota-ledger` | 额度流水 | `platform.quota.view` | — |
| PUT | `/tenants/{id}/quota-config` | 预警阈值与耗尽策略 | `platform.quota.config` | — |
| GET | `/tenants/{id}/reconciliation` | 对账视图（按账期） | `platform.quota.view` | — |
| POST | `/quota-grants/batch` | 批量发放 | `platform.quota.grant` | ✓ |
| POST | `/tenants/{id}/quota-ledger/export` | 导出流水 | `platform.quota.export` | — |

发放请求示例：

```json
{
  "ledger_type": "purchased",
  "amount_credit": 1000000,
  "source": "contract",
  "effective_at": "2026-08-05T00:00:00+08:00",
  "expire_at": null,
  "contract_no": "CT-2026-0813",
  "status": "pending",
  "idempotency_key": "grant-CT-2026-0813-01"
}
```

对账响应示例：

```json
{
  "billing_period": "2026-07",
  "platform": {"granted": 500000, "consumed": 169180, "closing_balance": 842050},
  "tenant":   {"recharged": 500000, "consumed": 169180, "closing_balance": 842050},
  "matched": true,
  "diffs": []
}
```

### 13.4 模型

| 方法 | 路径 | 说明 | 权限点 | 幂等 |
|---|---|---|---|:---:|
| GET | `/model-catalog` | 平台模型目录 | `platform.model_catalog.view` | — |
| POST | `/model-catalog` | 新增条目 | `platform.model_catalog.create` | ✓ |
| PATCH | `/model-catalog/{mid}` | 编辑 | `platform.model_catalog.edit` | — |
| POST | `/model-catalog/{mid}/publish` | 上架 | `platform.model_catalog.publish` | ✓ |
| POST | `/model-catalog/{mid}/offline` | 下架（需 offline_at ≥ 今日+30 天） | `platform.model_catalog.publish` | ✓ |
| GET | `/tenants/{id}/model-grants` | 租户模型授权列表 | `platform.model_grant.view` | — |
| PUT | `/tenants/{id}/model-grants` | 全量覆盖式授权（穿梭框提交） | `platform.model_grant.grant` | ✓ |
| DELETE | `/tenants/{id}/model-grants/{code}` | 撤销单个授权 | `platform.model_grant.revoke` | ✓ |
| PATCH | `/tenants/{id}/model-grants/{code}/limits` | 配置限速与限额 | `platform.model_grant.limit` | — |

### 13.5 试用

| 方法 | 路径 | 说明 | 权限点 | 幂等 |
|---|---|---|---|:---:|
| GET | `/trial-plans` | 套餐模板列表 | `platform.trial_plan.view` | — |
| POST | `/trial-plans` | 新建模板 | `platform.trial_plan.create` | ✓ |
| PATCH | `/trial-plans/{pid}` | 编辑模板 | `platform.trial_plan.edit` | — |
| POST | `/trial-plans/{pid}/disable` | 停用模板 | `platform.trial_plan.disable` | ✓ |
| POST | `/tenants/{id}/trial/open` | 开通试用 | `platform.trial.open` | ✓ |
| POST | `/tenants/{id}/trial/extend` | 延期 | `platform.trial.extend` | ✓ |
| POST | `/tenants/{id}/trial/convert` | 转正式 | `platform.trial.convert` | ✓ |
| POST | `/tenants/{id}/trial/terminate` | 提前终止 | `platform.trial.terminate` | ✓ |

### 13.6 看板与审计

| 方法 | 路径 | 说明 | 权限点 |
|---|---|---|---|
| GET | `/dashboard/summary` | 看板汇总指标 | `platform.dashboard.view` |
| GET | `/dashboard/risks` | 风险清单 | `platform.dashboard.view` |
| GET | `/audit-logs` | 审计日志（支持全维度筛选） | `platform.audit.view` |
| POST | `/audit-logs/export` | 导出审计日志 | `platform.audit.export` |

### 13.7 幂等约定

1. 所有标记「幂等 ✓」的写接口接受 `idempotency_key`（字符串，≤128 字符）。
2. 服务端以 `(account_id, path, idempotency_key)` 为唯一键缓存首次成功响应，有效期 24 小时。
3. 相同 key 重复提交直接返回首次的响应体，不重复执行业务逻辑。
4. 相同 key 但请求体不同，返回 `409 IDEMPOTENCY_KEY_REUSED`。
5. 前端在打开操作弹窗时生成 key，提交失败重试时复用同一 key。

---

## 14. 关键规则与边界

### 14.1 幂等与并发

1. 席位授予、额度发放这类「新增授予单」的操作靠 `idempotency_key` 防重。
2. 席位占用与释放存在并发：多个成员同时激活可能同时通过席位校验。解决方式为在 `tenant_seat_assignment` 上建部分唯一索引 + 占用时对 `tenant` 行加行锁（或用 `seat_occupied` 计数字段做乐观锁 CAS），保证 `occupied ≤ seat_total` 不被击穿。
3. 额度扣减是高频写路径，不适合行锁。采用「预扣 + 异步核销」：调用前按预估 token 预扣，调用结束按实际用量补差。预扣记录超时（默认 15 分钟）未核销则自动释放。
4. 额度余额的权威值来自 `tenant_quota_ledger` 的最新 `balance_after`，不单独维护可变的余额字段。缓存中的余额只用于展示与限流前置判断，最终扣减以流水为准。

### 14.2 时区与账期

1. 一切与「日期」相关的规则（赠送额度清零、账期归属、试用到期、宽限期）按 `tenant.timezone` 计算，不按服务器时区。
2. 跨时区租户的账期边界不同，出账任务需按时区分批调度。
3. 存储一律 UTC，展示按租户时区，接口出参统一带时区偏移的 ISO 8601 格式。

### 14.3 精度与舍入

1. 额度存储为 credit 整数，杜绝浮点累积误差。
2. 美元 ↔ credit：`credit = round(usd × 100)`，仅在输入校验时使用，非整数直接拒绝。
3. 消耗折算若产生小数 credit，向上取整。
4. 展示消耗率、占用率等百分比时保留 1 位小数，不参与任何计算。

### 14.4 缩容与回收冲突

见 7.4。补充边界：

1. 企业管理员账号永不被自动强制回收。
2. 若强制回收后仍无法满足不变式（剩余全是管理员），操作失败，返回 `SEAT_REDUCE_IMPOSSIBLE`。
3. 缩容与并发的成员激活存在竞态：缩容执行时对租户席位加锁，期间成员激活请求排队等待，超时返回 `SEAT_LOCKED_RETRY`。

### 14.5 注销时的资源处置

| 资源 | 保留期内 | 彻底清除后 |
|---|---|---|
| 席位授予单 | 置 `revoked`，记录保留 | 保留（凭证） |
| 席位占用关系 | 保留（用于恢复） | 删除 |
| 额度授予单 | 冻结，记录保留 | 保留（凭证） |
| 额度流水 | 保留 | 保留（凭证） |
| 模型授权 | 撤销，记录保留 | 保留 |
| 租户成员/团队/会话/令牌/使用日志/渠道配置 | 保留（不可访问） | 删除 |
| 账单归档 | 保留 | 保留（凭证） |
| 审计日志 | 保留 | 保留（凭证） |
| 租户主记录 | 保留 | 保留但脱敏（清除联系人姓名/邮箱/手机号） |

### 14.6 数据隔离

1. 所有租户级表带 `tenant_id`，所有查询强制带 `tenant_id` 条件，由 DAO 层统一注入，禁止业务代码自行拼接。
2. 平台侧账号可跨租户查询，但每次跨租户访问写审计日志。
3. 导出文件按租户隔离，文件名含租户编码，下载链接绑定操作人身份。
4. 物理隔离（独立库/独立渠道 key）不在本期范围，见第 18 章。

### 14.7 通知

统一的通知触发点与收件人：

| 事件 | 收件人 | 提前量 |
|---|---|---|
| 额度阈值（20% / 5% / 0） | 租户管理员 + 归属销售（+ 平台运营，5% 起） | 实时 |
| 席位到期 | 租户管理员 + 归属销售 | 30 / 7 / 1 天 |
| 席位强制回收 | 租户管理员 | 实时 |
| 试用到期 | 租户管理员 + 归属销售 + 平台运营 | 7 / 3 / 1 / 0 天 |
| 模型下线 | 已授权租户的管理员 | 30 / 7 / 1 天 |
| 租户注销保留期届满 | 平台超管 + 归属销售 | 7 / 1 天 |
| 合同到期 | 归属销售 | 30 / 7 天 |

同一事件同一收件人在同一天内至多发一次，做去重。

---

## 15. 审计与日志

### 15.1 记录范围

平台侧**所有写操作**必须写审计日志，含失败的操作（`result=failure`，带 `error_code`）。读操作中，跨租户的详情查看与导出也记录。

### 15.2 字段与展示

字段见 12.10。审计日志页面沿用租户侧管理日志的列布局与筛选形式：

展示列：时间、操作人、角色、操作对象、操作类型、变更摘要、涉及租户、来源、结果、详情。

筛选：时间范围、操作类型（按权限点分组的下拉）、操作人、操作对象类型、涉及租户、结果。

「详情」抽屉展示 `change_detail` 的逐字段 diff（before → after）与 `reason` 全文。

### 15.3 保留与归档

1. 审计日志**不提供删除入口**（与租户侧不同）。
2. 在线保留 24 个月，超期数据归档到冷存储，归档后仍可按 tenant + 时间范围检索，但延迟较高。
3. 与资金相关的操作（额度发放、回收、调账）永久保留，不归档。

### 15.4 变更摘要的写法

`change_summary` 是给人看的，必须包含关键数字，不能只写「修改了席位」。示例：

- `向「某某科技」分发 20 个席位（SG-2608-014），有效期至 2027-06-30`
- `将「某某科技」席位授予单 SG-2608-014 从 50 缩容至 30，策略：拒绝冲突`
- `向「某某科技」发放购买额度 $10,000（1,000,000 credit），单号 QG-2608-031，状态：待确认`
- `「某某科技」额度调账 −$120（−12,000 credit），工单 INC-20260804-03，理由：重复扣费修正`

---

## 16. 异常与错误码

| 错误码 | HTTP | 场景 | 前端提示 |
|---|---|---|---|
| `TENANT_NAME_DUPLICATED` | 409 | 租户名称重复 | 该租户名称已存在，请确认是否重复创建 |
| `TENANT_STATUS_INVALID` | 409 | 当前状态不允许该操作 | 租户当前状态为「X」，不支持此操作 |
| `TENANT_SUSPENDED` | 403 | 停用租户的调用 | 服务已暂停，请联系服务方 |
| `TENANT_DEREGISTERING` | 403 | 注销中租户的操作 | 租户处于注销保留期，请先恢复 |
| `TENANT_ADMIN_REQUIRED` | 400 | 创建时未指定管理员 | 请指定租户管理员 |
| `SEAT_INSUFFICIENT` | 409 | 占用时席位不足 | 席位已用尽（X/X），请联系服务方扩容 |
| `SEAT_REDUCE_CONFLICT` | 409 | 缩容后低于占用数 | 缩容后席位数低于当前占用（X），需先释放 N 个 |
| `SEAT_REDUCE_IMPOSSIBLE` | 409 | 强制回收后仍超限 | 剩余均为管理员账号，无法继续回收 |
| `SEAT_LOCKED_RETRY` | 409 | 席位操作并发锁超时 | 席位正在变更中，请稍后重试 |
| `SEAT_GRANT_EXPIRED` | 409 | 操作已过期的授予单 | 该席位授予单已过期 |
| `QUOTA_INSUFFICIENT` | 402 | 额度不足 | 额度不足，请联系服务方充值 |
| `QUOTA_REVOKE_EXCEEDED` | 409 | 回收超过未消耗部分 | 最多可回收 X credit（已消耗部分不可回收） |
| `QUOTA_AMOUNT_INVALID` | 400 | 非整数 credit 或 ≤0 | 金额必须为正数且精确到分 |
| `QUOTA_GRANT_NOT_CONFIRMED` | 409 | 使用未确认到账的额度 | 该充值单尚未确认到账 |
| `MODEL_NOT_GRANTED` | 403 | 调用未授权模型 | 当前套餐不包含该模型 |
| `MODEL_OFFLINE` | 410 | 模型已下线 | 该模型已下线，请切换其他模型 |
| `MODEL_OFFLINE_TOO_SOON` | 400 | 下线时间不足 30 天 | 下线时间需至少距今 30 天 |
| `MODEL_DEFAULT_REQUIRED` | 409 | 撤销后无可用默认模型 | 撤销后租户将无可用模型，请先授权其他模型 |
| `MODEL_QUOTA_EXCEEDED` | 402 | 单模型额度上限 | 该模型本期额度已用尽 |
| `RATE_LIMITED` | 429 | 触发 TPM/RPM/并发 | 请求过于频繁，请稍后重试 |
| `TRIAL_DURATION_EXCEEDED` | 409 | 试用累计超 90 天 | 累计试用已达 90 天上限，需超管审批 |
| `TRIAL_PLAN_DISABLED` | 409 | 使用已停用的模板 | 该试用套餐已停用 |
| `REASON_REQUIRED` | 400 | 危险操作未填理由 | 请填写操作理由（不少于 10 字） |
| `CONFIRM_NAME_MISMATCH` | 400 | 二次确认输入不匹配 | 输入的租户名称不匹配 |
| `IDEMPOTENCY_KEY_REUSED` | 409 | 相同 key 不同请求体 | 请求重复，请刷新后重试 |
| `PERMISSION_DENIED` | 403 | 无权限点 | 无权执行该操作 |
| `EXPORT_ROWS_EXCEEDED` | 400 | 导出超 10 万行 | 数据量过大，请缩小筛选范围 |

---

## 17. 验收标准

按 5 个子需求逐条给可验证项。每条都应能在测试环境上以「操作 → 观察」的方式确认。

### 17.1 租户席位管理与分发

1. 向租户分发 10 个席位后，租户详情席位总数为 10，生成一条 `active` 授予单，审计日志出现对应记录且摘要含数量与有效期。
2. 分两批分发（10 个到 2027-06、20 个到 2027-12），席位总数为 30，授予单列表为两条，到期时间各自独立。
3. 租户侧创建第 11 个成员时被拦截，错误码 `SEAT_INSUFFICIENT`；扩容后可创建。
4. 缩容到低于占用数，策略「拒绝」时返回 `SEAT_REDUCE_CONFLICT` 且响应含 `must_release` 数量与占用明细链接。
5. 缩容策略选「强制回收」时，弹窗展示待回收名单，顺序符合 7.4 的四级规则，管理员不在名单内；执行后被回收成员席位释放，租户管理员收到通知。
6. 停用某成员后席位仍占用；删除该成员后席位释放，剩余可用 +1。
7. 授予单到期后进入宽限期，席位仍可用且界面提示剩余天数；宽限期届满后席位退出总数计算。
8. 开启 10% 软限后，占用数可超出总数 10%，列表标红「席位超卖」；超出 10% 后拦截。
9. 强制释放席位仅超管可操作，未填理由时返回 `REASON_REQUIRED`。
10. 批量向 3 个租户分发席位，返回成功/失败明细，失败项可下载报告。

### 17.2 平台向租户的额度分发

11. 发放 $10,000 购买额度，状态为「待确认」时不计入可用余额；确认到账后可用余额增加 1,000,000 credit。
12. 租户侧「额度充值」列表出现同一单号、金额、类型、到账时间、状态的记录，与平台侧一一对应。
13. 同时存在赠送与购买额度时，消耗优先扣减赠送额度，且优先扣即将到期的。
14. 跨月后赠送额度余额归零，产生一条 `expire` 流水；购买额度不变。
15. 账期出账后，`期初 + 本期充值 − 本期消耗 − 本期过期 = 期末` 成立；无过期额度的账期退化为原公式，租户侧账单展示不变。
16. 回收超过未消耗部分时返回 `QUOTA_REVOKE_EXCEEDED` 并提示可回收上限。
17. 调账需超管 + 工单号 + 理由，缺一即拒；调账流水在租户侧账单中单列，不混入充值与消耗。
18. 余额降至 20% / 5% / 0 各触发一次通知，同一账期内不重复触发。
19. 耗尽策略为 `hard_stop` 时余额归零后调用返回 `QUOTA_INSUFFICIENT` 且租户转 `suspended(arrears)`；补足额度后自动恢复 `active`。
20. 对账视图中平台侧与租户侧的三组数字一致时 `matched=true`；人为制造差异后标红并列出差异明细。

### 17.3 平台向租户的模型管理

21. 未在平台目录 `published` 的模型无法授权给租户。
22. 按「基础模型集」分组授权后，向该组新增一个模型，租户自动获得该模型授权。
23. 单独授权的模型不随分组变化增减。
24. 撤销授权后租户侧该模型立即不可见，调用返回 `MODEL_NOT_GRANTED`。
25. 撤销租户默认模型时自动改选其他可用模型；无其他可用模型时拒绝并返回 `MODEL_DEFAULT_REQUIRED`。
26. 设置下线时间距今不足 30 天时返回 `MODEL_OFFLINE_TOO_SOON`；满足条件时，已授权租户在 30/7/1 天各收到一次通知。
27. 配置 TPM/RPM/并发后超限返回 `RATE_LIMITED`；配置单模型额度上限后超限返回 `MODEL_QUOTA_EXCEEDED`，两者不混淆。
28. 租户侧只能在白名单内配置渠道优先级与权重，无法启用未授权模型。
29. 关闭「允许自建渠道」后，租户侧已有自建渠道被禁用但配置保留；重新开启后恢复。

### 17.4 租户生命周期

30. 三种开通方式各自落到正确的初始状态（`pending` / `trialing` / `active`），且资源授予与开通方式一致。
31. 初始席位数为 0 且选择开通时，创建被拒绝（首个管理员需占位）。
32. 停用租户后成员可登录但模型调用返回 `TENANT_SUSPENDED`，租户侧管理中心为只读；恢复后一切正常。
33. 发起注销后成员立即无法登录，席位授予单转 `revoked`，额度冻结并生成余额快照。
34. 保留期内执行恢复，席位、额度、模型授权按快照原样还原。
35. 保留期届满后自动清除业务数据；授予单、流水、账单、审计日志仍可查询；租户主记录联系人字段已脱敏。
36. 注销与清除的二次确认要求完整输入租户名称，不匹配时返回 `CONFIRM_NAME_MISMATCH`。
37. `deregistered` 为终态，任何恢复操作返回 `TENANT_STATUS_INVALID`。
38. 生命周期时间线完整记录每次状态流转的前后状态、操作人、理由、时间。

### 17.5 试用管理标准化

39. 按「标准试用 14 天」模板开通，一次性生成 10 个席位授予单、20,000 credit 赠送额度授予单、基础模型集授权，三者到期时间一致且为开通时间 +14 天。
40. 试用租户在租户侧看不到「额度充值」入口与「新建渠道」按钮。
41. 试用到期前 7/3/1/0 天各收到一次通知。
42. 到期后按模板的「到期后动作」处理：`suspend` 时资源全部回收；`keep_readonly` 时保留只读访问。
43. 到期后**不会**自动注销，租户停留在 `suspended(trial_expired)` 等待人工处理。
44. 延期后席位、额度、模型授权到期时间同步顺延；累计超过 90 天时返回 `TRIAL_DURATION_EXCEEDED`。
45. 转正式时试用席位保留至原到期时间并与新席位叠加；试用赠送额度立即作废并产生 `expire` 流水；确认弹窗明示作废金额。
46. 停用的试用套餐模板不可用于新开通，但已开通的试用不受影响。

### 17.6 查询与通用

47. 租户总览的 5 个风险视图各能正确筛出对应租户。
48. 席位占用明细、额度流水、审计日志均可导出 xlsx，超 10 万行时返回 `EXPORT_ROWS_EXCEEDED`。
49. 所有写操作在审计日志中可查，含失败操作；`change_summary` 含关键数字。
50. 平台侧审计日志无删除入口。
51. 无权限点的账号访问对应接口返回 `PERMISSION_DENIED`，且前端不展示对应入口。
52. 相同 `idempotency_key` 重复提交不产生第二条授予单，返回首次响应；请求体不同则返回 `IDEMPOTENCY_KEY_REUSED`。

---

## 18. 开放问题

以下问题在本 Spec 中已给出默认方案，标注为「默认」，需在评审时确认或推翻。

| # | 问题 | 本文默认方案 | 影响面 |
|---|---|---|---|
| 1 | 席位是否区分类型（开发者席位 / 只读席位 / 管理席位） | 本期只做单一 `standard` 类型，数据模型预留 `seat_type` 字段 | 若要拆分，7.1~7.6、12.2、12.3 及所有席位接口需按类型维度展开，工作量约 +40% |
| 2 | 租户注销后未消耗的购买额度是否支持退款 | 本系统只固化金额快照，退款走财务线下流程，不在系统内实现 | 若要做，需引入退款单据、审批流与财务对接 |
| 3 | 同一企业是否允许重复申请试用，如何判重 | 本期不做自动判重，仅在创建时按租户名称查重提示 | 若要做，需确定判重维度（企业名/邮箱域名/统一社会信用代码），并引入黑名单 |
| 4 | 租户之间是否需要物理隔离（独立库 / 独立上游渠道 key） | 本期逻辑隔离，所有表带 `tenant_id` | 战略客户若要求独立部署，需要单独的租户路由层，属于架构级改动 |
| 5 | 平台模型授权与租户自建渠道冲突时以谁为准 | 自建渠道不受白名单约束，但受平台「允许自建渠道」总开关控制 | 若要求自建渠道也走白名单，需要租户侧渠道配置增加校验 |
| 6 | 额度耗尽后 `overdraft` 策略的透支上限由谁定 | 按租户配置，默认 0（即等同 hard_stop） | 涉及坏账风险，需与财务确认授信规则 |
| 7 | 账期出账后的调账是否允许回改历史账期 | 不允许，只能计入当前账期 | 若财务要求可回改，需要账单版本化与重新出账机制 |
| 8 | 平台运营是否需要「模拟登录租户」能力 | 本期不做 | 做的话需要独立的模拟登录审计与租户侧授权确认 |
| 9 | 试用累计 90 天上限的超管审批走什么流程 | 本期为「超管直接操作」，无独立审批流 | 若要审批流，需引入工单系统 |
| 10 | 席位到期宽限期届满后若占用超限，是否允许强制回收 | 默认不强制回收，改为冻结超出成员并置租户 `suspended(manual)` 人工介入 | 若允许自动强制回收，客户体验风险较高，需商务确认 |

---

## 附录 A：与租户侧管理中心的改动清单

本 Spec 的非侵入约束下，租户侧仍需以下最小改动：

| 位置 | 改动 | 原因 |
|---|---|---|
| 用户管理 - 成员列表 | 展示「席位占用」列；停用成员时提示「仍占用席位」 | 7.3 释放规则需要可见 |
| 用户管理 - 新建成员 | 席位不足时拦截，提示 `SEAT_INSUFFICIENT` 文案 | 席位不变式 |
| 批量导入成员 | 导入报告增加「跳过：席位不足」类型 | 7.3 |
| 额度管理 - 额度分配 | 分配总和超过可用余额时拦截 | 额度不变式 |
| 额度管理 - 额度充值 | 试用租户隐藏该 tab | 10.3 |
| 额度管理 - 企业账单 | 增加「本期过期」列（无过期时为 0，不影响现有展示） | 8.3 账期公式扩展 |
| 渠道管理 | 模型选择范围限定在平台白名单内；试用/关闭开关时隐藏「新建渠道」 | 9.4、10.3 |
| 全局 | 租户 `suspended` 时切换为只读模式 | 6.1 |

## 附录 B：定时任务清单

| 任务 | 频率 | 说明 | 章节 |
|---|---|---|---|
| 赠送额度清零 | 每月 1 日 00:00（按租户时区分批） | 清零上月赠送余额并写 `expire` 流水 | 8.3 |
| 账期出账 | 每月 1 日 02:00（按租户时区分批） | 生成账单，随后触发对账 | 8.3、8.5 |
| 席位到期检查 | 每日 00:10 | 处理到期与宽限期届满 | 7.5 |
| 试用到期检查 | 每日 00:30 | 按模板执行到期动作 | 10.4 |
| 延期生效缩容执行 | 每日 00:40 | 处理 `pending_reduce_at` 到期的授予单 | 7.4 |
| 注销保留期检查 | 每日 01:00 | 保留期届满执行彻底清除 | 6.4 |
| 通知调度 | 每日 09:00 | 席位/试用/合同/模型下线的提前提醒，去重后发送 | 14.7 |
| 额度预扣超时释放 | 每 5 分钟 | 释放 15 分钟未核销的预扣 | 14.1 |
