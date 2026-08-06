# 平台运营后台

按 [平台运营后台Spec.md](平台运营后台Spec.md) 实现的参考实现：租户席位 / 额度 / 模型 / 生命周期 / 试用。

## 运行

零依赖，不需要 `npm install`。要求 Node ≥ 23.6（原生 TypeScript 类型擦除 + 内置测试运行器）。

```bash
npm start
```

启动后打开 http://localhost:8080 即是控制台，API 在同源的 `/platform/v1` 下。
首次启动会载入演示数据（8 个租户，覆盖正式、试用、欠费停用、席位超卖、注销保留期等场景），
`SEED=0 npm start` 可关闭。

```bash
npm test
```

## 目录

```
src/domain/     类型、错误码、时钟与时区、credit 金额、编号生成、RBAC 权限点
src/store/      存储层（内存实现，表结构见 Spec 第 12 章）
src/services/   tenant / seat / quota / model / trial / query / export / audit / notifier
src/jobs/       每日任务：宽限期届满、赠送额度清零、出账、试用到期、保留期清除
src/api/        HTTP 路由（54 个端点）、node:http 适配、web/ 静态托管
src/dev/        演示种子数据（不参与测试与生产逻辑）
web/            控制台前端，原生 ES Module，无构建步骤
test/           181 个用例，按 Spec 章节组织
```

## 控制台

前端复用现有租户侧管理中心的设计令牌（`web/tokens.css` 由其 `colors_and_type.css` 搬入），
保证两侧同一套视觉。无构建、无第三方依赖。

| 页面 | 覆盖的操作项 |
|---|---|
| 运营看板 | 租户数 / 席位水位 / 在途余额 / 转化率、五个风险清单、模型消耗分布 |
| 租户管理 | 筛选排序、风险视图切换、新建租户（三种开通方式）、导出列表 |
| 租户详情 · 基本信息 | 编辑资料、变更管理员、追加备注、生命周期时间线、停用 / 恢复 / 注销 / 撤销注销 / 立即清除、开通试用 / 延期 / 转正式 / 终止 |
| 租户详情 · 席位 | 分发、缩容（拒绝 / 延期生效 / 强制回收三策略）、回收、续期、强制释放、导出明细 |
| 租户详情 · 额度 | 发放、赠送、确认到账、回收、调账、额度策略、账期出账、对账、导出流水 |
| 租户详情 · 模型 | 授权模型、按分组授权、解除分组、撤销、设为默认、单模型限额、租户级限速、自建渠道开关 |
| 租户详情 · 审计 | 该租户的操作日志与导出 |
| 模型目录 | 新建、上架、安排下线（30 天硬约束）、立即下线 |
| 试用套餐 | 新建、停用 |
| 审计日志 | 全平台日志与导出 |
| 每日任务 | 手动触发并查看执行报告 |

顶栏可切换平台侧四个角色（超管 / 运营 / 商务 / 只读审计），用于验证 Spec 5.2 的权限矩阵：
越权操作会返回 403 并在提示条里显示错误码与缺失的权限点。

## 与 Spec 的对应

| Spec 章节 | 代码 |
|---|---|
| 5 角色与权限（42 个权限点） | `src/domain/rbac.ts` |
| 6 租户生命周期 | `src/services/tenant.ts` |
| 7 席位管理与分发 | `src/services/seat.ts` |
| 8 额度分发与账本 | `src/services/quota.ts` |
| 9 模型目录与授权 | `src/services/model.ts` |
| 10 试用管理 | `src/services/trial.ts` |
| 11 查询与看板 | `src/services/query.ts` |
| 12 数据模型 | `src/domain/types.ts` + `src/store/store.ts` |
| 13 接口清单 | `src/api/router.ts` |
| 16 错误码 | `src/domain/errors.ts` |

## 生产化前需替换

1. `src/store/store.ts` 的内存存储换成真实数据库，保持读写语义。
2. `src/api/router.ts` 的 `X-Actor-Id` / `X-Actor-Role` 请求头鉴权换成 JWT 解析。
3. `src/services/notifier.ts` 只产生通知事件，需接真实的邮件与站内信通道。
4. 每日任务需接调度器（Spec 规定的时点：出账次月 1 日 02:00、试用到期检查每日 00:30）。
