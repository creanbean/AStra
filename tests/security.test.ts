import { describe, expect, it } from 'vitest';
import { assertPublicUrl, isPublicAddress } from '../server/security.js';

describe('browser destination guard', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.2.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '2001:db8::1'])('blocks private and reserved address %s', address => {
    expect(isPublicAddress(address)).toBe(false);
  });
  it.each(['1.1.1.1', '8.8.8.8', '2606:4700:4700::1111'])('accepts public address %s', address => {
    expect(isPublicAddress(address)).toBe(true);
  });
  it.each(['http://localhost', 'http://127.0.0.1', 'http://2130706433', 'http://[::1]', 'file:///etc/passwd', 'http://user:password@example.com'])('blocks unsafe URL %s', async url => {
    await expect(assertPublicUrl(url)).rejects.toThrow();
  });
});
