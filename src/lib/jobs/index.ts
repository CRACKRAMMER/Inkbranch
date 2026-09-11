/**
 * The job queue's public surface.
 *
 * Everything outside `src/lib/jobs` imports from here, so the module layout
 * inside can change without touching callers — and so that the queue, the
 * handlers and the loop stay distinguishable at the point of use.
 */

export {
  CLAIM_STALE_MS,
  DEFAULT_LIST_LIMIT,
  DEFAULT_MAX_ATTEMPTS,
  JobQueueError,
  MAX_ERROR_LENGTH,
  MAX_LIST_LIMIT,
  RESULT_KEY,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  claimNextJob,
  completeJob,
  enqueue,
  failJob,
  isClaimStale,
  listJobs,
  retryDecision,
  retryDelayMs,
  truncateError,
  type EnqueueInput,
  type FailJobOptions,
  type JobStatus,
  type ListJobsOptions,
  type RetryDecision,
} from './queue'

export {
  JOB_KINDS,
  JobHandlerError,
  PublishSupersededError,
  UnknownJobKindError,
  isKnownJobKind,
  isPublishDue,
  jobHandlers,
  resolveHandler,
  type JobContext,
  type JobHandler,
  type JobKind,
  type JobLogger,
  type JobLogEvent,
  type JobResult,
} from './handlers'

export {
  CADENCE_FAILURE_COOL_OFF_MS,
  DEFAULT_JOB_TIMEOUT_MS,
  DEFAULT_POLL_MS,
  DEFAULT_SHUTDOWN_GRACE_MS,
  JobTimeoutError,
  WorkerShutdownError,
  WorkerStartupError,
  runWorker,
  type WorkerOptions,
  type WorkerSummary,
} from './worker'
