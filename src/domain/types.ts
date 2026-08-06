// 领域类型定义。对应 Spec 第 12 章数据模型。
// 注意：本工程直接由 Node 原生类型擦除运行，不能使用 enum / namespace / 构造器参数属性。

// ── 租户 ────────────────────────────────────────────────────────────────────

/** Spec 6.1 租户状态机 */
export type TenantStatus =
  | 'pending' // 待开通：已创建，未下发资源
  | 'trialing' // 试用中
  | 'active' // 正式
  | 'suspended' // 已停用
  | 'deregistering' // 注销中（保留期）
  | 'deregistered'; // 已注销（终态）

/** Spec 6.1 停用原因 */
export type SuspendReason =
  | 'trial_expired' // 试用到期
  | 'arrears' // 额度耗尽（系统自动）
  | 'manual' // 人工冻结
  | 'violation'; // 违规

export type TenantLevel = 'strategic' | 'key' | 'normal' | 'longtail';

/** Spec 8.4 耗尽策略 */
export type ExhaustPolicy = 'hard_stop' | 'overdraft' | 'degrade';

/** Spec 7.4 缩容冲突策略 */
export type ReduceStrategy = 'reject' | 'defer' | 'force';

export interface QuotaWarnThresholds {
  /** 提醒档：可用余额占比 ≤ 该值。null 表示关闭该档 */
  notice: number | null;
  /** 告警档 */
  alert: number | null;
  /** 耗尽档 */
  exhausted: number | null;
}

export interface TenantRemark {
  at: string;
  operatorId: string;
  text: string;
}

export interface DeregisterSnapshot {
  at: string;
  purchasedBalanceCredit: number;
  giftBalanceCredit: number;
  seatTotal: number;
  seatOccupied: number;
  grantedModelCount: number;
  /** 保留期内恢复时按这三组 id 原样还原（Spec 6.4 第 3 条） */
  revokedSeatGrantIds: string[];
  revokedModelGrantIds: string[];
  frozenQuotaGrantIds: string[];
}

export interface Tenant {
  id: string;
  /** 租户编码 T + 8 位数字，创建后不可修改 */
  code: string;
  /** 企业全称，全局唯一。注销二次确认以当前名称为准 */
  name: string;
  shortName: string | null;
  industry: string | null;
  level: TenantLevel | null;
  ownerSalesId: string | null;
  contactName: string;
  contactEmail: string;
  contactPhone: string | null;
  emailDomains: string[];
  contractNo: string | null;
  contractStartAt: string | null;
  contractEndAt: string | null;
  remarks: TenantRemark[];
  tags: string[];

  status: TenantStatus;
  suspendReason: SuspendReason | null;

  /** 账期与清零任务以租户时区为准 */
  timezone: string;
  /** 注销保留期天数，范围 7 ~ 180 */
  retentionDays: number;

  // 席位策略（Spec 7.5）
  /** null = 硬限；数字 = 允许超卖的百分比，上限 20 */
  seatOversellPercent: number | null;
  /** 席位授予单到期宽限天数，0 ~ 30 */
  seatGraceDays: number;
  /** 宽限期届满仍超限时采用的策略 */
  seatReduceStrategy: ReduceStrategy;

  // 额度策略（Spec 8.4）
  quotaWarnThresholds: QuotaWarnThresholds;
  exhaustPolicy: ExhaustPolicy;
  /** overdraft 策略下允许透支的 credit 数（正数） */
  overdraftLimitCredit: number;
  /** 已透支的 credit（正数）。余额 = 授予单余额 − 已透支，下次发放时优先偿还 */
  overdraftUsedCredit: number;
  /** 已触发过的预警档，按账期记录，避免抖动重复通知 */
  firedWarnings: Record<string, string[]>;

  // 模型策略（Spec 9.3 / 9.4）
  allowSelfHostedChannel: boolean;
  /** 租户级默认限制，与单模型配置取最严 */
  modelLimits: TenantModelLimits;

  // 试用（Spec 10）
  trialPlanId: string | null;
  trialExpireAt: string | null;
  /** 累计试用天数（含所有延期），上限 90 */
  trialTotalDays: number;
  /** 试用期是否允许充值 */
  allowRecharge: boolean;

  // 注销（Spec 6.4）
  deregisterAt: string | null;
  purgeAt: string | null;
  deregisterSnapshot: DeregisterSnapshot | null;

  createdAt: string;
  updatedAt: string;
}

// ── 席位（Spec 7）─────────────────────────────────────────────────────────

export type SeatGrantStatus = 'active' | 'expired' | 'revoked';
export type SeatGrantSource = 'contract' | 'trial' | 'gift' | 'compensation';
/** 本期只做单一席位类型，字段预留给后续区分开发者/只读席位 */
export type SeatType = 'standard';

export interface SeatGrant {
  id: string;
  /** SG-YYMM-NNN */
  no: string;
  tenantId: string;
  seatCount: number;
  seatType: SeatType;
  source: SeatGrantSource;
  effectiveAt: string;
  /** null 表示永久，仅 contract 允许 */
  expireAt: string | null;
  status: SeatGrantStatus;
  contractNo: string | null;
  remark: string | null;
  /** Spec 7.4 策略 B：延期生效的缩容目标 */
  pendingReduceTo: number | null;
  pendingReduceAt: string | null;
  operatorId: string;
  reason: string | null;
  createdAt: string;
}

export type SeatReleaseReason =
  | 'member_deleted'
  | 'member_resigned'
  | 'force_released'
  | 'tenant_purged'
  | 'trial_revoked';

export interface SeatAssignment {
  id: string;
  tenantId: string;
  memberId: string;
  memberName: string;
  memberEmail: string;
  teamId: string | null;
  /** 企业管理员永不被自动强制回收（Spec 7.4） */
  isAdmin: boolean;
  boundAt: string;
  lastActiveAt: string | null;
  /** 停用成员仍占用席位（Spec 7.1） */
  memberStatus: 'active' | 'disabled';
  releasedAt: string | null;
  releaseReason: SeatReleaseReason | null;
}

// ── 额度（Spec 8）─────────────────────────────────────────────────────────

/** 购买额度不清零；赠送额度按月清零 */
export type QuotaBook = 'purchased' | 'gift';
export type QuotaGrantStatus = 'pending' | 'active' | 'expired' | 'revoked';
export type QuotaGrantSource =
  | 'contract'
  | 'trial'
  | 'gift'
  | 'compensation'
  | 'adjustment';

export interface QuotaGrant {
  id: string;
  /** QG-YYMM-NNN，对应租户侧「充值单号」 */
  no: string;
  tenantId: string;
  book: QuotaBook;
  /** credit 整数 */
  amountCredit: number;
  source: QuotaGrantSource;
  effectiveAt: string;
  /** gift 强制为当月月末 */
  expireAt: string | null;
  status: QuotaGrantStatus;
  contractNo: string | null;
  reason: string | null;
  operatorId: string;
  /** 已从该授予单扣减的 credit */
  consumedCredit: number;
  /** 已回收的 credit */
  revokedCredit: number;
  /** 已过期作废的 credit */
  expiredCredit: number;
  createdAt: string;
}

export type LedgerDirection = 'in' | 'out';
export type LedgerBizType =
  | 'grant' // 发放购买额度
  | 'gift' // 发放赠送额度
  | 'consume' // 消耗
  | 'revoke' // 回收
  | 'adjustment' // 人工调账
  | 'expire'; // 过期作废

export interface QuotaLedgerEntry {
  id: string;
  tenantId: string;
  occurredAt: string;
  /** 账期 YYYY-MM，按租户时区归属 */
  period: string;
  direction: LedgerDirection;
  bizType: LedgerBizType;
  book: QuotaBook;
  amountCredit: number;
  /** 变动后该租户的总可用余额 */
  balanceAfterCredit: number;
  grantId: string | null;
  teamId: string | null;
  modelCode: string | null;
  operatorId: string;
  remark: string | null;
  /** 调账必填的工单号 */
  ticketNo: string | null;
}

export type BillingPeriodStatus = 'billing' | 'closed';

/**
 * 账期。闭合公式（Spec 8.3）：
 *   期初 + 充值 − 消耗 − 过期 + 调账净额 − 回收 = 期末
 * 当期无调账与回收时，退化为租户侧现有的 `期初 + 充值 − 消耗 = 期末`。
 */
export interface BillingPeriod {
  id: string;
  tenantId: string;
  period: string;
  openingCredit: number;
  rechargeCredit: number;
  consumeCredit: number;
  expireCredit: number;
  /** 调账净额，可正可负，账单中单列不混入充值/消耗 */
  adjustmentCredit: number;
  revokeCredit: number;
  closingCredit: number;
  status: BillingPeriodStatus;
  closedAt: string | null;
}

/** 租户侧的团队额度分配，平台侧只用于校验额度不变式（Spec 4.3） */
export interface TeamAllocation {
  id: string;
  tenantId: string;
  teamId: string;
  teamName: string;
  allocatedCredit: number;
  updatedAt: string;
}

// ── 模型（Spec 9）─────────────────────────────────────────────────────────

export type ModelStatus = 'draft' | 'published' | 'deprecated' | 'offline';
export type ModelVendor =
  | 'anthropic'
  | 'openai'
  | 'azure'
  | 'deepseek'
  | 'google'
  | 'self_hosted';
export type ModelCapability =
  | 'chat'
  | 'code'
  | 'vision'
  | 'reasoning'
  | 'embedding';

export interface CatalogModel {
  code: string;
  displayName: string;
  channel: string;
  vendor: ModelVendor;
  capabilities: ModelCapability[];
  /** 相对基准的计价倍率 */
  priceMultiplier: number;
  /** 分组，用于批量授权 */
  group: string;
  status: ModelStatus;
  publishedAt: string | null;
  /** 下线时间，设置时距今必须 ≥30 天 */
  offlineAt: string | null;
  createdAt: string;
}

export type GrantMode = 'group' | 'individual';

export interface TenantModelGrant {
  id: string;
  tenantId: string;
  modelCode: string;
  enabled: boolean;
  isDefault: boolean;
  /** group = 跟随分组，分组新增模型自动授权，不可单独取消 */
  grantMode: GrantMode;
  group: string | null;
  effectiveAt: string;
  expireAt: string | null;
  tpm: number | null;
  rpm: number | null;
  concurrency: number | null;
  /** 该模型当前账期的额度消耗封顶 */
  modelQuotaCapCredit: number | null;
  /** 当前账期已消耗，账期切换时清零 */
  periodUsedCredit: number;
  periodKey: string | null;
  revokedAt: string | null;
}

/** 租户级默认限制，与单模型配置取最严（Spec 9.3） */
export interface TenantModelLimits {
  tpm: number | null;
  rpm: number | null;
  concurrency: number | null;
}

/**
 * 租户对模型分组的跟随关系（Spec 9.2）。
 * 跟随后分组内新上架的模型自动授权，单个模型不可单独取消。
 */
export interface ModelGroupFollow {
  id: string;
  tenantId: string;
  group: string;
  followedAt: string;
}

// ── 试用（Spec 10）────────────────────────────────────────────────────────

export type TrialExpireAction = 'suspend' | 'keep_readonly';

export interface TrialPlan {
  id: string;
  name: string;
  seatCount: number;
  giftCredit: number;
  modelGroups: string[];
  modelCodes: string[];
  durationDays: number;
  allowRecharge: boolean;
  allowSelfHostedChannel: boolean;
  concurrencyLimit: number | null;
  expireAction: TrialExpireAction;
  status: 'enabled' | 'disabled';
  createdAt: string;
}

// ── 生命周期与审计（Spec 6.1 / 15）────────────────────────────────────────

export interface LifecycleEvent {
  id: string;
  tenantId: string;
  fromStatus: TenantStatus | null;
  toStatus: TenantStatus;
  reason: string | null;
  detail: string | null;
  operatorId: string;
  at: string;
}

export interface AuditLog {
  id: string;
  at: string;
  actorId: string;
  actorRole: string;
  tenantId: string | null;
  objectType: string;
  objectId: string | null;
  action: string;
  summary: string;
  source: 'console' | 'api' | 'system';
  status: 'success' | 'failure';
  reason: string | null;
  diff: Record<string, unknown> | null;
}

// ── 平台账号（Spec 5.1）───────────────────────────────────────────────────

export type PlatformRole =
  | 'super_admin'
  | 'operator'
  | 'sales'
  | 'auditor';

export interface Actor {
  id: string;
  role: PlatformRole;
  source?: 'console' | 'api' | 'system';
}

/** 系统任务的操作者，用于每日任务写审计（Spec 10.4） */
export const SYSTEM_ACTOR: Actor = {
  id: 'system',
  role: 'super_admin',
  source: 'system',
};
