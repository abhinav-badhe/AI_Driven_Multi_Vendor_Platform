import type { Logger } from '../../../observability/logger.js';
import type { PriceAlertService } from './price-alert-service.js';

export interface PriceAlertSweepRunnerConfig {
  intervalMs?: number;
  sinceDays?: number;
}

/**
 * Background runner that periodically sweeps recently watched products
 * to detect price drops missed during inline listing updates and reconcile
 * watchers whose notifications have confirmed delivery.
 *
 * Conforms to project background lifecycle conventions:
 * - Prevents overlapping sweep executions within the same process.
 * - Logs failures without crashing the application.
 * - Cleans up interval timers upon application shutdown.
 * - Disabled in test environments unless enableBackgroundWorkers is explicitly enabled.
 */
export class PriceAlertSweepRunner {
  private timer: NodeJS.Timeout | null = null;
  private isRunningCycle = false;
  private started = false;

  constructor(
    private readonly service: PriceAlertService,
    private readonly logger: Logger,
    private readonly config: PriceAlertSweepRunnerConfig = {},
  ) {}

  get isRunning(): boolean {
    return this.started;
  }

  get isSweeping(): boolean {
    return this.isRunningCycle;
  }

  /**
   * Starts the periodic sweep scheduler.
   */
  start(): void {
    if (this.timer || this.started) {
      return;
    }

    this.started = true;
    const intervalMs = this.config.intervalMs ?? 60000;
    this.timer = setInterval(() => {
      void this.runCycle();
    }, intervalMs);
  }

  /**
   * Stops the periodic sweep scheduler and clears the interval timer.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    this.isRunningCycle = false;
  }

  /**
   * Executes a single sweep cycle with in-process overlap guard.
   */
  async runCycle(): Promise<{ productsChecked: number; alertsSent: number; reconciled: number } | null> {
    if (this.isRunningCycle) {
      this.logger.debug('Price-drop sweep cycle already in progress; skipping tick');
      return null;
    }

    this.isRunningCycle = true;
    try {
      const sinceDays = this.config.sinceDays ?? 90;
      const res = await this.service.sweepAll(sinceDays);
      if (res.alertsSent > 0) {
        this.logger.info('Price-drop background sweep cycle completed', {
          productsChecked: res.productsChecked,
          alertsSent: res.alertsSent,
        });
      }
      return res;
    } catch (err: unknown) {
      this.logger.warn('Price-drop background sweep runner failed', {
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    } finally {
      this.isRunningCycle = false;
    }
  }
}
