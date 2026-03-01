// Pure validation logic — testable without HTTP
const VALID_ITEMS = ['biryani', 'khichuri', 'haleem', 'dates', 'juice'];
const MAX_ITEMS_PER_ORDER = 10;

function validateOrder(order) {
  const errors = [];

  if (!order || typeof order !== 'object') {
    return { valid: false, errors: ['Order must be an object'] };
  }

  if (!order.items || !Array.isArray(order.items) || order.items.length === 0) {
    errors.push('items must be a non-empty array');
  } else {
    for (const item of order.items) {
      if (!VALID_ITEMS.includes(item.itemId)) {
        errors.push(`Invalid itemId: ${item.itemId}`);
      }
      if (!item.quantity || item.quantity < 1 || !Number.isInteger(item.quantity)) {
        errors.push(`Invalid quantity for item ${item.itemId}: must be positive integer`);
      }
    }
    const totalItems = order.items.reduce((sum, i) => sum + (i.quantity || 0), 0);
    if (totalItems > MAX_ITEMS_PER_ORDER) {
      errors.push(`Cannot order more than ${MAX_ITEMS_PER_ORDER} items at once`);
    }
  }

  return { valid: errors.length === 0, errors };
}

module.exports = { validateOrder, VALID_ITEMS, MAX_ITEMS_PER_ORDER };
