import type { Client as PgClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { superDb } from './helpers';

/**
 * Migration 0549 (0.15.269, owner decision 2026-11-27): the owner-approved Arabic names of the 45 Project Status
 * weight items, over the 0546 backfill. Every item of the published set and of the draft set carries exactly the
 * approved name_ar; Latin acronyms sit at the end in parentheses.
 */
let db: PgClient;

beforeAll(async () => {
  db = await superDb();
});
afterAll(async () => {
  await db.end();
});

const APPROVED: Record<string, string> = {
  '1.1': 'اعتماد تقرير المسح الفني الميداني (TSSR)',
  '1.2': 'اعتماد مخطط الموقع وتقرير تحليل البرج (Layout/STA/ST)',
  '1.3': 'التصميم العام (HLD)',
  '1.4': 'التصميم الفني الدقيق لكل موقع (LLD)',
  '1.5': 'قوالب الوثائق الفنية',
  '2.1': 'اختيار الموقع المرشح',
  '2.2': 'اكتساب الموقع',
  '2.3': 'تصريح دخول الموقع للأعمال المدنية',
  '3.1': 'أمر الشراء / أمر العمل للأعمال المدنية (PO/WO)',
  '3.2': 'هوائي الراديو (BTS)',
  '3.3': 'هوائي التراسل (PtP)',
  '3.4': 'هوائي طرفي (CPE)',
  '3.5': 'البطاريات',
  '3.6': 'خزانة المعدات',
  '3.7': 'الموجّه (Router)',
  '3.8': 'نظام إدارة الشبكة (NMS)',
  '3.9': 'خادم الشبكة الأساسية (Core Server)',
  '3.10': 'الفوترة',
  '4.1': 'بنود تهيئة الموقع (Adaption)',
  '4.2': 'أعمال البرج',
  '4.3': 'الأعمال الكهربائية الداخلية (AC/DC)',
  '4.4': 'توصيل التغذية الكهربائية من GECOL',
  '4.5': 'الألياف الضوئية للموقع',
  '4.6': 'وصلة الألياف الضوئية (HLC)',
  '4.7': 'جاهزية الموقع للتركيب (RFI)',
  '4.8': 'القبول الابتدائي للأعمال المدنية (PAC)',
  '5.1': 'اعتماد مذكرة تسليم المواد (DN) لأعمال TE',
  '5.2': 'المواد في الموقع (MOS)',
  '5.3': 'بنود تركيب TE',
  '5.4': 'وثيقة تركيب الأجهزة (HWID)',
  '6.1': 'الموقع التجريبي (Pilot)',
  '6.2': 'التشغيل التجريبي (Commissioning)',
  '6.3': 'مواءمة وصلة الميكروويف (MW)',
  '6.4': 'الدمج في الشبكة (Integration)',
  '6.5': 'دخول الخدمة (On-Air)',
  '6.6': 'الدمج في نظام إدارة الشبكة (NMS)',
  '7.1': 'الاختبار المستقل للموقع (EIR) لكل نظام',
  '7.2': 'اختبار القبول الابتدائي (PAT) لكل نظام',
  '7.3': 'زيارة فحص الموقع (SSV)',
  '7.4': 'مخططات التنفيذ النهائي (As-Built)',
  '7.5': 'القبول الابتدائي لأعمال TE (PAC)',
  '7.6': 'قبول مؤشرات الأداء الرئيسية (KPI)',
  '7.7': 'قبول نظام إدارة الشبكة (NMS)',
  '8.1': 'تدريب المورّد',
  '8.2': 'التسليم والاستلام (HOTO)',
};

describe('the owner-approved Arabic names', () => {
  it('gives every one of the 45 items exactly the approved name_ar, in the published set and the draft set', async () => {
    const r = await db.query(
      `SELECT s.version, i.code, i.name_ar
       FROM weight_items i
       JOIN weight_activities a ON a.id = i.activity_id
       JOIN weight_sets s ON s.id = a.weight_set_id
       WHERE s.code = 'project_status'
       ORDER BY s.version, i.code`);
    const byVersion = new Map<number, Map<string, string | null>>();
    for (const row of r.rows) {
      if (!byVersion.has(row.version)) byVersion.set(row.version, new Map());
      byVersion.get(row.version)!.set(row.code, row.name_ar);
    }
    expect(byVersion.size).toBeGreaterThanOrEqual(2); // published v1 and draft v2
    for (const [version, items] of byVersion) {
      expect(items.size, `version ${version} item count`).toBe(45);
      for (const [code, nameAr] of Object.entries(APPROVED)) {
        expect(items.get(code), `version ${version} item ${code}`).toBe(nameAr);
      }
    }
  });

  it('records the owner approval in the audit log', async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'progress_standards_name_ar'`);
    expect(r.rows[0]!.n).toBeGreaterThanOrEqual(1);
  });
});
