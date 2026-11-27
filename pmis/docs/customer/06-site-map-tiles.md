# Site map on real map tiles (EN / AR)

## English walkthrough

The site map can draw real map tiles under the site pins. It is OFF by default, and the outline map stays until you turn it on.

1. The tiles come from your own server. The tile address is a path on this server, for example `/tiles/{z}/{x}/{y}.png`. Another website is not accepted, so no site or person is contacted by the map and nothing leaves your server.
2. Put the tiles on the server. For Libya, make an extract from OpenStreetMap data (for example with a tile renderer or a ready tile pack) as PNG files in folders `{z}/{x}/{y}.png`, and copy them to a folder such as `/srv/tiles`. Install with `TILES_DIR=/srv/tiles` so the web server serves `/tiles/`. Without `TILES_DIR` the installer adds nothing.
3. A System Admin opens Settings > Screens > Map, turns it on and sets the address, the smallest and largest zoom, the start position and zoom, and the credit line (the source of the map data, shown in the map corner). Every save needs a reason and is audited.
4. On Sites > Map a switch changes between the tiles and the outline map. Drag to move, use the wheel or the + and - buttons to zoom, arrow keys when the map has focus. A pin opens the same site drawer as before.
5. If the tiles cannot be loaded, the map shows a notice and the outline map is one click away. Respect the licence of the map data you use, and keep its credit line.

## الشرح بالعربية

يمكن لخريطة المواقع أن ترسم بلاطات خريطة حقيقية تحت دبابيس المواقع. الميزة متوقفة افتراضيًا وتبقى خريطة المخطط حتى تشغّلها.

1. البلاطات تأتي من خادمك أنت. عنوان البلاطات مسار على هذا الخادم مثل `/tiles/{z}/{x}/{y}.png`. لا يُقبل موقع آخر، فلا تتصل الخريطة بأي جهة ولا يخرج شيء من خادمك.
2. ضع البلاطات على الخادم. لليبيا اصنع مقتطفًا من بيانات OpenStreetMap بملفات PNG في مجلدات `{z}/{x}/{y}.png` وانسخها إلى مجلد مثل `/srv/tiles`. ثبّت مع `TILES_DIR=/srv/tiles` ليقدّم خادم الويب `/tiles/`. بدون `TILES_DIR` لا يضيف المثبّت شيئًا.
3. يفتح مدير النظام الإعدادات > الشاشات > الخريطة، يشغّلها ويحدد العنوان وأصغر وأكبر تكبير وموضع البداية وتكبيرها وسطر العزو (مصدر بيانات الخريطة، يظهر في زاوية الخريطة). كل حفظ يتطلب سببًا ويُسجَّل في المراجعة.
4. في المواقع > الخريطة مفتاح للتبديل بين البلاطات وخريطة المخطط. اسحب للتحريك واستخدم العجلة أو زرّي + و- للتكبير، والأسهم عند التركيز على الخريطة. يفتح الدبوس نفس درج الموقع.
5. إن تعذّر تحميل البلاطات تعرض الخريطة تنبيهًا وتبقى خريطة المخطط بنقرة واحدة. التزم برخصة بيانات الخريطة التي تستعملها واحتفظ بسطر العزو.
