import { Injectable, Logger } from '@nestjs/common';
import { MailMessage, MailPort } from './mail.port';

/**
 * Placeholder of the outbound mail service (work package P9). It sends nothing; P8 calls MailPort only, and the binding is switched to
 * P9's real service at merge. Tests spy on it (`app.get(MailPort)`).
 */
@Injectable()
export class NoopMail extends MailPort {
  private readonly log = new Logger('Mail');

  async send(m: MailMessage): Promise<void> {
    this.log.debug(`mail not sent (no mail service yet): ${m.category} to ${m.to.length} recipient(s)`);
  }
}

/** Sends without ever failing the caller: a mail outage must not undo the request, and never drops a check (Q158). */
export async function sendQuietly(mail: MailPort, m: MailMessage, onError: (e: unknown) => Promise<void> | void): Promise<boolean> {
  const to = [...new Set(m.to.filter((x) => typeof x === 'string' && x.includes('@')))];
  if (to.length === 0) return false;
  try {
    await mail.send({ ...m, to });
    return true;
  } catch (e) {
    await onError(e);
    return false;
  }
}
