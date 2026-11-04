import { AddressInfo, Server, Socket, createServer } from 'node:net';

/** One mail the fake server accepted. */
export interface Received {
  from: string;
  to: string[];
  data: string;
  auth: string | null;
  /** The decoded text body (base64 part). */
  text: string;
  subject: string;
  headers: Record<string, string>;
}

export interface FakeSmtpOptions {
  /** Offer STARTTLS in the EHLO answer (the fake never upgrades; it is used to test the client's refusal to go without it). */
  starttls?: boolean;
  /** Answer STARTTLS with 220 and, in the same write, a forged plain-text reply (the STARTTLS response injection the client must refuse). */
  starttlsInject?: boolean;
  /** Reply code for RCPT TO (250 accepts; 451 is a temporary failure, 550 a permanent one). */
  rcptCode?: () => number;
  /** Required AUTH PLAIN credentials; others get 535. */
  user?: string;
  pass?: string;
}

const decodeWord = (v: string): string =>
  v.replace(/=\?UTF-8\?B\?([^?]+)\?=\s*/gi, (_m, b: string) => Buffer.from(b, 'base64').toString('utf8')).replace(/\r\n /g, '');

/**
 * A minimal SMTP server for the tests (no TLS): EHLO, AUTH PLAIN and LOGIN, MAIL, RCPT, DATA, RSET, QUIT. It records what it receives and never
 * leaves the loopback interface.
 */
export class FakeSmtp {
  readonly received: Received[] = [];
  readonly commands: string[] = [];
  private server: Server;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly opts: FakeSmtpOptions = {}) {
    this.server = createServer((s) => this.session(s));
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  listen(): Promise<void> {
    return new Promise((r) => this.server.listen(0, '127.0.0.1', () => r()));
  }

  close(): Promise<void> {
    for (const s of this.sockets) s.destroy();
    return new Promise((r) => this.server.close(() => r()));
  }

  private session(s: Socket): void {
    this.sockets.add(s);
    s.on('close', () => this.sockets.delete(s));
    s.on('error', () => undefined);
    let buf = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    let auth: string | null = null;
    let loginStep = 0;
    let loginUser = '';
    const say = (l: string): void => {
      s.write(`${l}\r\n`);
    };
    say('220 fake.smtp.test ESMTP ready');
    s.on('data', (d) => {
      buf += d.toString('latin1');
      let i: number;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            const raw = Buffer.from(data, 'latin1').toString('utf8');
            const [head, ...rest] = raw.split('\r\n\r\n');
            const headers: Record<string, string> = {};
            for (const h of (head ?? '').replace(/\r\n /g, ' ').split('\r\n')) {
              const k = h.indexOf(':');
              if (k > 0) headers[h.slice(0, k).toLowerCase()] = h.slice(k + 1).trim();
            }
            const text = Buffer.from(rest.join('\r\n\r\n').replace(/\r\n/g, ''), 'base64').toString('utf8');
            this.received.push({ from, to, data: raw, auth, text, subject: decodeWord(headers.subject ?? ''), headers });
            say('250 2.0.0 queued');
            data = '';
          } else data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          continue;
        }
        if (loginStep === 1) {
          loginUser = Buffer.from(line, 'base64').toString('utf8');
          loginStep = 2;
          say('334 UGFzc3dvcmQ6');
          continue;
        }
        if (loginStep === 2) {
          loginStep = 0;
          const pass = Buffer.from(line, 'base64').toString('utf8');
          if (this.opts.user && (loginUser !== this.opts.user || pass !== this.opts.pass)) say('535 5.7.8 bad credentials');
          else {
            auth = `LOGIN ${loginUser}`;
            say('235 2.7.0 ok');
          }
          continue;
        }
        const cmd = line.split(' ')[0]?.toUpperCase() ?? '';
        this.commands.push(cmd === 'AUTH' ? 'AUTH' : line);
        if (cmd === 'EHLO' || cmd === 'HELO') {
          say('250-fake.smtp.test');
          if (this.opts.starttls) say('250-STARTTLS');
          say('250-AUTH PLAIN LOGIN');
          say('250 8BITMIME');
        } else if (cmd === 'AUTH') {
          const parts = line.split(' ');
          if ((parts[1] ?? '').toUpperCase() === 'LOGIN') {
            loginStep = 1;
            say('334 VXNlcm5hbWU6');
          } else {
            const dec = Buffer.from(parts[2] ?? '', 'base64').toString('utf8').split('\0');
            if (this.opts.user && (dec[1] !== this.opts.user || dec[2] !== this.opts.pass)) say('535 5.7.8 bad credentials');
            else {
              auth = `PLAIN ${dec[1] ?? ''}`;
              say('235 2.7.0 ok');
            }
          }
        } else if (cmd === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          say('250 2.1.0 ok');
        } else if (cmd === 'RCPT') {
          const code = this.opts.rcptCode?.() ?? 250;
          if (code === 250) to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          say(code === 250 ? '250 2.1.5 ok' : code === 451 ? '451 4.3.0 try later' : '550 5.1.1 no such user');
        } else if (cmd === 'DATA') {
          inData = true;
          say('354 go ahead');
        } else if (cmd === 'RSET' || cmd === 'NOOP') say('250 ok');
        else if (cmd === 'STARTTLS' && this.opts.starttlsInject) s.write('220 2.0.0 go ahead\r\n250-injected\r\n250 AUTH PLAIN\r\n');
        else if (cmd === 'STARTTLS') say('454 4.7.0 TLS not available in the fake');
        else if (cmd === 'QUIT') {
          say('221 bye');
          s.end();
        } else say('502 5.5.2 unknown command');
      }
    });
  }
}
