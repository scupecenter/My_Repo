import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { APP_CONFIG, AppConfig } from '../config/config';
import { JobRunsService } from '../logs/job-runs.service';
import { JOB_TIME_ZONE, nextRunAt } from '../jobs/jobs.service';
import { purgeExpiredExports, rescanPending } from './storage-maintenance';
import { StorageService } from './storage.service';

export const PURGE_HOUR = 3;
export const RESCAN_HOUR = 4;

/**
 * The nightly storage jobs (owner answer Q134): `storage_purge` deletes the stored objects of zip exports past expires_at (03:00 Africa/Tripoli),
 * `malware_rescan` scans the files stored while clamd was down (04:00). Each run is a job_runs row. Runs only when JOBS_ENABLED is on.
 */
@Injectable()
export class StorageJobsService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger('StorageJobs');
  private timers: NodeJS.Timeout[] = [];
  private stopped = false;

  constructor(
    private readonly storage: StorageService,
    private readonly runs: JobRunsService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.config.jobsEnabled) return;
    this.schedule('storage_purge', PURGE_HOUR, () => this.purgeExports());
    this.schedule('malware_rescan', RESCAN_HOUR, () => this.rescan());
  }

  onModuleDestroy(): void {
    this.stopped = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private schedule(name: string, hour: number, fn: () => Promise<unknown>): void {
    const at = nextRunAt(new Date(), JOB_TIME_ZONE, hour);
    const t = setTimeout(() => {
      void fn().catch((e: unknown) => this.log.warn(`${name} failed: ${e instanceof Error ? e.message : 'error'}`)).finally(() => {
        if (!this.stopped) this.schedule(name, hour, fn);
      });
    }, Math.max(1000, at.getTime() - Date.now()));
    t.unref();
    this.timers.push(t);
  }

  /** Deletes the stored objects of expired zip exports. Returns the number purged. */
  async purgeExports(): Promise<{ purged: number; failed: number }> {
    const id = await this.runs.start('storage_purge');
    try {
      const r = await purgeExpiredExports(this.storage.meta, this.storage.store);
      await this.runs.finish(id, r.failed > 0 ? 'failed' : 'ok', r.done, r.failed > 0 ? `${r.failed} export(s) could not be purged` : null, { purged: r.done, failed: r.failed });
      return { purged: r.done, failed: r.failed };
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      await this.runs.finish(id, 'failed', null, message);
      throw e;
    }
  }

  /** Rescans the files flagged pending_rescan. Infected ones are quarantined and raise a malware_upload alert. */
  async rescan(): Promise<{ done: number; infected: number; still_pending: number }> {
    if (!this.storage.store.scanning) {
      const id = await this.runs.start('malware_rescan');
      await this.runs.finish(id, 'skipped', null, null, { reason: 'MALWARE_SCAN is off' });
      return { done: 0, infected: 0, still_pending: 0 };
    }
    const id = await this.runs.start('malware_rescan');
    try {
      const r = await rescanPending(this.storage.meta, this.storage.store);
      await this.runs.finish(id, r.failed > 0 ? 'failed' : 'ok', r.done + r.infected, r.failed > 0 ? `${r.failed} file(s) could not be rescanned` : null,
        { clean: r.done, infected: r.infected, still_pending: r.still_pending, failed: r.failed });
      return { done: r.done, infected: r.infected, still_pending: r.still_pending };
    } catch (e) {
      const message = e instanceof Error ? e.message.split('\n')[0] ?? 'failed' : 'failed';
      await this.runs.finish(id, 'failed', null, message);
      throw e;
    }
  }
}
