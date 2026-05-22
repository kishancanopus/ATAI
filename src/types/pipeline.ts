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

/** Normalize raw pipeline_summary from API / Step Function output */
export function normalizePipelineSummary(raw: unknown): PipelineSummary | null {
  if (!raw || typeof raw !== 'object') return null;

  const obj = raw as Record<string, unknown>;

  if (
    typeof obj.pipeline_status === 'string' &&
    typeof obj.message === 'string' &&
    obj.stages &&
    typeof obj.stages === 'object'
  ) {
    return {
      pipeline_status: obj.pipeline_status as PipelineStatus,
      message: obj.message,
      stages: obj.stages as PipelineSummary['stages'],
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

/** True when resolver produced per-stage entries (not an empty batch placeholder) */
export function hasPipelineStageData(summary: PipelineSummary | null | undefined): boolean {
  if (!summary?.stages || typeof summary.stages !== 'object') return false;
  return Object.keys(summary.stages).length > 0;
}

/** Resolve business pipeline status for a category child execution */
export function getCategoryExecutionPipelineStatus(
  exec: CategoryExecution
): PipelineStatus | 'RUNNING' | 'PENDING' | 'ABORTED' {
  // Prefer resolver output over a stale pipeline_status field from an earlier poll
  if (exec.pipeline_summary?.pipeline_status) {
    return exec.pipeline_summary.pipeline_status;
  }
  if (exec.pipeline_status) {
    return exec.pipeline_status;
  }
  if (exec.status === 'ABORTED' || exec.status === 'TIMED_OUT') {
    return exec.status === 'ABORTED' ? 'ABORTED' : 'FAILED';
  }
  if (exec.status === 'PENDING' || exec.status === 'STARTING' || !exec.status) {
    return 'PENDING';
  }
  if (!isTerminalAwsStatus(exec.status)) {
    return 'RUNNING';
  }
  // AWS finished but resolver summary not loaded yet — avoid flashing FAILED
  if (exec.status === 'SUCCEEDED' && !exec.pipeline_summary) {
    return 'RUNNING';
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
