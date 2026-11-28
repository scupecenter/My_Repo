# وثائق العميل | Customer Documents

> النظام في **نهاية المرحلة P0** (التصميم مكتمل)، والتنفيذ يبدأ في **P1**. الشاشات من النموذج الأولي ببيانات تجريبية مصطنعة.
> The system is at the **end of phase P0** (design complete); implementation starts in **P1**. Screens come from the prototype with synthetic data.

## المتاح الآن | Available now

| الملف | الوصف | Description |
|---|---|---|
| [01-system-overview.md](01-system-overview.md) | وثيقة وصف النظام | System overview: scope, roles, workflow, visibility, registers, documents, sign-in, configuration, NFRs, rollout |
| [02-change-log-for-customer.md](02-change-log-for-customer.md) | سجل التعديلات للعميل (منذ 2026-10-24) | Customer change log grouped by topic, with decision codes |
| [05-training-ar.md](05-training-ar.md) | مادة التدريب | Arabic training material per role |
| [06-admin-guide-ar.md](06-admin-guide-ar.md) | دليل مدير النظام | Arabic administrator guide |
| [03-architecture-and-data.md](03-architecture-and-data.md) | البنية ومخطط البيانات | Architecture, authentication, authorization/RLS, data entities, audit, backups, integrations, IT needs |
| [05-field-mode.md](05-field-mode.md) | وضع الميدان (دون اتصال)، المرحلة 1 | Field mode (offline), phase 1: what is stored, the queue, sync and conflict rules |
| [09-handover-open-items-warning.md](09-handover-open-items-warning.md) | تحذير البنود المفتوحة عند تسليم الجاهزية | Readiness handover: open items warning |
| [07-reorder-limits-and-supplier-returns.md](07-reorder-limits-and-supplier-returns.md) | حدود إعادة الطلب ومرتجعات الموردين | Reorder limits and supplier returns (tracking only, no stock effect) |
| [06-site-map-tiles.md](06-site-map-tiles.md) | خريطة المواقع على بلاطات من خادمك | Site map on map tiles served from your own server (off by default) |
| [08-workflow-studio-lists.md](08-workflow-studio-lists.md) | استوديو مسار العمل: القوائم والتعديل داخل الجدول | Workflow Studio: lists and editing in the table |

## وثائق مخططة لاحقاً | Planned later

| الوثيقة | التوقيت | Document | When |
|---|---|---|---|
| دليل المستخدم لكل دور | بعد P2 | User manual per role | after P2 |
| مرجع الشيفرة للمطوّرين (يُولَّد من الشيفرة) | من P1 | Developer code reference (generated from code) | from P1 |
| دليل التشغيل (Runbook) | P3 | Operations runbook | P3 |

المصادر: `CLAUDE.md`، `CHANGELOG.md`، `docs/adr/`، `docs/spec/`، `db/erd.md`، `contracts/openapi.yaml`، `HANDOVER.md`. الإضافات المقترحة غير المؤكدة مكتوبة فيها «يُؤكَّد لاحقاً».
| [shortage-draft-purchase-request.md](shortage-draft-purchase-request.md) | Draft purchase request from a material shortage line |
