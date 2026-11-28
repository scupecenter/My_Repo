# Field mode, phase 1 (EN / AR)

## English walkthrough

Field mode is a narrow screen (Work > Field mode) for site teams who lose signal. It is OFF by default.

1. A System Admin turns it on in Settings > Screens > Field mode. The same page sets four limits: hours a saved copy is kept (default 24), most waiting actions per device (50), largest photo (8 MB) and seconds between send attempts (60). Every save needs a reason and is audited.
2. While it is on, the menu shows Work > Field mode. Open it once with a connection: it saves your three task lists and the snags of the site you pick on this device.
3. Without a signal you can read the saved tasks and snags, take or choose a photo for a snag, and press Submit fix. Each action waits in a queue on this device and is sent when the connection returns. The queue shows what is waiting and what needs attention.
4. Sending follows the server's own rules. A photo is checked like any snag photo (format, shot type, date). A submit is sent only if the snag is still waiting for the fix; if somebody changed it meanwhile, the action is marked "needs attention" and nothing is overwritten. A failed action holds the later ones of the same snag.
5. Approval (L2) is never done offline. Approving or rejecting a fix stays online-only.
6. Signing out deletes the saved copy and the queue from the device. If actions are still waiting, you are asked first.

What is stored on the device: the app shell (never API data in the service worker), your task lists, snags and the queue, in a database named for your user. Turning the setting off removes the worker and its cache.

Limits to know: the server remembers an Idempotency-Key for 24 hours in memory; a restart forgets it, then a replayed photo can be stored twice, and the reviewer can withdraw the extra one. The session still ends after 8 hours idle or 12 hours in total; queued actions are kept and sent after you sign in again.

## الشرح بالعربية

وضع الميدان شاشة ضيقة (العمل > وضع الميدان) لفرق المواقع حين ينقطع الإشارة. وهو متوقف افتراضيًا.

1. يفعّله مدير النظام من الإعدادات > الشاشات > وضع الميدان. في الصفحة نفسها أربعة حدود: ساعات الاحتفاظ بالنسخة المحفوظة (24)، أقصى عدد إجراءات منتظرة للجهاز (50)، أكبر صورة (8 ميغابايت)، ثواني بين محاولات الإرسال (60). كل حفظ يحتاج سببًا ويُدقَّق.
2. أثناء التفعيل تظهر في القائمة «العمل > وضع الميدان». افتحها مرة واحدة باتصال لتُحفظ على الجهاز قوائم مهامك الثلاث وملاحظات الموقع الذي تختاره.
3. بلا إشارة يمكنك قراءة المهام والملاحظات المحفوظة والتقاط صورة لملاحظة أو اختيارها ثم «إرسال الإصلاح». كل إجراء ينتظر في طابور على الجهاز ويُرسل عند عودة الاتصال، والطابور يعرض ما ينتظر وما يحتاج انتباهًا.
4. الإرسال يتبع قواعد الخادم نفسها. تُفحص الصورة كأي صورة ملاحظة (الصيغة ونوع اللقطة والتاريخ). ولا يُرسل «إرسال الإصلاح» إلا إذا كانت الملاحظة ما تزال بانتظار الإصلاح؛ فإن غيّرها أحد في الأثناء يُعلَّم الإجراء «يحتاج انتباهًا» ولا يُكتب فوق شيء. والإجراء الفاشل يوقف اللاحقة له في الملاحظة نفسها.
5. الاعتماد (L2) لا يتم دون اتصال أبدًا. اعتماد الإصلاح أو رفضه يبقى عبر الاتصال فقط.
6. تسجيل الخروج يحذف النسخة المحفوظة والطابور من الجهاز، ويُسأل المستخدم أولًا إن بقيت إجراءات منتظرة.

ما يُخزَّن على الجهاز: هيكل التطبيق (دون بيانات الـ API في الـ service worker) وقوائم المهام والملاحظات والطابور في قاعدة باسم المستخدم. وإيقاف الإعداد يزيل الـ worker وذاكرته.

حدود يجب معرفتها: يحفظ الخادم مفتاح Idempotency-Key 24 ساعة في الذاكرة؛ وإعادة تشغيله تنسى المفاتيح فقد تُخزَّن صورة مُعادة مرتين ويستطيع المراجع سحب الزائدة. وتنتهي الجلسة بعد 8 ساعات خمول أو 12 ساعة إجمالًا؛ وتبقى الإجراءات المنتظرة وتُرسل بعد تسجيل الدخول من جديد.
