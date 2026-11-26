import type { TransactionSql } from 'postgres';
import { invitationEmail } from '../model/email.js';
import { EmailDeliveryError } from '../model/errors.js';
import { createVerificationToken } from '../model/verification.js';
import type { Deps } from './http.js';

/**
 * Crea un enlace de verificación y envía el email de invitación. Se llama
 * DENTRO de la transacción: si el envío falla, se deshace todo (502).
 */
export async function sendInvitation(
  tx: TransactionSql,
  deps: Pick<Deps, 'email' | 'appUrl'>,
  user: { id: string; email: string },
  actorId: string | null,
): Promise<void> {
  const token = await createVerificationToken(tx, user.id, actorId);
  const link = `${deps.appUrl.replace(/\/+$/, '')}/verificar?token=${token}`;
  try {
    await deps.email.send(invitationEmail(user.email, link));
  } catch (e) {
    console.error('Fallo al enviar email:', (e as Error).message);
    throw new EmailDeliveryError();
  }
}
