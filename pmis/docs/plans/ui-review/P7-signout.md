# P7: Sign out moves into the user menu
The top bar no longer has a separate Sign-out icon. The account chip (`topbar-user`) opens the user menu: My profile, Appearance, Change password, Sign out (`user-menu-signout`, icon plus text, last entry, separated by a rule). Same logout call, same redirect to /login. e2e specs use `signOutViaMenu(page)` from `e2e/helpers.ts`.
