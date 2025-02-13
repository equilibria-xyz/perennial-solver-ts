export interface OrderBook {
    long: { price: number; quantity: number }[];
    short: { price: number; quantity: number }[];
  }
  
  export function generateSolverBook(
    oraclePrice: number,
    skew: number,
    scale: number,
    linearFee: number,
    proportionalFee: number,
    adiabaticFee: number,
    maxDepth: number
  ): OrderBook {
    const solverBook: OrderBook = { long: [], short: [] };
  
    for (let depth = 1; depth <= maxDepth; depth++) {
      const orderSkew = depth / scale;
  
      // Compute long side pricing and quantity
      const longSpread =
        linearFee +
        proportionalFee * orderSkew +
        adiabaticFee * (2 * skew + orderSkew);
      const longQuantity =
        (2 * (adiabaticFee * skew + linearFee - longSpread)) /
        (adiabaticFee + 2 * proportionalFee);
      const longPrice = oraclePrice + longSpread / depth;
  
      // Compute short side pricing and quantity
      const shortSpread =
        linearFee +
        proportionalFee * orderSkew -
        adiabaticFee * (2 * skew - orderSkew);
      const shortQuantity =
        (2 * (adiabaticFee * skew - linearFee + shortSpread)) /
        (adiabaticFee - 2 * proportionalFee);
      const shortPrice = oraclePrice - shortSpread / depth;
  
      solverBook.long.push({ price: longPrice, quantity: longQuantity });
      solverBook.short.push({ price: shortPrice, quantity: shortQuantity });
    }
  
    return solverBook;
  }
  