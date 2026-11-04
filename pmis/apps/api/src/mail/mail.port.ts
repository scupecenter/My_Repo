export interface MailMessage { to: string[]; subject: string; text: string; category: string }
export abstract class MailPort { abstract send(m: MailMessage): Promise<void> }
