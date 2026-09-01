import { expect, test } from 'vitest';
import { qualflare } from '@qualflare/vitest';

test('a known user can log in', () => {
  qualflare.tag('smoke', 'auth');
  qualflare.parameter('username', 'ada@example.com');
  expect('ada@example.com').toContain('@');
});

test('an unknown user is rejected', () => {
  qualflare.tag('auth');
  expect(() => {
    throw new Error('invalid credentials');
  }).toThrow('invalid credentials');
});
