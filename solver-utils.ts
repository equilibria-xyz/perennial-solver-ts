import {Big6Math} from '@perennial/sdk'
export interface OrderBook {
    long: { price: bigint; quantity: bigint }[];
    short: { price: bigint; quantity: bigint }[];
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

    const big6Scale = BigInt(10 ** 6)
    for (let depth = 1; depth <= maxDepth; depth++) {
        const depthBigInt: bigint = BigInt(depth) * big6Scale
        const twoBigInt: bigint = BigInt(2) * big6Scale
        const orderSkew = Big6Math.div(depthBigInt, scale);

        // Compute long side pricing and quantity
        const longSpread =
          linearFee +
          Big6Math.mul(proportionalFee, orderSkew) +
          Big6Math.mul(adiabaticFee, Big6Math.mul(skew, twoBigInt) + orderSkew)

        const longQuantity =
          Big6Math.div(
            Big6Math.mul(Big6Math.mul(adiabaticFee, skew) + linearFee - longSpread, twoBigInt),
            adiabaticFee + Big6Math.mul(proportionalFee, twoBigInt)
          )

        const longPrice = oraclePrice + Big6Math.div(longSpread, depthBigInt)

        // Compute short side pricing and quantity
        const shortSpread =
          linearFee +
          Big6Math.mul(proportionalFee, orderSkew) -
          Big6Math.mul(adiabaticFee, Big6Math.mul(skew, twoBigInt) - orderSkew)

        const shortQuantity =
          Big6Math.div(
            Big6Math.mul(Big6Math.mul(adiabaticFee, skew) - linearFee + shortSpread, twoBigInt),
            adiabaticFee - Big6Math.mul(proportionalFee, twoBigInt)
          )

        const shortPrice = oraclePrice - Big6Math.div(shortSpread, depthBigInt)

        // Ensure price and quantity are positive
        solverBook.long.push({
          price: Big6Math.abs(longPrice),
          quantity: Big6Math.abs(longQuantity)
        })

        solverBook.short.push({
          price: Big6Math.abs(shortPrice),
          quantity: -Big6Math.abs(shortQuantity)
        })
      }

      return solverBook
  }
  