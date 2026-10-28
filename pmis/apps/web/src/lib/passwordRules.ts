/** The contract says `errors[]` "names the rule" without fixing the codes; map likely spellings to our message keys. */
export function ruleKey(code: string): string {
  const c = code.toLowerCase();
  if (/(^|_)(short|min|length)/.test(c)) return 'too_short';
  if (/long|max/.test(c)) return 'too_long';
  if (/current|same|reuse|equal/.test(c)) return 'same_as_current';
  if (/email/.test(c)) return 'contains_email';
  if (/employee|(^|_)id(_|$)/.test(c)) return 'contains_employee_id';
  if (/phone/.test(c)) return 'contains_phone';
  if (/common|list|breach|dictionary/.test(c)) return 'common_password';
  return 'weak';
}
