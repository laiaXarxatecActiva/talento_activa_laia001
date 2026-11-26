import { describe, it, expect } from 'vitest';
import { invitationEmail, createResendSender } from '../../src/model/email.js';

describe('model/email — invitationEmail', () => {
  it('incluye destinatario, asunto y el enlace en texto y HTML', () => {
    const link = 'http://localhost:3000/verificar?token=abc_DEF-123';
    const m = invitationEmail('ana@example.com', link);
    expect(m.to).toBe('ana@example.com');
    expect(m.subject).toMatch(/Xarxatec Activa/);
    expect(m.text).toContain(link);
    expect(m.html).toContain(`href="${link}"`);
  });

  it('escapa el HTML del enlace', () => {
    const m = invitationEmail('a@b.com', 'http://x/verificar?token=a"><script>');
    expect(m.html).not.toContain('<script>');
  });
});

describe('model/email — createResendSender', () => {
  it('hace POST a la API de Resend con la clave y el mensaje', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response('{"id":"1"}', { status: 200 });
    }) as unknown as typeof fetch;

    const sender = createResendSender({ apiKey: 're_test', from: 'App <no-reply@x.com>', fetch: fakeFetch });
    await sender.send({ to: 'ana@example.com', subject: 'Hola', text: 'texto', html: '<p>html</p>' });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.resend.com/emails');
    expect(calls[0]!.init.method).toBe('POST');
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.get('Authorization')).toBe('Bearer re_test');
    expect(headers.get('Content-Type')).toBe('application/json');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      from: 'App <no-reply@x.com>',
      to: ['ana@example.com'],
      subject: 'Hola',
      text: 'texto',
      html: '<p>html</p>',
    });
  });

  it('lanza si Resend responde con error', async () => {
    const fakeFetch = (async () => new Response('{"message":"bad"}', { status: 422 })) as unknown as typeof fetch;
    const sender = createResendSender({ apiKey: 're_test', from: 'a@x.com', fetch: fakeFetch });
    await expect(sender.send({ to: 'a@b.com', subject: 's', text: 't' })).rejects.toThrow(/422/);
  });
});
