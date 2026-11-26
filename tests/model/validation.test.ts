import { describe, it, expect } from 'vitest';
import {
  requiredText,
  optionalText,
  intInRange,
  optionalEnum,
  optionalIsoDate,
  httpUrl,
  optionalHttpUrl,
  uuid,
} from '../../src/model/validation.js';
import { InvalidDataError } from '../../src/model/errors.js';

const bad = (fn: () => unknown) => expect(fn).toThrow(InvalidDataError);

describe('model/validation', () => {
  it('requiredText recorta y limita', () => {
    expect(requiredText('  hola ', 10)).toBe('hola');
    bad(() => requiredText('   ', 10));
    bad(() => requiredText('x'.repeat(11), 10));
    bad(() => requiredText(5, 10));
  });

  it('optionalText: vacío → null', () => {
    expect(optionalText(undefined, 5)).toBeNull();
    expect(optionalText(null, 5)).toBeNull();
    expect(optionalText('  ', 5)).toBeNull();
    expect(optionalText(' ab ', 5)).toBe('ab');
    bad(() => optionalText(1, 5));
  });

  it('intInRange', () => {
    expect(intInRange(2026, 2000, 2100)).toBe(2026);
    bad(() => intInRange(1.5, 0, 10));
    bad(() => intInRange('3', 0, 10));
    bad(() => intInRange(11, 0, 10));
  });

  it('optionalEnum', () => {
    expect(optionalEnum('a', ['a', 'b'] as const)).toBe('a');
    expect(optionalEnum(null, ['a'] as const)).toBeNull();
    bad(() => optionalEnum('c', ['a', 'b'] as const));
  });

  it('optionalIsoDate exige fecha real YYYY-MM-DD', () => {
    expect(optionalIsoDate('2024-02-29')).toBe('2024-02-29');
    bad(() => optionalIsoDate('2023-02-29'));
    bad(() => optionalIsoDate('2024-2-1'));
  });

  it('httpUrl solo acepta http(s) con dominio', () => {
    expect(httpUrl('https://github.com/ana/proyecto')).toBe('https://github.com/ana/proyecto');
    expect(httpUrl(' http://mi-web.dev ')).toBe('http://mi-web.dev');
    for (const u of ['javascript:alert(1)', 'ftp://x.com/a', 'https://localhost', 'no es url', '', 'data:text/html,hi']) {
      bad(() => httpUrl(u));
    }
    bad(() => httpUrl(`https://x.com/${'a'.repeat(2048)}`));
  });

  it('optionalHttpUrl: vacío → null', () => {
    expect(optionalHttpUrl('')).toBeNull();
    expect(optionalHttpUrl(null)).toBeNull();
    bad(() => optionalHttpUrl('javascript:x'));
  });

  it('uuid', () => {
    expect(uuid('00000000-0000-4000-8000-000000000001')).toBe('00000000-0000-4000-8000-000000000001');
    bad(() => uuid('no'));
  });
});
