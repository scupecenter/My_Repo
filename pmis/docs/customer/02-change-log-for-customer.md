# 02 — سجل التعديلات للعميل | Change Log for the Customer

> **حالة الوثيقة:** النظام في **نهاية المرحلة P0** (التصميم مكتمل) و**التنفيذ يبدأ في P1**. الشاشات المذكورة من **النموذج الأولي** ببيانات **تجريبية مصطنعة**. هذه الوثيقة تلخّص القرارات والتعديلات منذ **2026-10-24** مجمّعة حسب الموضوع، بلغة الأعمال؛ المصدر `CHANGELOG.md` و`CLAUDE.md`. الرمز بين قوسين (B2…B13) هو رمز القرار عند وجوده.
>
> **Document status:** the system is at the **end of phase P0** (design complete); **implementation starts in P1**. Screens mentioned come from the **prototype** with **synthetic data**. This document summarises decisions and changes since **2026-10-24**, grouped by topic, in business language; sources are `CHANGELOG.md` and `CLAUDE.md`. The code in brackets (B2…B13) is the decision code where one exists.

> ملاحظة: في المصدر عدة قرارات مؤرخة «2026-10-25» دون ساعة، فالترتيب داخل اليوم الواحد غير محدد. | Note: several decisions in the source share the date 2026-10-25 with no finer ordering.

---

# القسم العربي

## أ. المنصة والأساس (2026-10-24)

- NestJS مع PostgreSQL على **خادم داخلي، وليس سحابة**.
- الدخول بـ Microsoft 365 لموظفي Aljeel فقط؛ التحقق الثنائي عبر Entra لاحقاً.
- ألوان ERPNext (frappe-ui 1.0.2) بخط Cairo؛ وخط الإنجاز (pipeline) بأسلوب لوحة المتابعة القديمة.
- **الإطلاق:** تجربة في طرابلس أسبوعين، ثم تشغيل موازٍ مع الـMaster شهراً.
- أُنجز في P0: فريق الوكلاء، والمواصفات (69 مهمة، 92 قصة، القواعد، الأسئلة المفتوحة)، ومخطط البيانات (75 نموذجاً) وربط أعمدة الـMaster الـ187، ورموز التصميم والنموذج الأولي، ثم في 2026-10-25: عشر وثائق قرارات معمارية (ADR 0001–0010)، وعقد API الإصدار 0.1، وتقرير بوابة P0.

## ب. الأدوار والمستخدمون والتفويض

| التاريخ | القرار | الرمز |
|---|---|---|
| 2026-10-24 | إسناد الأدوار **متعدد-لمتعدد في الاتجاهين**، والمجموعات تُستخدم في خلايا المصفوفة. | — |
| 2026-10-24 | شبكة صلاحيات لكل وحدة وشاشة. | — |
| 2026-10-25 | **الأدوار يعرّفها المدير بالكامل** (مثال دور «الإدارة» للاطلاع على لوحة المتابعة فقط). | — |
| 2026-10-25 | **مدير النظام مجموعة من شخص أو أكثر**، ويفوّض أي صلاحية لأي شخص أو دور أو مجموعة. | — |
| 2026-10-25 | **رؤية من يحمل أكثر من دور:** مجموع أدواره، وكل دور محصور في مناطقه ووحداته؛ النطاقات لا تتقاطع. | B3 |
| 2026-10-25 | **المعتمد الافتراضي:** الدور الرئيسي للمرحلة، وProject Manager يعتمد Final Closure؛ قابل للتعديل. | B2 |

## ج. الدخول والأمان

| التاريخ | القرار | الرمز |
|---|---|---|
| 2026-10-25 | **سجل الموظفين:** رقم الموظف (4 أرقام) يظهر بجانب اسم كل مكلّف وببطاقة صغيرة بالمرور عليه؛ لا حذف نهائي بل تعطيل. | B13 (حسب CLAUDE.md) |
| 2026-10-25 | **إعفاء مستخدم من التحقق الثنائي داخل PMIS** (بسبب وتحقق إضافي من المدير، لا أحد يعفي نفسه، تدقيق وبريد للمستخدم). لا يلغي MFA المفروض من Entra. | — |
| 2026-10-25 (3) | **خانة دخول واحدة:** بريد أو رقم وظيفي أو هاتف، ثم يُجري Microsoft 365 الدخول فعلياً. لا كلمات مرور في المنظومة، والشاشة لا تكشف إن كان الشخص مسجلاً. | — |
| 2026-10-25 (3) | **الدخول المحلي (رقم/هاتف + كلمة مرور) مؤجل لمرحلة لاحقة.** | — |
| 2026-10-25 (3) | **ظهور الهاتف والبريد في البطاقة:** افتراضياً لكل الموظفين المسجلين، وللمدير تحديد من يرى كل حقل أو إخفاؤه لموظف بعينه. | — |
| 2026-10-24 / 25 | أمان قاعدة البيانات: فلترة بالمناطق على مستوى الصفوف، وعدم الكتابة المباشرة على جداول الهوية، وفحوص ضد المنح الذاتي، وتصعيد التحقق للإجراءات الحساسة، وحماية حقول الهاتف والبريد، وقوالب النماذج. | — |

## د. دورة الاعتماد

| التاريخ | القرار | الرمز |
|---|---|---|
| 2026-10-25 | **الاعتماد الذاتي** مسموح عند حمل شخص لكل المستويات، مع تحقق إضافي وعلامة «اعتماد ذاتي». | B5 |
| 2026-10-25 | **الرفض بعد التخطّي التلقائي** يعود إلى من تصرّف فعلاً، يصحح ويعيد الإرسال، ويُسجَّل التخطّي من جديد. | B6 |
| 2026-10-25 | **تغيير عدد مستويات الاعتماد** يسري على المهام الجديدة وغير المُرسَلة؛ والمهمة تحفظ مسارها عند أول إرسال. | B7 |
| 2026-10-25 | **مهمة بلا صاحب** تذهب لصندوق مديري النظام مع تنبيه فوري ولا تُتخطّى؛ وفي «كل الأعضاء يجب أن يعتمدوا» رفض عضو واحد يرفض المهمة. | B10 |
| 2026-10-25 | **صفوف المصفوفة للسجلات والتفكيك:** صف لكل سجل وصف للتفكيك، بعدد مستويات (1–3) يحدده المدير. | B11 |
| 2026-10-25 | **غياب الموظفين وإعادة الإسناد:** لا نقل تلقائي؛ القائد يقرر (إبقاء، أو تكليف غيره، أو العمل نيابةً). لا يمس البيانات ولا يصفّر الـSLA ولا يوقفه. تسجيل الغياب اختياري، وتنبيه عن مهمة متوقفة يومي عمل (قابل للتعديل). | B12b |

## هـ. سير العمل والمراحل والمهام

| التاريخ | القرار | الرمز |
|---|---|---|
| 2026-10-25 | **المراحل والبوابات قابلة للتعديل من المدير** (بدل «ثابتة»): تعديلات خفيفة فورية، وهيكلية كنسخة جديدة من تعريف سير العمل. | — |
| 2026-10-25 | **مهمة مضافة قد تؤخّر المرحلة عن الـMaster:** تحذير عند الإضافة، وتأكيد صريح أثناء التشغيل الموازي، والفرق يُعلَّم «بسبب مهمة مضافة» ولا يُحسب خطأ نقل. | B8 |
| 2026-10-25 | **تجميد التعديلات الهيكلية** خلال التجربة والتشغيل الموازي؛ يرفعه مدير النظام فقط بسبب ومصادقة إضافية. التعديلات الخفيفة والمهام المضافة داخل مرحلة متاحة. | B9 |
| 2026-10-25 | **Site RFI** يعمل كمهمة بلا مستند: تاريخه يُفتح عند تحقق شروطه ويُعبَّأ مسبقاً ويمر بالمراجعة والاعتماد. | (CLAUDE.md) |
| 2026-10-25 | **قياس D-1** من تاريخ Site RFI لا من Site Release. | (CLAUDE.md) |
| 2026-10-25 | **Project Status** يبقى حتى HOTO، و**Final Closure** مؤشر منفصل (المواقع المغلقة، النسبة، CW/TE FAC المعلّقة وأعمارها). | — |
| 2026-10-24 | SLA (أدنى/أقصى بأيام العمل) وأوزان Project Status **قابلة للتعديل ومُصدَّرة بنسخ**. | — |

## و. التقويم والعطل

- **العطل الرسمية** (2026-10-25، B12): شاشة «إعدادات ← تقويم العمل» لإضافة وتعديل وحذف واستيراد العطل الوطنية والدينية وأيام نهاية الأسبوع. مسودة 2026–2027 فيها 28 عطلة؛ الدينية «تقريبية» حتى يؤكدها المدير مع تذكير قبل 14 يوماً. التعديل يعيد حساب SLA للمهام المفتوحة فقط.
- *مفتوح:* تأكيد التواريخ الدينية وعدد أيام العيد (HANDOVER.md).

## ز. المستندات والجودة والنماذج

- **نماذج CW (DN وRN وPAC وFAC)** يصدرها النظام وتُملأ تلقائياً؛ جداول الأصناف من حركات المخزن لا من النموذج؛ **نماذج TE مؤجلة**. أُضيفت قوالب النماذج الأربعة ومحرك الطباعة PDF وعينات البيانات وقائمة 28 صنفاً.
- **فترة ضمان العيوب (DLP):** CW = 3 أشهر وTE = 12 شهراً من تاريخ PAC، كإعدادين قابلين للتعديل، وتُحفظ القيمة على كل PAC. عيّنات PAC/FAC أُعدّت بثلاثة أشهر.
- **القوالب المعتمدة فقط، والحقول المخصصة، ومكتبة المستندات** كلها بيانات يديرها المدير بنسخ وتدقيق (قرارات 2026-10-24/25).

## ح. السجلات والتدقيق

- **من يرى سجل التدقيق** (2026-10-25، B4): مديرو النظام وProject Manager كاملاً؛ قائد الفريق لوحداته ومناطقه؛ غيرهم بصلاحية `view_audit`. كل اطلاع على السجل يُسجَّل.
- السجلات: التجهيز لـ13 سجلاً مستقلاً، منها سجل المشاكل (عدة مشاكل للموقع).

## ط. الوثائق والتصميم والتسليم

- 2026-10-24: المواصفات في `docs/spec/`، ومخطط Prisma، ورموز التصميم، والنموذج الأولي v2.
- 2026-10-25: لقطات النموذج الأولي (حتى 13 لقطة)، وبطاقة الموظف في الشاشات الرئيسية، و`HANDOVER.md` لمطوّر P1، ومواصفة سجل الموظفين ومسودة 25 صفاً وهمياً.
- تعديل العقد: مسار `return_to` مقيّد وقائمة سماح، وفصل `GET /users/picker`.

## ي. بنود ما زالت مفتوحة (من السجل)

- تنفيذ **B3** في قاعدة البيانات (مناطق لكل وحدة) في P1، **والجلسة الموقّعة** قبل التجربة.
- جدول الغياب وإجراء `reassign` وتنبيه المهمة المتوقفة، وتعديل جدول العطل، وإعفاء 2FA، وإعدادات ظهور الهاتف والبريد: كلها P1.
- تسجيل تطبيق Entra لدى IT (B1)، وأسئلة البوابة المتبقية.
- عند تفعيل الدخول المحلي لاحقاً: تأكيد «الهاتف + كلمة المرور»، وصلاحية Graph `User.Read.All` من IT.

## ك. ما أُزيل أو نُقل في تنظيف المستودع (2026-10-25، التحديث 4)

- **حُذف:** اللوحة القديمة في جذر المستودع مع ملفي السجل والمرجع الخاصين بها؛ تجارب التصميم الأولى (مفهوم صفحة الموقع، واتجاهات الألوان، وملف ألوان قديم غير مستخدم)؛ 3 لقطات شاشة قديمة.
- **نُقل:** مجلد اللوحة إلى `docs/reference/legacy-dashboard/` (مرجع قراءة فقط لمؤشرات لوحة P3)؛ وملف القرارات D1–D88 إلى `docs/reference/`.
- **تعديل:** README جديد خاص بالنظام، وتحديث المسارات في الملفات المرجعية.
- **أُبقي عمداً:** ملف Master ومولّده، ومهارات الوكلاء (لأن سكربت إعداد حساب المالك ينسخها)، وهي أدوات تطوير لا جزء من النظام.
- **تحقق:** النموذج الأولي 120 اختباراً ناجحاً بلا فشل، ونماذج الطباعة الأربعة تعمل.

---

# English section

## A. Platform and foundation (2026-10-24)

- NestJS with PostgreSQL on an **internal server, never cloud**.
- Microsoft 365 sign-in for Aljeel employees only; two-factor authentication through Entra later.
- ERPNext colours (frappe-ui 1.0.2) with the Cairo font; the pipeline component follows the style of the previous dashboard.
- **Rollout:** a 2-week pilot in Tripoli, then a 1-month parallel run with the Master.
- Delivered in P0: the agent team; the specification (69 tasks, 92 stories, rules, open questions); the data model (75 models) with the mapping of all 187 Master columns; design tokens and the prototype; then on 2026-10-25 ten architecture decision records (ADR 0001–0010), API contract v0.1 and the P0 gate report.

## B. Roles, users and delegation

| Date | Decision | Code |
|---|---|---|
| 2026-10-24 | Role assignment is **many-to-many in both directions**; groups can be used in matrix cells. | — |
| 2026-10-24 | A permission grid per module and screen. | — |
| 2026-10-25 | **Roles are fully admin-defined** (for example a Management role limited to viewing the dashboard). | — |
| 2026-10-25 | **System Admin is a group of one or more people** and can delegate any right to any person, role or group. | — |
| 2026-10-25 | **Visibility for people with several roles:** the union of their roles, each limited to its own regions and modules; scopes never cross. | B3 |
| 2026-10-25 | **Default approver:** the stage's main role; the Project Manager approves Final Closure; editable. | B2 |

## C. Sign-in and security

| Date | Decision | Code |
|---|---|---|
| 2026-10-25 | **Staff registry:** the 4-digit employee ID is shown beside every assignee's name with a small card on hover; no hard delete, deactivate only. | B13 (per CLAUDE.md) |
| 2026-10-25 | **Per-user MFA exemption inside the PMIS** (reason and the admin's own step-up; nobody exempts themselves; audited and emailed). It does not cancel MFA enforced by Entra. | — |
| 2026-10-25 (3) | **One sign-in box:** email, employee ID or phone; Microsoft 365 then performs the sign-in. No passwords in the system; the screen does not reveal whether a person is registered. | — |
| 2026-10-25 (3) | **Local sign-in (ID/phone + password) deferred to a later phase.** | — |
| 2026-10-25 (3) | **Phone and email on the card:** visible to all registered staff by default; the admin can choose who sees each field or hide it for one employee. | — |
| 2026-10-24 / 25 | Database security: row-level region filtering, no direct writes to identity tables, checks against self-granting, step-up for sensitive actions, protection of phone/email fields, and form templates. | — |

## D. The approval flow

| Date | Decision | Code |
|---|---|---|
| 2026-10-25 | **Self-approval** allowed when one person holds all levels, with step-up and a "self-approval" flag. | B5 |
| 2026-10-25 | **Rejection after an auto-skip** returns to the person who actually acted, who corrects and resubmits; the skip is logged again. | B6 |
| 2026-10-25 | **Changing the number of approval levels** applies to new and not-yet-submitted tasks; a task keeps its path from first submission. | B7 |
| 2026-10-25 | **A task with no holder** goes to the System Admins' inbox with an immediate alert and is not skipped; under "all members must approve", one rejection rejects the task. | B10 |
| 2026-10-25 | **Matrix rows for registers and Dismantle**, with 1–3 levels set by the admin. | B11 |
| 2026-10-25 | **Absence and reassignment:** no automatic move; the lead decides (keep, reassign, or act on behalf). It does not touch data or reset/pause the SLA. Absence records are optional; an alert fires for tasks idle N working days (default 2, editable). | B12b |

## E. Workflow, milestones and tasks

| Date | Decision | Code |
|---|---|---|
| 2026-10-25 | **Milestones and gates are admin-configurable** (replacing "fixed"): light changes at once, structural changes as a new workflow-definition version. | — |
| 2026-10-25 | **An added task may delay a milestone versus the Master:** a warning when added, explicit confirmation during the parallel run, and the difference is tagged "caused by an added task", not counted as an import error. | B8 |
| 2026-10-25 | **Freeze of structural changes** during the pilot and the parallel run; only a System Admin can lift it with a reason and extra authentication. Light changes and tasks added inside a stage stay allowed. | B9 |
| 2026-10-25 | **Site RFI** works like a task with no document: its date unlocks when its conditions are met, is pre-filled, then reviewed and approved. | (CLAUDE.md) |
| 2026-10-25 | **D-1 is measured** from the Site RFI date, not from Site Release. | (CLAUDE.md) |
| 2026-10-25 | **Project Status** stays up to HOTO; **Final Closure** is a separate KPI (sites closed, %, pending CW/TE FAC and their age). | — |
| 2026-10-24 | SLA (minimum/maximum working days) and Project Status weights are **editable and versioned**. | — |

## F. Calendar and holidays

- **Public holidays** (2026-10-25, B12): Settings → Work calendar to add, edit, delete and import national and religious holidays and weekend days. A 2026–2027 draft with 28 holidays; religious dates are tentative until the admin confirms them, with a reminder 14 days ahead. A change recalculates open tasks only.
- *Open:* confirmation of the religious dates and the number of Eid days (HANDOVER.md).

## G. Documents, quality and forms

- **CW forms (DN, RN, PAC, FAC)** are issued by the system and pre-filled; item tables come from warehouse movements, not the form; **TE forms are deferred**. The four form templates, the PDF print engine, sample data and the 28-item list were added.
- **Defects Liability Period (DLP):** CW 3 months, TE 12 months from the PAC date, as editable settings; each PAC keeps the value in force when issued. Sample PAC/FAC were set to three months.
- **Approved templates only, custom fields and the Document Library** are all admin-managed data with versions and audit (decisions of 2026-10-24/25).

## H. Registers and audit

- **Who can read the Audit Log** (2026-10-25, B4): System Admins and the Project Manager see all; a Team Lead sees their own modules and regions; others need the `view_audit` grant. Every read of the log is itself recorded.
- Registers: the design covers 13 independent registers, including an Issue Log with several issues per site.

## I. Documents, design and handover

- 2026-10-24: the specification in `docs/spec/`, the Prisma schema, design tokens and prototype v2.
- 2026-10-25: prototype screenshots (up to 13), the employee card on the main screens, `HANDOVER.md` for the P1 developer, the staff-registry specification and a 25-row synthetic draft.
- Contract changes: a restricted `return_to` path with an allow-list, and a separate `GET /users/picker`.

## J. Items still open (from the log)

- Implementing **B3** in the database (regions per module) in P1, and **the signed session context** before the pilot.
- Absence table, the `reassign` action and the idle-task alert; the holiday table changes; the MFA exemption; phone/email visibility settings: all P1.
- Entra app registration by IT (B1) and the remaining gate questions.
- When local sign-in is enabled later: confirm "phone + password", and obtain Graph `User.Read.All` from IT.

## K. What was removed or moved in the repository cleanup (2026-10-25, entry 4)

- **Removed:** the old dashboard at the repository root with its own change-log and reference files; the first design experiments (site-page concept, visual directions, an unused old colour file); 3 old screenshots.
- **Moved:** the dashboard folder to `docs/reference/legacy-dashboard/` (read-only reference for the P3 dashboard KPIs); the D1–D88 decisions file to `docs/reference/`.
- **Changed:** a new system-specific README, and paths updated in the reference files.
- **Kept on purpose:** the Master workbook and its generator, and the agent skills (the owner's account setup script copies them); they are development tools, not part of the system.
- **Checked:** the prototype passes 120 tests with no failures, and the four print forms work.
