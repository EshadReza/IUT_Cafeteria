function validateStockDecrement(currentStock, quantity) {
  if (quantity <= 0) throw new Error('Invalid quantity');
  if (currentStock < quantity) throw new Error('Insufficient stock');
}

function calculateNewStock(currentStock, quantity) {
  validateStockDecrement(currentStock, quantity);
  return currentStock - quantity;
}

module.exports = { validateStockDecrement, calculateNewStock };
