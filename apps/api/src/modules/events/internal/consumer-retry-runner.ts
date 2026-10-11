import type { Logger } from '../../../observability/logger.js';
import type { BaseEventConsumer, ConsumerRetryOptions, ConsumerRetryResult } from './event-consumer.js';

export interface ConsumerRetryRunnerConfig {
  intervalMs?: number;
  batchSize?: number;
  baseRetryDelayMs?: number;
  maxRetryDelayMs?: number;
  maxAttempts?: number;
  staleTimeoutMs?: number;
}

export class ConsumerRetryRunner {
  private timer: NodeJS.Timeout | null = null;
  private isRunningCycle = false;
  private readonly consumers: BaseEventConsumer[] = [];

  constructor(
    private readonly logger: Logger,
    private readonly config: ConsumerRetryRunnerConfig = {},
  ) {}

  /**
   * Register a BaseEventConsumer instance whose failed/stale receipts should be retried.
   */
  registerConsumer(consumer: BaseEventConsumer): void {
    if (!this.consumers.includes(consumer)) {
      this.consumers.push(consumer);
    }
  }

  /**
   * Returns all currently registered consumers.
   */
  getRegisteredConsumers(): readonly BaseEventConsumer[] {
    return this.consumers;
  }

  /**
   * Execute a single retry pass across all registered consumers.
   * Runs sequentially to prevent resource contention.
   */
  async runOnce(options?: ConsumerRetryOptions): Promise<Record<string, ConsumerRetryResult>> {
    const results: Record<string, ConsumerRetryResult> = {};
    for (const consumer of this.consumers) {
      try {
        const res = await consumer.retryFailedEvents({
          batchSize: options?.batchSize ?? this.config.batchSize ?? 50,
          baseRetryDelayMs: options?.baseRetryDelayMs ?? this.config.baseRetryDelayMs ?? 2000,
          maxRetryDelayMs: options?.maxRetryDelayMs ?? this.config.maxRetryDelayMs ?? 300000,
          maxAttempts: options?.maxAttempts ?? this.config.maxAttempts ?? 5,
          staleTimeoutMs: options?.staleTimeoutMs ?? this.config.staleTimeoutMs ?? 60000,
        });
        results[consumer.consumerName] = res;
      } catch (err: unknown) {
        this.logger.error('Error during consumer retry cycle', {
          consumerName: consumer.consumerName,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return results;
  }

  /**
   * Starts the background retry scheduler.
   * Guards against overlapping executions within the same process.
   */
  start(): void {
    if (this.timer) {
      return;
    }

    const intervalMs = this.config.intervalMs ?? 15000;
    this.timer = setInterval(() => {
      if (this.isRunningCycle) {
        this.logger.debug('Consumer retry cycle already in progress; skipping tick');
        return;
      }
      this.isRunningCycle = true;
      this.runOnce()
        .then((results) => {
          for (const [name, res] of Object.entries(results)) {
            if (res.claimed > 0) {
              this.logger.info('Consumer retry cycle processed events', {
                consumerName: name,
                claimed: res.claimed,
                succeeded: res.succeeded,
                failed: res.failed,
                quarantined: res.quarantined,
              });
            }
          }
        })
        .catch((err: unknown) => {
          this.logger.warn('Consumer retry runner cycle failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          this.isRunningCycle = false;
        });
    }, intervalMs);
  }

  /**
   * Stops the background retry scheduler and cleans up interval timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.isRunningCycle = false;
  }

  /**
   * Indicates whether the timer is currently active.
   */
  get isRunning(): boolean {
    return this.timer !== null;
  }

  /**
   * Indicates whether a retry cycle is actively running.
   */
  get isExecuting(): boolean {
    return this.isRunningCycle;
  }
}
