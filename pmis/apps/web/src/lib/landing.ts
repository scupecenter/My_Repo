/** Where "/" goes: the Dashboard when it is the only module the user can open (Messages and Inbox are in every menu, so they do not count), else My Work. */
export function landingPath(nav: readonly string[] | null | undefined): string {
  const keys = nav ?? [];
  const others = keys.filter((k) => k !== 'dashboard' && k !== 'messages' && k !== 'inbox');
  return keys.includes('dashboard') && others.length === 0 ? '/dashboard' : '/my-work';
}
