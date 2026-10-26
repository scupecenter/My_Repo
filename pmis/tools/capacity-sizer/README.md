# GSDN PMIS — Infrastructure Sizing Tool v1.0 (2026-10-26)

## English
A standalone, offline calculator that estimates servers (vCPU, RAM, disk), storage growth, backups and restore time for the GSDN PMIS components (nginx, web, API, workers, PostgreSQL 16, Redis, MinIO) on an on-prem Docker Compose server.

- **Open:** double-click `index.html` (any modern browser; no installation, no network needed; Cairo font is used when online, system fonts otherwise).
- Fill the report details, pick a preset or edit the inputs; results update live. The inputs are kept in the page link (`#...`), so copying the link reproduces the sizing.
- **Save / Load scenario (JSON)** lets you send your inputs back to us. **Keep for comparison** stores up to 3 scenarios in this browser. **Print / PDF** produces an A4 report. **Copy summary** and **Download CSV** are also available.
- **Important:** all numbers are planning estimates based on editable coefficients. Confirm them with a load test (100 concurrent users, 1000 sites, pages under 2 s) before buying hardware.
- Check: `node tests/check.mjs` (needs Playwright).

## العربية
أداة مستقلة تعمل دون اتصال بالشبكة لتقدير الخوادم (vCPU وRAM والقرص) ونمو التخزين والنسخ الاحتياطي وزمن الاستعادة لمكوّنات GSDN PMIS (nginx والويب وAPI والعمّال وPostgreSQL 16 وRedis وMinIO) على خادم داخلي بنظام Docker Compose.

- **الفتح:** افتح الملف `index.html` بأي متصفح حديث (دون تثبيت أو اتصال؛ يُستخدم خط Cairo عند توفر الإنترنت وإلا خط النظام).
- املأ بيانات التقرير، اختر إعداداً جاهزاً أو عدّل المدخلات؛ تتحدث النتائج مباشرة. تُحفظ المدخلات في رابط الصفحة (`#...`) فيعيد نسخ الرابط الحساب نفسه.
- **حفظ/تحميل السيناريو (JSON)** لإرسال مدخلاتكم إلينا. **حفظ للمقارنة** يحفظ حتى 3 سيناريوهات في هذا المتصفح. **طباعة / PDF** يعطي تقريراً بحجم A4. كما يتوفر **نسخ الملخص** و**تنزيل CSV**.
- **مهم:** كل الأرقام تقديرات تخطيطية مبنية على معاملات قابلة للتعديل، ويجب تأكيدها باختبار حمل (100 مستخدم متزامن و1000 موقع، الصفحات أقل من ثانيتين) قبل شراء الأجهزة.
