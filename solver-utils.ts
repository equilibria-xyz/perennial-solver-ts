export interface OrderBook {
    long: { price: bigint; quantity: bigint }[];
    short: { price: bigint; quantity: bigint }[];
}

  function getAbsoluteValue(val: bigint): bigint {
    return val < 0 ? -val : val
  }
  
  export function generateSolverBook(
    oraclePrice: bigint,
    skew: bigint,
    scale: bigint,
    linearFee: bigint,
    proportionalFee: bigint,
    adiabaticFee: bigint,
    maxDepth: number
  ): OrderBook {
    const solverBook: OrderBook = { long: [], short: [] };
  
    for (let depth = 1; depth <= maxDepth; depth++) {
      const orderSkew = BigInt(depth) * BigInt(10 ** 6) / scale
  
      // Compute long side pricing and quantity
      const longSpread =
        linearFee +
        proportionalFee * orderSkew / BigInt(10 ** 6) +
        adiabaticFee * (BigInt(2) * skew + orderSkew) / BigInt(10 ** 6);
      const longQuantity =
        (BigInt(2) * (adiabaticFee * skew + linearFee - longSpread)) /
        (adiabaticFee + BigInt(2) * proportionalFee)
      const longPrice = oraclePrice + longSpread / BigInt(depth)
  
      // Compute short side pricing and quantity
      const shortSpread =
        linearFee +
        proportionalFee * orderSkew / BigInt(10 ** 6) -
        adiabaticFee * (BigInt(2) * skew - orderSkew) / BigInt(10 ** 6)
      const shortQuantity =
        (BigInt(2) * (adiabaticFee * skew - linearFee + shortSpread)) /
        (adiabaticFee - BigInt(2) * proportionalFee)
      const shortPrice = oraclePrice - shortSpread / BigInt(depth)
  
      // Ensure price and quantity are integers
      solverBook.long.push({ price: getAbsoluteValue(longPrice), quantity: getAbsoluteValue(longQuantity) })
      solverBook.short.push({ price: getAbsoluteValue(shortPrice), quantity: -getAbsoluteValue(shortQuantity) })
    }
  
    return solverBook;
  }
  