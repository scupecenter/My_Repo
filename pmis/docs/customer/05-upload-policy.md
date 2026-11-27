# Upload policy for the Master import (EN / AR)

## English walkthrough

1. Open Settings > Data > Imports. The "Upload policy" box sits under the background threshold. The gear on the Master import, batch and Templates screens leads here.
2. "Enforce the sequence" is the default and changes nothing: the sequencing locks of each site decide, as before.
3. "Accept incomplete data" opens the sites of a Master import file when you apply it. The data then enters in any order. The sites are opened through the same switch as the lock button of the site page, so it needs the right to unlock for each region of the file, a reason and a fresh step-up. Every site gets an audit row.
4. A task approved on an open site while a lock would have held it is flagged "Admin override", as for any open site.
5. The import status list of a run or batch shows what is missing for each site (a task without an actual date while the next task has one, or a missing delivery scenario).
6. Only a System Admin, or a delegate of Settings edit for all regions, changes the policy. Every change needs a reason and is audited with the old and new value.

What does not change: no right, role or grant. The historical load opens its own sites and ignores the policy. Sites created by the same apply ("create sites") keep their locks. The mode "valid rows only" is not available yet.

## الشرح بالعربية

1. افتح الإعدادات > البيانات > الاستيراد. يظهر مربع «سياسة الرفع» تحت حدّ المعالجة في الخلفية. وتقود إليه أيقونة الترس في شاشات استيراد الماستر والدفعات والقوالب.
2. «فرض التسلسل» هو الافتراضي ولا يغيّر شيئاً: أقفال التسلسل لكل موقع هي التي تقرر كما كان.
3. «قبول البيانات الناقصة» يفتح مواقع ملف الماستر عند اعتماده، فتدخل البيانات بأي ترتيب. يتم الفتح بنفس مفتاح زر القفل في صفحة الموقع، فيحتاج صلاحية فتح القفل لكل منطقة في الملف وسبباً وإعادة تأكيد حديثة. ويُسجَّل لكل موقع صف في سجل التدقيق.
4. المهمة المعتمدة على موقع مفتوح رغم قفل كان سيمنعها تُعلَّم بعلامة «تجاوز المسؤول» كأي موقع مفتوح.
5. تعرض قائمة حالة الاستيراد لكل تشغيل أو دفعة ما ينقص كل موقع (مهمة بلا تاريخ فعلي بينما للمهمة التالية تاريخ، أو غياب سيناريو التسليم).
6. لا يغيّر السياسة إلا مسؤول النظام أو مفوَّض بتعديل الإعدادات لجميع المناطق. كل تغيير يحتاج سبباً ويُسجَّل بالقيمة القديمة والجديدة.

ما لا يتغير: لا صلاحية ولا دور ولا منحة. التحميل التاريخي يفتح مواقعه بنفسه ويتجاهل السياسة. المواقع التي ينشئها الاعتماد نفسه («إنشاء المواقع») تبقى مقفلة. وضع «الصفوف الصالحة فقط» غير متاح بعد.
