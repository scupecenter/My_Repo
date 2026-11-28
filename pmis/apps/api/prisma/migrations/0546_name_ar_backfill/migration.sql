-- 0.15.269: Arabic names of the 45 progress weight items (owner request 2026-11-27).
-- Published weight sets are immutable (weight_freeze), so this migration first narrows the freeze:
-- on a published set a weight_items UPDATE that changes ONLY name_ar stays allowed (Arabic labels
-- stay fixable on the live set; weights, codes, rules and structure still cannot move). Drafts were
-- never frozen. Then the 45 names are backfilled where name_ar is empty; an Arabic name an admin
-- already typed is kept. Idempotent.

CREATE OR REPLACE FUNCTION public.weight_freeze()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE sid uuid;
BEGIN
  IF TG_TABLE_NAME = 'weight_sets' THEN
    IF OLD.status = 'published' AND (NEW.code, NEW.version, NEW.effective_from, NEW.status, NEW.reason)
       IS DISTINCT FROM (OLD.code, OLD.version, OLD.effective_from, OLD.status, OLD.reason) THEN
      RAISE EXCEPTION 'published weight set % is immutable; create a new version', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    IF TG_OP = 'DELETE' AND OLD.status = 'published' THEN
      RAISE EXCEPTION 'published weight set % cannot be deleted', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  END IF;
  IF TG_TABLE_NAME = 'weight_activities' THEN sid := coalesce(NEW.weight_set_id, OLD.weight_set_id);
  ELSE SELECT a.weight_set_id INTO sid FROM weight_activities a WHERE a.id = coalesce(NEW.activity_id, OLD.activity_id);
  END IF;
  IF EXISTS (SELECT 1 FROM weight_sets WHERE id = sid AND status = 'published') THEN
    -- 0.15.269: on a published set a weight_items UPDATE that changes only name_ar is allowed.
    IF TG_TABLE_NAME = 'weight_items' AND TG_OP = 'UPDATE'
       AND (NEW.activity_id, NEW.code, NEW.name, NEW.weight, NEW.unit, NEW.measure_rule, NEW.source, NEW.sort)
           IS NOT DISTINCT FROM (OLD.activity_id, OLD.code, OLD.name, OLD.weight, OLD.unit, OLD.measure_rule, OLD.source, OLD.sort) THEN
      RETURN NEW;
    END IF;
    RAISE EXCEPTION 'weight set % is published; its activities and items are immutable', sid USING ERRCODE = 'check_violation';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END $function$;

UPDATE public.weight_items i SET name_ar = 'اعتماد TSSR'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '1.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'اعتماد التخطيط / STA / ST'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '1.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'التصميم عالي المستوى HLD'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '1.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'التصميم التفصيلي LLD لكل موقع'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '1.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'قوالب الوثائق الفنية'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '1.5' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'اختيار الموقع المرشح'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '2.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'اكتساب الموقع'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '2.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'تصريح دخول الأعمال المدنية'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '2.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'أمر شراء / عمل الأعمال المدنية'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'هوائي الراديو'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'هوائي التراسل'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'هوائي طرفي'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'البطاريات'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.5' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'خزانة المعدات'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.6' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الراوتر'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.7' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'نظام إدارة الشبكة NMS'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.8' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'خادم النواة'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.9' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الفوترة'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '3.10' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'أعمال تأهيل الموقع'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'أعمال البرج'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الكهرباء الداخلية AC/DC'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'تشغيل كهرباء GECOL'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الألياف البصرية للموقع'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.5' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'ربط HLC'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.6' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'جاهزية الموقع للتركيب RFI'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.7' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'القبول المبدئي للأعمال المدنية PAC'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '4.8' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'اعتماد مذكرة تسليم معدات TE'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '5.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'أمر توريد معدات TE (MOS)'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '5.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'بنود أعمال TE'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '5.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'تعريف الأجهزة HWID'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '5.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الموقع التجريبي'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'التشغيل التجريبي'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'مواءمة المايكروويف'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الدمج في الشبكة'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'على الهواء'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.5' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'الدمج في نظام إدارة الشبكة'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '6.6' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'تقرير الفحص الأولي EIR لكل نظام'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'اختبار القبول المبدئي PAT لكل نظام'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'جولة فحص الموقع SSV'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.3' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'مخططات التنفيذ النهائية As-Built'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.4' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'القبول المبدئي لأعمال TE'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.5' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'قبول مؤشرات الأداء KPI'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.6' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'قبول نظام إدارة الشبكة'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '7.7' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'تدريب المورّد'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '8.1' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
UPDATE public.weight_items i SET name_ar = 'التسليم والتشغيل HOTO'
FROM public.weight_activities a JOIN public.weight_sets s ON s.id = a.weight_set_id
WHERE i.activity_id = a.id AND s.code = 'project_status' AND i.code = '8.2' AND (i.name_ar IS NULL OR btrim(i.name_ar) = '');
