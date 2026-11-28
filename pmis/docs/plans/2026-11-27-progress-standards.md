# Plan: progress-calculation standards (PR #458)

Status: in progress. One PR, one branch `feat/progress-standards`, contract label 0.15.269, migrations 0540+ in order, one commit per proposal, tests per proposal, docs EN+AR in the same PR. Owner decisions came from the project owner on 2026-11-27 and were relayed in chat. Merge order, deploy and main stay with the owner: the PR opens as a draft and merges only at a real 8/8 in an owner-granted window. No dependency changes; CHANGELOG.md untouched.

## Commits (all pushed)

- [DONE] 0540 register / level-of-effort ground work.
- [DONE] 0541 draft calibrated weight set v2 (A4 25→20, A6 12→15, A7 13→15; every activity totals 100; a draft is never auto-published).
- [DONE] 0542 task estimated man-days / planned duration and the suggested weight.
- [DONE] 0543 partial credit (off by default; GET/PUT /settings/partial-credit).
- [DONE] 0544 warehouse-linked central equipment.
- [DONE] 0545 per-region forecast date + the full contract pass (`86805046`).
- [DONE] 0546 Arabic name backfill for the 45 items + the weight freeze narrowed to allow name-only changes on a published set (`2f1d0c48`).
- [DONE] 0547 the B11 split: draft workflow v2 with B12 (Internal AC/DC → 4.3) and B16 (Site internal fiber → 4.5) after B9, feeding MS3, with the B11 SLA; B9/B11/B12/B16 apply to every site; migration carry-over of an approved B11 into B12/B16 with the same date and an audit line (`bac4f805`).
- [DONE] 0548 the milestone and phase-gate date rule for v2+ sites: a milestone's date is the date of its last linked task, set automatically (Site RFI/MS4 included); a phase gate takes the milestone's date and nothing else; conditions and Change Control suspensions decide open/blocked but never move the date; version 1 sites and historical dates untouched (`ca28ca2c`).
- [DONE] 0549 the owner-approved Arabic names of the 45 items, on the published and the draft set (`f8e277e6`).
- [DONE] API + contract + web for the date rule: `is_milestone_task` and `workflow_version` on TaskSummary, and the drawer's actual date is read-only with a hint on a v2+ milestone task (`35610e8c`).
- [DONE] Docs EN+AR (this note and rules.md §6.1).
- [DONE] 0590 merge compatibility with 0552 (main, #471): in migration-number order the 0552 in-place replace of weight_set_errors runs after 0540/0544 and would drop their register and warehouse blocks, and its method whitelist does not know warehouse; 0590 extends the whitelist and re-applies both blocks, idempotently, so deployed databases that already applied 0552 change nothing.
- [DONE] 0591 doc_live_spec dedupe: 0547's version-2 copy of document placements left two active placement rows for tasks placed on both sides of a split stage; 0591 keeps one placement per task (verified: A2 one placement, B9 keeps [B8,B9]).

## What stayed manual

- NMS ×3 (3.8, 6.6, 7.7), Pilot (6.1) and HLD (1.3): no existing workflow task or register key to link, so they stay manual central items.
- Training (8.1) stays manual by decision.

## Out of scope

- Site-complexity weighting factor: approved by the owner 2026-11-28 (derived/automatic only) and built on branch `feat/site-complexity-weighting` (migration 0593), so no longer out of scope of the engine.
- Settings gap 1 from the review: the UI profiles agent builds it in its own Settings PR.
- Old-version sites: frozen on workflow v1 everywhere above.

## Tests

- `test/b11-split.test.ts` (7): the v2 draft structure and SLA, applicability, the weight links (4.3 = [B11,B12], 4.5 = [B11,B16]; B12 moves only 4.3, B16 only 4.5), both sets total 100, the migration carry-over.
- `test/milestone-autodate.test.ts` (7): the typed date is overridden by the last linked task's date; a pending linked task leaves the date alone; Site RFI takes the latest of civil works, CW PAC and GECOL with HLC skipped when not required; a submit needs no typed date; the gate keeps the milestone date against a later condition; a suspension blocks but never shifts; version 1 keeps today's behavior exactly.
- `test/name-ar-corrections.test.ts` (2): every one of the 45 items carries exactly the approved Arabic name on both sets; the approval is audited.

---

## ملاحظة الخطة بالعربية (PR #458)

فرع واحد `feat/progress-standards`، ترحيلات 0540+ بالترتيب، التزام واحد لكل مقترح، والاختبارات مع كل التزام. الدمج يبقى للمالك عند اكتمال 8/8 فقط.

- **الأسماء العربية للبنود الـ45:** اعتمدها المالك كاملة (1.3 «التصميم العام (HLD)»، 1.4 «التصميم الفني الدقيق لكل موقع (LLD)»، 1.2 «اعتماد مخطط الموقع وتقرير تحليل البرج (Layout/STA/ST)»، 4.1 «بنود تهيئة الموقع (Adaption)»، 5.2 «المواد في الموقع (MOS)»، 5.4 «وثيقة تركيب الأجهزة (HWID)»، 7.1 «الاختبار المستقل للموقع (EIR) لكل نظام»، 7.3 «زيارة فحص الموقع (SSV)»، 4.6 «وصلة الألياف الضوئية (HLC)»، 5.1 «اعتماد مذكرة تسليم المواد (DN) لأعمال TE»، 5.3 «بنود تركيب TE»، القبول «الابتدائي» لـPAC/PAT، 3.7 «الموجّه (Router)»، 3.9 «خادم الشبكة الأساسية (Core Server)»، 4.5 «الألياف الضوئية للموقع»، 6.5 «دخول الخدمة (On-Air)»؛ 2.1 و8.1 كما هما؛ معدات 3.2–3.4 بنص المالك). الاختصار اللاتيني في نهاية الاسم بين قوسين. تُعدَّل الأسماء من محرر مجموعة الأوزان المسودة.
- **تقسيم B11 (مسودة سير العمل v2):** B11 لبنود التهيئة (4.1) فقط؛ B12 «الأعمال الكهربائية الداخلية» لـ4.3 وB16 «الألياف الضوئية للموقع» لـ4.5 بعد B9 مثل B11، يغذيان MS3 وبنفس اتفاقية مستوى الخدمة (4–8 أيام عمل من CW MOS Actual (AZ)). الأربعة B9/B11/B12/B16 تنطبق على كل المواقع. موقع عليه B11 معتمدة تُعتمد له B12 وB16 بنفس التاريخ مع قيد تدقيق؛ وB11 الجارية تتركهما مفتوحتين. مواقع الإصدار 1 مجمدة.
- **تاريخ المعلم والبوابة (الإصدار 2 فأحدث):** تاريخ المعلم = تاريخ آخر مهمة مرتبطة به، يُحسب تلقائيًا ولا يُكتب يدويًا، وجاهزية الموقع للتركيب (Site RFI/MS4) مثل بقية المعالم: مهامها المرتبطة الأعمال المدنية (MS3) والقبول الابتدائي للأعمال المدنية (B13) وGECOL (C2) ووصلة الألياف (C4) عندما يتطلبها الموقع، وأحدثها يحسم. البوابة تأخذ تاريخ المعلم فقط؛ الشروط (التصاريح، المهام، حقول التاريخ بإزاحة) والإيقافات في Change Control تتحكم في الفتح/الحجب ولا تحرّك التاريخ أبدًا. مواقع الإصدار 1 تبقى على سلوك اليوم حرفيًا ولا يُعاد كتابة أي تاريخ تاريخي. المعالم بلا وزن ولا مدة (عناوين فقط).
- **يبقى يدويًا:** NMS الثلاثة وPilot وHLD (لا مهمة سير عمل ولا سجل قائم يربطها)، والتدريب يدوي بقرار.
- معامل وزن تعقيد الموقع: وافق عليه المالك بتاريخ 2026-11-28 (مشتق/تلقائي فقط) وبُني على فرع `feat/site-complexity-weighting` (الترحيل 0593). فجوة الإعدادات الأولى يبنيها وكيل واجهات الإعدادات في PR خاص به.
