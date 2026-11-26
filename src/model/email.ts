/** Mensaje de email transaccional. */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/** Puerto de envío de emails (Resend en producción, falso en tests). */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
