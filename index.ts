import PerennialSdk, {
  Big6Math,
  ChainMarkets,
  HermesClient,
  type Intent,
  PositionSide,
  parseViemContractCustomError,
  SupportedMarket,
  addressToMarket,
  perennialSepolia,
  mergeMultiInvokerTxs,
} from '@perennial/sdk'
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomUUID } from 'crypto'
import ResilientWebSocket, { WebSocketEvent } from 'resilient-websocket'
import { Hyperliquid, type L2Book } from 'hyperliquid'
import { PythPriceClient } from './pyth-client'
import { ETH_USD_PRICE_ID } from './constants'
import { sendDatadogMetric } from './datadog'
import { generateSolverBook } from './solver-utils'
import { RateLimitedLogger } from './utils/logger'

const RpcUrl = Bun.env.RPC_URL!
const PriceStreamUrl = Bun.env.PYTH_URL!
const WssUrl = Bun.env.WSS_URL!
const GraphUrl = Bun.env.GRAPH_URL!
const StorkUrl = Bun.env.STORK_URL!
const PrivateKey = Bun.env.PRIVATE_KEY!

const SpreadBufferLong = Big6Math.fromFloatString('1.002')
const SpreadBufferShort = Big6Math.fromFloatString('0.998')

const logger = new RateLimitedLogger(60000) // Logs at most once every 60 seconds

class PerennialMarketMaker {
  private readonly pythDirectClient: PythPriceClient
  private socketConnected = false
  private pendingExecutions: Set<SupportedMarket> = new Set()

  static async create() {
    const socket = new ResilientWebSocket(WssUrl, {
      autoJsonify: true,
      autoConnect: true,
      reconnectInterval: 5000, // Reconnect every 5 seconds
      reconnectOnError: true,
    })

    const walletClient = createWalletClient({
      account: privateKeyToAccount(PrivateKey as Hex),
      chain: perennialSepolia,
      transport: http(RpcUrl),
    })
    const sdk = new PerennialSdk({
      chainId: perennialSepolia.id,
      rpcUrl: RpcUrl,
      pythUrl: PriceStreamUrl,
      graphUrl: GraphUrl,
      storkConfig: {
        url: StorkUrl,
      },
      walletClient: walletClient as any,
    })

    const pythClient = Array.isArray(sdk.oracleClients.pyth)
      ? sdk.oracleClients.pyth[0]
      : sdk.oracleClients.pyth

    return new PerennialMarketMaker(socket, pythClient, new Hyperliquid(), sdk)
  }

  constructor(
    private readonly wsConnection: ResilientWebSocket,
    private readonly pythClient: HermesClient,
    private readonly hyperliquid: Hyperliquid,
    private readonly sdk: PerennialSdk
  ) {
    this.pythDirectClient = new PythPriceClient()
  }

  private async fetchMarketSnapshots(markets: SupportedMarket[]) {
    try {
      const snapshots = await this.sdk.markets.read.marketSnapshots({
        markets,
      })
      return snapshots
    } catch (error) {
      logger.error('Error fetching market snapshots:', error)
      return null
    }
  }

  async run() {
    this.listen()

    // Start Pyth direct price feed
    const priceIds = [ETH_USD_PRICE_ID]

    const priceIdToMarket: Record<string, SupportedMarket> = {
      [ETH_USD_PRICE_ID]: SupportedMarket.eth,
    }

    this.pythDirectClient
      .getPriceFeed(priceIds, async data => {
        logger.debug(`Pyth price update: ${JSON.stringify(data)}`)

        for (const priceData of data) {
          const { price_id, price: oraclePrice } = priceData
          const formattedPriceId = `0x${price_id.toLowerCase()}`
          const marketKey = priceIdToMarket[formattedPriceId]
          if (!marketKey) {
            logger.error(`Unknown price_id received: ${price_id}`)
            continue
          }

          const marketAddress =
            ChainMarkets[this.sdk.currentChainId]?.[marketKey]
          if (!marketAddress) {
            logger.error(
              `Market address not found for chain ID ${this.sdk.currentChainId} and market ${marketKey}`
            )
            continue
          }

          const marketSnapshot = await this.fetchMarketSnapshots([marketKey])
          if (!marketSnapshot) {
            logger.error(`Market snapshot retrieval failed for ${marketKey}`)
            continue
          }

          const userMarketSnapshot = marketSnapshot?.user?.[marketKey]
          if (!userMarketSnapshot) {
            logger.error(`User market snapshot retrieval failed for ${marketKey}`)
            continue
          }

          const tags = [`market:${marketKey}`, "source:perennial"]
          const localCollateral = Number(userMarketSnapshot.local.collateral) / Number(Big6Math.BASE)
          await sendDatadogMetric('solver.collateral', 'gauge', localCollateral, tags, logger)

          // Find the correct market key based on the marketAddress
          const resolvedMarketKey = Object.keys(marketSnapshot.market).find(
            key =>
              marketSnapshot.market[
                key as keyof typeof marketSnapshot.market
              ]?.marketAddress?.toLowerCase() === marketAddress.toLowerCase()
          ) as keyof typeof marketSnapshot.market | undefined

          if (!resolvedMarketKey) {
            logger.error(
              `Market address ${marketAddress} not found in snapshot for ${marketKey}`
            )
            continue
          }

          const marketData = marketSnapshot.market[resolvedMarketKey]
          if (!marketData || !marketData.global) {
            logger.error(
              `Market data or global exposure is missing for ${marketKey}`
            )
            continue
          }

          const oraclePriceScaled = Big6Math.fromFloatString(oraclePrice.toString())

          const maxLeverage = BigInt(Bun.env.MAX_LEVERAGE ?? '10') // Default: 10x leverage
          const maxNotional = Big6Math.mul(userMarketSnapshot.local.collateral, maxLeverage)

          logger.debug(
            `Generating solver book with inputs: oraclePrice=${oraclePrice}, oraclePriceScaled=${oraclePriceScaled}, maxLeverage=${maxLeverage}, maxNotional=${maxNotional}`
          )

          // Generate order book
          const solverBook = generateSolverBook({
            numLevels: 20,
            marketSnapshot: marketData,
            latestPrice: oraclePriceScaled,
            maxNotional: maxNotional,
            logger,
          })

          // Push solver book to WebSocket
          this.pushSolverBook(marketKey, solverBook)
        }
      })
      .catch(logger.error)
  }

  private pushSolverBook(
    market: SupportedMarket,
    solverBook: { long: any[]; short: any[] }
  ) {
    if (!this.socketConnected) {
      logger.error('WebSocket is not connected, skipping message send.')
      return
    }

    const payload = {
      type: 'quote',
      quoteID: randomUUID(),
      markets: {
        [`${this.sdk.currentChainId}:${
          ChainMarkets[this.sdk.currentChainId]?.[market]
        }`]: {
          bid: solverBook.long.map(entry => ({
            price: Number(entry.price),
            amount: Number(entry.quantity),
          })),
          ask: solverBook.short.map(entry => ({
            price: Number(entry.price),
            amount: Number(entry.quantity),
          })),
        },
      },
    }

    logger.debug(
      `Pushing solver book for ${market}: quoteID: ${
        payload.quoteID
      }. Payload: ${JSON.stringify(payload)}`
    )
    try {
      this.wsConnection.send(payload)
    } catch (error) {
      logger.error(`Failed to send solver book: ${error}`, error)
    }
  }

  listen() {
    this.wsConnection.on(WebSocketEvent.PONG, () => {
      logger.info('Received pong')
    })

    this.wsConnection.on(WebSocketEvent.MESSAGE, data => {
      if (data?.type === 'quote_confirmation') {
        logger.debug(`Quote confirmed: quoteID=${data.quoteID}`)
        return
      }

      logger.info(`Received message: ${JSON.stringify(data)}`)
      if (data?.type === 'intent_execution_request') {
        this.executeIntent(data.intent, data.signature, data.transaction)
      }
    })

    this.wsConnection.on(WebSocketEvent.CONNECTING, data => {
      logger.error('WebSocket is still connecting:', data)
    })

    this.wsConnection.on(WebSocketEvent.CONNECTION, () => {
      this.socketConnected = true
      logger.info('WebSocket connection opened')
    })

    this.wsConnection.on(WebSocketEvent.CLOSE, error => {
      this.socketConnected = false
      logger.warn(`WebSocket connection closed. Code: ${error}`)
    })

    this.wsConnection.on(WebSocketEvent.ERROR, error => {
      logger.error('WebSocket connection encountered an error:', error)
    })
  }

  async executeIntent(
    intent: Intent,
    signature: Hex,
    transactionData: { to: Address; data: Hex; value: string }
  ) {
    const marketKey = addressToMarket(
      this.sdk.currentChainId,
      intent.common.domain
    )
    try {
      if (process.env.EXECUTION_ENABLED !== 'true') {
        throw new Error('Execution is disabled!')
      }
      if (this.pendingExecutions.has(marketKey)) {
        throw new Error(
          `There is already a pending execution for this market ${marketKey}`
        )
      }

      this.pendingExecutions.add(marketKey)

      const solverExposure = BigInt(intent.amount) * -1n
      if (Big6Math.abs(solverExposure) === Big6Math.fromFloatString('0.123'))
        throw new Error('Force Fail')

      const tx = await this.sdk.walletClient?.sendTransaction({
        to: transactionData.to,
        data: transactionData.data,
        value: BigInt(transactionData.value),
        account: this.sdk.walletClient!.account!,
        chain: perennialSepolia as any,
      })

      logger.info(`Sent transaction for intent fill: ${tx}`)

      const marketSnapshots = await this.sdk.markets.read.marketSnapshots({
        markets: [marketKey],
      })
      const marketData = marketSnapshots.market[marketKey]

      const marketAddress = marketData?.marketAddress
      if (!marketAddress) {
        throw new Error(`Market address is undefined for market ${marketKey}`)
      }

      const positionSide =
        intent.amount > 0 ? PositionSide.long : PositionSide.short

      await new Promise(resolve => setTimeout(resolve, 10000)) // Wait 10s for safety
      logger.info(`Closing position via AMM for ${marketKey}`)

      const commitment = await this.sdk.oracles.read.oracleCommitmentsLatest({
        markets: [marketKey],
      })
      logger.info(`Latest commitment from Oracle: ${commitment}`)
      const commitPriceAction = this.sdk.oracles.build.commitPrice({ ...commitment[0], revertOnFailure: false })
      const modifyAction = await this.sdk.markets.build.modifyPosition({
        marketAddress: marketAddress,
        positionSide: positionSide,
        positionAbs: 0n, // Close position by specifying 0
      })
      const txAMM = mergeMultiInvokerTxs([commitPriceAction, modifyAction])

      logger.info(`Sending AMM transaction: ${txAMM}`)
      await this.sdk.walletClient?.sendTransaction({
        to: txAMM.to,
        data: txAMM.data,
        value: txAMM.value,
        account: this.sdk.walletClient!.account!,
        chain: perennialSepolia as any,
      })

      logger.info(`Executed AMM order for ${marketKey}`)

      this.wsConnection.send({
        type: 'intent_execution_response',
        signature: signature,
        transactionHash: tx,
        status: 'success',
      })
    } catch (e) {
      logger.error(
        `Error executing intent: ${e}`,
        parseViemContractCustomError(e),
        String(e)
      )
      this.wsConnection.send({
        type: 'intent_execution_response',
        status: 'error',
      })
    } finally {
      this.pendingExecutions.delete(marketKey)
    }
  }
}

const port = process.env.PORT ? parseInt(process.env.PORT) : 8080
Bun.serve({
  port: port,
  fetch(req) {
    return new Response('Perennial Solver')
  },
})

logger.info(`Server listening on port ${port}`)

const mm = await PerennialMarketMaker.create()
mm.run()
