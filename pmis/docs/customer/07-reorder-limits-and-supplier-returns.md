# Reorder limits and supplier returns (EN / AR)

## English walkthrough

1. Warehouse > Reorder limits: a System Admin (or a delegate of warehouse items edit) sets, per item, the level under which the item is flagged "Below reorder" and the quantity to reorder. Only the available stock counts; quarantined stock does not. Every save needs a reason and is audited. "Only items at or under the level" shows the ones to order.
2. Warehouse > Supplier returns: after stock leaves quarantine with the "returned to supplier" exit, record the return here (item in quarantine, quantity, supplier, reason). It gets a number (RMA-00001...). When the supplier answers, set Replaced, Credited or Rejected, then Close. A closed return does not change.
3. This page only tracks the return. It never changes stock: stock moves only through the existing quarantine exit, which L2 approves.
4. Who can: reading needs the Warehouse view; recording and moving a return needs the Warehouse create right; limits need the System Admin or a delegate of warehouse items edit.

## الشرح بالعربية

1. المستودع > حدود إعادة الطلب: يحدد مدير النظام (أو مفوَّض بتعديل أصناف المستودع) لكل صنف المستوى الذي يُعلَّم تحته "تحت حد إعادة الطلب" وكمية إعادة الطلب. يُحسب المخزون المتاح فقط دون المخزون في الحجر. كل حفظ يتطلب سببًا ويُسجَّل. خيار "الأصناف عند المستوى أو تحته" يعرض ما يجب طلبه.
2. المستودع > مرتجعات الموردين: بعد خروج المخزون من الحجر بخروج "مرتجع إلى المورد" سجّل المرتجع هنا (الصنف في الحجر والكمية والمورد والسبب). يأخذ رقمًا (RMA-00001...). عند رد المورد اضبط: استُبدل أو إشعار دائن أو رُفض، ثم أغلق. المرتجع المغلق لا يتغير.
3. هذه الصفحة تتبّع الإرجاع فقط ولا تغيّر المخزون أبدًا: المخزون يتحرك فقط عبر خروج الحجر الحالي الذي يعتمده المستوى الثاني.
4. الصلاحيات: القراءة تحتاج عرض المستودع، والتسجيل ونقل الحالة يحتاجان صلاحية الإنشاء في المستودع، والحدود تحتاج مدير النظام أو مفوَّضًا بتعديل أصناف المستودع.
