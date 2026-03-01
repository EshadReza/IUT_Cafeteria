const { validateOrder } = require('./orderValidation');

describe('Order Validation', () => {
  test('valid order passes', () => {
    const result = validateOrder({ items: [{ itemId: 'biryani', quantity: 2 }] });
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test('missing items fails', () => {
    const result = validateOrder({ items: [] });
    expect(result.valid).toBe(false);
  });

  test('invalid itemId fails', () => {
    const result = validateOrder({ items: [{ itemId: 'pizza', quantity: 1 }] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Invalid itemId'))).toBe(true);
  });

  test('zero quantity fails', () => {
    const result = validateOrder({ items: [{ itemId: 'biryani', quantity: 0 }] });
    expect(result.valid).toBe(false);
  });

  test('exceeding max items fails', () => {
    const result = validateOrder({ items: [{ itemId: 'biryani', quantity: 11 }] });
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('Cannot order more'))).toBe(true);
  });

  test('null order fails gracefully', () => {
    const result = validateOrder(null);
    expect(result.valid).toBe(false);
  });

  test('multiple valid items pass', () => {
    const result = validateOrder({
      items: [
        { itemId: 'biryani', quantity: 2 },
        { itemId: 'juice', quantity: 1 },
      ]
    });
    expect(result.valid).toBe(true);
  });
});
