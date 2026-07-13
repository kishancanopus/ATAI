import {
  getPipelineUserMessage,
  inferStageKeyFromFailureText,
  parseAwsExecutionFailure,
  resolveStageMessage,
  type StageMessageSource,
} from '@/lib/pipelineMessages';

export type StageKey = 'keyword_planner' | 'google_trends' | 'amazon' | 'alibaba';

export type StageStatus = 'SUCCEEDED' | 'FAILED' | 'EMPTY' | 'SKIPPED';

export type PipelineStatus = 'SUCCEEDED' | 'PARTIALLY_SUCCEEDED' | 'FAILED';

export interface StageSummary {
  stage: StageKey | string;
  status: StageStatus | string;
  message: string;
  rows: number;
  /** Legacy field from some Lambdas before resolver normalization */
  rows_processed?: number;
  /** Raw error from Lambda (formatted copy also in message) */
  error?: string;
}

export interface PipelineSummary {
  pipeline_status: PipelineStatus;
  message: string;
  generated_at?: string;
  stages: Partial<Record<StageKey, StageSummary>> & Record<string, StageSummary | undefined>;
}

/** AWS Step Functions execution status from DescribeExecution */
export type AwsExecutionStatus =
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'ABORTED'
  | string;

export interface ExecutionStatusResponse {
  status: AwsExecutionStatus;
  pipeline_summary: PipelineSummary | null;
  startDate?: Date | string;
  stopDate?: Date | string;
  output?: string;
  error?: string;
  cause?: string;
}

const TERMINAL_AWS_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'TIMED_OUT', 'ABORTED']);

export function isTerminalAwsStatus(status: string | undefined | null): boolean {
  return !!status && TERMINAL_AWS_STATUSES.has(status);
}

function normalizeStages(
  stages: Record<string, unknown>
): PipelineSummary['stages'] {
  const result: PipelineSummary['stages'] = {};

  for (const [key, val] of Object.entries(stages)) {
    if (!val || typeof val !== 'object') continue;
    const s = val as Record<string, unknown>;
    const status = String(s.status ?? 'SKIPPED');
    const fallback = `${key.replace(/_/g, ' ')} ${status.toLowerCase()}`;

    result[key] = {
      stage: String(s.stage ?? key),
      status,
      message: resolveStageMessage(s as StageMessageSource, fallback),
      rows: Number(s.rows ?? s.rows_processed ?? 0),
      ...(s.rows_processed != null ? { rows_processed: Number(s.rows_processed) } : {}),
      ...(typeof s.error === 'string' ? { error: s.error } : {}),
    };
  }

  return result;
}

/** Normalize raw pipeline_summary from API / Step Function output */
export function normalizePipelineSummary(raw: unknown): PipelineSummary | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  if (typeof obj.pipeline_status === 'string' && obj.stages && typeof obj.stages === 'object') {
    const status = obj.pipeline_status as PipelineStatus;
    const stages = normalizeStages(obj.stages as Record<string, unknown>);
    return {
      pipeline_status: status,
      message:
        typeof obj.message === 'string'
          ? obj.message
          : `Pipeline execution completed with status ${status}`,
      stages,
      ...(typeof obj.generated_at === 'string' ? { generated_at: obj.generated_at } : {}),
    };
  }

  return null;
}

/**
 * Business-level pipeline health.
 * Prefer pipeline_summary when the execution has finished and the resolver has run.
 */
export function getBusinessPipelineStatus(
  awsStatus: string | undefined | null,
  summary: PipelineSummary | null | undefined
): PipelineStatus | 'RUNNING' | 'ABORTED' {
  if (summary?.pipeline_status) {
    return summary.pipeline_status;
  }

  if (awsStatus === 'ABORTED') {
    return 'ABORTED';
  }

  if (!isTerminalAwsStatus(awsStatus)) {
    return 'RUNNING';
  }

  // Legacy fallback when summary is missing on a terminal execution
  return awsStatus === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED';
}

/** Map business status to frontend pipelineStatus enum */
export function businessStatusToPipelineUi(
  business: PipelineStatus | 'RUNNING' | 'ABORTED'
): 'COMPLETED' | 'FAILED' | null {
  if (business === 'RUNNING') return null;
  if (business === 'ABORTED' || business === 'FAILED') return 'FAILED';
  return 'COMPLETED';
}

/** Aggregate batch status from multiple per-keyword summaries */
export function aggregatePipelineStatuses(
  statuses: (PipelineStatus | null | undefined)[]
): PipelineStatus | 'RUNNING' {
  const resolved = statuses.filter((s): s is PipelineStatus => !!s);
  if (resolved.length === 0) return 'RUNNING';
  if (resolved.every((s) => s === 'FAILED')) return 'FAILED';
  if (resolved.every((s) => s === 'SUCCEEDED')) return 'SUCCEEDED';
  return 'PARTIALLY_SUCCEEDED';
}

/** Per-keyword execution row in category-based search */
export interface CategoryExecution {
  keyword: string;
  run_id: string;
  execution_arn: string;
  /** AWS Step Functions status */
  status?: string;
  started_at?: number | null;
  /** Business pipeline health from resolve_pipeline_status */
  pipeline_status?: PipelineStatus | null;
  pipeline_summary?: PipelineSummary | null;
}

/** Prefer loaded parquet row counts over resolver summary (Amazon may report unique keywords, not products). */
export function resolveStageDisplayRows(
  stageKey: string,
  summaryRows: number | null | undefined,
  loadedRows: number | null | undefined
): number | null {
  const loaded = typeof loadedRows === 'number' && loadedRows >= 0 ? loadedRows : null;
  const summary = typeof summaryRows === 'number' && summaryRows >= 0 ? summaryRows : null;

  if (loaded != null && summary != null) {
    if (stageKey === 'amazon') return Math.max(loaded, summary);
    return loaded > 0 ? loaded : summary;
  }
  return loaded ?? summary ?? null;
}

/** True when resolver produced per-stage entries (not an empty batch placeholder) */
export function hasPipelineStageData(summary: PipelineSummary | null | undefined): boolean {
  if (!summary?.stages || typeof summary.stages !== 'object') return false;
  return Object.keys(summary.stages).length > 0;
}

/** True when summary was created by the frontend 5-minute guard (not AWS) */
export function isClientSyntheticTimeoutSummary(
  summary: PipelineSummary | null | undefined
): boolean {
  if (!summary) return false;
  const messages = [
    summary.message,
    summary.stages?.keyword_planner?.message,
  ]
    .filter(Boolean)
    .map(String);
  return messages.some((m) => m.includes('exceeded the execution time limit'));
}

/** True when local row may disagree with AWS and needs another status fetch */
export function hasStaleCategoryExecutionStatus(exec: CategoryExecution): boolean {
  if (!exec.execution_arn || exec.status === 'ABORTED') return false;

  const awsStatus = String(exec.status ?? '').toUpperCase();
  const summary = exec.pipeline_summary;
  const hasStages = hasPipelineStageData(summary);

  // Client-side timeout was applied before AWS was checked — always re-verify
  if (awsStatus === 'TIMED_OUT' && isClientSyntheticTimeoutSummary(summary)) {
    return true;
  }

  // AWS succeeded but resolver stages never loaded (or only synthetic failure shell)
  if (awsStatus === 'SUCCEEDED' && !hasStages) {
    return true;
  }

  // Local terminal failure with an ARN — verify against AWS before showing FAILED
  if ((awsStatus === 'FAILED' || awsStatus === 'TIMED_OUT') && !hasStages) {
    return true;
  }

  // Synthetic FAILED summary while AWS reports success
  if (awsStatus === 'SUCCEEDED' && summary?.pipeline_status === 'FAILED' && !hasStages) {
    return true;
  }

  return false;
}

/** Resolve the best pipeline summary from a DescribeExecution payload */
export function resolveExecutionPipelineSummary(
  data: ExecutionStatusResponse
): PipelineSummary | null {
  return (
    normalizePipelineSummary(data.pipeline_summary) ??
    extractPartialPipelineSummaryFromOutput(data.output)
  );
}

/** True while a child occupies a concurrent trigger slot (batch limit) */
export function isCategoryExecutionInFlight(exec: CategoryExecution): boolean {
  if (exec.status === 'PENDING' || exec.status === 'FAILED' || exec.status === 'ABORTED') {
    return false;
  }
  if (isTerminalAwsStatus(exec.status) && !hasStaleCategoryExecutionStatus(exec)) {
    return false;
  }
  // Resolver summary with stage data — done for slot counting even if AWS status string is stale
  if (
    exec.pipeline_summary?.pipeline_status &&
    hasPipelineStageData(exec.pipeline_summary)
  ) {
    return false;
  }
  // Only AWS RUNNING with a known ARN occupies a concurrent slot (max 5)
  if (!exec.execution_arn) return false;
  return exec.status === 'RUNNING';
}

/** True when no further Step Function polling is needed for this child */
export function isCategoryExecutionSettled(exec: CategoryExecution): boolean {
  if (exec.status === 'ABORTED') return true;
  if (needsBusinessSummaryRefresh(exec)) return false;

  if (exec.status === 'FAILED' || exec.status === 'TIMED_OUT') {
    return true;
  }
  if (isTerminalAwsStatus(exec.status)) return true;
  if (exec.pipeline_summary?.pipeline_status && hasPipelineStageData(exec.pipeline_summary)) {
    return true;
  }
  return false;
}

export function countInFlightCategoryExecutions(executions: CategoryExecution[]): number {
  return executions.filter(isCategoryExecutionInFlight).length;
}

/** Batch complete when every child is settled and resolver summary is loaded where needed */
export function areAllCategoryExecutionsFinished(executions: CategoryExecution[]): boolean {
  if (executions.length === 0) return false;
  return executions.every(
    (exec) =>
      exec.status !== 'PENDING' &&
      !isCategoryExecutionInFlight(exec) &&
      !needsBusinessSummaryRefresh(exec)
  );
}

const AWS_STATUS_RANK: Record<string, number> = {
  PENDING: 0,
  STARTING: 1,
  RUNNING: 2,
  SUCCEEDED: 3,
  FAILED: 3,
  TIMED_OUT: 3,
  ABORTED: 3,
};

export function categoryKeywordKey(keyword: string): string {
  return (keyword ?? '').trim();
}

/** Monotonic merge — stale polls cannot regress ARN, AWS status, or resolver summary */
export function mergeCategoryExecutionRow(
  existing: CategoryExecution,
  incoming: Partial<CategoryExecution>
): CategoryExecution {
  // User-aborted rows must not be overwritten by stale AWS polls
  if (existing.status === 'ABORTED' && incoming.status !== 'ABORTED') {
    return existing;
  }

  const merged: CategoryExecution = {
    ...existing,
    ...incoming,
    keyword: existing.keyword,
  };

  if (incoming.status !== undefined && existing.status !== undefined) {
    const existingRank = AWS_STATUS_RANK[existing.status] ?? 0;
    const incomingRank = AWS_STATUS_RANK[incoming.status] ?? 0;
    if (incomingRank < existingRank) {
      merged.status = existing.status;
    }
  }

  if (existing.execution_arn && (!incoming.execution_arn || incoming.execution_arn === '')) {
    merged.execution_arn = existing.execution_arn;
    // Stale poll / abandon artifact must not downgrade a row that already has an AWS execution
    const existingRank = AWS_STATUS_RANK[existing.status ?? ''] ?? 0;
    const incomingRank = AWS_STATUS_RANK[incoming.status ?? ''] ?? 0;
    if (incomingRank < existingRank || incoming.status === 'FAILED' || incoming.status === 'PENDING') {
      merged.status = existing.status;
      merged.run_id = existing.run_id || merged.run_id;
      merged.pipeline_summary = existing.pipeline_summary ?? merged.pipeline_summary;
      merged.pipeline_status = existing.pipeline_status ?? merged.pipeline_status;
      merged.started_at = existing.started_at ?? merged.started_at;
    }
  }

  if (existing.pipeline_summary?.pipeline_status && !incoming.pipeline_summary?.pipeline_status) {
    const incomingAws = String(incoming.status ?? merged.status ?? '').toUpperCase();
    // A successful AWS poll without parsed summary should not keep a stale FAILED shell
    if (incomingAws !== 'SUCCEEDED') {
      merged.pipeline_summary = existing.pipeline_summary;
      merged.pipeline_status =
        existing.pipeline_status ?? existing.pipeline_summary.pipeline_status;
    }
  } else if (incoming.pipeline_summary?.pipeline_status) {
    merged.pipeline_status = incoming.pipeline_summary.pipeline_status;
    // Successful AWS poll replaces stale local failure / client timeout state
    if (
      incoming.status === 'SUCCEEDED' &&
      (existing.status === 'TIMED_OUT' ||
        existing.pipeline_summary?.pipeline_status === 'FAILED')
    ) {
      merged.status = 'SUCCEEDED';
    }
  }

  if (existing.started_at && incoming.started_at === undefined) {
    merged.started_at = existing.started_at;
  }

  if (existing.run_id && !incoming.run_id) {
    merged.run_id = existing.run_id;
  }

  return merged;
}

export function applyCategoryExecutionUpdates(
  current: CategoryExecution[],
  updates: Array<Partial<CategoryExecution> & { keyword: string }>
): CategoryExecution[] {
  const byKeyword = new Map(updates.map((u) => [categoryKeywordKey(u.keyword), u]));
  return current.map((exec) => {
    const update = byKeyword.get(categoryKeywordKey(exec.keyword));
    if (!update) return exec;
    // Stale poll snapshot: skip only when poll adds no new status or resolver summary
    if (
      exec.execution_arn &&
      (!update.execution_arn || update.execution_arn === '') &&
      update.status === exec.status &&
      !update.pipeline_summary?.pipeline_status
    ) {
      return exec;
    }
    return mergeCategoryExecutionRow(exec, update);
  });
}

/** Apply DescribeExecution response without losing prior settled state */
export function categoryExecutionFromStatusApi(
  existing: CategoryExecution,
  data: ExecutionStatusResponse
): CategoryExecution {
  const awsStatus = data.status || existing.status;
  let summary = resolveExecutionPipelineSummary(data);

  // Never invent a failure summary for a successful Step Functions execution
  if (!summary && awsStatus === 'SUCCEEDED') {
    summary = null;
  } else if (
    !summary &&
    isTerminalAwsStatus(awsStatus) &&
    awsStatus !== 'SUCCEEDED'
  ) {
    summary = buildPipelineSummaryFromExecutionFailure(data);
  }

  return mergeCategoryExecutionRow(existing, {
    keyword: existing.keyword,
    status: awsStatus,
    pipeline_summary: summary ?? existing.pipeline_summary ?? null,
    pipeline_status:
      summary?.pipeline_status ??
      (awsStatus === 'SUCCEEDED' ? existing.pipeline_status : null) ??
      existing.pipeline_status ??
      null,
  });
}

/** Mark stuck PENDING rows FAILED once most of the batch has settled (3+ min) */
export function abandonStuckCategoryPendingExecutions(
  executions: CategoryExecution[],
  batchStartedAtMs: number,
  nowMs: number = Date.now()
): CategoryExecution[] {
  const minElapsedMs = 3 * 60 * 1000;
  if (batchStartedAtMs <= 0 || nowMs - batchStartedAtMs < minElapsedMs) {
    return executions;
  }

  const settled = executions.filter(isCategoryExecutionSettled).length;
  const total = executions.length;
  if (total === 0 || settled / total < 0.85) {
    return executions;
  }

  return executions.map((exec) => {
    if (exec.status !== 'PENDING' || exec.execution_arn) return exec;
    return mergeCategoryExecutionRow(exec, {
      keyword: exec.keyword,
      status: 'FAILED',
      pipeline_status: 'FAILED',
      pipeline_summary: {
        pipeline_status: 'FAILED',
        message: 'Variant did not start within the batch window',
        stages: {},
      },
    });
  });
}

/** True when batch triggering is done and every child is fully settled */
export function isCategoryBatchReadyToComplete(
  executions: CategoryExecution[],
  _batchStartedAtMs?: number,
  _nowMs?: number
): boolean {
  return areAllCategoryExecutionsFinished(executions);
}

/** True when we should keep polling DescribeExecution for business summary */
export function needsBusinessSummaryRefresh(exec: CategoryExecution): boolean {
  if (!exec.execution_arn) return false;
  if (exec.status === 'ABORTED') return false;
  if (exec.status === 'PENDING' || exec.status === 'STARTING') return false;

  if (!exec.pipeline_summary?.pipeline_status) {
    return (
      exec.status === 'RUNNING' ||
      exec.status === 'SUCCEEDED' ||
      isTerminalAwsStatus(exec.status)
    );
  }

  return hasStaleCategoryExecutionStatus(exec);
}

function stageSummaryFromRaw(
  primary: unknown,
  fallback: unknown,
  defaultName: StageKey
): StageSummary {
  const stageObj =
    primary && typeof primary === 'object'
      ? primary
      : fallback && typeof fallback === 'object'
        ? fallback
        : null;

  if (!stageObj) {
    return {
      stage: defaultName,
      status: 'SKIPPED',
      message: `${STAGE_LABELS[defaultName] ?? defaultName} stage skipped`,
      rows: 0,
    };
  }

  const record = stageObj as Record<string, unknown>;
  const status = String(record.status ?? 'SKIPPED');
  return {
    stage: defaultName,
    status,
    message: resolveStageMessage(
      record as StageMessageSource,
      `${STAGE_LABELS[defaultName] ?? defaultName} ${status.toLowerCase()}`
    ),
    rows: Number(record.rows ?? record.rows_processed ?? 0),
  };
}

const STAGE_LABELS: Record<StageKey, string> = {
  keyword_planner: 'Keyword Planner',
  google_trends: 'Google Trends',
  amazon: 'Amazon',
  alibaba: 'Alibaba',
};

function computePipelineStatusFromStages(
  stages: Partial<Record<StageKey, StageSummary>>
): PipelineStatus {
  const statuses = Object.values(stages)
    .filter((s): s is StageSummary => !!s)
    .map((s) => String(s.status ?? '').toUpperCase());

  if (statuses.length === 0) return 'FAILED';

  const failedCount = statuses.filter((s) => s === 'FAILED').length;
  const partialCount = statuses.filter((s) => s === 'EMPTY' || s === 'SKIPPED').length;

  if (failedCount === statuses.length) return 'FAILED';
  if (failedCount > 0 || partialCount > 0) return 'PARTIALLY_SUCCEEDED';
  return 'SUCCEEDED';
}

/** Build resolver-style summary from raw Step Function output when resolver did not run */
export function extractPartialPipelineSummaryFromOutput(
  output: string | undefined | null
): PipelineSummary | null {
  if (!output?.trim()) return null;

  try {
    let parsed: unknown = JSON.parse(output);
    if (typeof parsed === 'string') {
      parsed = JSON.parse(parsed);
    }
    if (!parsed || typeof parsed !== 'object') return null;

    const root = parsed as Record<string, unknown>;
    if (root.pipeline_summary) {
      return normalizePipelineSummary(root.pipeline_summary);
    }

    const amazonStage =
      root.amazon_fcl ?? root.amazon_clean ?? root.amazon_fetch ?? null;

    const stages: Partial<Record<StageKey, StageSummary>> = {
      keyword_planner: stageSummaryFromRaw(root.kwp_clean, root.kwp_fetch, 'keyword_planner'),
      google_trends: stageSummaryFromRaw(root.trends_clean, root.trends_fetch, 'google_trends'),
      amazon: stageSummaryFromRaw(amazonStage, null, 'amazon'),
      alibaba: stageSummaryFromRaw(root.alibaba_clean, root.alibaba_fetch, 'alibaba'),
    };

    const hasAnyStage = Object.values(stages).some(
      (s) => s && String(s.status).toUpperCase() !== 'SKIPPED'
    );
    if (!hasAnyStage) return null;

    const pipeline_status = computePipelineStatusFromStages(stages);
    return {
      pipeline_status,
      message: `Pipeline execution completed with status ${pipeline_status}`,
      stages,
      generated_at: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

/** Synthetic summary when trigger never received an execution ARN */
export function buildTriggerFailureSummary(reason: string): PipelineSummary {
  const message = resolveStageMessage(
    { status: 'FAILED', message: reason },
    'Pipeline trigger failed — could not start Step Function execution'
  );
  return {
    pipeline_status: 'FAILED',
    message,
    generated_at: new Date().toISOString(),
    stages: {
      keyword_planner: {
        stage: 'keyword_planner',
        status: 'FAILED',
        message,
        rows: 0,
      },
    },
  };
}

/** Synthetic summary when a child execution exceeds the client-side wait window */
export function buildTimeoutFailureSummary(keyword?: string): PipelineSummary {
  const message = keyword
    ? `Pipeline timed out for "${keyword}" — exceeded the execution time limit`
    : 'Pipeline timed out — exceeded the execution time limit';
  return {
    pipeline_status: 'FAILED',
    message,
    generated_at: new Date().toISOString(),
    stages: {
      keyword_planner: {
        stage: 'keyword_planner',
        status: 'FAILED',
        message,
        rows: 0,
      },
    },
  };
}

/** Synthetic summary when the user aborts a running category child */
export function buildAbortedFailureSummary(keyword?: string): PipelineSummary {
  const message = keyword
    ? `Pipeline aborted by user for "${keyword}"`
    : 'Pipeline aborted by user before completion';
  return {
    pipeline_status: 'FAILED',
    message,
    generated_at: new Date().toISOString(),
    stages: {
      keyword_planner: {
        stage: 'keyword_planner',
        status: 'FAILED',
        message,
        rows: 0,
      },
    },
  };
}

/** True when a category child still has an active Step Functions execution to stop */
export function shouldStopCategoryExecution(exec: CategoryExecution): boolean {
  const arn = exec.execution_arn?.trim();
  if (!arn || arn.startsWith('category_search:')) return false;
  return !isTerminalAwsStatus(exec.status);
}

/** True when a category child was cancelled before/during execution */
export function isCategoryExecutionAbortable(exec: CategoryExecution): boolean {
  const status = String(exec.status ?? '').toUpperCase();
  return (
    status === 'PENDING' ||
    status === 'STARTING' ||
    status === 'RUNNING' ||
    shouldStopCategoryExecution(exec)
  );
}

/** UI may load per-variant stage panels (including after user abort) */
export function canBrowseCategoryVariantDetails(pipelineStatus: string): boolean {
  return (
    pipelineStatus === 'COMPLETED' ||
    pipelineStatus === 'POLLING' ||
    pipelineStatus === 'FAILED'
  );
}

/** True when this keyword never received a Step Function execution ARN */
export function isCategoryVariantUnprocessed(exec: CategoryExecution | null | undefined): boolean {
  if (!exec) return true;
  if (exec.status === 'ABORTED' && !exec.execution_arn?.trim()) return true;
  if (exec.status === 'PENDING' && !exec.execution_arn?.trim()) return true;
  return false;
}

/** Build a user-facing summary from AWS terminal status when resolver output is missing */
export function buildPipelineSummaryFromExecutionFailure(
  data: ExecutionStatusResponse
): PipelineSummary {
  const fromOutput =
    extractPartialPipelineSummaryFromOutput(data.output) ??
    normalizePipelineSummary(data.pipeline_summary);
  if (fromOutput) return fromOutput;

  const parsed = parseAwsExecutionFailure(data.error, data.cause);
  const stageKey = (parsed.stageKey ??
    inferStageKeyFromFailureText(parsed.message) ??
    'keyword_planner') as StageKey;
  const stageLabel = STAGE_LABELS[stageKey];

  const awsStatus = String(data.status ?? '').toUpperCase();
  let message = parsed.message;
  if (awsStatus === 'TIMED_OUT') {
    message = parsed.message.includes('timed out')
      ? parsed.message
      : 'Pipeline timed out before completing';
  } else if (awsStatus === 'ABORTED') {
    message = parsed.message.includes('abort')
      ? parsed.message
      : 'Pipeline was aborted before completion';
  }

  return {
    pipeline_status: 'FAILED',
    message,
    generated_at: new Date().toISOString(),
    stages: {
      [stageKey]: {
        stage: stageKey,
        status: 'FAILED',
        message: `${stageLabel} failed — ${message}`,
        rows: 0,
      },
    },
  };
}

/** True when the Step Functions execution itself failed or was aborted */
export function isCategoryExecutionAwsFailed(exec: CategoryExecution | null | undefined): boolean {
  if (!exec) return false;
  const status = String(exec.status ?? '').toUpperCase();
  return status === 'FAILED' || status === 'TIMED_OUT' || status === 'ABORTED';
}

type StageSummaryLike = {
  status?: string | null;
  message?: string | null;
  error?: string | null;
  rows?: number | null;
  rows_processed?: number | null;
};

/** Resolve a stage object from pipeline summary stages map */
export function getResolverStageFromSummary(
  stages: PipelineSummary['stages'] | null | undefined,
  stageKey: string
): StageSummaryLike | null {
  if (!stages) return null;

  const aliases: Record<string, string[]> = {
    keyword_planner: ['keyword_planner', 'keyword_planner_clean', 'google_keyword_planner'],
    google_trends: ['google_trends', 'google_trends_clean', 'trends'],
    amazon: ['amazon', 'amazon_clean', 'amazon_fcl_enrichment'],
    alibaba: ['alibaba', 'alibaba_clean', 'alibaba_enrichment'],
  };

  for (const key of aliases[stageKey] ?? [stageKey]) {
    const stage = stages[key];
    if (stage) return stage;
  }
  return null;
}

/** One-line tracker message for a category child execution */
export function getCategoryExecutionUserMessage(
  exec: CategoryExecution,
  filters: MarketplaceFilterConfig
): string {
  const displayStatus = getCategoryExecutionDisplayStatus(exec, filters);

  if (exec.pipeline_summary) {
    return getPipelineUserMessage({
      pipelineStatus: exec.pipeline_summary.pipeline_status,
      stages: exec.pipeline_summary.stages,
      amazonFilters: filters.amazonFilters,
      alibabaFilters: filters.alibabaFilters,
      displayStatus,
      summaryMessage: exec.pipeline_summary.message,
    });
  }

  if (displayStatus === 'RUNNING' && isTerminalAwsStatus(exec.status)) {
    return 'Finalizing pipeline results...';
  }
  if (displayStatus === 'RUNNING') return 'Pipeline in progress...';
  if (displayStatus === 'PENDING') return 'Waiting to start...';

  if (displayStatus === 'FAILED' || displayStatus === 'ABORTED') {
    if (!exec.execution_arn) {
      return 'Pipeline trigger failed — could not start Step Function execution';
    }
    if (exec.status === 'TIMED_OUT') {
      return 'Pipeline timed out — keyword exceeded the execution time limit';
    }
    if (exec.status === 'ABORTED') {
      return 'Pipeline aborted before completion';
    }
    return 'Pipeline execution failed — no detailed stage output was returned';
  }

  return '—';
}

/** Resolve business pipeline status for a category child execution */
export function getCategoryExecutionPipelineStatus(
  exec: CategoryExecution
): PipelineStatus | 'RUNNING' | 'PENDING' | 'ABORTED' | 'FAILED' {
  if (exec.status === 'ABORTED') {
    return 'ABORTED';
  }

  if (exec.status === 'STARTING') {
    return 'RUNNING';
  }

  if (exec.status === 'PENDING' || !exec.status) {
    return 'PENDING';
  }

  if (!isTerminalAwsStatus(exec.status)) {
    return 'RUNNING';
  }

  // Trigger failed — no Step Function ARN was assigned
  if (!exec.execution_arn && exec.status === 'FAILED') {
    return 'FAILED';
  }

  const awsStatus = String(exec.status ?? '').toUpperCase();
  const hasStages = hasPipelineStageData(exec.pipeline_summary);

  // Step Functions succeeded — use resolver output once loaded
  if (awsStatus === 'SUCCEEDED') {
    if (exec.pipeline_summary?.pipeline_status && hasStages) {
      return exec.pipeline_summary.pipeline_status;
    }
    return 'RUNNING';
  }

  // AWS terminal failure — show FAILED once verified (only defer while stale/local timeout)
  if (awsStatus === 'FAILED' || awsStatus === 'TIMED_OUT') {
    if (hasStaleCategoryExecutionStatus(exec)) {
      return 'RUNNING';
    }
    if (exec.pipeline_summary?.pipeline_status && hasStages) {
      return exec.pipeline_summary.pipeline_status;
    }
    return 'FAILED';
  }

  if (exec.pipeline_summary?.pipeline_status && hasStages) {
    return exec.pipeline_summary.pipeline_status;
  }

  if (awsStatus === 'TIMED_OUT') {
    return 'FAILED';
  }

  const business = getBusinessPipelineStatus(exec.status, exec.pipeline_summary);
  return business === 'ABORTED' ? 'ABORTED' : business;
}

/** Build aggregate summary for category batch (ALL variants view) */
export function buildCategoryBatchSummary(
  executions: CategoryExecution[]
): PipelineSummary {
  const statuses = executions.map((exec) => {
    const s = getCategoryExecutionPipelineStatus(exec);
    if (s === 'SUCCEEDED' || s === 'PARTIALLY_SUCCEEDED' || s === 'FAILED') {
      return s;
    }
    return null;
  });

  const batchStatus = aggregatePipelineStatuses(statuses);
  const succeeded = statuses.filter((s) => s === 'SUCCEEDED').length;
  const partial = statuses.filter((s) => s === 'PARTIALLY_SUCCEEDED').length;
  const failed = statuses.filter((s) => s === 'FAILED').length;

  return {
    pipeline_status: batchStatus === 'RUNNING' ? 'PARTIALLY_SUCCEEDED' : batchStatus,
    message: `Category batch: ${executions.length} keyword(s) — ${succeeded} succeeded, ${partial} partial, ${failed} failed`,
    generated_at: new Date().toISOString(),
    stages: {},
  };
}

export type PipelineDisplayStatus =
  | PipelineStatus
  | 'RUNNING'
  | 'PENDING'
  | 'ABORTED'
  | string;

export interface MarketplaceFilterConfig {
  amazonFilters: boolean;
  alibabaFilters: boolean;
}

const CORE_STAGE_OK = new Set(['SUCCEEDED', 'EMPTY']);

export function isCoreStageOk(status: string | undefined | null): boolean {
  return !!status && CORE_STAGE_OK.has(status);
}

/**
 * AWS resolve_pipeline_status marks disabled marketplace stages SKIPPED, which yields
 * PARTIALLY_SUCCEEDED even when KWP + Trends completed. When marketplace filters are off,
 * treat that as full success for UI badges and batch progress.
 */
export function getEffectivePipelineStatus(
  rawStatus: PipelineDisplayStatus,
  summary: PipelineSummary | null | undefined,
  filters: MarketplaceFilterConfig
): PipelineDisplayStatus {
  if (rawStatus !== 'PARTIALLY_SUCCEEDED' || !summary?.stages) {
    return rawStatus;
  }

  const kwp = summary.stages.keyword_planner?.status;
  const trends = summary.stages.google_trends?.status;
  if (kwp === 'FAILED' || trends === 'FAILED') {
    return 'PARTIALLY_SUCCEEDED';
  }

  const coreOk = isCoreStageOk(kwp) && isCoreStageOk(trends);
  if (!coreOk) return 'PARTIALLY_SUCCEEDED';

  if (!filters.amazonFilters && !filters.alibabaFilters) {
    return 'SUCCEEDED';
  }

  if (!filters.amazonFilters && filters.alibabaFilters) {
    const ali = summary.stages.alibaba?.status;
    if (ali === 'FAILED') return 'PARTIALLY_SUCCEEDED';
    if (isCoreStageOk(ali)) return 'SUCCEEDED';
  }

  if (filters.amazonFilters && !filters.alibabaFilters) {
    const amz = summary.stages.amazon?.status;
    if (amz === 'FAILED') return 'PARTIALLY_SUCCEEDED';
    if (isCoreStageOk(amz)) return 'SUCCEEDED';
  }

  return 'PARTIALLY_SUCCEEDED';
}

export function getCategoryExecutionDisplayStatus(
  exec: CategoryExecution,
  filters: MarketplaceFilterConfig
): PipelineDisplayStatus {
  const raw = getCategoryExecutionPipelineStatus(exec);
  return getEffectivePipelineStatus(raw, exec.pipeline_summary ?? null, filters);
}

/** Score used for GT min-threshold filtering — prefers sustainability over simple avg */
export function getGoogleTrendFilterScore(row: {
  trend_sustainability?: number | null;
  trend_avg?: number | null;
}): number | null {
  if (row.trend_sustainability != null && Number.isFinite(Number(row.trend_sustainability))) {
    return Number(row.trend_sustainability);
  }
  if (row.trend_avg != null && Number.isFinite(Number(row.trend_avg))) {
    return Number(row.trend_avg);
  }
  return null;
}

/** True when a consolidated row satisfies the user-configured Google Trend Score minimum */
export function meetsGoogleTrendScoreThreshold(
  trendScore: number | null | undefined,
  minScore: number
): boolean {
  if (minScore <= 0) return true;
  if (trendScore === null || trendScore === undefined) return false;
  const n = Number(trendScore);
  if (!Number.isFinite(n)) return false;
  return n >= minScore;
}

/** Exclude consolidated rows that lack GT data or fall below the configured minimum */
export function filterConsolidatedByGoogleTrendScore<
  T extends { trend_sustainability?: number | null; trend_avg?: number | null },
>(rows: T[], minScore: number): T[] {
  if (minScore <= 0) return rows;
  return rows.filter((row) =>
    meetsGoogleTrendScoreThreshold(getGoogleTrendFilterScore(row), minScore)
  );
}

/** Tailwind classes for pipeline status badges */
export function getPipelineStatusBadgeClasses(status: PipelineDisplayStatus): {
  badge: string;
  dot: string;
  pulse: boolean;
} {
  switch (status) {
    case 'SUCCEEDED':
      return {
        badge: 'bg-green-500/20 text-green-400 border border-green-500/30',
        dot: 'bg-green-400',
        pulse: false,
      };
    case 'PARTIALLY_SUCCEEDED':
      return {
        badge: 'bg-orange-500/20 text-orange-400 border border-orange-500/30',
        dot: 'bg-orange-400',
        pulse: false,
      };
    case 'FAILED':
    case 'ABORTED':
      return {
        badge: 'bg-red-500/20 text-red-400 border border-red-500/30',
        dot: 'bg-red-400',
        pulse: false,
      };
    case 'RUNNING':
    case 'STARTING':
      return {
        badge: 'bg-blue-500/20 text-blue-400 border border-blue-500/30 animate-pulse',
        dot: 'bg-blue-400',
        pulse: true,
      };
    case 'EMPTY':
      return {
        badge: 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30',
        dot: 'bg-yellow-400',
        pulse: false,
      };
    case 'SKIPPED':
      return {
        badge: 'bg-white/10 text-gray-400 border border-white/20',
        dot: 'bg-gray-400',
        pulse: false,
      };
    default:
      return {
        badge: 'bg-gray-500/20 text-gray-400 border border-gray-500/30',
        dot: 'bg-gray-400',
        pulse: false,
      };
  }
}
