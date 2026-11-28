# Lessons learned suggested on a new Issue

While a new Issue is written, the form shows the approved Lessons Learned that may apply, under the form. It is a read-only hint.

- **What it reads.** Title, description and remark of the Issue being typed (the form waits until you stop typing, and needs at least 6 characters). Words under 3 letters and common English words are ignored.
- **What matches.** Approved, current lessons that share at least two different whole words with the text (one when the text has one usable word) in their title, lesson, description, recommendation or category. Words are matched as typed: no stemming and no translation, so an Arabic text finds Arabic lessons and an English text finds English ones.
- **Order.** More shared words, then closer text, then a lesson of the same site, then the newest. At most 5 are shown.
- **Rights.** Only lessons in the regions where you hold the Lessons Learned view right (the Responsibility matrix decides). Without that right the list is empty and the section does not appear.
- **What it does not do.** It stores nothing, links nothing and changes nothing in the Issue. A lesson opens in a new tab.
- **Where.** New Issue form only (not on a saved issue). `GET /registers/issues/lesson-suggestions`, database function `lessons_suggest` (migration 0765).
