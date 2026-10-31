import { ArrowLeft, Send, SquarePen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useMe } from '@/api/hooks';
import { useMarkRead, useMessageContacts, useMessageThreads, useReply, useStartThread, useThread } from '@/api/msg';
import type { MessageItem, MessageThread, MessageThreadSummary, UserPickerItem } from '@/api/types';
import { errText, FormDialog } from '@/components/FormDialog';
import { PeoplePicker } from '@/components/PeoplePicker';
import { PersonTag } from '@/components/PersonTag';
import { fmtDateTime } from '@/lib/time';

const SUBJECT_MAX = 200, BODY_MAX = 5000;

function IdChip({ id }: { id?: string | null }) {
  return id ? <span className="mono rounded bg-card2 px-1 text-xs text-mute">{id}</span> : null;
}

function ThreadRow({ th, active }: { th: MessageThreadSummary; active: boolean }) {
  const { t, i18n } = useTranslation();
  return (
    <li>
      <Link to={`/messages/${th.id}`} data-testid={`thread-${th.id}`} aria-current={active ? 'true' : undefined} data-unread={th.unread ? 'true' : 'false'}
        className={`block border-b border-line p-3 hover:bg-hover ${active ? 'border-s-2 border-s-accent bg-sideOn' : ''}`}>
        <div className="flex items-center gap-2">
          {th.unread && <span data-testid={`thread-unread-${th.id}`} className="h-2 w-2 shrink-0 rounded-full bg-accent"><span className="sr-only">{t('messages.unread')}</span></span>}
          <span className={`min-w-0 flex-1 truncate ${th.unread ? 'font-bold' : 'font-semibold'}`} dir="auto" data-testid={`thread-subject-${th.id}`}>{th.subject}</span>
          <span className="shrink-0 text-xs text-mute">{fmtDateTime(th.last_message_at, i18n.language)}</span>
        </div>
        <div className="mt-0.5 flex items-center gap-1 text-sm text-mute"><span className="truncate">{th.other.display_name}</span><IdChip id={th.other.employee_id} /></div>
        {th.last_message_preview && <p className="mt-0.5 truncate text-sm text-mute" dir="auto" data-testid={`thread-preview-${th.id}`}>{th.last_message_preview}</p>}
      </Link>
    </li>
  );
}

function Bubble({ m, testid, label }: { m: MessageItem; testid: string; label?: string }) {
  const { i18n } = useTranslation();
  return (
    <article data-testid={testid} className="card p-3">
      <header className="mb-1 flex flex-wrap items-center gap-2 text-sm">
        <PersonTag name={m.author.display_name} employeeId={m.author.employee_id} />
        <span className="text-xs text-mute">{fmtDateTime(m.created_at, i18n.language)}</span>
        {label && <span className="chip bg-openBg text-openInk">{label}</span>}
      </header>
      {/* Plain text only: line breaks kept, nothing is rendered as HTML. */}
      <div className="whitespace-pre-wrap break-words" dir="auto" data-testid={`${testid}-body`}>{m.body}</div>
    </article>
  );
}

function ThreadView({ id }: { id: string }) {
  const { t } = useTranslation();
  const me = useMe(true);
  const q = useThread(id);
  const read = useMarkRead();
  const reply = useReply(id);
  const [body, setBody] = useState('');
  // Opening a thread marks it read, once per thread.
  const { mutate: markRead } = read;
  const loaded = q.data?.id;
  useEffect(() => { if (loaded) markRead(loaded); }, [loaded, markRead]);
  if (q.isError) return <p role="alert" data-testid="thread-missing" className="p-6 text-mute">{t('messages.missing')}</p>;
  const th: MessageThread | undefined = q.data;
  if (!th) return <p className="p-6 text-mute">{t('common.loading')}</p>;
  const replies = [...th.replies].sort((a, b) => b.created_at.localeCompare(a.created_at)); // newest first, whatever the order of arrival
  const author = { id: me.data?.user.id ?? '', display_name: me.data?.user.display_name ?? '', employee_id: me.data?.user.employee_id ?? null };
  const send = () => {
    const text = body.trim();
    if (!text) return;
    setBody('');
    reply.mutate({ body: text, author }, { onError: () => setBody(text) }); // the text comes back with the error
  };
  return (
    <div className="space-y-3 p-4" data-testid="thread-detail">
      <Link to="/messages" className="btn md:hidden" data-testid="thread-back"><ArrowLeft size={14} className="rtl:rotate-180" />{t('messages.back')}</Link>
      <div>
        <h2 className="text-xl font-bold" dir="auto" data-testid="thread-title">{th.subject}</h2>
        <p className="flex flex-wrap items-center gap-1 text-sm text-mute">{t('messages.between')} {th.participants.map((p, i) => <span key={p.id}>{i > 0 && <span className="me-1">·</span>}<PersonTag name={p.display_name} employeeId={p.employee_id} /></span>)}</p>
      </div>
      <Bubble m={th.original} testid="msg-original" label={t('messages.original')} />
      <div className="card p-3" data-testid="reply-box">
        <label htmlFor="reply-body" className="text-sm font-semibold">{t('messages.reply')}</label>
        <textarea id="reply-body" data-testid="reply-body" className="input mt-1 min-h-20" maxLength={BODY_MAX} placeholder={t('messages.reply_placeholder')} value={body} onChange={(e) => setBody(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); } }} />
        {reply.isError && <p role="alert" data-testid="reply-error" className="mt-1 text-lateInk">{errText(reply.error, t)}</p>}
        <div className="mt-2 flex justify-end"><button className="btn btn-accent" data-testid="reply-send" disabled={!body.trim() || reply.isPending} onClick={send}><Send size={14} className="rtl:-scale-x-100" />{t('messages.send')}</button></div>
      </div>
      <section aria-label={t('messages.replies')} data-testid="reply-list" className="space-y-2">
        <h3 className="text-sm font-semibold text-mute">{t('messages.replies_newest', { count: replies.length })}</h3>
        {replies.length === 0 && <p className="text-sm text-mute" data-testid="replies-empty">{t('messages.no_replies')}</p>}
        {replies.map((r) => <Bubble key={r.id} m={r} testid={`reply-${r.id}`} />)}
      </section>
    </div>
  );
}

export function NewMessageDialog({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const nav = useNavigate();
  const contacts = useMessageContacts();
  const start = useStartThread();
  const [to, setTo] = useState('');
  const [picked, setPicked] = useState<UserPickerItem[]>([]);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const c = contacts.data;
  const anyone = !!c?.can_message_anyone;
  const options = c ? [...(c.manager ? [{ ...c.manager, rel: 'manager' as const }] : []), ...c.reports.map((r) => ({ ...r, rel: 'report' as const }))] : [];
  // With a single contact (usually the direct manager) it is chosen already.
  const target = anyone ? picked[0]?.id : to || (options.length === 1 ? options[0]!.id : '');
  const none = !!c && !anyone && options.length === 0;
  return (
    <FormDialog open onClose={onClose} testid="new-message" withReason={false} title={t('messages.new')} submitLabel={t('messages.send')} busy={start.isPending} disabled={!target || !subject.trim() || !body.trim()}
      error={start.isError ? errText(start.error, t) : null}
      onSubmit={() => start.mutate({ to_user_id: target!, subject: subject.trim(), body }, { onSuccess: (th) => { onClose(); nav(`/messages/${th.id}`); } })}>
      {anyone ? (
        <div><span className="text-sm font-semibold">{t('messages.to')}</span><PeoplePicker id="new-message-picker" single value={picked} onChange={setPicked} /></div>
      ) : (
        <label className="block text-sm font-semibold">{t('messages.to')}
          <select className="input mt-1 font-normal" data-testid="new-message-to" value={target ?? ''} disabled={none} onChange={(e) => setTo(e.target.value)}>
            <option value="">{t('messages.choose')}</option>
            {options.map((o) => <option key={o.id} value={o.id} data-testid={`new-message-opt-${o.employee_id}`}>{o.display_name} ({o.employee_id}) — {t(o.rel === 'manager' ? 'messages.rel_manager' : 'messages.rel_report')}</option>)}
          </select>
        </label>
      )}
      {none && <p className="rounded-md bg-waitBg p-2 text-sm text-waitInk" data-testid="new-message-none">{t('messages.no_contacts')}</p>}
      <label className="block text-sm font-semibold">{t('messages.subject')}<input className="input mt-1 font-normal" data-testid="new-message-subject" maxLength={SUBJECT_MAX} value={subject} onChange={(e) => setSubject(e.target.value)} /></label>
      <label className="block text-sm font-semibold">{t('messages.body')}<textarea className="input mt-1 min-h-28 font-normal" data-testid="new-message-body" maxLength={BODY_MAX} value={body} onChange={(e) => setBody(e.target.value)} /></label>
    </FormDialog>
  );
}

/** Messages: my threads on one side, the open thread on the other (`/messages` and `/messages/:threadId`). */
export function Messages() {
  const { t } = useTranslation();
  const { threadId } = useParams();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [composing, setComposing] = useState(false);
  const list = useMessageThreads(unreadOnly);
  const items = list.data?.items ?? [];
  return (
    <div data-testid="page-messages">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h1 className="me-auto text-2xl font-bold">{t('nav.messages')}</h1>
        <button className="btn btn-accent" data-testid="messages-new" onClick={() => setComposing(true)}><SquarePen size={16} />{t('messages.new')}</button>
      </div>
      <div className="card grid min-h-[60vh] overflow-hidden md:grid-cols-[22rem_1fr]">
        <div className={`${threadId ? 'hidden md:block' : ''} border-e border-line`}>
          <div className="flex items-center gap-2 border-b border-line p-3">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" data-testid="messages-unread-only" checked={unreadOnly} onChange={(e) => setUnreadOnly(e.target.checked)} />{t('messages.unread_only')}</label>
            <span className="ms-auto text-xs text-mute" data-testid="messages-unread-total">{t('messages.unread_count', { count: list.data?.unread_total ?? 0 })}</span>
          </div>
          <ul data-testid="thread-list" aria-label={t('nav.messages')}>
            {items.map((th) => <ThreadRow key={th.id} th={th} active={th.id === threadId} />)}
          </ul>
          {list.isSuccess && !items.length && <p className="p-6 text-center text-mute" data-testid="threads-empty">{t(unreadOnly ? 'messages.empty_unread' : 'messages.empty')}</p>}
        </div>
        <div className={threadId ? '' : 'hidden md:block'}>
          {threadId ? <ThreadView key={threadId} id={threadId} /> : <p className="p-10 text-center text-mute" data-testid="thread-none">{t('messages.pick')}</p>}
        </div>
      </div>
      {composing && <NewMessageDialog onClose={() => setComposing(false)} />}
    </div>
  );
}
