/**
 * Normalize pipeline / Lambda stage messages for dashboard display.
 */

export interface StageMessageSource {
  status?: string | null;
  message?: string | null;
  error?: string | null;
  cause?: string | null;
}

export interface PipelineUserMessageContext {
  pipelineStatus: string;
  stages?: Record<string, StageMessageSource | undefined>;
  amazonFilters?: boolean;
  alibabaFilters?: boolean;
  /** Effective UI status — may differ from raw AWS pipeline_status */
  displayStatus?: string;
  /** Resolver / synthetic summary message when stages are empty */
  summaryMessage?: string;
}

const STAGE_LABELS: Record<string, string> = {
  keyword_planner: 'Keyword Planner',
  google_trends: 'Google Trends',
  amazon: 'Amazon',
  alibaba: 'Alibaba',
};

/** Collapse whitespace and strip escaped newlines from Lambda strings */
export function collapseMessageText(raw: string): string {
  return raw.replace(/\\n/g, ' ').replace(/\s+/g, ' ').trim();
}

function extractJsonMessage(text: string): string | null {
  const jsonStart = text.indexOf('{');
  if (jsonStart < 0) return null;

  try {
    const parsed = JSON.parse(text.slice(jsonStart)) as Record<string, unknown>;
    const errObj = parsed.error;
    if (errObj && typeof errObj === 'object') {
      const inner = (errObj as Record<string, unknown>).message;
      if (typeof inner === 'string' && inner.trim()) return inner.trim();
    }
    if (typeof parsed.message === 'string' && parsed.message.trim()) {
      return parsed.message.trim();
    }
  } catch {
    // not valid JSON
  }
  return null;
}

function applyKnownErrorPatterns(text: string): string | null {
  const lower = text.toLowerCase();

  if (lower.includes('monthly usage hard limit exceeded')) {
    return 'Apify monthly limit reached — upgrade plan or wait for reset';
  }
  if (lower.includes('platform-feature-disabled')) {
    return 'Apify account limit reached';
  }
  if (lower.includes('apify') && lower.includes('http 403')) {
    return 'Apify access denied — check token and usage limits';
  }
  if (lower.includes('apify') && lower.includes('http 401')) {
    return 'Apify authentication failed — check APIFY_TOKEN';
  }
  if (lower.includes('google ads api failed')) {
    return 'Keyword Planner API request failed';
  }
  if (lower.includes('no keyword planner data')) {
    return 'No Keyword Planner data returned';
  }
  // Check specific "filtered out" variants before the generic catch-alls
  if (lower.includes('no alibaba products remained after filtering') || lower.includes('alibaba') && lower.includes('after filtering')) {
    return 'Alibaba products fetched but all were removed by your active filters';
  }
  if (lower.includes('no amazon products') && lower.includes('after')) {
    return 'Amazon products fetched but all were removed by your active filters';
  }
  if (lower.includes('no amazon products')) {
    return 'No Amazon products found';
  }
  if (lower.includes('no alibaba')) {
    return 'No Alibaba products found';
  }
  if (lower.includes('result cap is 0') || lower.includes('size is 0')) {
    return 'Marketplace fetch skipped (Results Cap = 0)';
  }

  return null;
}

/** Format a raw stage message or error string for UI display */
export function formatPipelineStageMessage(raw: unknown, fallback = ''): string {
  if (raw == null || raw === '') return fallback;

  const text = collapseMessageText(String(raw));
  if (!text) return fallback;

  const known = applyKnownErrorPatterns(text);
  if (known) return known;

  const jsonMsg = extractJsonMessage(text);
  if (jsonMsg) {
    const prefixEnd = text.indexOf('{');
    const prefix = prefixEnd > 0 ? text.slice(0, prefixEnd).replace(/:\s*$/, '').trim() : '';
    if (prefix.toLowerCase().includes('apify')) {
      const httpMatch = prefix.match(/HTTP\s*(\d+)/i);
      const code = httpMatch ? ` (${httpMatch[1]})` : '';
      return `Apify error${code}: ${jsonMsg}`;
    }
    if (prefix) return `${prefix}: ${jsonMsg}`;
    return jsonMsg;
  }

  if (/^pipeline execution completed with status /i.test(text)) {
    return '';
  }

  if (text.length > 200) return `${text.slice(0, 197)}…`;
  return text;
}

/** Pick the best raw string from a stage object, then format it */
export function resolveStageMessage(
  stage: StageMessageSource | null | undefined,
  fallback: string
): string {
  if (!stage) return fallback;

  const status = String(stage.status ?? '').toUpperCase();
  const isFailure = status === 'FAILED' || status === 'EMPTY';

  const raw =
    (isFailure && (stage.error || stage.cause)) ||
    stage.message ||
    stage.error ||
    stage.cause;

  return formatPipelineStageMessage(raw, fallback);
}

function stageFailures(stages: Record<string, StageMessageSource | undefined> | undefined) {
  return Object.entries(stages ?? {}).filter(([, s]) => {
    const st = String(s?.status ?? '').toUpperCase();
    return st === 'FAILED' || st === 'EMPTY';
  });
}

/** Separate EMPTY stages from genuinely FAILED stages */
function stageEmpties(stages: Record<string, StageMessageSource | undefined> | undefined) {
  return Object.entries(stages ?? {}).filter(([, s]) => {
    return String(s?.status ?? '').toUpperCase() === 'EMPTY';
  });
}

function isFilterEmptyStage(stage: StageMessageSource | undefined): boolean {
  const msg = String(stage?.message ?? '').toLowerCase();
  return (
    msg.includes('remained after filtering') ||
    msg.includes('after filtering') ||
    msg.includes('filtered out')
  );
}

function describeEmptyStage(stageKey: string, stage: StageMessageSource | undefined): string {
  const label = STAGE_LABELS[stageKey] ?? stageKey.replace(/_/g, ' ');
  if (isFilterEmptyStage(stage)) {
    return `${label} results removed by active filters`;
  }
  const detail = resolveStageMessage(stage, `${label} returned no results`);
  return `${label}: ${detail}`;
}

function stageHardFailures(stages: Record<string, StageMessageSource | undefined> | undefined) {
  return Object.entries(stages ?? {}).filter(([, s]) => {
    return String(s?.status ?? '').toUpperCase() === 'FAILED';
  });
}

function disabledMarketplaceLabels(
  amazonFilters: boolean,
  alibabaFilters: boolean,
  stages: Record<string, StageMessageSource | undefined> | undefined
): string[] {
  const labels: string[] = [];
  if (!amazonFilters || stages?.amazon?.status === 'SKIPPED') labels.push('Amazon');
  if (!alibabaFilters || stages?.alibaba?.status === 'SKIPPED') labels.push('Alibaba');
  return labels;
}

/**
 * One-line user-facing pipeline summary — safe to call repeatedly (idempotent).
 */
export function getPipelineUserMessage(ctx: PipelineUserMessageContext): string {
  const {
    pipelineStatus,
    stages,
    amazonFilters = true,
    alibabaFilters = true,
    displayStatus,
  } = ctx;

  const effective = displayStatus ?? pipelineStatus;
  const failed = stageFailures(stages);
  const hardFailed = stageHardFailures(stages);
  const emptied = stageEmpties(stages);

  if (effective === 'RUNNING') return 'Pipeline in progress\u2026';
  if (effective === 'PENDING') return 'Waiting to start\u2026';

  if (effective === 'FAILED') {
    if (hardFailed.length > 0) {
      const [key, s] = hardFailed[0];
      const label = STAGE_LABELS[key] ?? key.replace(/_/g, ' ');
      return `${label} failed \u2014 ${resolveStageMessage(s, 'see stage card for details')}`;
    }
    if (failed.length > 0) {
      const [key, s] = failed[0];
      const label = STAGE_LABELS[key] ?? key.replace(/_/g, ' ');
      return `${label} failed \u2014 ${resolveStageMessage(s, 'see stage card for details')}`;
    }
    if (ctx.summaryMessage?.trim()) {
      return formatPipelineStageMessage(ctx.summaryMessage, 'Pipeline execution failed');
    }
    return 'Pipeline execution failed';
  }

  // Hard failures take priority over EMPTY in the banner message
  if (hardFailed.length > 0) {
    const [key, s] = hardFailed[0];
    const label = STAGE_LABELS[key] ?? key.replace(/_/g, ' ');
    return `Core data collected \u2014 ${label} failed: ${resolveStageMessage(s, 'see details below')}`;
  }

  // EMPTY stages — fetch returned nothing vs clean filtered everything out
  if (emptied.length > 0) {
    const [key, stage] = emptied[0];
    return `Core data collected \u2014 ${describeEmptyStage(key, stage)}`;
  }

  if (effective === 'SUCCEEDED') {
    if (!amazonFilters && !alibabaFilters) {
      return 'Keyword and trend data collected successfully';
    }
    return 'All requested stages completed successfully';
  }

  if (effective === 'PARTIALLY_SUCCEEDED' || pipelineStatus === 'PARTIALLY_SUCCEEDED') {
    const disabled = disabledMarketplaceLabels(amazonFilters, alibabaFilters, stages);
    if (disabled.length > 0) {
      if (disabled.length === 2) {
        return 'Keyword and trend data collected \u2014 marketplace stages not enabled';
      }
      return `Keyword and trend data collected \u2014 ${disabled[0]} not enabled`;
    }
    return 'Completed with some optional stages skipped';
  }

  return 'Pipeline finished';
}

const STAGE_INFERENCE_PATTERNS: Array<{ key: keyof typeof STAGE_LABELS; patterns: RegExp[] }> = [
  {
    key: 'keyword_planner',
    patterns: [/keyword\s*planner/i, /kwp_/i, /keywordplanner/i, /google ads/i],
  },
  {
    key: 'google_trends',
    patterns: [/google\s*trends/i, /trends_/i, /pytrends/i],
  },
  {
    key: 'amazon',
    patterns: [/amazon/i, /amazonfetch/i],
  },
  {
    key: 'alibaba',
    patterns: [/alibaba/i, /alibabafetch/i, /alibabaclean/i],
  },
];

/** Guess which pipeline stage failed from AWS / Step Functions error text */
export function inferStageKeyFromFailureText(text: string): keyof typeof STAGE_LABELS | null {
  for (const { key, patterns } of STAGE_INFERENCE_PATTERNS) {
    if (patterns.some((pattern) => pattern.test(text))) {
      return key;
    }
  }
  return null;
}

function firstNonEmptyString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }
  return null;
}

function parseCausePayload(cause: string | undefined | null): string | null {
  if (!cause?.trim()) return null;
  const trimmed = cause.trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    const direct = firstNonEmptyString(parsed.errorMessage, parsed.message, parsed.Cause);
    if (direct) return direct;

    if (typeof parsed.Cause === 'string') {
      try {
        const nested = JSON.parse(parsed.Cause) as Record<string, unknown>;
        const nestedMsg = firstNonEmptyString(nested.errorMessage, nested.message);
        if (nestedMsg) return nestedMsg;
      } catch {
        // nested Cause is plain text
        return parsed.Cause.trim();
      }
    }
  } catch {
    // cause is plain text
  }
  return trimmed;
}

/** Parse Step Functions error + cause into a user-facing failure message */
export function parseAwsExecutionFailure(
  error: string | undefined | null,
  cause: string | undefined | null
): { message: string; stageKey: keyof typeof STAGE_LABELS | null } {
  const causeText = parseCausePayload(cause);
  const combined = collapseMessageText([error, causeText].filter(Boolean).join(': '));

  const formatted =
    formatPipelineStageMessage(causeText, '') ||
    formatPipelineStageMessage(combined, '') ||
    formatPipelineStageMessage(error, '');

  if (/timed?\s*out/i.test(combined) || error === 'States.Timeout') {
    return {
      message: formatted || 'Pipeline timed out before completing',
      stageKey: inferStageKeyFromFailureText(combined),
    };
  }

  if (error === 'States.TaskFailed' || /taskfailed/i.test(combined)) {
    return {
      message: formatted || 'A pipeline stage failed during execution',
      stageKey: inferStageKeyFromFailureText(combined),
    };
  }

  if (/aborted/i.test(combined) || error === 'ExecutionAborted') {
    return {
      message: formatted || 'Pipeline was aborted before completion',
      stageKey: inferStageKeyFromFailureText(combined),
    };
  }

  return {
    message: formatted || 'Pipeline execution failed',
    stageKey: inferStageKeyFromFailureText(combined),
  };
}

/** @deprecated Use getPipelineUserMessage — kept for tests migrating */
export function summarizePipelineSummaryMessage(
  pipelineStatus: string,
  _defaultMessage: string,
  stages: Record<string, StageMessageSource | undefined> | undefined
): string {
  return getPipelineUserMessage({ pipelineStatus, stages });
}
