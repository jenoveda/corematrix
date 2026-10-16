export const MICRO = 1_000_000;
export type User = {
  id: string;
  name: string;
  email: string;
  role: "user" | "admin";
  locale: "zh-CN" | "en-US" | "ja-JP" | "ko-KR";
  emailVerifiedAt: string | null;
};
export type Runtime = {
  artifact: string;
  revision: string;
  dtype: "auto" | "float16" | "bfloat16";
  maxModelLen: number;
  minGpuMemoryMiB: number;
  tensorParallelSize: number;
};
export type Model = {
  id: string;
  name: string;
  tag: string;
  description: string;
  inputPrice: number;
  outputPrice: number;
  gpus: number;
  vram: number;
  enabled: boolean;
  configured: boolean;
  contextTokens: number;
  maxOutputTokens: number;
  upstreamUrl?: string;
  upstreamModel?: string;
  apiKeyEnv?: string;
  routingMode?: "external" | "managed";
  runtime?: Runtime | null;
};
export type Gpu = {
  lastSeenAt: string | null;
  uuid: string;
  index: number;
  name: string;
  totalMemoryMiB: number;
  usedMemoryMiB: number | null;
  utilizationPercent: number | null;
  temperatureC: number | null;
  externalBusy: boolean;
  missing: boolean;
  allocated: boolean;
};
export type Server = {
  workMode: "inference" | "gpu-rental";
  rentalSalesEnabled: boolean;
  hourlyPrice: number;
  id: string;
  name: string;
  region: string;
  inferenceHost: string;
  portStart: number;
  portEnd: number;
  schedulingEnabled: boolean;
  maintenance: boolean;
  status: "pending" | "online" | "offline" | "disabled";
  lastHeartbeatAt: string | null;
  inventoryError: string | null;
  capabilities: {
    dockerReady?: boolean;
    runtimeImageDigest?: string;
    workspaceImageDigest?: string;
    inferenceReady?: boolean;
    workspaceReady?: boolean;
    expirySupported?: boolean;
    renewalSupported?: boolean;
  };
  gpus: Gpu[];
  allocatedGpuCount: number;
  freeGpuCount: number;
};
export type Deployment = {
  workloadType: "inference" | "gpu-rental";
  ownerId: string | null;
  id: string;
  serverId: string;
  modelId: string;
  phase:
    | "queued"
    | "starting"
    | "checking"
    | "ready"
    | "draining"
    | "stopping"
    | "stopped"
    | "failed"
    | "unknown";
  desiredState: string;
  spec: Runtime & {
    workloadType?: "inference" | "gpu-rental";
    gpuUuids: string[];
    endpointPort: number;
    servedModelName: string;
    imageDigest: string;
    apiKeyEnv: string;
  };
  replaces: string | null;
  createdAt: string;
  healthAt: string | null;
  lastError: string | null;
  allocated: boolean;
};
export type Bill = {
  id: string;
  time: string;
  type: "token" | "recharge" | "compute" | "compute_refund" | "recharge_refund";
  resource: string;
  quantity: string;
  amount: number;
  inputPrice?: number;
  outputPrice?: number;
  metadata?: {
    inputTokens?: number;
    outputTokens?: number;
    modelId?: string;
    reason?: string;
    orderId?: string;
    cards?: number;
    hours?: number;
    hourlyPrice?: number;
    chargedSeconds?: number;
    renewal?: boolean;
    streamed?: boolean;
    paymentId?: string;
    provider?: "stripe";
    chargeback?: boolean;
    restored?: boolean;
  } | null;
};
export type BillPage = { data: Bill[]; nextCursor: number | null };
export type RentalOffer = {
  id: string;
  name: string;
  region: string;
  gpuName: string;
  memoryMiB: number;
  availableCards: number;
  hourlyPrice: number;
};
export type PaymentOrder = {
  id: string;
  amount: number;
  credited: number;
  reversed: number;
  review: boolean;
  status:
    | "creating"
    | "open"
    | "paid"
    | "expired"
    | "failed"
    | "refund_pending"
    | "partially_refunded"
    | "refunded";
  createdAt: string;
  expiresAt: string;
  checkedAt: string | null;
  checkoutUrl: string | null;
  email?: string;
};
export type Order = {
  reservationId: string | null;
  scheduledStart: string | null;
  scheduledEnd: string | null;
  id: string;
  deploymentId: string;
  resource: string;
  cards: number;
  hours: number;
  hourlyPrice: number;
  amount: number;
  reserved: number;
  charged: number;
  refunded: number;
  status: "provisioning" | "active" | "stopping" | "completed" | "failed";
  createdAt: string;
  startedAt: string | null;
  expiresAt: string | null;
  confirmedExpiresAt: string | null;
  renewalPending: boolean;
  closedAt: string | null;
  accessReady: boolean;
};
export type Reservation = {
  id: string;
  serverName: string;
  resource: string;
  memoryMiB: number;
  cards: number;
  hours: number;
  hourlyPrice: number;
  amount: number;
  reserved: number;
  status:
    | "booked"
    | "starting"
    | "active"
    | "stopping"
    | "completed"
    | "canceled"
    | "failed";
  startsAt: string;
  endsAt: string;
  createdAt: string;
  closedAt: string | null;
  errorCode: string | null;
  cancelReason: string | null;
  orderId: string | null;
  email?: string;
  serverId?: string;
  gpuUuids?: string[];
  port?: number;
};
export type Summary = {
  revenue: number;
  credits: number;
  users: number;
  requests: number;
  byModel: {
    name: string;
    revenue: number;
    inputTokens: number;
    outputTokens: number;
  }[];
  daily: { day: string; revenue: number }[];
};
export type Expense = {
  id: string;
  category:
    | "equipment"
    | "electricity"
    | "bandwidth"
    | "storage"
    | "operations"
    | "upstream"
    | "other";
  amount: number;
  day: string;
  reason: string;
  reference: string;
  serverId: string | null;
  serverName: string | null;
  actorId: string;
  createdAt: string;
  voidedAt: string | null;
  voidReason: string | null;
  voidActorId: string | null;
};
export type FinancialReport = {
  byModel: Summary["byModel"];
  from: string;
  to: string;
  revenue: number;
  tokenRevenue: number;
  gpuRevenue: number;
  credits: number;
  cost: number;
  costRecorded: boolean;
  profit: number | null;
  daily: { day: string; revenue: number; cost: number }[];
  byCategory: { category: Expense["category"]; amount: number }[];
  expenses: Expense[];
  nextCursor: number | null;
};
export type Reconciliation = {
  checkedAt: string;
  healthy: boolean;
  issues: {
    code: string;
    entityId: string;
    expected: number;
    actual: number;
  }[];
};
export type State = {
  reservations: Reservation[];
  reservationSchedule?: Reservation[];
  paymentsEnabled: boolean;
  paymentDebt: number;
  paymentReview: boolean;
  mailEnabled: boolean;
  user: User | null;
  csrfToken: string;
  balance: number;
  heldBalance: number;
  tokenSpend: number;
  dailyBudget: number;
  account: string;
  email: string;
  registered: boolean;
  hasKey: boolean;
  keyPrefix: string;
  models: Model[];
  servers: Server[];
  deployments: Deployment[];
  bills: Bill[];
  orders: Order[];
  rentals: {
    id: string;
    phase: Deployment["phase"];
    createdAt: string;
    gpuCount: number;
    allocated: boolean;
  }[];
  summary?: Summary;
};
export const emptyState = (): State => ({
  reservations: [],
  paymentsEnabled: false,
  paymentDebt: 0,
  paymentReview: false,
  mailEnabled: false,
  user: null,
  csrfToken: "",
  balance: 0,
  heldBalance: 0,
  tokenSpend: 0,
  dailyBudget: 100 * MICRO,
  account: "访客",
  email: "",
  registered: false,
  hasKey: false,
  keyPrefix: "",
  models: [],
  servers: [],
  deployments: [],
  bills: [],
  orders: [],
  rentals: [],
});
export const money = (micros: number) =>
  new Intl.NumberFormat("zh-CN", {
    style: "currency",
    currency: "CNY",
    minimumFractionDigits: 2,
    maximumFractionDigits: 6,
  }).format(micros / MICRO);
export const modelOnline = (state: State, modelId: string) =>
  state.models.some((m) => m.id === modelId && m.enabled && m.configured);

export type OpsMetric = {
  requests: number;
  errors: number;
  aborted: number;
  errorRate: number;
  averageMs: number | null;
};
export type OpsMetrics = {
  since: string;
  api: OpsMetric;
  inference: OpsMetric;
  agent: OpsMetric;
};
export type OpsAlert = {
  id: string;
  code: string;
  entityId: string;
  severity: "warning" | "critical";
  details: { expected?: number; actual?: number };
  detectedAt: string;
  openedAt: string;
  lastSeenAt: string;
  ackAt: string | null;
  ackActorId: string | null;
  resolvedAt: string | null;
};
export type OperationsReport = {
  attemptAt: string | null;
  successAt: string | null;
  stale: boolean;
  notificationsEnabled: boolean;
  metrics: OpsMetrics;
  alerts: OpsAlert[];
  nextCursor: number | null;
  counts: { active: number; unacknowledged: number; resolved: number };
  notifications: {
    id: string;
    state: "pending" | "sent" | "failed";
    attempts: number;
    createdAt: number;
    sentAt: number | null;
    errorCode: "smtp_failed" | "expired" | "recipient_changed" | null;
  }[];
  deliveryCounts: { pending: number; failed: number };
};

export type ErrorDetails = {
  field?: string;
  min?: number;
  max?: number;
  requiredMiB?: number;
  availableMiB?: number;
  requiredCards?: number;
  availableCards?: number;
  requiredAmount?: number;
  availableAmount?: number;
};
