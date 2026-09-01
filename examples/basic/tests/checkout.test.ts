import { expect, test } from 'vitest';
import { qualflare } from '@qualflare/vitest';

test('a customer can check out', async () => {
  qualflare.label('epic', 'Billing');
  qualflare.label('owner', 'payments-team');
  qualflare.link('https://tracker.example/QF-42', { type: 'issue', name: 'QF-42' });
  qualflare.priority('high');
  qualflare.description('Covers the happy path from cart to receipt.');

  await qualflare.step('add an item to the cart', () => {
    qualflare.parameter('sku', 'WIDGET-1');
    expect(1).toBe(1);
  });

  await qualflare.step('pay', async () => {
    qualflare.parameter('amount', '42.00');
    await qualflare.step('authorize the card', () => {
      expect(true).toBe(true);
    });
  });
});
