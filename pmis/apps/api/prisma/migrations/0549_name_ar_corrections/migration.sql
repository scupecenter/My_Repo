-- 0.15.269: the owner-approved Arabic names of the 45 Project Status weight items (owner decision 2026-11-27,
-- on top of the 0546 backfill). Source: the bilingual review table with the owner's final picks: 1.2/1.3/1.4,
-- 4.1, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 6.5, 7.1, 7.3, PAC/PAT «الابتدائي», 3.7, 3.9; 2.1 and 8.1 stay as they were;
-- the owner's exact equipment names 3.2-3.4 stand. Latin acronyms sit at the end of the name in parentheses so the
-- name reads right in RTL messaging. Only name_ar changes; the 0546 freeze narrowing already lets a published set
-- take a name_ar-only update, and this migration writes the values directly for both the published and the draft set.

UPDATE public.weight_items i
   SET name_ar = x.name_ar
  FROM (VALUES
    ('1.1',  'اعتماد تقرير المسح الفني الميداني (TSSR)'),
    ('1.2',  'اعتماد مخطط الموقع وتقرير تحليل البرج (Layout/STA/ST)'),
    ('1.3',  'التصميم العام (HLD)'),
    ('1.4',  'التصميم الفني الدقيق لكل موقع (LLD)'),
    ('1.5',  'قوالب الوثائق الفنية'),
    ('2.1',  'اختيار الموقع المرشح'),
    ('2.2',  'اكتساب الموقع'),
    ('2.3',  'تصريح دخول الموقع للأعمال المدنية'),
    ('3.1',  'أمر الشراء / أمر العمل للأعمال المدنية (PO/WO)'),
    ('3.2',  'هوائي الراديو (BTS)'),
    ('3.3',  'هوائي التراسل (PtP)'),
    ('3.4',  'هوائي طرفي (CPE)'),
    ('3.5',  'البطاريات'),
    ('3.6',  'خزانة المعدات'),
    ('3.7',  'الموجّه (Router)'),
    ('3.8',  'نظام إدارة الشبكة (NMS)'),
    ('3.9',  'خادم الشبكة الأساسية (Core Server)'),
    ('3.10', 'الفوترة'),
    ('4.1',  'بنود تهيئة الموقع (Adaption)'),
    ('4.2',  'أعمال البرج'),
    ('4.3',  'الأعمال الكهربائية الداخلية (AC/DC)'),
    ('4.4',  'توصيل التغذية الكهربائية من GECOL'),
    ('4.5',  'الألياف الضوئية للموقع'),
    ('4.6',  'وصلة الألياف الضوئية (HLC)'),
    ('4.7',  'جاهزية الموقع للتركيب (RFI)'),
    ('4.8',  'القبول الابتدائي للأعمال المدنية (PAC)'),
    ('5.1',  'اعتماد مذكرة تسليم المواد (DN) لأعمال TE'),
    ('5.2',  'المواد في الموقع (MOS)'),
    ('5.3',  'بنود تركيب TE'),
    ('5.4',  'وثيقة تركيب الأجهزة (HWID)'),
    ('6.1',  'الموقع التجريبي (Pilot)'),
    ('6.2',  'التشغيل التجريبي (Commissioning)'),
    ('6.3',  'مواءمة وصلة الميكروويف (MW)'),
    ('6.4',  'الدمج في الشبكة (Integration)'),
    ('6.5',  'دخول الخدمة (On-Air)'),
    ('6.6',  'الدمج في نظام إدارة الشبكة (NMS)'),
    ('7.1',  'الاختبار المستقل للموقع (EIR) لكل نظام'),
    ('7.2',  'اختبار القبول الابتدائي (PAT) لكل نظام'),
    ('7.3',  'زيارة فحص الموقع (SSV)'),
    ('7.4',  'مخططات التنفيذ النهائي (As-Built)'),
    ('7.5',  'القبول الابتدائي لأعمال TE (PAC)'),
    ('7.6',  'قبول مؤشرات الأداء الرئيسية (KPI)'),
    ('7.7',  'قبول نظام إدارة الشبكة (NMS)'),
    ('8.1',  'تدريب المورّد'),
    ('8.2',  'التسليم والاستلام (HOTO)')
  ) AS x(code, name_ar)
 WHERE i.code = x.code
   AND i.name_ar IS DISTINCT FROM x.name_ar
   AND EXISTS (
     SELECT 1 FROM public.weight_activities a
     JOIN public.weight_sets s ON s.id = a.weight_set_id
     WHERE a.id = i.activity_id AND s.code = 'project_status'
   );

INSERT INTO public.audit_log (action, entity_type, entity_id, reason, after, is_admin_override, actor_id)
VALUES ('progress_standards_name_ar', 'weight_set', 'project_status', 'Owner-approved Arabic names of the 45 weight items (0.15.269, owner decision 2026-11-27)',
        jsonb_build_object('items', 45, 'source', 'owner-approved review table 2026-11-27'), true,
        '00000000-0000-0000-0000-000000000000');
