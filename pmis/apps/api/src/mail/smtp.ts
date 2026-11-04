import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Socket, connect as netConnect } from 'node:net';
import { TLSSocket, connect as tlsConnect } from 'node:tls';
import type { MailConfig } from '../config/config';

/**
 * A small SMTP client for the internal relay (RFC 5321, ESMTP; STARTTLS RFC 3207; AUTH PLAIN and LOGIN RFC 4954). One message per connection,
 * one recipient. No dependency: the API sends a few mails an hour.
 *
 * - With `tls: 'starttls'` the upgrade is required: a server that does not offer STARTTLS is refused (no silent downgrade).
 * - The password goes only into the AUTH exchange. Errors never quote a command line, only its verb and the server's reply (cut to 200 characters).
 * - Header values are checked for line breaks before anything is sent; the body is UTF-8 in base64, so a line never starts with a dot.
 */

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
  /** X-PMIS-Kind header (the outbox kind). */
  kind?: string;
  /** Message-ID without the angle brackets; generated when absent. */
  messageId?: string;
}

export class SmtpError extends Error {
  constructor(message: string, readonly code: number | null, readonly permanent: boolean) {
    super(message);
    this.name = 'SmtpError';
  }
}

const NO_BREAK = /[\r\n\0]/;

/** RFC 2047 encoded-word(s) for a header value that is not plain ASCII; chunks end on whole UTF-8 characters. */
export function encodeHeader(v: string): string {
  if (NO_BREAK.test(v)) throw new SmtpError('header value with a line break', null, true);
  if (/^[\x20-\x7e]*$/.test(v)) return v;
  const words: string[] = [];
  let cur = '';
  for (const ch of v) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 45) {
      words.push(cur);
      cur = '';
    }
    cur += ch;
  }
  if (cur) words.push(cur);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ');
}

function fromHeader(h: string): string {
  const m = /^(.*?)\s*<([^<>]+)>$/.exec(h);
  if (!m) return h;
  const name = m[1] as string;
  return `${/^[\x20-\x7e]*$/.test(name) ? `"${name.replace(/["\\]/g, '')}"` : encodeHeader(name)} <${m[2] as string}>`;
}

/** The message as sent after DATA (CRLF line ends, without the final dot). */
export function buildMessage(cfg: Pick<MailConfig, 'fromHeader' | 'fromAddress'>, m: OutgoingMail, date = new Date()): { data: string; messageId: string } {
  for (const v of [m.to, m.subject, m.kind ?? '', cfg.fromHeader]) if (NO_BREAK.test(v)) throw new SmtpError('header value with a line break', null, true);
  const domain = cfg.fromAddress.split('@')[1] ?? 'localhost';
  const messageId = m.messageId ?? `${randomUUID()}@${domain}`;
  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n');
  const headers = [
    `From: ${fromHeader(cfg.fromHeader)}`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeader(m.subject)}`,
    `Date: ${date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${messageId}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'Auto-Submitted: auto-generated',
    ...(m.kind ? [`X-PMIS-Kind: ${m.kind}`] : []),
  ];
  return { data: `${headers.join('\r\n')}\r\n\r\n${body}`, messageId };
}

interface Reply {
  code: number;
  lines: string[];
}

/** Reads SMTP replies (multi-line: "250-..." until "250 ...") from a socket that may be replaced by its TLS upgrade. */
class Conversation {
  private buf = '';
  private waiting: { resolve: (r: Reply) => void; reject: (e: Error) => void } | null = null;
  private pending: Reply[] = [];
  private lines: string[] = [];
  private failure: Error | null = null;

  constructor(public sock: Socket | TLSSocket, private readonly timeoutMs: number) {
    this.attach(sock);
  }

  attach(sock: Socket | TLSSocket): void {
    this.sock = sock;
    sock.setTimeout(this.timeoutMs);
    sock.on('data', (d: Buffer) => this.onData(d.toString('latin1')));
    sock.on('timeout', () => this.fail(new SmtpError('the mail server did not answer in time', null, false)));
    sock.on('error', (e) => this.fail(new SmtpError(`connection error: ${e.message.slice(0, 200)}`, null, false)));
    sock.on('close', () => this.fail(new SmtpError('the mail server closed the connection', null, false)));
  }

  /**
   * Anything the server sent after its 220 reply to STARTTLS arrived in
   * plain text and must never be read as a reply inside TLS (STARTTLS response injection): the connection is refused instead.
   * Called right after the 220 reply to STARTTLS, before detach.
   */
  assertNoBufferedData(): void {
    if (this.buf.length > 0 || this.pending.length > 0 || this.lines.length > 0) {
      this.buf = '';
      this.pending = [];
      this.lines = [];
      throw new SmtpError('the mail server sent data after its STARTTLS reply; refused (possible injection)', null, false);
    }
  }

  /** Removes the listeners and clears the read state. Never throws: it is also the cleanup path. */
  detach(): void {
    this.buf = '';
    this.pending = [];
    this.lines = [];
    this.sock.removeAllListeners('data');
    this.sock.removeAllListeners('timeout');
    this.sock.removeAllListeners('error');
    this.sock.removeAllListeners('close');
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    if (this.waiting) {
      this.waiting.reject(e);
      this.waiting = null;
    }
  }

  private onData(s: string): void {
    this.buf += s;
    if (this.buf.length > 64_000) return this.fail(new SmtpError('reply too long', null, false));
    let i: number;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      const m = /^(\d{3})([ -])(.*)$/.exec(line);
      if (!m) return this.fail(new SmtpError('not an SMTP reply', null, false));
      this.lines.push(m[3] as string);
      if (m[2] === ' ') {
        const r = { code: Number(m[1]), lines: this.lines };
        this.lines = [];
        if (this.waiting) {
          this.waiting.resolve(r);
          this.waiting = null;
        } else this.pending.push(r);
      }
    }
  }

  read(): Promise<Reply> {
    const r = this.pending.shift();
    if (r) return Promise.resolve(r);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      this.waiting = { resolve, reject };
    });
  }

  write(s: string): void {
    this.sock.write(s, 'latin1');
  }

  /** Sends one command and checks the reply code. `verb` is what an error names (never the line itself: it may hold a credential). */
  async cmd(line: string, ok: number[], verb: string): Promise<Reply> {
    this.write(`${line}\r\n`);
    return this.expect(ok, verb);
  }

  async expect(ok: number[], verb: string): Promise<Reply> {
    const r = await this.read();
    if (!ok.includes(r.code)) {
      const text = r.lines.join(' ').replace(/[^\x20-\x7e]/g, '?').slice(0, 200);
      throw new SmtpError(`${verb} refused: ${r.code} ${text}`, r.code, r.code >= 500);
    }
    return r;
  }
}

function open(cfg: MailConfig, ca: Buffer | undefined): Promise<Socket | TLSSocket> {
  return new Promise((resolve, reject) => {
    const onErr = (e: Error): void => reject(new SmtpError(`cannot connect to ${cfg.host}:${cfg.port}: ${e.message.slice(0, 200)}`, null, false));
    const s: Socket | TLSSocket = cfg.tls === 'tls'
      ? tlsConnect({ host: cfg.host, port: cfg.port, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized, ca, timeout: cfg.timeoutMs }, () => {
        s.off('error', onErr);
        resolve(s);
      })
      : netConnect({ host: cfg.host, port: cfg.port, timeout: cfg.timeoutMs }, () => {
        s.off('error', onErr);
        resolve(s);
      });
    s.once('error', onErr);
    s.once('timeout', () => {
      s.destroy();
      reject(new SmtpError(`cannot connect to ${cfg.host}:${cfg.port}: timeout`, null, false));
    });
  });
}

function upgrade(sock: Socket, cfg: MailConfig, ca: Buffer | undefined): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    const t = tlsConnect({ socket: sock, servername: cfg.host, rejectUnauthorized: cfg.rejectUnauthorized, ca }, () => {
      t.off('error', onErr);
      resolve(t);
    });
    const onErr = (e: Error): void => reject(new SmtpError(`STARTTLS failed: ${e.message.slice(0, 200)}`, null, false));
    t.once('error', onErr);
  });
}

const ehloCaps = (r: Reply): Set<string> => new Set(r.lines.slice(1).map((l) => l.toUpperCase()));

/** Sends one mail. Resolves with the Message-ID; rejects with SmtpError (`permanent` for a 5xx refusal, which is not retried). */
export async function smtpSend(cfg: MailConfig, m: OutgoingMail): Promise<{ messageId: string }> {
  if (!cfg.enabled) throw new SmtpError('SMTP is not configured', null, true);
  const { data, messageId } = buildMessage(cfg, m);
  if (NO_BREAK.test(m.to) || !/^[^\s<>@]+@[^\s<>@]+$/.test(m.to)) throw new SmtpError('not a valid recipient', null, true);
  const ca = cfg.caFile ? readFileSync(cfg.caFile) : undefined;
  const sock = await open(cfg, ca);
  const c = new Conversation(sock, cfg.timeoutMs);
  try {
    await c.expect([220], 'greeting');
    let caps = ehloCaps(await c.cmd(`EHLO ${cfg.heloName}`, [250], 'EHLO'));
    if (cfg.tls === 'starttls') {
      if (!caps.has('STARTTLS')) throw new SmtpError('the mail server does not offer STARTTLS (set SMTP_TLS=tls or fix the relay; no downgrade)', null, true);
      await c.cmd('STARTTLS', [220], 'STARTTLS');
      c.assertNoBufferedData();
      c.detach();
      const t = await upgrade(c.sock as Socket, cfg, ca);
      c.attach(t);
      caps = ehloCaps(await c.cmd(`EHLO ${cfg.heloName}`, [250], 'EHLO'));
    }
    if (cfg.user && cfg.pass !== undefined) {
      const auth = [...caps].find((x) => x.startsWith('AUTH')) ?? '';
      if (/\bPLAIN\b/.test(auth) || !/\bLOGIN\b/.test(auth)) {
        await c.cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`, 'utf8').toString('base64')}`, [235], 'AUTH');
      } else {
        await c.cmd('AUTH LOGIN', [334], 'AUTH');
        await c.cmd(Buffer.from(cfg.user, 'utf8').toString('base64'), [334], 'AUTH');
        await c.cmd(Buffer.from(cfg.pass, 'utf8').toString('base64'), [235], 'AUTH');
      }
    }
    await c.cmd(`MAIL FROM:<${cfg.fromAddress}>`, [250], 'MAIL FROM');
    await c.cmd(`RCPT TO:<${m.to}>`, [250, 251], 'RCPT TO');
    await c.cmd('DATA', [354], 'DATA');
    // dot-stuffing (RFC 5321 4.5.2); base64 lines never start with a dot, the headers are checked above
    const stuffed = data.replace(/(^|\r\n)\./g, '$1..');
    c.write(Buffer.from(`${stuffed}\r\n.\r\n`, 'utf8').toString('latin1'));
    await c.expect([250], 'message');
    try {
      await c.cmd('QUIT', [221], 'QUIT');
    } catch {
      /* the mail is accepted; the goodbye does not matter */
    }
    return { messageId };
  } finally {
    try {
      c.detach();
    } finally {
      c.sock.destroy();
    }
  }
}
