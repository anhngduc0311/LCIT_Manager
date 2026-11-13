import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { CronJob } from 'cron';
import { PoolClient } from 'pg';
import { requireAdmin, SessionRequest } from './access';
import { Database } from './database';
import { monitoringConfig, MonitoringJobKey, monitoringJobKeys } from './monitoring-config';

const lockNamespace = 1279478093;
const lockKey = (key: MonitoringJobKey) => monitoringJobKeys.indexOf(key) + 1;
const timerName = (key: MonitoringJobKey) => `monitoring:${key}`;

export interface MonitoringRunContext {
  runId: string;
  /** Dedicated connection holding the job lock. Workers must finish any BEGIN/COMMIT/ROLLBACK before returning. */
  client: PoolClient;
}
export type MonitoringHandler = (context: MonitoringRunContext) => Promise<void>;
export type MonitoringRunResult = { status: 'succeeded' | 'failed'; runId: string } |
  { status: 'skipped_disabled' | 'skipped_unregistered' | 'skipped_running' | 'skipped_stopping' };

@Injectable()
export class MonitoringService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(MonitoringService.name);
  readonly config = monitoringConfig();
  private readonly handlers = new Map<MonitoringJobKey, MonitoringHandler>();
  private readonly active = new Set<Promise<MonitoringRunResult>>();
  private bootstrapped = false;
  private stopping = false;

  constructor(private readonly db: Database, private readonly registry: SchedulerRegistry) {}

  /** T3.2/T3.3 register their real handlers in onModuleInit; there is deliberately no successful no-op handler. */
  register(key: MonitoringJobKey, handler: MonitoringHandler) {
    if (!monitoringJobKeys.includes(key) || this.handlers.has(key) || this.stopping) throw new Error('Invalid or duplicate monitoring handler registration.');
    this.handlers.set(key, handler);
    if (this.bootstrapped) this.schedule(key);
  }

  async onApplicationBootstrap() {
    if (!process.env.DATABASE_URL) return;
    for (const key of monitoringJobKeys) {
      await this.db.withAdvisoryLock(lockNamespace, lockKey(key), async (client) => {
        await this.recoverInterrupted(client, key);
      });
    }
    this.bootstrapped = true;
    for (const key of monitoringJobKeys) this.schedule(key);
  }

  private schedule(key: MonitoringJobKey) {
    if (!this.config.enabled || !this.handlers.has(key) || this.registry.doesExist('cron', timerName(key))) return;
    const job = CronJob.from({ cronTime: this.config.schedules[key], timeZone: this.config.timeZone,
      onTick: async () => {
        try { await this.run(key); }
        catch { this.logger.error(`Monitoring job ${key} could not record its execution; check database availability.`); }
      }, unrefTimeout: true, waitForCompletion: true });
    this.registry.addCronJob(timerName(key), job);
    job.start();
  }

  run(key: MonitoringJobKey): Promise<MonitoringRunResult> {
    if (!monitoringJobKeys.includes(key)) return Promise.reject(new Error('Unknown monitoring job.'));
    if (this.stopping) return Promise.resolve({ status: 'skipped_stopping' });
    const pending = this.execute(key);
    this.active.add(pending);
    // Both branches remove the task without creating an unhandled rejected cleanup promise.
    void pending.then(() => this.active.delete(pending), () => this.active.delete(pending));
    return pending;
  }

  private async recoverInterrupted(client: PoolClient, key: MonitoringJobKey) {
    await client.query(`UPDATE lcit.monitoring_job_runs SET status='interrupted',
      finished_at=GREATEST(clock_timestamp(),started_at),error_code='PROCESS_INTERRUPTED'
      WHERE id=(SELECT last_run_id FROM lcit.monitoring_jobs WHERE key=$1) AND status='running'`, [key]);
  }

  private async execute(key: MonitoringJobKey): Promise<MonitoringRunResult> {
    if (!this.config.enabled) return { status: 'skipped_disabled' };
    const handler = this.handlers.get(key);
    if (!handler) return { status: 'skipped_unregistered' };
    const locked = await this.db.withAdvisoryLock(lockNamespace, lockKey(key), async (client): Promise<MonitoringRunResult> => {
      // Also recovers after a worker connection was lost without an API restart.
      await this.recoverInterrupted(client, key);
      const { rows: [run] } = await client.query<{ id: string }>(`WITH started AS (
        INSERT INTO lcit.monitoring_job_runs (job_key) VALUES ($1) RETURNING id
      ) UPDATE lcit.monitoring_jobs SET last_run_id=started.id FROM started WHERE key=$1 RETURNING started.id`, [key]);
      let status: 'succeeded' | 'failed' = 'succeeded';
      try { await handler({ runId: run.id, client }); }
      catch {
        status = 'failed';
        // A SQL failure can leave a worker transaction aborted. Restore the session before saving the outcome.
        await client.query('ROLLBACK');
        this.logger.warn(`Monitoring job ${key} failed (run ${run.id}).`);
      }
      // Never persist/log exception messages: they may contain endpoint credentials or connection strings.
      await client.query(`WITH finished AS (
        UPDATE lcit.monitoring_job_runs SET status=$2,finished_at=GREATEST(clock_timestamp(),started_at),error_code=$3
        WHERE id=$1 RETURNING id,job_key,finished_at
      ) UPDATE lcit.monitoring_jobs SET last_success_at=CASE WHEN $2='succeeded' THEN finished.finished_at ELSE last_success_at END
        FROM finished WHERE key=finished.job_key AND last_run_id=finished.id`, [run.id, status, status === 'failed' ? 'JOB_FAILED' : null]);
      return { status, runId: run.id };
    });
    return locked.acquired ? locked.result : { status: 'skipped_running' };
  }

  async list(request: SessionRequest) {
    requireAdmin(request.actor);
    const { rows } = await this.db.query(`SELECT j.key,j.last_success_at AS "lastSuccessAt",r.id AS "runId",
      r.status,r.started_at AS "startedAt",r.finished_at AS "finishedAt",r.error_code AS "errorCode"
      FROM lcit.monitoring_jobs j LEFT JOIN lcit.monitoring_job_runs r ON r.id=j.last_run_id ORDER BY j.key`);
    return { enabled: this.config.enabled, timeZone: this.config.timeZone,
      items: rows.map((row) => {
        const key = row.key as MonitoringJobKey;
        const registered = this.handlers.has(key);
        const scheduled = this.registry.doesExist('cron', timerName(key));
        return { key, cron: this.config.schedules[key], handlerRegistered: registered,
          state: !this.config.enabled ? 'disabled' : !registered ? 'waiting_handler' : 'scheduled',
          nextRunAt: scheduled ? this.registry.getCronJob(timerName(key)).nextDate().toUTC().toISO() : null,
          lastSuccessAt: row.lastSuccessAt,
          lastRun: row.runId ? { id: row.runId, status: row.status, startedAt: row.startedAt,
            finishedAt: row.finishedAt, errorCode: row.errorCode } : null };
      }) };
  }

  async onModuleDestroy() {
    this.stopping = true;
    for (const key of monitoringJobKeys) {
      if (this.registry.doesExist('cron', timerName(key))) await this.registry.getCronJob(timerName(key)).stop();
    }
    await Promise.allSettled([...this.active]);
  }
}
