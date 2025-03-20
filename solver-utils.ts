import { Big6Math, type MarketSnapshot, calcTakerLiquidity } from '@perennial/sdk'
import { RateLimitedLogger } from './utils/logger'
export interface OrderBook {
    long: { price: bigint; quantity: bigint }[];
    short: { price: bigint; quantity: bigint }[];
}
  
  export function generateSolverBookOld(
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

const getPrecision = (price: bigint) => {
    if (price < 10000) return 1n
    if (price < 100000) return 10n
    if (price < 1000000) return 100n
    if (price < 10000000) return 1000n
    if (price < 10000000000) return 100000n
    return 100000n
}

export const generateSolverBook = ({
    numLevels,
    marketSnapshot,
    latestPrice,
    maxNotional,
    logger,
  }: {
    numLevels: number
    marketSnapshot?: MarketSnapshot
    latestPrice: bigint
    logger: RateLimitedLogger
    maxNotional: bigint
  }): OrderBook => {
    const solverBook: OrderBook = { long: [], short: [] }
    if (!marketSnapshot) {
      return solverBook
    }
    const availableLiquidity = calcTakerLiquidity(marketSnapshot)
    const {
      riskParameter: {
        takerFee: { linearFee, proportionalFee, adiabaticFee, scale },
      },
      nextPosition: { long, short },
    } = marketSnapshot

    const denominator = adiabaticFee + proportionalFee
    if (denominator === 0n) {
      return solverBook
    }

    const skew = Big6Math.div(long - short, scale)
    const tick = getPrecision(latestPrice)

    let totalLongLiquidity = 0n
    let totalShortLiquidity = 0n

    let totalLongNotional = 0n
    let totalShortNotional = 0n

    for (let i = 0; i < numLevels; i++) {
      try {
        const initialSpreadAsk = linearFee - 2n * Big6Math.mul(adiabaticFee, skew)
        const initialPriceAsk = latestPrice + Big6Math.mul(initialSpreadAsk, latestPrice)
        const initialTickAsk = ((initialPriceAsk - 1n) / tick) * tick + tick // ceil

        const initialSpreadBid = linearFee + 2n * Big6Math.mul(adiabaticFee, skew)
        const initialPriceBid = latestPrice - Big6Math.mul(initialSpreadBid, latestPrice)
        const initialTickBid = (initialPriceBid / tick) * tick // floor

        if (totalShortLiquidity <= availableLiquidity.availableShortLiquidity) {
          const price = initialTickAsk + tick * BigInt(i)
          const { quantity } = calcSyntheticLiquidity({
            availableLiquidity: availableLiquidity.availableShortLiquidity,
            cumulativeLiquidity: totalShortLiquidity,
            isAsk: true,
            cumulativeTick: price,
            marketSnapshot,
            latestPrice,
          })

          if (quantity > 0n) {
            totalShortLiquidity += quantity
            totalShortNotional += quantity * price
            if (totalShortNotional > maxNotional) {
                logger.debug(`Breaking due to short side reached notional limit: totalShortNotional=${totalShortNotional}, maxNotional=${maxNotional}`)
                break
            }
            solverBook.short.push({
                price: price,
                quantity: -quantity
              })
          }
        }

        if (totalLongLiquidity <= availableLiquidity.availableLongLiquidity) {
          const price = initialTickBid - tick * BigInt(i)
          const { quantity } = calcSyntheticLiquidity({
            availableLiquidity: availableLiquidity.availableLongLiquidity,
            cumulativeLiquidity: totalLongLiquidity,
            isAsk: false,
            cumulativeTick: price,
            marketSnapshot,
            latestPrice,
          })
          if (quantity > 0n) {
            totalLongLiquidity += quantity
            totalLongNotional += quantity * price
            if (totalLongNotional > maxNotional) {
                logger.debug(`Breaking due to long side reached notional limit: totalLongNotional=${totalLongNotional}, maxNotional=${maxNotional}`)
                break
            }
            solverBook.long.push({
                price: price,
                quantity: quantity
            })
          }
        }

        if (
          totalLongLiquidity >= availableLiquidity.availableLongLiquidity &&
          totalShortLiquidity >= availableLiquidity.availableShortLiquidity
        ) {
          logger.debug(`Breaking due to liquidity limit: totalLongLiquidity=${totalLongLiquidity}, totalShortLiquidity=${totalShortLiquidity}, availableLongLiquidity=${availableLiquidity.availableLongLiquidity}, availableShortLiquidity=${availableLiquidity.availableShortLiquidity}`)
          break
        }
      } catch (error) {
        logger.error(`Error in building synthetic orders (i=${i}, numLevels=${numLevels}, latestPrice=${latestPrice}): ${error}`)
        continue
      }
    }

    return solverBook
}

function calcSyntheticLiquidity({
    availableLiquidity,
    cumulativeLiquidity,
    isAsk,
    cumulativeTick,
    marketSnapshot,
    latestPrice,
  }: {
    availableLiquidity: bigint
    cumulativeLiquidity: bigint
    isAsk: boolean
    cumulativeTick: bigint
    marketSnapshot: MarketSnapshot
    latestPrice: bigint
  }) {
    const {
      riskParameter: {
        takerFee: { adiabaticFee, linearFee, proportionalFee, scale },
      },
      nextPosition: { long, short },
    } = marketSnapshot

    const denominator = adiabaticFee + proportionalFee
    if (denominator === 0n || latestPrice === 0n) {
      return { quantity: 0n, price: 0n }
    }

    const skew = Big6Math.div(long - short, scale)
    const spread = isAsk ? cumulativeTick - latestPrice : latestPrice - cumulativeTick
    const impactPct = Big6Math.div(spread, latestPrice)

    const numerator = (isAsk ? 2n : -2n) * Big6Math.mul(adiabaticFee, skew) - linearFee + impactPct
    const cumulativeQuantity = Big6Math.mul(Big6Math.div(numerator, denominator), scale)
    const finalCumulativeQuantity = cumulativeQuantity <= availableLiquidity ? cumulativeQuantity : availableLiquidity

    return { quantity: finalCumulativeQuantity - cumulativeLiquidity }
  }