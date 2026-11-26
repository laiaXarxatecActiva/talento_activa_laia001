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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
}

/** Email de invitación con el enlace para verificar y fijar la contraseña. */
export function invitationEmail(to: string, link: string): EmailMessage {
  const safe = escapeHtml(link);
  return {
    to,
    subject: 'Tu acceso a Xarxatec Activa',
    text:
      'Te han dado de alta en la plataforma de Xarxatec Activa.\n\n' +
      `Para activar tu cuenta y elegir tu contraseña, abre este enlace (caduca en 7 días):\n${link}\n\n` +
      'Si no esperabas este email, puedes ignorarlo.',
    html:
      '<p>Te han dado de alta en la plataforma de Xarxatec Activa.</p>' +
      `<p>Para activar tu cuenta y elegir tu contraseña, abre este enlace (caduca en 7 días):</p>` +
      `<p><a href="${safe}">${safe}</a></p>` +
      '<p>Si no esperabas este email, puedes ignorarlo.</p>',
  };
}

/** Envío real vía la API HTTP de Resend. */
export function createResendSender(opts: { apiKey: string; from: string; fetch?: typeof fetch }): EmailSender {
  const doFetch = opts.fetch ?? fetch;
  return {
    async send(m) {
      const res = await doFetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: `Bearer ${opts.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: opts.from, to: [m.to], subject: m.subject, text: m.text, html: m.html }),
      });
      if (!res.ok) throw new Error(`Resend respondió ${res.status}`);
    },
  };
}
