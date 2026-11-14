import { describe, expect, it } from 'vitest';
import {
  buildZlibBookKey,
  classifyZlibError,
  explainZlibError,
  formatDomainLabel,
  formatZlibQuota,
  normalizeBookIdHash,
} from '../src/ebook/zlib-helpers';

describe('zlib-helpers', () => {
  it('normalizes id and hash without double-appending existing :hash', () => {
    expect(normalizeBookIdHash('17735211:25efe8', '25efe8')).toBe(
      '17735211:25efe8',
    );
    expect(normalizeBookIdHash('17735211:25efe8:25efe8', '25efe8')).toBe(
      '17735211:25efe8',
    );
    expect(normalizeBookIdHash('17735211', '25efe8')).toBe('17735211:25efe8');
    expect(normalizeBookIdHash(' 17735211 ', ' 25efe8 ')).toBe(
      '17735211:25efe8',
    );
  });

  it('builds unique list keys with normalized id:hash and index', () => {
    expect(buildZlibBookKey({ id: '17735211:25efe8', hash: '25efe8' }, 0)).toBe(
      '17735211:25efe8-0',
    );
  });

  it('classifies auth expiry distinctly from transient network failures', () => {
    expect(
      classifyZlibError('zlibrary: session expired or revoked, log in again'),
    ).toBe('auth_expired');
    expect(classifyZlibError('login was rejected')).toBe('auth_expired');
    expect(classifyZlibError('HTTP 401 UNAUTHORIZED')).toBe('auth_expired');

    expect(
      classifyZlibError(
        'Get "https://z-lib.gd/eapi/user/profile": Could Not Resolve Host',
      ),
    ).toBe('network');
    expect(classifyZlibError('连接节点 https://z-lib.gd 失败：timed out')).toBe(
      'network',
    );
    expect(classifyZlibError('context deadline exceeded (TIMEOUT)')).toBe(
      'network',
    );

    expect(
      classifyZlibError(
        'Error: failed to fetch book: zlibrary: EAPI book ID must use id:hash format',
      ),
    ).toBe('other');
  });

  it('produces actionable Chinese error messages while preserving context', () => {
    expect(
      explainZlibError('zlibrary: session expired or revoked, log in again'),
    ).toContain('重新登录');
    expect(explainZlibError('could not resolve host z-lib.gd')).toContain(
      '本地会话已保留',
    );
    expect(
      explainZlibError('zlibrary: EAPI book ID must use id:hash format'),
    ).toContain('重新搜索');
  });

  it('formats quota from CLI dailyRemaining/dailyAllowed and fallback fields', () => {
    expect(
      formatZlibQuota({
        email: 'a@b.com',
        name: 'user',
        downloadsToday: 2,
        downloadsLimit: 10,
        dailyRemaining: 8,
        dailyAllowed: 10,
        isLoggedIn: true,
        activeDomain: 'https://z-lib.gd',
      }),
    ).toBe('余 8/10');

    expect(
      formatZlibQuota({
        email: null,
        downloadsToday: 3,
        downloadsLimit: 10,
        isLoggedIn: true,
      }),
    ).toBe('余 7/10');
  });

  it('formats domain labels concisely', () => {
    expect(formatDomainLabel('https://z-lib.gd/')).toBe('z-lib.gd');
    expect(formatDomainLabel(null)).toBeNull();
  });
});
