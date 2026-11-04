import { Injectable } from '@nestjs/common';
import { DbService } from '../db/db.service';
import { MailMessage, MailPort } from './mail.port';
import { MailService } from './mail.service';

/**
 * MailPort (P8: identity and profile mails) bound to the outbound mail service of P9: each recipient becomes one row of the mail outbox, written in
 * the request transaction so a rolled-back change sends nothing. The kind is `identity.<category>`; the email-change verification code is marked
 * sensitive (its subject is hidden in the outbox list and nothing of it reaches a log). Inside a request each row is written under a savepoint: a
 * refusal of the queue (a cap, a bad address) undoes only that row, and sendQuietly logs it without failing the request.
 */
@Injectable()
export class OutboxMail extends MailPort {
  constructor(
    private readonly mail: MailService,
    private readonly db: DbService,
  ) {
    super();
  }

  async send(m: MailMessage): Promise<void> {
    const msg = { kind: `identity.${m.category}`, subject: m.subject, text: m.text, sensitive: m.category === 'email_change_verification' };
    for (const to of m.to) {
      if (!this.db.inRequestTx) {
        await this.mail.sendToAddress(to, msg);
        continue;
      }
      await this.db.tx.$executeRaw`SAVEPOINT pmis_mail`;
      try {
        await this.mail.sendToAddress(to, msg);
        await this.db.tx.$executeRaw`RELEASE SAVEPOINT pmis_mail`;
      } catch (e) {
        await this.db.tx.$executeRaw`ROLLBACK TO SAVEPOINT pmis_mail`;
        throw e;
      }
    }
  }
}
