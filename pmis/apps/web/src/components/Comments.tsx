import { Check, MessageSquare, ThumbsUp } from 'lucide-react';
import { UnsavedGuard } from '@/lib/unsavedGuard';
import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { usePicker } from '@/api/admin';
import type { Comment, UserPickerItem } from '@/api/types';
import { insertMention, mentionQuery, mentionTokens, splitMentions } from '@/lib/x';
import { DictateButton } from './DictateButton';

/** The text of a comment with each `@1234` token shown as a chip. */
export function CommentBody({ text }: { text: string }) {
  return <>{splitMentions(text).map((p, i) => (p.token ? <span key={i} className="chip mono mx-0.5 bg-openBg text-openInk" data-testid="mention-token">{p.text}</span> : <span key={i}>{p.text}</span>))}</>;
}

/**
 * X3: the box of a comment with @mentions. Typing `@` and two letters offers registered people; picking one writes their `@<employee id>` token, which the server
 * resolves like `mention_user_ids`. The server notifies and names only the people who can read the item, and says nothing about anyone else, so the list of names
 * under a saved comment is the truth about who was reached.
 */
export function MentionBox({ onSend, pending, label }: { onSend: (body: string, mentionIds: string[]) => void; pending: boolean; label: string }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<UserPickerItem[]>([]);
  const q = mentionQuery(text);
  const found = usePicker(q ?? '');
  const options = q !== null && q.length >= 2 ? (found.data ?? []).filter((u) => !!u.employee_id).slice(0, 6) : [];
  const choose = (u: UserPickerItem) => { setText((x) => insertMention(x, u.employee_id ?? '')); setPicked((p) => (p.some((x) => x.id === u.id) ? p : [...p, u])); };
  const send = () => {
    const ids = picked.filter((u) => mentionTokens(text).includes(u.employee_id ?? '')).map((u) => u.id);
    onSend(text.trim(), ids);
    setText('');
    setPicked([]);
  };
  return (
    <div className="relative mt-2">
      <UnsavedGuard scope="composers" dirty={!!text.trim()} label={t('ui.guard_comment')} onSave={() => { send(); return true; }} />
      <div className="flex gap-2">
        <input className="input" data-testid="comment-input" aria-label={label} aria-autocomplete="list" aria-expanded={options.length > 0} placeholder={t('mention.placeholder')} value={text}
          onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape' && options.length) { e.stopPropagation(); setText((x) => x.replace(/@[^\s@()]*$/, '')); } }} />
        {/* Item 14 widened: voice capture on the comment box of every record screen (tasks and register records share this box). Renders nothing without speech recognition. */}
        <DictateButton testid="comment-dictate" onText={(said) => setText((cur) => (cur.trim() ? `${cur.trim()} ${said}` : said))} />
        <button className="btn" data-testid="comment-send" disabled={!text.trim() || pending} onClick={send}>{t('drawer.send')}</button>
      </div>
      {options.length > 0 && (
        <ul role="listbox" aria-label={t('mention.people')} data-testid="mention-list" className="card absolute inset-x-0 z-10 mt-1 max-h-48 overflow-y-auto p-1">
          {options.map((u) => (
            <li key={u.id}>
              <button type="button" role="option" aria-selected={false} data-testid={`mention-opt-${u.employee_id}`} className="flex w-full items-center justify-between gap-2 rounded px-2 py-1.5 text-start text-sm hover:bg-hover" onClick={() => choose(u)}>
                <span>{u.display_name}</span><span className="mono text-xs text-mute">@{u.employee_id}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-1 text-xs text-mute">{t('mention.hint')}</p>
    </div>
  );
}

/**
 * A comment thread (task or register record): the list, the people each comment reached, and the box. The parent invalidates its own query after a send.
 * PM item 18 (0.15.247): each comment carries a 👍 "acknowledged" toggle and can be marked resolved; the parent passes the two handlers and
 * invalidates its own query after each toggle.
 */
export function CommentsPanel({ items, loaded, pending, onSend, onReact, onToggleResolved, error, heading }: {
  items: Comment[] | undefined; loaded: boolean; pending: boolean; onSend: (body: string, mentionIds: string[]) => void;
  onReact?: (commentId: string, emoji: string, on: boolean) => void; onToggleResolved?: (commentId: string, resolved: boolean) => void;
  error?: ReactNode; heading?: string;
}) {
  const { t } = useTranslation();
  return (
    <section aria-labelledby="dr-comments">
      <h3 id="dr-comments" className="mb-1 flex items-center gap-1 font-semibold"><MessageSquare size={14} />{heading ?? t('drawer.comments')}</h3>
      <ul data-testid="comment-list" className="space-y-1 text-sm">
        {items?.map((x) => {
          const ack = x.reactions?.find((r) => r.emoji === '👍');
          return (
            <li key={x.id} className={`rounded-md p-2 ${x.is_rejection_note ? 'bg-lateBg text-lateInk' : 'bg-card2'}`}>
              <b>{x.author.display_name}</b> · <CommentBody text={x.body} />
              {!!x.mentions?.length && <p className="mt-1 text-xs text-mute" data-testid="comment-mentions">{t('mention.reached')}: {x.mentions.map((m) => m.display_name).join(', ')}</p>}
              {(onReact || onToggleResolved) && (
                <div className="mt-1 flex flex-wrap items-center gap-2 text-xs" data-testid={`comment-actions-${x.id}`}>
                  {onReact && (
                    <button type="button" aria-pressed={!!ack?.mine} title={ack?.mine ? t('comment.react_ack') : t('comment.react')} data-testid={`comment-react-${x.id}`}
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 ${ack?.mine ? 'border-openInk bg-openBg text-openInk' : 'border-line text-mute hover:bg-hover'}`}
                      onClick={() => onReact(x.id, '👍', !ack?.mine)}>
                      <ThumbsUp size={12} aria-hidden />{t('comment.react_ack')}{ack?.count ? <span className="font-semibold" data-testid={`comment-react-count-${x.id}`}>{ack.count}</span> : null}
                    </button>
                  )}
                  {onToggleResolved && (x.resolved ? (
                    <>
                      <span className="chip inline-flex items-center gap-1 bg-doneBg text-doneInk" data-testid={`comment-resolved-${x.id}`}><Check size={12} aria-hidden />{t('comment.resolved')} · {x.resolved.by.display_name}</span>
                      <button type="button" className="text-mute underline hover:bg-hover" data-testid={`comment-reopen-${x.id}`} onClick={() => onToggleResolved(x.id, false)}>{t('comment.reopen')}</button>
                    </>
                  ) : (
                    <button type="button" className="text-mute underline hover:bg-hover" data-testid={`comment-resolve-${x.id}`} onClick={() => onToggleResolved(x.id, true)}>{t('comment.resolve')}</button>
                  ))}
                </div>
              )}
            </li>
          );
        })}
        {loaded && !items?.length && <li className="text-mute">{t('drawer.no_comments')}</li>}
      </ul>
      {error && <p role="alert" className="mt-1 text-sm text-lateInk" data-testid="comment-error">{error}</p>}
      <MentionBox label={t('drawer.comment_label')} pending={pending} onSend={onSend} />
    </section>
  );
}
