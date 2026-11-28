# Login card display settings (Item 13)

Item 13 (modern login card) was built by #270 (card, language and theme switch, show/hide password, caps-lock hint, remember id, animation, announcement, default locale, support links, logo from identity settings). This PR adds the missing admin control, render only:

- Show or hide: remember-my-ID box (hidden = the ID is not remembered), language switch, light/dark switch, help line.
- Welcome title and subtitle, English and Arabic (empty = built-in text).
- Settings > Screens > Login page, same guarded door (rights, reason, step-up, If-Match, audit). Migration 0658 replaces three functions additively; a PUT body without the new keys keeps the stored values.
- No change to authentication, limits, sessions or any security setting. Hide, never delete.
