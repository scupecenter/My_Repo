# GSDN Workspace — مراجعة الأسئلة والإجابات المقترحة

> **Status (2026-11-04): approved by the product owner as decisions.** The owner confirmed in the session that every answer below is an owner decision (the preface's "advisory" wording is superseded). Where an answer depends on data not yet provided, the current default stays until the data arrives. Implementation plan: `docs/plans/2026-11-04-owner-answers-gap.md`.


تاريخ المراجعة: 2026-11-03 — أُجيب عن جميع الأسئلة الـ108، مع الحفاظ على أرقامها وترتيبها ونصوصها الأصلية وإضافة الإجابة العربية تحت **Answer:**.

## نطاق هذه الإجابات وحالتها

هذه إجابات استشارية مقترحة لتجهيز القرارات والتنفيذ، مبنية على الأسئلة المرفقة وسياق الاتفاقات السابقة لمشروع GSDN Workspace؛ ليست ادعاءً بأن المالك اعتمد كل اختيار جديد. أُبقي اسم GSDN الوارد في الملف، دون افتراض إعادة تسمية المشروع إلى GSDM.

لم تُرفق هنا نسخ CLAUDE.md أو Blueprint أو rules.md أو Master أو المستودع؛ لذلك عوملت أوصاف التنفيذ وأرقام الترحيلات الواردة في الأسئلة كمعلومات من الملف، ولم يُتحقق من الكود أو الصيغ أو حالة البناء فعليًا. الإشارات إلى ملفات/أقسام أخرى محفوظة كما وردت وليست مصادر فُحصت في هذه المراجعة. الإجابة الخاصة بالسؤال تتقدم على Proposed default إذا عدّلته؛ وعبارات «مؤقت» و«تجريبي» لا تعني اعتماد قيمة تشغيلية نهائية.

يرتكز التوجيه على مصدر واحد لكل حقل، وفصل CW عن TE وGECOL عن HLC، وحساب أيام العمل باستبعاد الجمعة والسبت والعطلات المعتمدة، واعتبار HOTO نهاية التسليم التشغيلي مع متابعة الإغلاق النهائي. تُستخدم مقارنة Master لشرح الفروق أثناء التشغيل المتوازي، ولا تصبح الأخطاء الموروثة قواعد دائمة لمجرد تحقيق التطابق.

هذه المراجعة تعدّل ملف الإجابات فقط، ولا تنفذ أي تغيير على النظام أو الأدوار أو البيانات أو القواعد الحالية. لا تزال هناك مدخلات خارجية لازمة قبل تثبيت بعض الإعدادات: مدة SLA المعتمدة لـ HLC، تقويم العطلات المعتمد، تعريف العوامل الستة لمؤشر الصحة، قوائم الأنواع غير المحسومة، أسماء مسؤولي التشغيل والمفاتيح، وقرار الشكل النهائي للـ Pipeline بعد المعاينة.

---

## Earlier open questions (P0 spec, phase 4)

### Q1

**The Master upload has no `_tpl` sheet.** CLAUDE.md rejects uploads without an embedded ID. The live Master file contains no `_tpl` sheet, but must be uploadable during migration and the 1-month parallel run.

**Proposed default / question:** GSDN Workspace issues a "Master template" by adding `_tpl` (TPL-MASTER, version) to the user's copy once. Until then, an admin-only "legacy Master import" path accepts it, identified by sheet names and headers, and writes every use to the System Log.

**Answer:** المقترح: الإبقاء على مسارين واضحين: استيراد Master قديم بصلاحية إدارية، وقوالب صادرة من PMIS تحمل `_tpl` ومعرّف القالب وإصداره. لا يُرفض الملف التشغيلي القديم لمجرد غياب الورقة، ولا تُضاف الورقة إلى الأصل دون نسخة محفوظة. يلزم فحص البنية ومعاينة الفروق قبل التطبيق، وتسجيل المصدر والبصمة ونتيجة كل استيراد؛ وجود `_tpl` وحده لا يثبت صحة المحتوى.


### Q2

**D-1 start where RFI is N/A.** CLAUDE.md measures D-1 from the Site RFI date. Hot / Cold Swap and sites with no CW, GECOL or HLC have no Site RFI (BP §03). BP §06 says D-1 is not measured for Swap.

**Proposed default / question:** D-1 starts from MS4. Where RFI is N/A, it starts from MS1 (the base date of gate CA). D-1 is not measured for Hot / Cold Swap. The Master SLA sheet (column Y, which starts from Site Release) needs the same fix for the parallel-run comparison.

**Answer:** المقترح: يبدأ D-1 من MS4 عندما يكون RFI مطلوبًا، ومن MS1، باعتباره التاريخ الأساسي لـ CA، عندما يكون RFI غير منطبق. لا يُقاس D-1 لسيناريوهَي Hot Swap وCold Swap. تُوحَّد القاعدة في PMIS ونسخة Master المقارنة بتغيير موثّق؛ التاريخ المفقود يبقى نقص بيانات ولا يُستبدل بتاريخ اليوم. جميع المدد بأيام العمل، واليوم نفسه = 0.


### Q3

**RFI for Swap sites.** BP §03 and the SLA sheet say RFI is N/A for Hot / Cold Swap. Site Calc F and Master BQ decide RFI from the flags AA:AD only.

**Proposed default / question:** Follow the Master formula (flags), so the parallel run matches. Add an alert when a Hot / Cold Swap site has any of AA:AD = Yes.

**Answer:** المقترح: لا نجعل خطأ محتملًا في Master قاعدة تشغيل دائمة. يكون RFI غير منطبق للـ Hot/Cold Swap وفق السيناريو؛ تعارض ذلك مع أعلام النطاق يوقف اعتماد النطاق حتى مراجعته. يمكن إظهار نتيجة معادلة Master القديمة في مقارنة مستقلة مع تفسير الفرق، دون استخدامها لاعتماد البوابات. إذا ثبت وجود أعمال تتطلب RFI، يُعتمد استثناء نطاق موثّق عبر Change Control.


### Q4

**The holidays table is empty.** Setting "Public Holidays" (F:G) has no rows, so every SLA currently ignores holidays.

**Proposed default / question:** The admin enters the Libyan public holidays for 2026–2027 before the pilot. Until then SLA counts Fri / Sat only, and a banner warns "holiday table empty".

**Answer:** المقترح: إدخال تقويم العطلات الليبية من مصدر معتمد ومراجعته قبل التجربة، مع الجمعة والسبت عطلة أسبوعية. لا نختلق تواريخ 2026–2027؛ العطلات التي لم تُعلن تبقى معلّقة للمراجعة. إلى حين الاكتمال، يظهر تنبيه بأن النتائج تستبعد العطلات الأسبوعية فقط؛ تغيير التقويم له إصدار وتاريخ سريان ولا يعيد كتابة النتائج التاريخية بصمت.


### Q5

**Document step codes differ.** CLAUDE.md seeds "B4 STA / ST report", but in the blueprint step table B4 is the CW survey and B5 is STA / ST. CLAUDE.md seeds "B9 MOS proof" only, but B8 (tower MOS) has the same evidence.

**Proposed default / question:** Attach the STA / ST report to step B5 and the MOS proof to both B8 and B9. Confirm both.

**Answer:** المقترح: ربط تقرير STA/ST بالخطوة B5، وإثبات MOS بكل من B8 وB9 عند انطباقهما. يحتفظ B4 بمستندات المسح الخاصة به. تُصحَّح المراجع في المواصفة والقوالب ومكتبة المستندات معًا، ويُسمح بإعادة استخدام المستند نفسه إذا كان يغطي الخطوتين فعلًا، دون رفع نسخ مكررة.


### Q6

**Warehouse need for IP Router Only sites.** D72 applies a fixed need to every TE site: Router 1, Cabinet 1, Battery 2, LPU 2, plus sectors. An IP Router Only site (AF = Yes) probably needs only the router, so its TE Dispatch Complete would never be reached.

**Proposed default / question:** When AF = Yes and AE = N/A, the need is Router = 1 and every other unit = 0, as a configurable rule per scenario. Confirm before the WH build.

**Answer:** المقترح: عندما AF = Yes وAE = N/A يكون الاحتياج الأساسي Router = 1 وبقية الوحدات = 0، كقاعدة قابلة للضبط للسيناريو. تُضاف الملحقات فقط من BOQ/تكوين موقع معتمد، ولا تُفرض Cabinet/Battery/LPU على Router Only تلقائيًا. اكتمال الصرف يقارن بالمطلوب المعتمد للموقع، مع معالجة أي تعارض في أعلام النطاق قبل الاعتماد.


### Q7

**Delay that no period covers.** BP §14 attributes the days above SLA to the executor (R). BP §09 says days not attributed are charged to no one.

**Proposed default / question:** Show these days on the default party (R), tagged "default (R)" and kept separate from approved attributions. The contractor scorecard counts approved attributions only (BP §06).

**Answer:** المقترح: تُعرض الأيام غير المغطاة باسم «تأخير غير منسوب»، وتظهر الجهة R كاقتراح مسؤولية فقط، لا كإسناد معتمد. تبقى هذه الأيام ضمن إجمالي تأخير المشروع، ولا تدخل تقييم المقاول أو الجزاءات حتى اعتماد الإسناد. يمنع احتساب اليوم نفسه مرتين، وتظهر نسبة الأيام المعتمدة وغير المنسوبة بوضوح.


### Q8

**Role list mismatch.** Setting StaffRole (15 values, for example "Team Lead (GECOL)", "Team Lead (Fiber)", "CW Engineer") does not match the 6 main roles and 9 sub-roles in CLAUDE.md.

**Proposed default / question:** GSDN Workspace uses the CLAUDE.md roles. Import maps the Master values (Team Lead (CW) → CW Team Lead, CW Engineer / Site Engineer → Site Engineers (CW), Team Lead (GECOL) → GECOL Power Team, and so on). The mapping table is editable and approved by the owner.

**Answer:** المقترح: اعتماد أكواد أدوار PMIS المستقرة، مع جدول تحويل قابل للتحرير والمراجعة لقيم Master. لا تُمنح صلاحيات فعلية لمجرد تطابق المسمى الوظيفي المستورد؛ يراجع المسؤول الدور والمنطقة والنطاق. لا يُحوَّل Site Engineer العام إلى CW تلقائيًا إن لم يُعرف تخصصه؛ القيم الملتبسة تظهر كاستثناءات استيراد. تبقى وظائف GECOL وFiber ممثلة دون فقدها في التحويل.


### Q9

**Gate date vs extra conditions.** CLAUDE.md says the gate date equals the previous milestone date. The Master gates AX, CA and CV take the latest of that date, the Access / PTW permit dates and the Commissioning Power Safe Date, and stay blank while a Stop Work is active.

**Proposed default / question:** Follow the Master formulas (rules.md §2.2). The CLAUDE.md wording covers the base case. An ADR records the refinement.

**Answer:** المقترح: تاريخ البوابة هو أحدث تاريخ بين المعلم السابق وجميع شروط السلامة والتصاريح المطلوبة والمنطبقة. مع شرط ناقص أو Stop Work فعال تكون البوابة محجوبة، ويُحتفظ بتاريخ فتحها السابق في السجل بدل محوه. سحب موافقة يعيد تقييم البوابات اللاحقة دون حذف إنجازاتها التاريخية؛ تُحدَّث المواصفة وADR بهذه القاعدة.


### Q10

**Region names.** The Master stores "Tripoli Area", "Middle Area" and so on. CLAUDE.md uses "Tripoli", "Middle" and so on.

**Proposed default / question:** Store a region code with an English and an Arabic label. Import maps "X Area" → X.

**Answer:** المقترح: تخزين كود ثابت للمنطقة مع تسميتين EN/AR، وجدول aliases للاستيراد والتصدير. تتحول القيم القديمة، مثل Tripoli Area، إلى الكود المقابل من خلال الجدول، لا بإزالة كلمة Area من أي نص عشوائيًا. القيم غير المعروفة تستلزم معالجة، وتغيير التسمية لا يغيّر ارتباط السجلات أو صلاحيات المناطق.


### Q11

**Several issues per site vs the Master.** The Master holds one issue per site (GA:GE). GSDN Workspace allows several. For the parallel-run export, which issue goes into GA:GE?

**Proposed default / question:** Export the oldest open issue, or the latest closed one when none is open, and append "+N more" in Remark.

**Answer:** المقترح: لأغراض توافق Master فقط، تُصدَّر أقدم مشكلة مفتوحة؛ وعند عدم وجود مفتوحة، أحدث مشكلة مغلقة. تُضاف عبارة +N more في Remark دون استبدال النص الأصلي، ويُرفق تصدير كامل مستقل للمشكلات. تعرض واجهة PMIS أيضًا المشكلات الحرجة أولًا، فلا تؤدي قاعدة التصدير إلى إخفاء الأهم تشغيليًا؛ تُوثَّق قاعدة كسر تعادل التواريخ بمعرّف السجل.


### Q12

**Meetings register has no source.** CLAUDE.md lists Meetings, but it has no Master sheet and no blueprint fields.

**Proposed default / question:** Minimal fields: date, title, type, attendees, sites, minutes file, and action items (owner, due date, status). Owner to confirm.

**Answer:** المقترح: سجل اجتماعات يشمل التاريخ، العنوان، النوع، المنظم، الحضور، المواقع/المشروع المرتبط، ومحضرًا مرفقًا. تكون إجراءات المتابعة عناصر منظمة لكل منها مسؤول وموعد وحالة وتاريخ إغلاق ورابط إلى المهمة إن وجدت. التاريخ والعنوان إلزاميان؛ الاجتماع قد يكون عامًا دون موقع، ولا تتحول الملاحظات تلقائيًا إلى مهام دون إجراء واضح.


### Q13

**B-6 is always 0 for analysis sites.** The Master has a single submission date (AR) for both the analysis report and the layout. B-6 therefore runs AR → AR when an analysis exists (D47).

**Proposed default / question:** Keep the Master behaviour for the parallel run. Propose a separate Layout Submitted Date after the Master is retired.

**Answer:** المقترح: حفظ سلوك AR → AR في مقياس توافق Master فقط مع وسم «قيمة موروثة لا تقيس دورة فعلية». يبدأ PMIS بحقل مستقل لـ Layout Submitted Date عند تفعيل القاعدة الجديدة، دون ملئه تخمينيًا من التاريخ الآخر. تعرض المقارنة الفرق، وتبقى مؤشرات الماضي بإصدار القاعدة الذي احتُسبت به؛ لا ينتظر إصلاح النموذج تقاعد Master بالكامل.


### Q14

**SLA step count.** D64 says 44 steps, but SLA sheet columns D:AV hold 45 step columns (B-10a and B-10b are separate).

**Proposed default / question:** Treat the 45 columns as the source of truth. 44 counts B-10 as one step.

**Answer:** المقترح: اعتماد 45 عمود قياس SLA في النسخة الحالية، مع توضيح أن 44 هو العد عند جمع B-10a وB-10b. لا يُستنتج عدد الخطوات النشطة لكل موقع من هذا الرقم، بل من السيناريو والنطاق. يلزم جدول أكواد مرجعي يطابق أعمدة SLA بالمهام الحالية، لأن تقسيم/دمج المهام قد يغيّر طريقة العرض دون تغيير القياسات الأصلية.


### Q15

**Swap sites and stage 1 (A1, A3).** Expansion drops A1 and A3 (CLAUDE.md). Nothing says whether Hot / Cold Swap sites, which are existing sites, need a search, a SAR and an acquisition.

**Proposed default / question:** A1 and A3 apply by default, and a scenario template setting can mark them N/A. Confirm.

**Answer:** المقترح: في Hot/Cold Swap على الموقع نفسه تكون A1 وA3 غير منطبقتين افتراضيًا إذا لم توجد حاجة بحث أو استحواذ جديد. تبقى مراجعة حق الدخول والموافقة على العمل والتصاريح مطلوبة حيث تنطبق. إذا وُجد موقع بديل أو عقد/استحواذ جديد، تُفعَّل الخطوات ذات الصلة عبر قالب السيناريو أو استثناء نطاق معتمد؛ لا تُعلَّم مكتملة وهميًا.


### Q16

**Health index and Final Closure KPI formulas.** These are new PMIS features with no source formula (rules.md §6.1, §9).

**Proposed default / question:** Equal weights across the 6 factors. The % closed base is HOTO-achieved sites. FAC age is counted from DLP End. The owner reviews all three before P1.

**Answer:** المقترح: أوزان متساوية للعوامل الستة كنموذج تجريبي فقط، مع توثيق تعريف كل عامل وطريقة تحويله إلى 0–100؛ هذه التعريفات غير واردة هنا فلا نختلقها. العامل غير المنطبق يُستبعد وتُعاد موازنة البقية، أما البيانات المفقودة فتظهر كنقص تغطية. نسبة Final Closure = المواقع المغلقة نهائيًا من المواقع المحققة HOTO حتى تاريخ التقرير؛ FAC overdue يبدأ بعد DLP End عند انطباق FAC. تبقى المؤشرات تجريبية حتى مراجعة الصيغ، وHOTO هو نهاية التسليم التشغيلي الأساسية.


### Q17

**TE PAC e-signature.** BP §05 says TE PAC is e-signed by the project team. CLAUDE.md says acceptance documents are filled, signed, scanned and uploaded.

**Proposed default / question:** Scanned upload only (CLAUDE.md). E-signature is deferred.

**Answer:** المقترح: اعتماد رفع نسخة TE PAC الموقعة والممسوحة ضوئيًا في المرحلة الحالية، مع رقم المستند وإصداره وصلاحيات اعتماده. موافقة L2 داخل النظام لا تُسمّى توقيعًا إلكترونيًا على المستند. التوقيع الإلكتروني ميزة لاحقة بمواصفة مستقلة، دون منع تطويرها مستقبلًا.


### Q18

**Assignment overlaps and level order.** CLAUDE.md now makes role assignment many-to-many with validity dates. It does not say whether two rows of the same role with overlapping dates may exist, or whether a higher permission level includes the lower ones.

**Proposed default / question:** One active row per user and role at a time; a bulk assign skips existing rows. The levels are ordered view < entry < review < approve < admin, and each includes the lower ones (AU-10, AU-11, MX-02b).

**Answer:** المقترح: منع التعيين المكرر أو المتداخل لنفس المستخدم والدور والنطاق والمنطقة، مع السماح بتعيينات مستقلة لمناطق/نطاقات مختلفة. التعيين الجماعي يتجاوز التطابق ويُظهر التعارضات. مستويات العمل تتدرج داخل الصلاحية المحددة، لكن approve لا يمنح admin أو تصديرًا أو حذفًا تلقائيًا، ولا يلغي منع اعتماد الشخص لإدخاله. تُفصل صلاحيات الدور عن مستويات L1/L2 الحالية وعن تاريخ المسار القديم ذي الثلاثة مستويات.


### Q103

**Typed effects of the registers enabled in 0025 / 0027.** The registers run on the generic framework, so an approved record stays in `register_records` (like Dismantle). The typed tables and the calculation readers are not fed: Change Control to `change_requests` (the suspension shift of the gates reads it), Acquisition (selected candidate, A3, Master T) and RF & Design (Master C:Q, the `SiteIDs` list), Quality snags (the PAC / FAC block, Q58), Readiness (G6, MS9, Z1), As-Built (Master BU and EF, Q68 / Q99), Issues and Risks (health index). Only two effects are built: Contractors to `external_parties` / `external_teams` (Procurement picks them) and the approver fields of Q45.

**Proposed default / question:** Keep the approved data in the register and feed the calculation layer register by register in follow-up work; until then the calc layer reads what it read before. The owner orders the follow-ups (suggested: Change Control, then Quality, then Acquisition and RF & Design).

**Answer:** المقترح: لا يُعد السجل مكتملًا وظيفيًا إذا كان اعتماده لا يصل إلى الحسابات والبوابات المعنية. ترتيب المعالجة: Change Control وQuality، ثم RF & Design/Acquisition، ثم Readiness وAs-Built، ثم Issues/Risks، مع إكمال الجميع قبل الاعتماد التشغيلي للوظائف التابعة. يكون الربط من المصدر المعتمد، قابلًا لإعادة التنفيذ دون تكرار، ويعالج السحب والإلغاء. مؤقتًا تظهر الوظائف غير المربوطة كغير متاحة/بيانات غير مكتملة، لا كصفر أو إنجاز صحيح.


### Q104

**Values of the lists the spec names but does not fix** (CompanyType, CoStatus, TeamType, TeamSpecialization, TeamStatus, Severity, QIResult, Activity, IssueStatus, RiskCat, ScopeCWTE, RiskResponse, RiskStatus, Trend, EHSCheck, ReviewStatus, SiteType, TowerOwner, TowerType, Ownership, TestPit, WLVendor and the other vendor and type lists of As-Built). Also the Arabic labels of the new fields.

**Proposed default / question:** Free text (a list with no options accepts any text, as Q95) until the owner fixes the values in `register_fields.options`; Arabic labels are empty until reviewed. The spec's closed lists are enforced (Stage, Point Type, Change Type / Scope, Candidate, Selected, MW LOS Check, Existing / New, RT / GF, Scenario, Warehouse Status / Condition / Reason).

**Answer:** المقترح: لا نعتمد النص الحر كحل دائم لقوائم تتحكم بالحسابات أو الصلاحيات. تُدار القوائم بأكواد ثابتة وتسميات EN/AR وتعطيل بدل حذف القيم المستخدمة؛ تُرحَّل القيم القائمة دون فقدها. القيم المتفق عليها: تخصصات الفرق Tower RT / Tower GF / Adaption / TE / Dismantle / GECOL / Fiber / Survey، الموظفون Active/Inactive، وحالات التنفيذ Done/Pending/N/A؛ لا تُفرض هذه الحالات على IssueStatus أو RiskStatus. للقوائم الأخرى تُجهَّز مسودة مستقلة للمراجعة؛ الحقول غير الحاسمة يمكن أن تستخدم Other مع وصف مؤقتًا، والحاسمة تمنع الاعتماد حتى اكتمال إعدادها. تُراجع الترجمة لاحقًا مع بقاء الإنجليزية أساسًا.


### Q105

**Warehouse stock model and movement rules (migration 0026).** The spec gives the document table but not the stock rules: one store or several, whether a return may exceed what the site holds, what a serial status is called, whether an adjustment may lower a serial-tracked item.

**Proposed default / question:** ASSUMPTIONS: one central store; stock is derived from posted and pending lines (never stored twice); a pending DN or negative ADJ reserves its quantity (`available` = on hand minus reserved); an RN cannot return more than the site holds (posted DN minus posted RN minus pending RN, `insufficient_stock` / `insufficient_on_site`); a serial-tracked item cannot be adjusted down; serial statuses `In Stock`, `Dispatched`, `Returned` (a Good return goes back to `In Stock`); PL, OPEN and ADJ have no site (`site_optional_types`); Qty Approved on a DN is not below the dispatched quantity; the dispatched quantity per site also lives in `warehouse_site_qty.dispatched`.

**Answer:** المقترح: يبدأ التشغيل بمخزن مركزي واحد، مع قابلية إضافة مخازن لاحقًا. المخزون الفعلي يُحسب من الحركات المرحلة فقط؛ DN وADJ السالب المعلّقان يحجزان المتاح دون تغيير on-hand، ويُحرر الحجز بالإلغاء. لا يتجاوز RN رصيد الموقع بعد المرتجعات والحجوزات؛ المرتجع الجيد يعود للمخزون، والتالف يُعزل. تسوية الأصناف المتسلسلة تتطلب تحديد الأرقام وسببًا واعتمادًا، ويمكن تعطيلها أوليًا بدل تسوية كمية عمياء؛ جدول dispatched إن بقي فهو إسقاط مشتق قابل لإعادة البناء. لا يُلزم CW المباشر بالموقع بدورة مخزن TE، ولا تُفرض PL/OPEN/ADJ على موقع وهمي.


### Q106

**Document numbers and the form link of DN / RN.** Doc No. is typed and unique; CLAUDE.md numbers the generated forms (`DN-CW-TR-2026-0001`, configurable sequence). The forms module that generates the numbered PDF is not built, so `wh_movements.form_id` is empty.

**Proposed default / question:** Doc No. is entered by the user (Duplicate Doc No. answers 409). When the forms module is built it fills Doc No. from the numbering sequence and sets `form_id`; the signed scan is uploaded into the document slot of the register record.

**Answer:** المقترح: الترقيم الآلي خدمة مستقلة عن توليد PDF، ويُفضَّل تفعيلها للحركات الجديدة منذ البداية. مؤقتًا يُقبل الرقم اليدوي الفريد مع منع التكرار وتثبيت الرقم بعد الترحيل؛ تحفظ أرقام المستندات القديمة كما هي. عند بناء النماذج يُربط `form_id` دون إعادة ترقيم حركة قائمة، وتُحفظ النسخة الموقعة بمكان مستندي موحد. لا نختلق نموذجًا أو توقيعًا لسد خانة فارغة.


### Q107

**Item codes and need quantities of the seeded Warehouse items.** The Master WH sheet has item codes for 11 of the 21 TE items and none for the 28 CW items, and the Need Unit row has no quantities.

**Proposed default / question:** CW items are `CW-01` to `CW-28` (the numbering of the DN / RN forms); the TE items without a code get a generated one (`SFP-SM-10G-10KM`, `ERKA-2X2-5`, `ERKA-4X0-75`, `FIBER-OUTDOOR`, `TELECOM-BRACKET`, `FIBER-CLAMP-4L8R`); need quantities follow D58 / D72 where stated (LPU Kit 2, Router 1, Cabinet 1, Battery 2) and are 1 per need unit otherwise. The admin edits all of it (items are data).

**Answer:** المقترح: تُحفظ الأكواد الأصلية، وتُستخدم CW-01…CW-28 والأكواد المولدة الأخرى كأكواد داخلية مؤقتة بعد التحقق من التفرد، لا كأرقام مصنّع مؤكدة. تُطبَّق القيم LPU=2 وRouter=1 وCabinet=1 وBattery=2 فقط على السيناريو المنطبق وBOQ المعتمد، مع استثناء Q6. لا نعتمد 1 تلقائيًا لكل عنصر مجهول؛ يبقى الاحتياج غير المحدد Pending Configuration حتى مراجعته، حتى لا يتولد اكتمال صرف خاطئ. تتغير القواعد بإصدار دون تغيير الحركات التاريخية.


### Q108

**As-Built items (migration 0027).** CLAUDE.md makes the CW quantities and the TE configuration items an editable list; the spec lists the TE columns as fixed fields. Who may edit the list is not a separate permission.

**Proposed default / question:** The 31 CW quantities (Master D:AH) and six TE quantity items (Sector Qty, MW Antenna Qty, Router Qty, Battery Qty, Patch Cord 1 / 2 Qty) are items; the other TE columns (vendors, types, heights, power data) are fixed fields. Each item is the number field `q_<code>` and keeps its Master column; it is linked to a Warehouse code by the WH "As-Built Item" row (Q74; Concrete and Manhole have none). Edited by the System Admin or a delegate of `fields.edit` (no new permission module). Antenna, router and patch-cord types should be Warehouse items (spec 3.14): they are free-text lists for now. Patch cord quantities use the unit `qty`. Master BU / EF projection: Q103.

**Answer:** المقترح: إبقاء كميات CW الـ31 وكميات TE الست ككتالوج عناصر قابل للإدارة، وبقية بيانات التكوين حقولًا منظمة، مع حفظ ربط أعمدة Master. الكميات تكون أعدادًا صحيحة أو عشرية وفق وحدة العنصر؛ الأطوال والخرسانة ليست بالضرورة أعدادًا صحيحة، وRF Height يبقى نصًا كما اتُّفق. يديرها System Admin أو مفوَّض `fields.edit`، مع إصدار وأثر على القوالب، وتعطيل العناصر المستخدمة بدل حذفها. تُربط الأصناف وأنواعها بكتالوج Warehouse حيث ينطبق، دون فرض مخزن على عناصر CW المباشرة؛ BU/EF وفق Q113.


### Q109

**Quality rules where the spec contradicts itself.** "A Snag needs a Severity" and "a blank severity counts as Blocking" cannot both hold; the Record ID is not checked for uniqueness in the Master; the fix photos (EXIF rule) and the closure of a snag by the QC photo approval need the document module.

**Proposed default / question:** A snag needs a severity before it is submitted; the Record ID is unique; Q45 fills Approved / Released By and N/A Approved By at the final approval. The QC photo flow and the "snag blocks PAC / FAC" link are follow-ups (Q103).

**Answer:** المقترح: Severity إلزامية قبل إرسال snag جديد، ومعرّف السجل فريد. في البيانات القديمة فقط تُعامل Severity الفارغة تحفظيًا كحاجبة مع تنبيه لاستكمالها. يُسجَّل صاحب الاعتماد الفعلي آليًا؛ إغلاق snag يتطلب مسار QC والأدلة اللازمة، وتمنع العيوب الحاجبة اعتماد PAC/FAC حسب نطاقها. لا يُعرض هذا المنع كوظيفة فعالة قبل إكمال الربط المشار إليه في Q103 وQ234.


### Q110

**Contractors: the party type, the status words and the link of a team.** The Master's CompanyType and the contract `ExternalPartyType` are different lists, and a team points to its company by name.

**Proposed default / question:** A company becomes an external party; the type is the normalized Company Type when it is one of `cw_contractor`, `te_vendor`, `gecol`, `hlc`, `supplier`, `landlord`, else `other`; a status of inactive, terminated, expired or closed makes it inactive; a team is linked to the company of the same name (the company must exist, DQ21) and is an external team with the same id as its record.

**Answer:** المقترح: كيان External Party واحد لكل جهة، مع تحويل صريح لأنواعها إلى الأكواد المذكورة؛ غير المعروف يصبح other مع تنبيه مراجعة. تُربط الفرق بمعرّف الجهة، ويُستخدم الاسم عند الاستيراد فقط؛ الأسماء المكررة أو الملتبسة لا تُربط تلقائيًا. حالة الجهة منفصلة عن صلاحية عقودها: انتهاء عقد واحد لا يعطل جهة ذات عقد آخر فعال، والعقد المناسب للنطاق والتاريخ هو الذي يحدد أهلية الإسناد. يحتفظ السجل بالمراجع الأصلية وأثر التحويل.


### Q111

**Meetings: attendees, linked sites, minutes file and action items.** The generic framework has no multi-user, multi-site, file or child-list field type (Q12 default).

**Proposed default / question:** Attendees and linked sites are text lists (names, site codes), the minutes are a reference text and the action items a free text, with Date and Title required. The structured version (action items with owner, due date, status; the minutes file in the document slots) needs those field types and the document module.

**Answer:** المقترح: النصوص الحرة حل انتقال فقط مع توضيح أنها غير قابلة للتتبع المنظم. المطلوب النهائي حضور ومواقع بروابط متعددة، ومحضر مرفق حتى للاجتماعات العامة، وإجراءات مستقلة بمسؤول وموعد وحالة وفق Q12 وQ228. لا نعتبر مرجع الملف النصي رفعًا فعليًا، ولا نكرر إنشاء إجراءات عند تحويل النص القديم؛ يلزم تحويل ومراجعة صريحان.


### Q112

**Template and export for the new registers and items.** The Templates and Export services are not built in the API, so "new items appear in approved templates and the Master-format export" is data-ready only.

**Proposed default / question:** Items and fields carry what those services need (code, labels, section, Master column, in_list); the template version bump on a field or item change is done when the Templates module reads them.

**Answer:** المقترح: استكمال بيانات الأكواد والتسميات والأقسام والربط خطوة لازمة، لكنها لا تعني أن القوالب والتصدير مكتملان. كل تغيير مؤثر في بنية الاستيراد يصدر قالبًا جديدًا عند نشر الإعداد، مع تعريف إصدارات مقبولة وتحويل القوالب القديمة. يلزم اختبار إصدار قالب، وتعبئته، واستيراده، ثم تصديره بما يحفظ المعنى؛ لا نؤجل رقم الإصدار إلى أول قراءة عشوائية للخدمة.


### Q113

**BU and EF after the move to As-Built (write-through, migration 0029).** BU (`cw_as_built_submitted`, Yes / N/A) and EF (`as_built_date`) are plain fields of the As-Built record, typed by hand from the B13 / D15 rows. Q68 proposed computing them from the CW and TE part approvals, and the calculation layer (dashboard "As-Built submitted") does not read the register yet (Q103). The As-Built record is one per site with one state, so the CW and TE parts are not approved separately.

**Proposed default / question:** Keep both as manual fields, with the existing record approval. Fill BU = Yes and EF = the approval date automatically on approval only if the owner confirms (setting `as_built.auto_fill_bu_ef`, default off). Confirm, and decide whether the CW and TE parts need separate records.

**Answer:** المقترح: فصل جزأي As-Built CW وTE إلى اعتمادين مستقلين داخل ملف الموقع، أو سجلين مترابطين إذا كان الإطار لا يدعم أجزاء مستقلة. BU يعكس تقديم جزء CW المنطبق تقديمًا صحيحًا، وEF يعكس تاريخ تقديم جزء TE وفق تعريف عمود Master؛ لا يُستبدل تاريخ التقديم بتاريخ الاعتماد. تُشتق القيم من أحداث الجزء المختص وتعرض الموافقة بحالة/تاريخ مستقلين. يبقى auto_fill_bu_ef معطلًا بصيغته المقترحة حتى تصحيح هذا الفرق الدلالي؛ عدم انطباق جزء لا يعطل الجزء الآخر.


### Q114

**FO / FT only for In-House work, and Procurement as a second source (Q52).** FO and FT are stored as the contractor (external party) of the Dismantle `cw` / `te` record. Q52 says they are typed only for In-House work and read from the active dismantle order of Procurement otherwise.

**Proposed default / question:** Dismantle holds the contractor for every part; Procurement scopes `CW Dismantle` / `TE Dismantle` stay informational. Confirm, or name the rule that picks Procurement.

**Answer:** المقترح: للمقاولات الخارجية يأتي FO/FT من أمر Procurement معتمد وفعال يطابق الموقع والنطاق CW Dismantle أو TE Dismantle. عند تعدد الأوامر يُختار الأمر صراحة في سجل Dismantle، ولا نستخدم «الأحدث» بلا تمييز. في In-House يُدخل الفريق الداخلي المنفذ، ولا يُجبر على تمثيله كمقاول خارجي. تحفظ هوية المنفذ المعتمد تاريخيًا، وأي تغيير لاحق يمر بإصدار ومراجعة؛ لا نكرر إدخال المقاول في مصدرين مستقلين.


### Q115

**Local drafts of work data.** Should unsaved form data survive a reload in the browser?

**Proposed default / question:** Default: no; only view preferences are stored locally. Unsaved data is kept in memory with an unsaved-changes guard.

**Answer:** المقترح: الاحتفاظ بتفضيلات العرض محليًا، والبيانات غير المحفوظة في الذاكرة مع تحذير مغادرة واضح. لا تُخزَّن بيانات العمل الحساسة تلقائيًا في localStorage. لتحسين تجربة الاستخدام يُضاف حفظ مسودة على الخادم بصلاحيات المستخدم ومؤشر آخر حفظ، واستعادة اختيارية؛ لا تعني المسودة إرسالًا أو اعتمادًا أو تحديثًا للحسابات.


### Q116

**Pipeline variant.** A: refined rings; B: flat segmented track.

**Proposed default / question:** Default: A, confirmed after real-code previews of both.

**Answer:** المقترح: إبقاء A، الحلقات المحسّنة، خيارًا مبدئيًا فقط وفق الافتراضي الوارد، دون الادعاء بأن الاختيار البصري حُسم. تُعرض معاينتان فعليتان بالكود قبل التثبيت النهائي، مع اختبار العربية وRTL والشاشات الضيقة والوضعين الفاتح والداكن. تعرض كل مرحلة الاسم والحالة والتأخير بوضوح، ولا يُعتمد اللون وحده؛ تُراعى بساطة Linear ووضوح متابعة العمل في ClickUp.


### Q117

**Who may create shared saved views.**

**Proposed default / question:** Default: System Admin and Team Leads through a new `views.share` grant, delegable like any grant.

**Answer:** المقترح: System Admin وTeam Leads، وإضافة PM ضمن المخوَّلين، عبر `views.share` قابلة للتفويض. يختار المنشئ جمهور المشاركة ضمن نطاقه فقط، ولا تمنح الرؤية المشتركة وصولًا إلى بيانات أو أعمدة محجوبة. لكل مستخدم مشاهد خاصة، مع صلاحيات واضحة لتعديل/حذف المشاهد المشتركة وإمكان نقل ملكيتها عند مغادرة منشئها.


---

## HLC purchasing and Q91 (migration 0042)

### Q135

**C-3 SLA values after the HLC redesign (migration 0042).** C-3 now measures PR issue → HLC approval (start event `PR:HLC`, end = the HLC approval date). The rule kept the values of the old planning link B03 (min 0, max 1 working day), which were set for "CW PR → HLC request".

**Proposed default / question:** Kept 0 / 1 working days. Give the target and the limit of PR issue → HLC approval (Settings → SLA, a new rule-set version).

**Answer:** المقترح: إبقاء 0/1 يوم عمل مؤقتًا كقيمة موروثة، لا كـ SLA متفق عليه لدورة PR:HLC → HLC approval؛ لا تتوفر هنا مدة تجارية تؤكدها. تُوسم القاعدة Pending SLA Confirmation وتُستبعد من تقييم الجهة والجزاءات حتى اعتماد الهدف والحد من PM والمسؤول عن HLC. بعد الاعتماد يصدر rule-set جديد بتاريخ سريان، دون إعادة تقييم الماضي تلقائيًا.


### Q136

**C-4 SLA end event.** C4 now closes on the in-service date of the HLC record. The SLA end event of C-4 stays the installation date (`hlc.installation_date`), because Q54 keeps the Master's end events during the parallel run.

**Proposed default / question:** Kept the installation date. Should C-4 end at the in-service date after the parallel run (a new end event `hlc.in_service_date`)?

**Answer:** المقترح: الاحتفاظ بتاريخ installation لمقياس مقارنة Master خلال التشغيل المتوازي، وإظهار in-service كحدث مستقل. بعد الانتقال تعتمد C-4 النهاية `hlc.in_service_date` لأنها تمثل جاهزية الخدمة، مع SLA وإصدار وتاريخ سريان متوافقين مع التعريف الجديد. يظل تاريخ التركيب محفوظًا؛ لا نبدل معنى نفس المقياس تاريخيًا دون تمييز الإصدار.


### Q137

**C3 tasks that started before migration 0042.** An open C3 task whose clock had already started keeps its stored start (the CW PR date, old rule), as 0018 did for B-15; only clocks that had not started use the PR issue.

**Proposed default / question:** Kept as stored. Re-base the open C3 clocks on the HLC PR date instead?

**Answer:** المقترح: الإبقاء على بداية الساعات التي بدأت بالفعل وفق إصدارها، وعدم إعادة تأسيسها جماعيًا. الساعات الجديدة تستخدم HLC PR date حسب القاعدة الجديدة. تصحيح ساعة قائمة ممكن بصلاحية محددة وسبب وموافقة وسجل قبل/بعد، مع إظهار أثر التصحيح على المقارنة؛ يُمنع استبدال البداية بتاريخ تخميني.


### Q138

**A GECOL or HLC request while C1 / C3 is still locked (Q92 applied to Q91).** C1 and C3 open after B1 (CW PR). A GECOL record (C1 source) or a scope-HLC order with an HLC approval date (C3 source) submitted while that task is locked is refused with 409 until it opens; the draft is kept. Before 0042 a GECOL request without Power-On was accepted on the register row.

**Proposed default / question:** Q92 default applied. Or: accept it on the register row and close C1 / C3 later by hand?

**Answer:** المقترح: السماح بحفظ مسودة GECOL/HLC قبل فتح C1/C3، دون اعتماد إنجاز أو إغلاق المهمة ما دامت مقفلة. عند الإرسال تُعرض أسباب المنع والمتطلبات الناقصة ويُحفظ الإدخال. إذا كانت الأعمال المبكرة مسموحة تعاقديًا، تُفعّل باستثناء/إعفاء معتمد من مصفوفة التبعيات؛ لا نتجاوز القفل بإغلاق يدوي غير موثق، ولا نفرض CW PR على موقع لا ينطبق عليه CW.


### Q139

**HLC requests entered in the HLC register before 0042.** Their `request_no` / `request_date` are kept read-only (legacy) and still counted in `v_purchase_requests` until the site has a scope-HLC Procurement record. No Procurement record was created from them, because that would invent an approval and an HLC approval date.

**Proposed default / question:** The HLC team re-enters each one in Procurement (scope HLC). Or approve a one-time migration with a named approver and a rule for the missing HLC approval date.

**Answer:** المقترح: ترحيل مساعد لمرة واحدة إلى مسودات Procurement scope HLC، مع ربط كل مسودة بالسجل القديم ومعاينة ومنع التكرار. تُنقل الأرقام والتواريخ الموجودة فقط؛ لا يُختلق approver أو HLC approval date. يُكمل فريق HLC النواقص ثم تمر السجلات بالاعتماد المعتاد، وتُستبعد النسخة القديمة من العد عند اعتماد بديلها. يفضَّل ذلك على إعادة الكتابة اليدوية لكل الطلبات.


### Q148

**An HLC execution record without an approved HLC purchase request.** It is a warning to the reviewer (`no_approved_hlc_pr`, Q96), not a refusal. C4 still cannot close before C3 (its predecessor), so the in-service date waits for the approved request.

**Proposed default / question:** Warning only. Should submitting any HLC record need the approved HLC PR?

**Answer:** المقترح: السماح بمسودة وملاحظات/مسح HLC دون PR معتمد، مع تحذير واضح. بدء التنفيذ الفعلي أو اعتماد in-service وإغلاق C4 يتطلب PR معتمدًا وC3 مستوفاة عند انطباق الشراء. الاستثناء للطوارئ يكون بصلاحية وسبب واعتماد صريح، وليس مجرد تجاهل للتحذير؛ لا نمنع إدخال طلب أو دراسة مبكرة لا تمثل التزام تنفيذ.


### Q149

**The HLC approval date at submit.** A scope-HLC order needs its PR No. and PR date; the HLC approval date is optional, so the PR can be approved first and the approval date added in a new version (which then closes C3).

**Proposed default / question:** Optional. Make it required (the request is entered only after HLC approves)?

**Answer:** المقترح: HLC approval date اختيارية عند إنشاء/إرسال PR لأنه طلب قيد المتابعة، مع إلزام PR No. وPR date. تصبح إلزامية لتسجيل حالة Approved by HLC وإغلاق C3. اعتماد الطلب الداخلي لا يعني موافقة HLC، ولا يملأ تاريخها تلقائيًا؛ تُضاف الموافقة الفعلية بإصدار وأدلة وفق المسار.


### Q150

**Several HLC purchase requests for one site.** Procurement allows several orders per site. C3 closes from the first one submitted while C3 is open (Q93); the HLC record links the approved one with the latest HLC approval date.

**Proposed default / question:** Confirm, or allow only one scope-HLC order per site (a new request = a new version, like Q55).

**Answer:** المقترح: السماح بعدة طلبات HLC للموقع عند اختلاف النطاق أو وجود طلب تكميلي، مع ربط سجل التنفيذ بالطلب/الطلبات التي تغطيه صراحة. تعديل الطلب نفسه يكون إصدارًا جديدًا لا طلبًا مكررًا. لا يُغلق C3 بأول طلب عشوائي ولا يُختار الأحدث زمنيًا تلقائيًا؛ الإغلاق عند اكتمال موافقات الطلبات المطلوبة للنطاق المعتمد، مع تجاهل الملغاة وحفظ الارتباط التاريخي.


### Q151

**The other date orders of Q96 for GECOL.** The warnings are built for the HLC record and the scope-HLC order only. GECOL keeps its one blocking rule (C-2 not negative); the order of its other steps (survey, layout, notice, MOS, acceptance, Power-On, billing) is not checked.

**Proposed default / question:** Give the step order of GECOL to warn on, or confirm none.

**Answer:** المقترح: تنبيهات ترتيب قابلة للضبط لـ GECOL: request ≤ survey ≤ layout submission ≤ layout approval، ثم الأعمال/الإشعار وMOS وفق النوع، ثم installation completion ≤ acceptance ≤ Power-On؛ billing يتبع الحدث المنصوص عليه بالعقد ولا يُفترض أنه دائمًا بعد Power-On. هذه مسودة ترتيب للتحقق من فريق GECOL، والخطوات غير المنطبقة تُتجاوز. الترتيب العام تحذيري في البداية، أما نهاية C-2 قبل بدايتها أو تجاوز شروط السلامة فمانع للاعتماد.


---

## Gate-lock exempt list and Q97 team / scope match (0043)

### Q140

**Gate-lock exempt list: "nothing" was also ticked.** The owner's answer adds D1, B14, B15, D18, E2 and E3 to `calc.gate_lock_exempt_tasks`, but the form also had "nothing" ticked.

**Proposed default / question:** Read as adding the three groups (done in 0043, merged into the current value so an admin's own codes stay; tasks a closed gate held were opened by the migration through the normal unlock). If "nothing" was meant, remove the six codes in the setting; no code change.

**Answer:** المقترح: تفسير الإجابة على أنها إضافة D1 وB14 وB15 وD18 وE2 وE3 لقائمة الإعفاء من قفل البوابة فقط، مع إبقاء الإعدادات الإضافية القائمة وسجل التغيير. الإعفاء لا يلغي تبعيات المهمة أو متطلبات السلامة أو صلاحيات اعتمادها. تُراجع الرموز في شاشة الإعدادات؛ إذا تعارض الاستثناء مع شرط سلامة يبقى المنع نافذًا.


### Q141

**Q97: which team may take an STA or ST order.** D37 (Scope Match) lists CW, GECOL, CW Dismantle, Tower Erection, Site Adaption, TE Installation and TE Dismantle, not STA / ST (the analysis provider, B5).

**Proposed default / question:** Conservative: STA and ST have a row with no specialization ticked, so an STA / ST order that names a team is refused; an order without a team is accepted. Tick the right column in Settings when the owner decides.

**Answer:** المقترح: لا نشترط فريق تنفيذ CW/TE على طلب STA/ST إذا كان التعاقد مع مزود تحليل فقط. عند تسمية فريق، يلزم تخصص مؤهل للتحليل ومصفوفة صلاحيات نطاق صريحة؛ لا نفترض أن Survey أو CW يؤهلان لـ STA/ST تلقائيًا. إلى حين ضبط ذلك يقبل الطلب دون فريق، مع التحقق من أهلية المزود والعقد، ويُمنع إسناده لفريق غير مؤهل.


### Q142

**Q97: a team without a specialization.** The Contractors register does not require the specialization of a team.

**Proposed default / question:** Conservative: such a team is refused on every checked scope (`team_scope_mismatch`, "has no specialization"). Alternative: make the field required in the Contractors register.

**Answer:** المقترح: يُسمح بحفظ فريق جديد كمسودة دون تخصص، لكن تخصص واحد على الأقل إلزامي قبل تفعيله/إسناده لنطاق يتطلب التحقق. الفرق القديمة بلا تخصص تظهر في تقرير استكمال بيانات ولا تقبل إسنادات جديدة. لا نغيّر الأوامر المعتمدة تاريخيًا بأثر رجعي؛ نعرض استثناءات الأوامر الجارية للمراجعة.


### Q143

**Q97: the values of TeamSpecialization (Q104).** The list is free text until the owner fixes it. The match compares a team's specialization trimmed and case-insensitively with the columns of the table (seed: CW and TE).

**Proposed default / question:** If the real values differ (for example "Civil Works"), the admin adds them as columns in Settings. Better: fix the list in the Contractors register (`register_fields.options`) and use the same values here.

**Answer:** المقترح: استخدام الأكواد نفسها في كتالوج تخصصات الفرق ومصفوفة مطابقة النطاق؛ القيم المتفق عليها Tower RT / Tower GF / Adaption / TE / Dismantle / GECOL / Fiber / Survey، مع قابلية إضافة تخصص تحليل معتمد. CW وTE مجموعتان وظيفيتان، فلا نحصر كل تخصصات CW في النص CW. تدعم الفرق عدة تخصصات، وتتحول الأسماء القديمة عبر aliases بدل مقارنة النصوص فقط.


### Q144

**Q97: scopes that are not in the table, and HLC.** A scope missing from the table (for example a scope added to the Procurement list later) accepts no team. HLC is seeded as exempt (the HLC request has no contractor team), so an HLC order is never checked, even if a team is named.

**Proposed default / question:** Conservative for unknown scopes; confirm HLC exempt, or name the specialization (for example an HLC fiber team) that may be put on an HLC request.

**Answer:** المقترح: النطاق الجديد لا يقبل إسناد فريق حتى ضبط مطابقته. HLC معفى من اشتراط الفريق عندما يكون طلب مزود خدمة دون فريق داخلي/خارجي مسمى. إذا سُمّي فريق تنفيذ في HLC، يلزم تخصص Fiber مناسب وعقد وصلاحية مهمة؛ لا يكون HLC إعفاءً عامًا يسمح بأي فريق. يبقى غياب الفريق مقبولًا حيث ينص نموذج الطلب على ذلك.


### Q145

**Q97: what a later change re-checks.** A change of the table, or of a team's specialization, does not touch approved orders; a draft is checked again at submit (and refused then if it no longer matches).

**Proposed default / question:** Confirm that approved orders stay as they are, or ask for a report of approved orders that no longer match.

**Answer:** المقترح: إبقاء الأوامر المعتمدة ونسخة قواعدها التاريخية دون تعديل صامت، وإعادة فحص المسودات عند الإرسال. يضاف تقرير بالأوامر الجارية التي لم تعد فرقها مطابقة بعد تغيير الإعدادات أو المؤهلات، مع تنبيه وإجراء تصحيحي. انتهاء شهادة سلامة أو تفعيل Stop Work يؤثر على أهلية العمل الجاري وفق قواعد السلامة، حتى لو بقي أصل الأمر محفوظًا.


### Q146

**Q97: GECOL.** D37 says GECOL needs a CW team, and the seed has that row, but a GECOL purchase request is entered in the GECOL register (Q56), which has no team field and no check.

**Proposed default / question:** Keep the row for when GECOL orders carry a team; decide whether the GECOL register should check its contractor too.

**Answer:** المقترح: فحص جهة GECOL والعقد الفعال والنطاق عند الاعتماد، وفحص تخصص الفريق فقط إذا كان هناك فريق مسمى. لا نعتبر شركة الكهرباء نفسها فريق CW، ولا نطلب فريقًا في حقل غير موجود. عند تنفيذ أعمال مدنية لمصلحة GECOL يُربط أمر/فريق CW مؤهل صراحة؛ تبقى GECOL وHLC مسارين منفصلين.


### Q147

**Q97: who reads and edits the table.** Reading needs the Settings screen (`admin.settings` view); saving needs a System Admin or a delegation of `admin.settings` edit for all regions, a reason and the version; it is audited with before and after. No step-up is asked, as for the other light settings. The Procurement entry team does not see the table, only the refusal message.

**Proposed default / question:** Confirm, or ask for step-up on save and a read-only view for Procurement. Also open: the "CW Delivery Model" rule named in the old Q97 row is not built.

**Answer:** المقترح: السماح بعرض مصفوفة المطابقة للشراء قراءة فقط ضمن النطاق اللازم لعمله. التعديل لـ System Admin أو مفوض `admin.settings` المناسب، مع سبب وإصدار وسجل قبل/بعد؛ تغييرات الأهلية المؤثرة تخضع لإعادة تحقق هوية قبل الحفظ. يُستكمل CW Delivery Model صراحة: Outsourced يرتبط بجهة/عقد وأمر، وIn-House بفريق داخلي مؤهل، مع عدم فرض Warehouse على CW المباشر بالموقع.


---

## My profile, email change, password, 2FA (0044)

### Q155

**Name in Arabic and position on the profile (migration 0044).** The owner listed name EN/AR and the position wording as self-editable "if the model has both". The API's `users` has one `display_name`; name EN/AR, position, team and region live in the staff registry, which is in the contract and the web mocks but not in the API database yet.

**Proposed default / question:** Self-editable now: `display_name`, `phone`, `locale`, `theme`. When the registry is built: `name_ar` self-editable like `display_name`; `position`, team and region stay admin-owned (they drive the registry card and assignments). Confirm.

**Answer:** المقترح: يمكن للمستخدم تعديل الاسم المعروض والهاتف وفق Q156 واللغة والمظهر. عند إنشاء Staff Registry يمكنه تعديل اسمه العربي مع سجل تغيير، بينما المسمى الرسمي والفريق والمنطقة والأدوار يغيّرها المسؤول المخول لأنها تؤثر في التوزيع والصلاحيات. تُفصل تسمية العرض عن الاسم الرسمي إن لزم، ولا يُنشأ حقل ظاهر يوحي بأنه محفوظ قبل بناء دعمه الفعلي.


### Q156

**Phone without approval.** The phone is a local sign-in identifier and is printed on the registry card, but the owner listed it as a self-edit field. It changes at once (unique, E.164, audited), with no step-up and no approval.

**Proposed default / question:** Keep as built, or ask for a step-up (password) when the phone changes. The registry phone (when the registry is built) follows the account phone.

**Answer:** المقترح: تغيير الهاتف الذي يُستخدم للدخول يتطلب إعادة تحقق حديثة من الهوية، والتحقق من ملكية الرقم الجديد إن كانت خدمة التحقق متاحة، مع E.164 والتفرد والتدقيق وإشعار المستخدم. دون وسيلة تحقق من الرقم، يُستخدم مسار مسؤول مخول بدل تغيير معرف الدخول ذاتيًا بلا تحقق. هاتف Staff Registry يتبع هاتف الحساب بعد نجاح التغيير؛ رقم اتصال منفصل يمكن تنظيمه بحقل مستقل.


### Q157

**Email change for an M365 account.** A request needs the password re-entered, which an M365 user does not have in GSDN Workspace; the API refuses it (403) and the page tells them to ask an admin. When M365 sign-in is built, should GSDN Workspace email follow Entra (and a request need an M365 step-up), and what happens on approval to a user with an Entra link, since the first-sign-in match uses the email?

**Proposed default / question:** Keep admin-only for M365 accounts until ADR 0002 sign-in is built; then require an M365 step-up and block approval while `m365_object_id` is set unless the new address is the Entra one.

**Answer:** المقترح: حتى تفعيل M365 يظل تغيير بريد الحساب المرتبط بـ Entra عبر المسؤول وفق إجراء موثق. بعد التفعيل يكون tenant ID + object ID هو رابط الهوية الثابت، لا البريد المتغير؛ يتبع البريد الموثوق بيانات Entra ويتطلب الإجراء إعادة تحقق M365. لا تُقبل موافقة محلية تفصل الحساب عن هويته المؤسسية، ولا يُدمج حسابان تلقائيًا لمجرد تطابق البريد.


### Q158

**Who is told about an email change.** In-app only: the deciders (System Admins and all-regions delegates of `users.edit`) on a request, the user on a decision. E-mail notifications are not built. Security practice also tells the old address when the email changes.

**Proposed default / question:** When e-mail is built: send the decision to both the old and the new address. Confirm.

**Answer:** المقترح: إشعار صاحب الحساب بطلب تغيير البريد ونتيجته داخل النظام، وإرسال تنبيه إلى البريد القديم والجديد عند توفر البريد، مع التحقق من الجديد قبل تفعيله. تصل طلبات القرار إلى المسؤولين المخولين فقط. تعطل البريد لا يبرر إسقاط التحقق؛ يُستخدم إجراء إداري موثق حتى تكتمل الخدمة، دون إرسال بيانات حساسة في الرسالة.


### Q159

**"Waiting for enrolment" and "enforced".** A user whose two-factor waits for enrolment cannot sign in without the admin code, so self-disable needs a code and is not offered then; an admin reset keeps the enforced mark as it was (a self-enrolled user who is reset stays not enforced).

**Proposed default / question:** Keep, or make a reset always enforce it.

**Answer:** المقترح: يبقى reset محافظًا على سياسة enforced السابقة؛ إعادة الضبط لا تمنح إعفاء من سياسة إلزامية. حالة waiting for enrolment تسمح بمسار تسجيل العامل الثاني فقط بعد إثبات الهوية وبصلاحية مؤقتة محدودة، ولا تفتح جلسة عمل كاملة. لا يُتاح self-disable عند فرض العامل الثاني؛ رموز الاستعادة مؤقتة/أحادية الاستخدام ومدققة.


### Q160

**Existing two-factor rows.** Migration 0044 marks every account whose two-factor is on (or waiting for enrolment) as enforced, because only admins could turn it on before.

**Proposed default / question:** Keep; an admin unmarks the ones that may turn it off.

**Answer:** المقترح: الاحتفاظ بعلامة enforced للحسابات القديمة التي فُعِّلت إداريًا، مع تقرير ترحيل للمراجعة. رفع الإلزام إجراء مستقل بصلاحية وسبب، وليس أثرًا جانبيًا لإعادة الضبط. تُفرض المصادقة الثنائية على الحسابات الإدارية والحساسة وفق سياسة النظام؛ لا نعيد توصيف التفعيل القديم كتسجيل ذاتي.


### Q161

**Sessions after a self-disable.** Turning two-factor on yourself ends your other sessions (they never passed a code); turning it off leaves them, as an admin "off" does.

**Proposed default / question:** Keep, or end the other sessions too.

**Answer:** المقترح: إنهاء الجلسات الأخرى عند تعطيل العامل الثاني أيضًا، مع إعادة تحقق حديثة للعملية وإشعار أمني. الجلسة الحالية تُجدَّد أو تُنهى وفق سياسة الجلسات، وتُبطل رموز الاستعادة المرتبطة بالتسجيل السابق. التعطيل الإداري يتبع القاعدة نفسها؛ لا يُسمح بالتعطيل الذاتي عند enforced.


---

## Logs and monitoring (0045)

### Q165

**Logs (0045): who is a Team Lead and who reads everything (B4).** The database reads two settings: `logs.audit.full_reader_roles` (seed `PM`) and `logs.audit.team_lead_roles` (seed `RFD_ACQ_TL`, `CW_TL`, `TE_TL`). A Team Lead reads the modules and regions of their Team Lead assignments.

**Proposed default / question:** Confirm the role lists, or name another way (a role property) to mark a Team Lead.

**Answer:** المقترح: الإبقاء على PM ضمن القراء الشاملين وعلى RFD_ACQ_TL وCW_TL وTE_TL كبداية لقادة الفرق، وإضافة قادة GECOL/Fiber الفعليين عند وجود أدوار مستقلة لهم. الأفضل خاصية role capability قابلة للإدارة بدل الاعتماد الدائم على أسماء أكواد محددة. قراءة قائد الفريق مقيدة بالموديولات والمناطق وفترة صلاحية تكليفه، ولا تعطيه سجل الأمن تلقائيًا.


### Q166

**Logs: audit rows without a module or region.** Configuration rows (users, roles, groups, settings) map to a module through `logs.audit.entity_modules`; a row with no module, or no region, is read only by a full reader (System Admin, Project Manager) or a `view_audit` holder for all regions.

**Proposed default / question:** Confirm, or say which configuration rows a Team Lead should see.

**Answer:** المقترح: الإبقاء على السجلات العامة أو عديمة المنطقة/الموديول للقراء الشاملين أو grant شامل صريح. يرى قائد الفريق فقط سجلات إعداد محلية مرتبطة بنطاقه إذا صُنفت بوضوح، دون بيانات مستخدمين عامة أو أسرار أمنية. غياب التصنيف لا يتحول إلى تصريح مفتوح؛ يظهر للمسؤول كحالة تحتاج تصنيفًا.


### Q167

**Logs: alert e-mail.** Security alerts reach the System Admins in-app only; the API has no mail sender yet, while CLAUDE.md says security types go in-app and by email.

**Proposed default / question:** Confirm in-app now and e-mail when the mail service exists.

**Answer:** المقترح: قبول التنبيه داخل النظام مؤقتًا أثناء التطوير، وإكمال بريد التنبيهات الأمنية قبل التشغيل الإنتاجي. إعداد المستلمين ودرجات الخطورة قابل للإدارة، مع إعادة محاولة وتسجيل فشل التسليم. لا تُوصف قناة البريد بأنها فعالة قبل اختبارها، ويُفضَّل مسار مراقبة خارجي أيضًا لتنبيهات تعطل المنظومة نفسها.


### Q168

**Logs: default thresholds.** 5 failed sign-ins per identifier or account in 15 minutes, 20 per address in 15 minutes, an export above 5 000 rows, any sign-in from a new address once a person has a history.

**Proposed default / question:** Confirm the defaults, and whether "new address" should ignore the internal network ranges.

**Answer:** المقترح: قبول 5 محاولات فاشلة/15 دقيقة للحساب أو المعرف، و20/15 دقيقة لعنوان IP، وتصدير أكثر من 5000 صف كحدود ابتدائية قابلة للضبط. يُطبق تحديد المعدل تدريجيًا لتجنب قفل المستخدمين جماعيًا خلف NAT. دخول IP جديد مؤشر منخفض الخطورة بحد ذاته؛ شبكات داخلية موثوقة قد تخفف شدته ولا تلغي بقية الكواشف، مع تسجيل الحدث دائمًا. لا يُعتبر IP دليلًا مؤكدًا على جهاز أو شخص جديد.


### Q169

**Logs: monthly activity report as Excel.** `GET /reports/activity` answers JSON; the export service builds CSV jobs, not workbooks, so no xlsx variant was added.

**Proposed default / question:** Is an xlsx file needed, and with which sheets?

**Answer:** المقترح: نعم، مطلوب XLSX شهري قابل للتصفية والطباعة. الأوراق المقترحة: Summary، User Activity، Module Activity، Exports، Exceptions، About؛ تتضمن About الفترة والمنطقة والفلاتر ووقت الإنشاء. تُحجب الأوراق والحقول حسب صلاحيات الطالب، ولا يُدمج Security Log في تقرير عام؛ يمكن تصديره منفصلًا لمن يملك صلاحياته.


### Q170

**Logs: export rights.** Exporting the Audit Log needs `export` on `audit` (or a System Admin) plus the reader rules; exporting the security log needs a System Admin, or `view_security_log` with `export` on `admin.security_log`. At most 100 000 rows per file.

**Proposed default / question:** Confirm the grants and the cap.

**Answer:** المقترح: اعتماد صلاحيات التصدير المذكورة مع تحقق قواعد القراءة ونطاق المنطقة على الخادم، وحد 100000 صف لكل ملف. عند التجاوز يُطلب تضييق الفلاتر أو تقسيم صريح دون بتر صامت. يُدقق كل تصدير ويُعالج كمهمة غير متزامنة عند الحجم الكبير، ولا يحتوي التصدير على أسرار أو حقول محجوبة عن صاحبه.


### Q171

**Logs: chain order and the integrity check.** Rows are sealed at commit (commit order), not at insert, so a long transaction never holds the chain lock; the admin check runs inside one request and checks every row.

**Proposed default / question:** Confirm, and say whether a scheduled nightly check (raising `audit_integrity_failure`) is wanted beside the admin button.

**Answer:** المقترح: قبول ختم السلسلة عند commit بشرط ذرية ربط الحدث والختم ومنع فقد الأحداث عند فشل العملية، واختبار التزامن والاستعادة. إضافة فحص ليلي مجدول مع `audit_integrity_failure` عند الخلل، والإبقاء على فحص يدوي. الفحص الكبير ينفذ كمهمة مراقبة ذات مؤشرات تقدم بدل طلب ويب طويل؛ تُحفظ نتيجة الفحص ونطاقه ومرجعه الموثوق، لأن سلسلة داخل قاعدة واحدة لا تكفي وحدها ضد إعادة كتابة كاملة بامتيازات عليا.


---

## Dashboard owner answers (0046)

### Q175

**Manual central items in a regional or site figure (Q118, migration 0046).** A manual percentage is a project-wide value. It now counts by its weight in every Project Status figure, also a region, a filtered view and one site (so `meta.central_items_hidden` falls to 0 once every central item has a value, as Q118 asks).

**Proposed default / question:** Confirm, or say that a manual value counts only in the project-wide figure (regional and site figures would then leave it out again).

**Answer:** المقترح: القيمة اليدوية المركزية تدخل نسبة المشروع العامة فقط، ولا تُنسخ إلى نسبة موقع أو منطقة لمجرد أنها متاحة. في العرض الإقليمي يمكن إظهار بند مستقل «مركزي على مستوى المشروع» خارج نسبة الإنجاز المحلي، مع `central_items_hidden`/excluded count واضح. لا تُوزع القيمة إلا بقاعدة تخصيص وأوزان معتمدة؛ بذلك لا تبدو كل المواقع متقدمة بسبب عمل مركزي لا يخصها مباشرة.


### Q176

**Who enters the manual values.** The Project Manager (role codes of the setting `dashboard.manual_items.roles`, default `PM`, on an all-regions assignment), a System Admin, or anyone holding `dashboard.project_status` edit for all regions (a grant or a delegation). No step-up is asked.

**Proposed default / question:** Confirm the holders, and whether a step-up re-authentication is wanted.

**Answer:** المقترح: PM بتكليف شامل، وSystem Admin، والمفوض صراحة بتحرير `dashboard.project_status` لجميع المناطق. كل تعديل يتضمن قيمة وتاريخ سريان وسببًا ومصدرًا وسجلًا قبل/بعد. لا يلزم step-up لكل تحديث تشغيلي اعتيادي؛ يلزم للتغيير في الأوزان/الصيغة/الصلاحيات، وتخضع التصحيحات التاريخية للمراجعة وفق Q178.


### Q177

**Planned % and SPI with manual items.** A manual item has no baseline, so under the 0039 rule ("Planned only when every measured item has a plan") Planned and SPI stay "not available" while any manual item is measured.

**Proposed default / question:** Should a manual item carry a planned percentage (for example a target date or a planned value per month), or be left out of Planned only?

**Answer:** المقترح: تزويد البنود اليدوية المركزية بخطة معتمدة متسلسلة زمنيًا، كنسبة مخططة بتاريخ محدد أو منحنى شهري. يُحسب مؤشر Actual/Planned على مجموعة بنود وأوزان متطابقة؛ لا نُدخل البند في الفعلي ونستبعده من المخطط ثم نسمي النتيجة SPI. إلى اكتمال الخطة يظهر المؤشر العام غير متاح، ويمكن إظهار مؤشر جزئي منفصل مع نسبة تغطية. إذا لم يكن المؤشر مبنيًا على EV/PV فعليين، تسمى النسبة مؤشر إنجاز مقابل الخطة ولا تُقدَّم كـ EVM SPI.


### Q178

**Back-dated manual values.** An entry may take any effective date up to today; figures computed for a past date use it, saved snapshots do not (they keep the values known when they were taken).

**Proposed default / question:** Confirm, or limit back-dating (for example to the current month).

**Answer:** المقترح: إدخال قيمة مؤرخة داخل الشهر الحالي متاح للمخول مع سبب؛ التعديل على فترة سابقة مغلقة يتطلب صلاحية تصحيح تاريخي ومراجعة موثقة. يُفصل effective date عن recorded at، وتمنع التواريخ المستقبلية لهذه القيم الفعلية. تبقى snapshots الأصلية ثابتة، ويُنشأ إصدار مصحح منفصل عند الحاجة مع بيان أثره، دون محو ما كان معلومًا حينها.


### Q179

**Suspension against an attribution period (Q122).** A working day under a Change Control suspension is left out of the delay even when an attribution period covers it. Periods of the same task may not overlap (422 `period_overlap`), so `overlapping_periods` is always 0.

**Proposed default / question:** Confirm that the suspension wins, and that overlapping periods should be refused rather than shared.

**Answer:** المقترح: التعليق المعتمد يستبعد أيام العمل المشمولة به من التأخير القابل للإسناد، حتى لو غطتها فترة مسؤولية. يُمنع تداخل الفترات المعتمدة للمهمة نفسها؛ ويمكن تقسيم اليوم/الفترة بين جهات فقط إذا أُضيف نموذج حصص صريح يضمن مجموعًا لا يتجاوز 100%. تُعرض أيام التعليق على حدة، ولا تُحذف من التقارير الإجمالية أو تُحتسب مرة أخرى كتعويض baseline.


### Q180

**The days of a suspension.** From the approval date of the suspension up to the day before the approval date of the next resumption (or the reference date while not resumed); only approved or applied Change Control records count.

**Proposed default / question:** Confirm the dates used (approval dates, not requested or effective dates).

**Answer:** المقترح: تُستخدم تواريخ السريان الفعلية المعتمدة للتعليق والاستئناف، لا تاريخ الاعتماد تلقائيًا؛ عند غياب تاريخ سريان صريح يكون الافتراضي تاريخ الاعتماد. النافذة من بداية التعليق شاملة إلى بداية الاستئناف غير شاملة، وتُحسب بأيام العمل، أو حتى reference date إذا لم يُستأنف. يحتفظ النظام بتاريخي السريان والاعتماد وسبب الأثر الرجعي، ولا يطبق المسودة أو الطلب المرفوض.


### Q181

**A late task without a due date.** A closed SLA clock over its maximum but with no due date keeps the 0039 figure (days over the maximum) under the default party; periods cannot apply because there is no day window.

**Proposed default / question:** Acceptable, or should the window be rebuilt from the SLA start and maximum?

**Answer:** المقترح: إعادة بناء نافذة التأخير من بداية SLA وحده الأقصى والتقويم بإصداراتها، مع مراعاة التعليقات والتعديلات المعتمدة. إذا توفرت هذه المعطيات نحدد الأيام المتأخرة الفعلية ونسمح بإسنادها؛ لا يكفي رقم أيام إجمالي بلا نافذة. إذا نقصت البداية أو القاعدة، يظهر نقص بيانات وتأخير غير منسوب، ولا يُحمَّل طرف افتراضي مسؤولية معتمدة.


### Q182

**Who records attribution periods.** The task's reviewer = a holder of its L2 level (or of the review level of an older 3-level task), a System Admin, or a holder of `dashboard.delay` edit in the task's region. L1 cannot propose a period.

**Proposed default / question:** Confirm, and say whether L1 may propose periods that L2 then confirms.

**Answer:** المقترح: السماح لـ L1 باقتراح فترات الإسناد والجهة والسبب والأدلة، دون أثر في التقييم حتى اعتماد L2. يعتمد L2 المختص أو صاحب تفويض صريح ضمن المنطقة، مع منع اعتماد الشخص اقتراحه. يستطيع المسؤول إدارة التصحيح بصلاحية وسبب؛ تبقى الإسنادات المعتمدة وإصداراتها وسحبها في السجل.


### Q183

**Delay attribution still marked draft.** The health index lost its draft label (Q121); delay attribution keeps `draft: true` because Q122 answered the periods only.

**Proposed default / question:** May the draft label of delay attribution be removed too?

**Answer:** المقترح: لا تُحذف علامة draft الآن لمجرد اكتمال إدخال الفترات. تُزال بعد إكمال ربط Change Control، وصحة نافذة الأيام، واعتماد الإسناد، ومنع التكرار، والتحقق بعينات تشمل N/A والتعليق والتصحيح التاريخي. عندها يثبت إصدار القاعدة وتاريخ سريانه؛ يمكن عرض المعتمد وغير المعتمد كلٌّ بحالته بدل وضع موثوقية واحدة لجميع البيانات.


### Q184

**Naming the contractor or external party of a period.** For the parties `contractor` and `external` the period may name an external party (optional).

**Proposed default / question:** Should naming it be mandatory for these two parties?

**Answer:** المقترح: اسم/معرّف External Party إلزامي لاعتماد فترة من نوع contractor أو external. يمكن تركه غير محدد في المسودة فقط، ولا يدخل scorecard حتى تحديده واعتماد الفترة. تُختار الجهة من السجل وتربط بالعقد/الأمر حيث ينطبق، مع خيار «غير معلوم» كحالة معلقة لا كطرف قابل للتقييم.


### Q185

**Milestones of a view (Q126).** The view filter keeps the milestones whose stage is a whole member of the view: CW = MS2 to MS4, TE = MS5 to MS9. A view made only of single tasks (O&M: TE FAC D18 and Z1) shows the stages of those tasks (MS10). CW FAC (B15) counts in the CW view's SLA and delay but does not add MS10 to the CW pipeline.

**Proposed default / question:** Confirm.

**Answer:** المقترح: قبول CW = MS2–MS4 وTE = MS5–MS9 بحسب حدود المراحل الواردة، مع عرض CW FAC ضمن متابعة ما بعد التسليم دون إضافته كمرحلة إنجاز CW جديدة. في O&M تعرض مهام D18 وZ1 ذات الصلة، ولا يُفهم عرض MS10 على أنه اكتمال جميع مهام المرحلة. يعرض Project Overview السلسلة كاملة، وتبقى HOTO نهاية التسليم التشغيلي مع متابعة Final Closure/FAC مستقلة.


### Q186

**Snapshot catch-up and past-date snapshots (Q127).** If the server was stopped on a Sunday or a month end, the daily job takes the missed snapshot within 7 days (setting `dashboard.snapshot_catchup_days`), computed as of that date from dated facts; blocked gates are live only, so such a snapshot records none. A date that is both Sunday and month end is one snapshot with both kinds.

**Proposed default / question:** Confirm the catch-up window, and that the weekly snapshot on Sunday (setting `dashboard.snapshot_weekday`, 0) is wanted rather than Thursday (the last working day of the week).

**Answer:** المقترح: نافذة الاستدراك 7 أيام مقبولة كبداية، واللقطة الأسبوعية نهاية الخميس بتوقيت Africa/Tripoli، مع نهاية كل شهر. إذا تعذر إعادة بناء حالة البوابات تاريخيًا تُسجَّل «غير متاحة تاريخيًا»، لا 0 بوابات محجوبة. تُوسم اللقطة المعاد بناؤها وتاريخ توليدها ولا تستبدل لقطة أصلية؛ يُستخدم سجل الأحداث كما كان معلومًا عند القطع إن توفر، ويُمنع تكرار التاريخ الذي يجمع أسبوعيًا وشهريًا.


### Q187

**Excel export layout (Q127).** The workbook has one sheet `Dashboard` (section, item, metric, value: the same rows as the CSV) and one sheet `About` (reference date, basis, scope).

**Proposed default / question:** Is one sheet per section, or the layout of the Master's Dashboard sheet (D67), wanted instead?

**Answer:** المقترح: ملف XLSX بأوراق Project Overview وCW وTE، مع أوراق مساندة للبيانات التفصيلية عند الحاجة وAbout للفلاتر والتاريخ والتعريفات والإصدارات. يكون التصدير من نفس بيانات وحسابات الواجهة، بتنسيق مناسب للطباعة، دون إلزام بنسخ تصميم Master القديم حرفيًا. يبقى CSV المسطح متاحًا للتحليل؛ العربية لاحقًا والوضع الداكن للواجهة لا يفرض طباعة داكنة.


---

## File storage protection (0048)

### Q195

**Storage: virus scan defaults.** The API default is `MALWARE_SCAN=off` (a warning at start-up); the installer turns the scan on when the owner says yes. `SCAN_FAILURE` defaults to `fail_closed` (uploads answer 503 while clamd is down). Zip exports and log exports also pass the scanner, so a clamd outage stops them too.

**Proposed default / question:** Confirm the default for a fresh install (scan on, not asked), `fail_closed` for uploads, and whether generated exports should skip the scan.

**Answer:** المقترح: تشغيل فحص الملفات افتراضيًا في التثبيت الإنتاجي، مع fail_closed للملفات الواردة عند تعطل الماسح، ورسالة قابلة لإعادة المحاولة وحفظ المسودة. المرفقات تبقى في الحجر ولا تُتاح قبل اجتياز الفحص. يمكن تجاوز إعادة فحص CSV/XLSX/سجلات مُولدة داخليًا دون مرفقات مستخدم، بشرط تعقيم المحتوى؛ ZIP يتضمن ملفات مرفوعة يتحقق من نظافة كل ملف ولا يتجاوز الحجر. يوضح الإعداد نطاق الفحص ولا يوقف كل التصدير بلا تمييز.


### Q196

**Backup: database dump and WAL.** The nightly `pg_dump` and the WAL archiving (RPO 15 minutes, CLAUDE.md) are not in the repository. The file backup (restic, `infra/backup`) needs the matching database dump to restore anything.

**Proposed default / question:** Who runs the database dump and WAL archive, where they are kept, and whether they go to the same restic repository or to another one.

**Answer:** المقترح: مسؤول قاعدة البيانات/التشغيل في IT ينفذ النسخ الآلي ومراقبته، ومالك المشروع مسؤول عن توفير المالك البديل واعتماد خطة الاستعادة. لتحقيق RPO 15 دقيقة تُعد نسخ PostgreSQL أساسية متوافقة مع WAL مستمر؛ pg_dump الليلي نسخة منطقية إضافية وليس أساس PITR من WAL. تحفظ النسخ مشفرة مع ارتباطها بإصدارات التطبيق ومرفقاتها، وفي وجهة مستقلة خارج الخادم ونسخة خارج المبنى؛ يمكن إبقاؤها في نفس منظومة النسخ مع فصل الصلاحيات. أسماء الأشخاص وRTO ومدة الاحتفاظ تُستكمل في سجل التشغيل قبل الإنتاج، وتُختبر استعادة كاملة.


### Q197

**Storage: second copy.** MinIO bucket replication to the standby server or another building (ADR 0008 item 9) is set up on the server, not by this repository.

**Proposed default / question:** Confirm the owner and the network team own it, and that the restic copy in another building is enough as the one off-site copy until then.

**Answer:** المقترح: IT/فريق الشبكات والتخزين ينفذ replication ومراقبته، ومالك النظام يتابع قبوله. نسخة restic خارج المبنى تكفي مؤقتًا كنسخة خارج الموقع إذا كانت مشفرة وتشمل قاعدة البيانات والملفات والمفاتيح اللازمة وخضعت لاختبار استعادة. التكرار إلى standby ليس بديلًا عن backup ذي تاريخ إصدارات، ولا نعلن جاهزية failover قبل اختبارها.


### Q198

**Storage: master key custody.** `FILE_ENC_KEY` lives in `pmis.env` and must be kept offline too (without it the stored files are unreadable). Rotation is supported (`FILE_ENC_OLD_KEYS`, `storage-cli.js rewrap`).

**Proposed default / question:** Who holds the offline copy (two people, sealed envelope?), and whether a vault or KMS should hold it later.

**Answer:** المقترح: مسؤول أمن/IT وبديل مخول يحتفظان بوسيلة استعادة للمفتاح وفق إجراء عهدة موثق؛ لا تُفترض أسماء أشخاص غير معروفة. تحفظ نسخة استعادة مشفرة ومنفصلة عن بيانات النسخ الاحتياطي، مع وصول مقيد وسجل استخدام، ولا يُضاف المفتاح إلى git أو سجلات الدعم. يُفضَّل secret manager/vault للإنتاج؛ التدوير يحتفظ بالمفاتيح القديمة ما دامت بيانات/نسخ تحتاجها، وبعد اختبار فك التشفير والاستعادة.


### Q199

**Storage: streamed decryption and tamper detection.** The file is one AES-256-GCM stream with one tag at the end (the envelope holds the tag). A changed byte is detected when the stream ends, so bytes before it may already have reached the client, and the download then breaks. A chunked format would verify each part but changes the envelope.

**Proposed default / question:** Accept the single-tag design (the bytes are the user's own, already checked by sniffing), or ask for a chunked format before go-live.

**Answer:** المقترح: لا نقبل إرسال plaintext قبل التحقق من وسم GCM. يمكن إبقاء صيغة single-tag إذا جرى التحقق الكامل في مساحة مؤقتة محمية قبل بدء الاستجابة ثم تقديم الملف المتحقق منه؛ sniffing لا يعوض تحقق السلامة التشفيرية. للملفات الكبيرة التي تتطلب streaming فعليًا يُضاف تنسيق قطع موثقة مستقلًا مع ترتيب وطول ونهائية محمية وإصدار envelope وخطة انتقال. المطلوب قبل الإنتاج ضمان عدم كشف بايتات غير موثقة، وليس فرض إعادة كتابة الصيغة إن حقق المسار الأول ذلك.


---

## Stream templates and TPL-MASTER (0051)

### Q205

**Stream templates: which task a Master column writes (migration 0049).** The Master has one column where GSDN Workspace has two tasks, and the spec table (registers-and-streams §2.3) names both: CW MOS Planned/Actual (AY, AZ) are B8 or B9; CW Installation Planned/Actual Start and End (BK:BN) are B10 or B11; the item lists BA:BC and BD:BJ sit on B10 and B11; Report/Layout Submitted and Approved (AR, AS) are B5, B6 or B7. Snags Found/Cleared (BS, BT, EG, EH, FC, FD, FH, FI) are Yes/N/A lists in the spec but the QC snags are records.

**Proposed default / question:** Seeded in `template_task_fields` (data, editable): AY/AZ on B8, BK:BN on B11, the snag lists as plain task values (the QC snags stay the QC module's), AR and AS not mapped (read only), AT/AU/CG/CH/DB/DC mapped to the submitted and approved dates the workflow sets (read only). A task with no Master column (A1 to A5, B1 to B3, B6, B9, B10, C1 to C4, D1, D4b, D12, D17 and so on) has its own Planned Date and Actual Date columns. Confirm the mapping, or say which task each Master column belongs to.

**Answer:** المقترح: لا نعتمد إسناد AY/AZ إلى B8 وBK:BN إلى B11 كقاعدة عامة إذا كان العمود يغطي أكثر من نشاط. يحدد السيناريو/النطاق المهمة المقابلة؛ وإذا انطبق نشاطان، تُستخدم حقول تفصيلية لكل منهما مع إسقاط Master موثق، مثل أبكر بداية وآخر نهاية للأعمال المطلوبة، بدل الكتابة إلى مهمة واحدة تعسفيًا. تبقى AR/AS قراءة فقط حتى تعريف فصل B5/B6/B7، وتُشتق حالات Snags من سجل QC الموحد عند ربطه؛ الحقول الموروثة تبقى للمقارنة فقط. تحفظ أعمدة الأحداث التي يولدها workflow للقراءة، والمهام بلا عمود Master لها أعمدة تواريخ مستقلة؛ الربط الملتبس يمنع الاستيراد ويظهر للمراجع.


### Q206

**A row of a stream template is submitted, so it needs its actual date.** The upload enters each task as L1 and submits it (the task screen's submit needs the actual date and the mandatory documents). A row that only brings a planned date or a value, with no actual date on the task, is refused (`actual_date_required`); a task whose mandatory document slot is empty is refused (`mandatory_slots_missing`, upload the document on the task first).

**Proposed default / question:** Planning dates and values are saved on the task screen (the save does not submit). Confirm, or say that a template may save an entry without submitting it (the row would then have no L2 decision).

**Answer:** المقترح: دعم وضعين صريحين للقالب: Save Draft/Planning وSubmit for Review. الأول يحفظ المخطط والقيم غير المكتملة دون actual date أو مستندات إرسال، ولا يولّد قرار L2 أو إنجازًا. الثاني يتطلب الفعلي والمستندات وشروط المهمة المعتادة. تُعرض معاينة نتيجة كل صف، ولا تُفسر خلايا التخطيط وحدها كطلب اعتماد تلقائي.


### Q207

**Who maintains the template field mapping.** `master_columns`, `template_task_fields`, `template_task_rules` (Dismantle E1 to E3 excluded, B14 and D4b calculated) and `template_parts` (the sheet names of TPL-MASTER) are configuration; a change issues the next template version, but only a migration changes them today.

**Proposed default / question:** Add an admin screen (a delegable `templates.edit` action, reason and audit like the other settings) in the next step. Confirm the rule and the owner of the screen.

**Answer:** المقترح: إضافة شاشة إدارة Mapping للقوالب يملكها System Admin ويمكن تفويض `templates.edit` لها. كل تغيير له سبب وإصدار ومعاينة أثر على القوالب والحقول المحسوبة والمصادر، واختبار قبل النشر. لا تسمح الشاشة بتحويل حقل محسوب أو مملوك لسجل إلى كتابة مباشرة تتجاوز المسار؛ يلزم تحديث منطقي موثق، وتُحفظ القوالب القديمة وسياسة قبولها.


### Q208

**Locked tasks in an upload.** TI-04 says a cell in a locked step is held until the earlier approval exists, and Q81 says a closed gate locks the next stage's tasks. Built: a task locked because a predecessor is not approved is held `pending_previous_approval` (released by the next send once it opens); a task locked by a closed gate is refused (`gate_locked`, the gate may stay closed for weeks). A task that is in review or approval is held (`open_submission`).

**Proposed default / question:** Confirm the difference, or hold gate-locked rows too (a send then keeps them until the gate opens).

**Answer:** المقترح: الاحتفاظ بالصفوف المحجوبة بالبوابة أيضًا كـ held مع سبب `gate_locked` بدل رفضها وفقد العمل، وبقاء `pending_previous_approval` و`open_submission` أسبابًا مستقلة. لا تُطبَّق الصفوف المحجوزة تلقائيًا عند الفتح؛ يعيد المخول معاينتها وإرسالها مع إعادة فحص الإصدار والصلاحية والبيانات. يظهر للرافع ما حُفظ وما طُبق وما ينتظر، ويمكنه إلغاء الصف أو استبداله دون تكرار.


### Q209

**Starting a pending task from an upload.** The task screen needs "Start" before entry; an upload does it for the uploader: the start date is the row's actual start when typed, else today (the same default as the Start button).

**Proposed default / question:** Confirm, or require the actual start in the row when the task is still pending.

**Answer:** المقترح: للمهمة pending، استيراد بدء/إنجاز فعلي يتطلب Actual Start Date أو تاريخ بداية موثقًا موجودًا، ولا نستخدم اليوم لتاريخ عمل قديم تلقائيًا. المهمة ذات الحدث الواحد يمكن أن تستخدم تاريخها الفعلي كبداية فقط إذا نص تعريفها على ذلك. صف تخطيط فقط لا يبدأ التنفيذ؛ يحافظ الاستيراد على التاريخ الأصلي ومصدره ويسجل وقت الإدخال منفصلًا.


### Q210

**What TPL-MASTER does not write.** Identity C:T (RF & Design sheet), baseline U, scope X:AG (changed only through Change Control), the calculated columns, Dismantle FN:FW (the Dismantle sheet) and Issue GA:GE (the Issue Log sheet) are shown grey and ignored with a warning; the register sheets of the file carry what the registers own. The scope flags and the baseline have no batch flow of their own.

**Proposed default / question:** Confirm that the Master sheet never writes scope or baseline, or say how a scope change by file should be approved (Change Control, BP §03).

**Answer:** المقترح: Master لا يكتب scope أو baseline أو الحقول المحسوبة مباشرة. تعديلات النطاق/إعادة baseline تكون Change Control بربط السبب والموافقة وأثر التواريخ، ويمكن دعم ملف جماعي مخصص ينشئ طلبات مسودة لهذا المسار. تبقى RF & Design وDismantle وIssues مصادرها الخاصة؛ الخلايا الرمادية مع شرح وعرض فرق عند وجود قيمة مختلفة، ولا يُعلن الاستيراد ناجحًا لهذه الخلايا المتجاهلة.


### Q211

**TPL-MASTER and the parallel run.** A file is a PMIS-issued template (hidden `_tpl`); the real Master has none (Q1). Every row keeps its source (`Sheet!row`, file name and hash) and its diff against what GSDN Workspace holds; the comparison report is the list of those diffs per part.

**Proposed default / question:** Confirm that the real Master reaches GSDN Workspace through the one-time import (`tools/master-import`), and that TPL-MASTER is the path for files GSDN Workspace issued. Say whether the comparison report needs its own screen or export.

**Answer:** المقترح: استخدام مسار legacy import للـ Master الحقيقي، ومسار TPL-MASTER للقوالب الصادرة من النظام. خلال شهر التشغيل المتوازي نحتاج تشغيل مقارنة متكرر للنسخ القديمة كمعاينة reconciliation دون تكرار ترحيل البيانات أو الكتابة فوق معتمد. مطلوب شاشة فروق وتصدير XLSX يتضمن الموقع والحقل والقيمتين والمصدر والسبب والحل؛ تحفظ البصمة وSheet!row والوقت والمستخدم، مع موافقة واضحة قبل تطبيق أي فرق.


### Q212

**Register-owned fields and write-through.** The Q73 owner update (2026-10-31) lets a work view edit a register-owned field through the register. A template does not: the register-owned columns (B13 BU and D15 EF from As-Built, the vendor CD, the dates of tasks whose date comes from a register such as B1 to B3, C1 to C4 and D1) are grey, and the file says "enter register data in its register".

**Proposed default / question:** Confirm, or say which register-owned fields a stream template may write through to their register (each would be a register batch of its own, with the register's L1 and L2).

**Answer:** المقترح: القاعدة مصدر واحد لكل حقل؛ يمكن للقالب دعم write-through فقط إذا أنشأ/حدّث مسودة في السجل المالك وخضعت لـ L1/L2 الخاصة به، مع بيان النتيجة لكل سجل. إلى حين بناء ذلك تبقى الحقول رمادية ويستخدم قالب السجل المختص، بما في ذلك B1–B3 وC1–C4 وD1. BU/EF مشتقان من أحداث As-Built بعد Q113، فلا يفتح لهما مسار كتابة مستقل؛ لا يُستخدم قالب العمل لتجاوز صلاحيات السجل.


---

## Two-level conversion and permits per stream (0050)

### Q215

**Conversion of old 3-level items (migration 0050): what happens to the review level's holders.** An open item waiting at the old review level moves to L2 and is asked of the old final approvers only; the reviewer is no longer asked, a pin on a reviewer is cleared, and an all_members L2 gets its own votes in a new round.

**Proposed default / question:** Keep, or should the old reviewer be told that the item moved on (today only the L2 holders get an in-app notice)?

**Answer:** المقترح: الإبقاء على نقل العناصر المفتوحة إلى L2 النهائي وفق المسار الجديد، مع إشعار المراجع السابق وصاحب الإدخال بما تغير وبالجهة المطلوبة الآن. تُلغى الأصوات غير القابلة للنقل وتبدأ جولة اعتماد صحيحة دون توريث موافقة شخص لم يعد مخولًا. يُحفظ snapshot المسار القديم ورقم الترحيل والسبب، ولا يُعدل اعتماد مكتمل بأثر رجعي.


### Q216

**Level actors of the dropped path.** For converted open items the `task_level_actors` / `register_level_actors` rows at level 2 and 3 are removed (the acts stay in the step history and in the audit row), so the approval path shows no reviewer who never became L2.

**Proposed default / question:** Keep, or keep the old review acts visible as history on the task screen?

**Answer:** المقترح: إظهار إجراءات المراجعة القديمة في تاريخ المهمة بعلامة «المسار السابق قبل التحويل»، مع الفاعل والتاريخ والقرار. يمكن إخراج صفوفها من مسار الاعتماد النشط، لكن لا تختفي المراجعة التاريخية من واجهة المستخدم أو التدقيق. ما لم ينفذ لا يُعرض كاعتماد منجز؛ snapshot التاريخي منفصل عن قائمة المخولين حاليًا.


### Q217

**Items on one level.** The conversion handles `levels_required = 3` only. A rare open item frozen on a 1-level snapshot (before 0032) is left as it is (one level, self-approval, step-up).

**Proposed default / question:** Convert these to L1/L2 as well (it would add an L2 approver they never had)?

**Answer:** المقترح: تحويل العناصر المفتوحة القديمة ذات المستوى الواحد إلى L1/L2 بعد تقرير أثر وتحديد L2 صالح وإشعار أصحابها؛ لا يبقى self-approval استثناءً خفيًا. عند غياب L2 تُحفظ كمسودة/محجوبة مع تنبيه إعداد، ولا يُختلق معتمد. العناصر المكتملة تبقى بتاريخ مسارها القديم؛ أي إجراء طارئ بديل يحتاج استثناء موثقًا بصلاحية محددة.


### Q218

**Cell level 2 is retired, not deleted.** `matrix_cells.retired_at` is set; the data and holders stay for history and for the audit rows. A workflow draft that copies stage cells copies them retired.

**Proposed default / question:** Delete the retired cells after a retention period, or keep forever?

**Answer:** المقترح: إبقاء الخلايا المتقاعدة وتعييناتها كمرجع تاريخي غير نشط، ولا تُنسخ إلى المسارات الجديدة كصلاحيات فعالة. لا تُحذف قبل سياسة احتفاظ معتمدة والتحقق من المراجع والتدقيق؛ يمكن أرشفتها لاحقًا. لا نحدد الاحتفاظ الأبدي أو الحذف الآلي بمدة اعتباطية داخل هذا الجواب.


### Q219

**Default L1 of Permits & HSE.** The owner said CW permits are entered by the CW team and TE permits by the TE team but named no roles. Defaults seeded: `permits_hse` L1 = Site Engineers (CW), `permits_hse_te` L1 = Site Engineers (TE); L2 = CW Team Lead / TE Team Lead.

**Proposed default / question:** Confirm the roles (for example the Project Support or the Acquisition team may enter some permits, such as Civil Aviation or City Council).

**Answer:** المقترح: الإبقاء على Site Engineers (CW) → CW Team Lead لمسار CW، وSite Engineers (TE) → TE Team Lead لمسار TE. يمكن تفويض Project Support/Acquisition لإدخال أنواع محددة ضمن نطاقهم، مع بقاء صاحب الاعتماد المناسب لنوع التصريح. مصفوفة المسؤوليات هي المرجع، ولا يمنح اختيار نوع تصريح صلاحية إدارية أو اعتمادًا ذاتيًا.


### Q220

**Which stream a permit type belongs to.** `permit_types.stream`: Access - CW and PTW - CW are CW; Access - TE and PTW - TE are TE; every other type (City Council, Civil Aviation, Security Clearance, Other, Access - Survey, Access - QC / Maintenance, Access / PTW - Dismantle) has no stream and is entered on the Permits & HSE row, which covers CW.

**Proposed default / question:** Which stream enters the Dismantle permits and the types with no stream? The stream is data (Settings), so it can change without code.

**Answer:** المقترح: تعيين stream حسب نشاط التصريح لا اسم التصريح وحده: Dismantle CW إلى CW وDismantle TE إلى TE، والمسح إلى RF/Design أو CW حسب الغرض. City Council وCivil Aviation والتصاريح العقارية ضمن مسار Acquisition/Design المشترك، وQC/Maintenance ضمن المسار المعني أو O&M بعد التسليم؛ الأمن والوصول العام يُربطان بالنطاق المطلوب. عند عجز النموذج عن تمثيل shared/Acquisition/O&M يُستكمل بدل إسناد الجميع لـ CW؛ Other يتطلب اختيار stream ومالك اعتماد، والإعداد قابل للضبط.


### Q221

**Existing permit records and the new rule.** A permit already in entry keeps its draft; the entry check runs when a version is created or the permit type moves to another stream. A TE draft started by a CW holder before 0050 can still be edited and submitted by its holder.

**Proposed default / question:** Keep, or re-check every open permit draft against the new row?

**Answer:** المقترح: إعادة فحص صلاحية جميع مسودات التصاريح المفتوحة عند الحفظ والإرسال وفق القاعدة الحالية، دون حذفها. إذا انتقل النوع إلى TE يفقد حامل CW غير المخول حق الإرسال وتُنقل المسودة لمسؤول مؤهل مع إشعار. السجلات المعتمدة تحتفظ بالتاريخ، وتراجع أي تغييرات عليها كإصدار جديد بالصلاحيات الصحيحة.


### Q222

**The form does not yet hide permit types the user may not enter.** For Procurement the catalogue returns `entry_scopes`; for permits the refusal comes at save (`not_eligible_holder`, naming the stream).

**Proposed default / question:** Add a list of the permit types the caller may enter to the register catalogue so the type list shows only those?

**Answer:** المقترح: نعم، يعيد الكتالوج أنواع التصاريح المسموح للمستخدم بإدخالها بحسب دوره ومنطقته وتفويضه، مع بيان الأنواع غير المتاحة عند الحاجة دون تسريب بيانات. تُفحص الصلاحية مجددًا على الخادم عند الحفظ والإرسال؛ إخفاء الخيار وحده ليس ضبط صلاحيات. المسودة القديمة غير المسموحة تظهر بوضع مناسب يسمح بطلب نقلها بدل فقدانها.


---

## Documents on registers and QC snag photos (0047)

### Q225

**Who edits a site field such as near_airport, and is it approved?** The Site Register has no L1 / L2 path for its own attributes yet (sites come from the Master import). Migration 0047 edits a site custom field directly through `PATCH /sites/{id}` (`sites` edit in the region plus the field-level rule), audited with before and after, without an L2 step.

**Proposed default / question:** Direct edit by `sites` edit holders, audited; the field can be made read-only for chosen roles in the field-level rules. Confirm, or say whether a site field change must go through L1 then L2 like a register record.

**Answer:** المقترح: تعديل مباشر مدقق للصفات الوصفية غير المؤثرة في القواعد، بصلاحية الحقل والمنطقة. الصفات المؤثرة في السلامة/التصاريح/النطاق، مثل near_airport، تمر بمقترح تغيير واعتماد L2 أو Change Control المناسب، ثم يعاد تقييم المتطلبات والبوابات. تحفظ القيمة المعتمدة القديمة حتى القرار، ولا يتيح تعديل مباشر إسقاط تصريح طيران مطلوب.


### Q226

**B1's rule when a site has several Procurement records.** `procurement.delivery` reads the latest version of each Procurement record of the site whose scope is a source scope of B1 (CW, Tower Erection, Site Adaption); a voided record does not count.

**Proposed default / question:** The PR e-mail applies when any of them is Outsourced; otherwise the delivery of the latest one decides; with no record the slot waits as "not required" and Data Entry can still declare it.

**Answer:** المقترح: الوثيقة المطلوبة تُحدد من أوامر Procurement المعتمدة غير الملغاة التي تغطي نطاق B1، باستخدام أحدث إصدار معتمد لكل أمر، لا أحدث مسودة. إذا كان أي نطاق مطلوب Outsourced تكون PR e-mail مطلوبة لذلك النطاق؛ المختلط لا يُحسم بـ «أحدث أمر». غياب أمر أو عدم معرفة delivery يظهر Unknown/Pending determination، لا Not required مؤكدًا؛ يمكن رفع المستند مبكرًا، ولا تعتمد المهمة حتى حسم القاعدة.


### Q227

**Register documents on a record that is the source of a task (Q43).** Such a record keeps using its task's slots; when the library also places a document on the register, the record gets its own slot too, and both are checked at Submit.

**Proposed default / question:** Both are kept and checked. Should register placements be skipped for records that feed a task?

**Answer:** المقترح: مطلب مستندي منطقي واحد لكل غرض، يمكن ربطه بالمهمة والسجل معًا دون مطالبة المستخدم برفع المستند نفسه مرتين. عند اختلاف الغرض تُنشأ متطلبات منفصلة واضحة، وعند تطابقه يكفي ملف/إصدار معتمد واحد مع فحص الأهلية في الموضعين. يمنع الإرسال إذا بقي مطلب إلزامي حقيقي ناقصًا، لا بسبب تكرار placement لنفس المطلب.


### Q228

**Register records without a site (Contractors, Risks, Meetings).** The slot table needs a site and a region, so a global record has no document slots.

**Proposed default / question:** No slots on global records. Is a document needed on any global register?

**Answer:** المقترح: نعم، السجلات العامة تحتاج مرفقات؛ أمثلة: عقود وشهادات المقاولين، ومحاضر الاجتماعات، وأدلة المخاطر العامة. يُضاف ربط المستند بالسجل مع site/region اختياريين عند عدم الانطباق، وتُشتق الصلاحية من السجل ونطاق المشروع. لا ننشئ موقعًا وهميًا، ولا نترك العقود المهمة كمراجع نصية فقط.


### Q229

**A new version of an approved record.** The slots follow the logical record; a new version reopens the approved slots as "uploaded" with their files (Data Entry may replace a file) and they go through L2 again. A voided correction gives them back their approval.

**Proposed default / question:** As built. Should a new version instead start with empty slots?

**Answer:** المقترح: الإصدار الجديد يحتفظ بروابط المستندات السابقة مع إمكانية الاستبدال، دون نسخ الملفات أو إعادة استخدام موافقتها تلقائيًا لتغيير مؤثر. يراجع L2 المستندات المتأثرة، وغير المتغيرة يمكن توريث اعتمادها بسياسة صريحة وسجل واضح. يظل الإصدار المعتمد السابق صالحًا حتى اعتماد البديل؛ إلغاء مسودة التصحيح يعيد العرض للإصدار السابق ولا يختلق موافقة جديدة. السحب الفعلي للمستند له أثره ولا يُلغى بسبب إلغاء مسودة أخرى.


### Q230

**Who raises a QC snag, and who holds L1 / L2 of a snag.** CLAUDE.md says the site engineer uploads the fix and the L2 approves; it does not say who raises the snag. Migration 0047 lets anyone with Quality `create` in the region raise it, and takes L1 / L2 from the Quality register's row of the Responsibility Matrix (B11).

**Proposed default / question:** As built; the Quality row's cells are set by the admin. Confirm, or name a separate Matrix row for QC snags (for example per stream CW / TE).

**Answer:** المقترح: يستطيع المخول بـ Quality create ضمن المنطقة إنشاء snag، مع استيراد L1/L2 من مصفوفة المسؤوليات. نحتاج فصل صلاحيات/صفوف CW وTE عندما تختلف فرق التنفيذ والاعتماد، دون اشتراط وحدة برمجية منفصلة. يرفع مهندس الموقع المكلف أدلة الإصلاح ويعتمدها QC/L2 المؤهل، مع منع الاعتماد الذاتي وتسجيل المكتشف والمنفذ والمعتمد كلٌّ على حدة.


### Q231

**"All members must approve" on the L2 of a snag.** Snags follow the any-one-member rule (with B5 self-approval and the B10 no-holder alert); a Quality L2 cell set to "all members" is treated as any one member for snags.

**Proposed default / question:** Any one member. Is a group vote needed for snags?

**Answer:** المقترح: أي عضو مؤهل واحد يكفي افتراضيًا، لكن إذا ضُبطت خلية L2 على all_members يجب احترامها في snags أيضًا. لا نتجاهل إعداد المصفوفة بصمت؛ إما دعم القاعدة أو منع اختيارها لهذه الوحدة مع رسالة واضحة. لا يُفرض تصويت جماعي افتراضي على كل العيوب، وتظل الحماية من self-approval وتنبيه غياب المخول نافذتين.


### Q232

**Photo dated after the upload, and the in-app camera rule.** A photo whose EXIF date is in the future is accepted (only "before the raise" is refused); photos are accepted from any camera until the mobile app exists (CLAUDE.md "Proof tasks (MOS, QC) accept the in-app camera only").

**Proposed default / question:** As built; the one-day tolerance is fixed (`qc_exif_tolerance`, API constant) per the owner answer. Should a future EXIF date be refused, and should the tolerance be a setting?

**Answer:** المقترح: لا تُقبل صورة ذات EXIF مستقبلي يتجاوز هامش اليوم الواحد الحالي؛ المخالفة تحفظ كدليل معلق/استثناء ولا تُقبل كإثبات إصلاح حتى المراجعة. يصبح الهامش إعدادًا مدققًا بصلاحية محددة مع إبقاء القيمة الحالية افتراضيًا، وتوحيد المناطق الزمنية. صور اكتشاف العيب قد تسبق تاريخ تسجيله، أما إثبات الإصلاح فلا يسبق الحدث المطلوب خارج الهامش. إلى حين توفر كاميرا التطبيق يُصرح بقبول الرفع كحل انتقالي؛ EXIF قابل للتعديل فلا يُعتبر وحده إثباتًا قاطعًا للمكان أو الوقت.


### Q233

**Default snag type.** No snag type was seeded before; migration 0047 seeds `QC_GENERAL` (1 photo, JPG / PNG / HEIC, 20 MB, blocks the PAC / FAC of its stream) so a snag can be raised at once.

**Proposed default / question:** Keep it as seed data, editable in Settings. Send the list of snag types and their photo rules (minimum count, shot types).

**Answer:** المقترح: الاحتفاظ بـ QC_GENERAL كنوع أولي قابل للتعديل، بحد أدنى صورة واحدة وبالصيغ والحجم المذكورين بعد التحقق من دعمها الفعلي. الحجب يُشتق من severity وقاعدة القبول للنطاق؛ للنوع العام غير المصنف تكون القاعدة تحفظية، دون جعل كل ملاحظة مستقبلية حاجبة دائمًا. تُجهَّز كتالوجات CW وTE لأنواع مثل الأعمال المدنية والتأريض والكابلات والطاقة والتسمية، مع متطلبات صور لكل نوع للمراجعة؛ لا تُقدَّم هذه الأمثلة كقائمة نهائية متفق عليها.


### Q234

**Quality register record of type "snag" and the QC snag.** The Quality register (0025) has a record type `snag` (data only), while the PAC / FAC block and the photo flow use the QC snags (`snags`). They are separate objects today.

**Proposed default / question:** Separate. Should a Quality "snag" record create (or be) the QC snag?

**Answer:** المقترح: توحيد Quality snag وQC snag ككيان عمل واحد، بمعرّف وحالة وSeverity ومسار صور واعتماد واحد؛ يمكن أن يبقى عرضان للكيان نفسه. إذا احتُفظ بجدولين تقنيًا، يكون الربط 1:1 مُدارًا تلقائيًا وقابلًا لإعادة المحاولة دون تكرار، مع أثر موحد على PAC/FAC. تُرحَّل السجلات القائمة مع كشف التكرارات ومراجعة الناقص، ولا تُغلق snag لمجرد اعتماد سجل عام بلا أدلة الإصلاح المطلوبة.

