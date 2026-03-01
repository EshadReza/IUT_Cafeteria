// Unit tests for stock deduction logic (without Redis)
const { validateStockDecrement, calculateNewStock } = require('./stockLogic');

describe('Stock Deduction Logic', () => {
  test('decrements stock correctly', () => {
    expect(calculateNewStock(100, 1)).toBe(99);
    expect(calculateNewStock(50, 5)).toBe(45);
  });

  test('throws when insufficient stock', () => {
    expect(() => validateStockDecrement(0, 1)).toThrow('Insufficient stock');
    expect(() => validateStockDecrement(2, 5)).toThrow('Insufficient stock');
  });

  test('validates quantity must be positive', () => {
    expect(() => validateStockDecrement(100, 0)).toThrow('Invalid quantity');
    expect(() => validateStockDecrement(100, -1)).toThrow('Invalid quantity');
  });

  test('succeeds when stock is exactly equal to demand', () => {
    expect(() => validateStockDecrement(5, 5)).not.toThrow();
    expect(calculateNewStock(5, 5)).toBe(0);
  });
});
