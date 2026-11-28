import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import type { AuthContext } from '../auth/auth.types';
import { StepUpService } from '../auth/step-up.service';
import { SyslogService } from '../auth/syslog.service';
import { parseIfMatch } from '../common/etag';
import { parse } from '../common/zod';
import { DbService } from '../db/db.service';
import { AccessService } from '../access/access.service';
import { exifWallToInstant, readExifDate } from '../documents/exif';
import { StorageService } from '../documents/storage.service';
import { GeoCfg, readMediaGeo } from './geo';

/**
 * The location and the media kind of an image (Media geotag, contract 0.15.539, migration 0477). The point is read from the file when it is uploaded
 * (the file stays the evidence; nothing in it is changed) and, for files that were stored before, by an explicit scan of a settings admin. A QC snag
 * photo with no point in its file keeps the device point the in-app camera sent. What counts as far from the site, whether panoramas are looked for
 * and which makers are drones is the setting media.geotag (Settings > Documents > Media).
 */
const putBody = z.object({
  enabled: z.boolean(), max_distance_m: z.number().int(), flag_missing: z.boolean(), panorama: z.boolean(),
  panorama_min_ratio: z.number(), panorama_min_width_px: z.number().int(), drone_makes: z.array(z.string()).max(20),
  reason: z.string().trim().min(3).max(1000),
}).strict();

export interface GeoSettings extends GeoCfg {
  enabled: boolean; max_distance_m: number; flag_missing: boolean;
  updated_at: string | null; updated_by: { id: string; display_name: string; employee_id: string | null } | null; version: number; can_edit: boolean;
}
export interface GeoStatus { scanned: number; with_location: number; panorama: number; drone: number; pending: number; last_scanned_at: string | null }
const HEAD_BYTES = 1024 * 1024;

@Injectable()
export class GeoService {
  constructor(
    private readonly db: DbService,
    private readonly access: AccessService,
    private readonly stepUp: StepUpService,
    private readonly storage: StorageService,
    private readonly syslog: SyslogService,
  ) {}

  async getSettings(): Promise<GeoSettings> {
    return (await this.db.tx.$queryRaw<{ r: GeoSettings }[]>(Prisma.sql`SELECT media_geo_state() AS r`))[0]!.r;
  }

  async setSettings(auth: AuthContext, ifMatch: string | undefined, raw: unknown): Promise<GeoSettings> {
    const { reason, ...body } = parse(putBody, raw);
    await this.access.requireAdmin('settings', 'edit');
    const etag = parseIfMatch(ifMatch);
    await this.stepUp.require(auth);
    return (await this.db.tx.$queryRaw<{ r: GeoSettings }[]>(Prisma.sql`SELECT admin_set_media_geo(${JSON.stringify(body)}::jsonb, ${reason}::text, ${etag}::int) AS r`))[0]!.r;
  }

  async status(): Promise<GeoStatus> {
    await this.access.requireAdmin('settings', 'view');
    return (await this.db.tx.$queryRaw<{ r: GeoStatus }[]>(Prisma.sql`SELECT media_geo_status() AS r`))[0]!.r;
  }

  private async write(kind: 'document_file' | 'snag_photo', id: string, bytes: Buffer, mime: string, cfg: GeoSettings, device: { lat: number | null; lon: number | null } | null): Promise<boolean> {
    const m = readMediaGeo(bytes, mime, cfg);
    const wall = m.taken_at === null && m.source === 'exif' ? readExifDate(bytes) : null;
    const meta: Record<string, unknown> = { ...m, taken_at: m.taken_at ?? (wall ? exifWallToInstant(wall).toISOString() : null) };
    if (m.lat === null && device && device.lat !== null && device.lon !== null) { meta.lat = device.lat; meta.lon = device.lon; meta.source = 'device'; }
    await this.db.tx.$executeRaw`SAVEPOINT geo_put`;
    try {
      await this.db.tx.$executeRaw(Prisma.sql`SELECT media_geo_put(${kind}::text, ${id}::uuid, ${JSON.stringify(meta)}::jsonb)`);
      await this.db.tx.$executeRaw`RELEASE SAVEPOINT geo_put`;
    } catch {
      await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT geo_put`;
      return false;
    }
    return meta.lat !== null && meta.lat !== undefined;
  }

  /** After an upload: reads the file in hand and keeps its point. Never fails the upload (a scan problem leaves the file unscanned; the admin scan picks it up). */
  async record(kind: 'document_file' | 'snag_photo', id: string, bytes: Buffer, mime: string, device: { lat: number | null; lon: number | null } | null = null): Promise<void> {
    if (!/^image\/(jpeg|png|tiff)$/i.test(mime) && !(device && device.lat !== null)) return;
    try {
      const cfg = await this.getSettings();
      if (cfg.enabled) await this.write(kind, id, bytes, mime, cfg, device);
    } catch {
      /* the file is stored; the scan can still read it later */
    }
  }

  /** The scan of images stored before the setting existed: up to `limit` files without a row, oldest first. A settings admin only. */
  async scan(auth: AuthContext, limitRaw: unknown): Promise<GeoStatus & { done: number }> {
    await this.access.requireAdmin('settings', 'edit');
    const limit = typeof limitRaw === 'number' && Number.isInteger(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
    const cfg = await this.getSettings();
    let done = 0;
    if (cfg.enabled) {
      const rows = await this.db.tx.$queryRaw<{ kind: 'document_file' | 'snag_photo'; id: string; storage_key: string; mime_type: string; size_bytes: bigint; device_lat: string | null; device_lon: string | null }[]>(
        Prisma.sql`SELECT kind, id::text AS id, storage_key, mime_type, size_bytes, device_lat::text AS device_lat, device_lon::text AS device_lon FROM media_geo_pending(${limit}::int)`);
      for (const r of rows) {
        const chunks: Buffer[] = [];
        let n = 0;
        try {
          for await (const c of await this.storage.store.get(r.storage_key)) {
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c as Uint8Array);
            chunks.push(b); n += b.length;
            if (n >= HEAD_BYTES) break;
          }
        } catch {
          // the object is gone or unreadable: an empty row so the scan does not meet it again
        }
        const device = r.device_lat !== null && r.device_lon !== null ? { lat: Number(r.device_lat), lon: Number(r.device_lon) } : null;
        await this.write(r.kind, r.id, Buffer.concat(chunks), r.mime_type, cfg, device);
        done++;
      }
    }
    await this.syslog.write('info', 'media_geo_scan', { scanned: done }, auth.user.id);
    return { ...(await this.status()), done };
  }
}
