import { arbitrumSepolia } from 'viem/chains'
import PerennialSdk, {
  Big18Math,
  Big6Math,
  ChainMarkets,
  HermesClient,
  Intent,
  PositionSide,
  parseViemContractCustomError,
  SupportedMarket,
} from '@perennial/sdk'
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomUUID } from 'crypto'
import ResilientWebSocket, { WebSocketEvent } from 'resilient-websocket'
import { Hyperliquid, type L2Book } from 'hyperliquid'
import { PythPriceClient } from './pyth-client'
import { ETH_USD_PRICE_ID } from './constants'
import { generateSolverBook } from './solver-utils'
import { RateLimitedLogger } from './utils/logger'

const RpcUrl = Bun.env.RPC_URL!
const PriceStreamUrl = Bun.env.PYTH_URL!
const WssUrl = Bun.env.WSS_URL!
const GraphUrl = Bun.env.GRAPH_URL!
const PrivateKeyLong = Bun.env.PRIVATE_KEY_LONG!
const PrivateKeyShort = Bun.env.PRIVATE_KEY_SHORT!
const DyDxUrl = 'https://indexer.dydx.trade/v4'

const SpreadBufferLong = Big6Math.fromFloatString('1.002')
const SpreadBufferShort = Big6Math.fromFloatString('0.998')

const logger = new RateLimitedLogger(60000) // Logs at most once every 60 seconds

class PerennialMarketMaker {
  private pythDirectClient: PythPriceClient
  private socketConnected = false
  private pendingExecutions: Set<SupportedMarket> = new Set()

  static async create() {
    const socket = new ResilientWebSocket(WssUrl, {
      autoJsonify: true,
      autoConnect: true,
      reconnectInterval: 5000, // Reconnect every 5 seconds
      reconnectOnError: false
    })

    const walletClientLong = createWalletClient({
      account: privateKeyToAccount(PrivateKeyLong as Hex),
      chain: arbitrumSepolia,
      transport: http(RpcUrl),
    })
    const walletClientShort = createWalletClient({
      account: privateKeyToAccount(PrivateKeyShort as Hex),
      chain: arbitrumSepolia,
      transport: http(RpcUrl),
    })
    const sdkLong = new PerennialSdk({
      chainId: arbitrumSepolia.id,
      rpcUrl: RpcUrl,
      pythUrl: PriceStreamUrl,
      graphUrl: GraphUrl,
      walletClient: walletClientLong as any,
    })
    const sdkShort = new PerennialSdk({
      chainId: arbitrumSepolia.id,
      rpcUrl: RpcUrl,
      pythUrl: PriceStreamUrl,
      graphUrl: GraphUrl,
      walletClient: walletClientShort as any,
    })

    const pythClient = Array.isArray(sdkLong.oracleClients.pyth)
      ? sdkLong.oracleClients.pyth[0]
      : sdkLong.oracleClients.pyth

    return new PerennialMarketMaker(
      socket,
      pythClient,
      new Hyperliquid(),
      sdkLong,
      sdkShort
    )
  }

  constructor(
    private readonly socket: ResilientWebSocket,
    private readonly pythClient: HermesClient,
    private readonly hyperliquid: Hyperliquid,
    private readonly sdkLong: PerennialSdk,
    private readonly sdkShort: PerennialSdk
  ) {
    this.pythDirectClient = new PythPriceClient()
  }

  private async fetchMarketSnapshots(markets: SupportedMarket[]) {
    try {
      const snapshots = await this.sdkLong.markets.read.marketSnapshots({ markets })
      return snapshots
    } catch (error) {
      logger.error('Error fetching market snapshots:', error)
      return null
    }
  }

  async run() {
    this.listen();

    // Start Pyth direct price feed
    const priceIds = [ETH_USD_PRICE_ID]

    const priceIdToMarket: Record<string, SupportedMarket> = {
      [ETH_USD_PRICE_ID]: SupportedMarket.eth,
    };

    this.pythDirectClient.getPriceFeed(priceIds, async (data) => {
        logger.debug(`Pyth price update: ${JSON.stringify(data)}`);

        for (const priceData of data) {
            const { price_id, price: oraclePrice } = priceData;
;
            const formattedPriceId = `0x${price_id.toLowerCase()}`
            const marketKey = priceIdToMarket[formattedPriceId];
            if (!marketKey) {
              logger.error(`Unknown price_id received: ${price_id}`);
                continue
            }

            const marketAddress = ChainMarkets[this.sdkLong.currentChainId]?.[marketKey];
            if (!marketAddress) {
                logger.error(`Market address not found for chain ID ${this.sdkLong.currentChainId} and market ${marketKey}`)
                continue
            }

            const marketSnapshot = await this.fetchMarketSnapshots([marketKey]);
            if (!marketSnapshot) {
                logger.error(`Market snapshot retrieval failed for ${marketKey}`);
                continue;
            }

            // Find the correct market key based on the marketAddress
            const resolvedMarketKey = Object.keys(marketSnapshot.market).find(
                key => marketSnapshot.market[key as keyof typeof marketSnapshot.market]?.marketAddress?.toLowerCase() === marketAddress.toLowerCase()
            ) as keyof typeof marketSnapshot.market | undefined;

            if (!resolvedMarketKey) {
                logger.error(`Market address ${marketAddress} not found in snapshot for ${marketKey}`);
                continue;
            }

            const marketData = marketSnapshot.market[resolvedMarketKey];
            if (!marketData || !marketData.global) {
                logger.error(`Market data or global exposure is missing for ${marketKey}`);
                continue;
            }

            const skew = Number(marketData.global.exposure);
            const riskParams = marketData.riskParameter;
            const scale = Number(riskParams.makerFee.scale);
            const linearFee = Number(Big6Math.fromFloatString(riskParams.takerFee.linearFee.toString()));
            const proportionalFee = Number(Big6Math.fromFloatString(riskParams.takerFee.proportionalFee.toString()));
            const adiabaticFee = Number(Big6Math.fromFloatString(riskParams.takerFee.adiabaticFee.toString()));
            const maxDepth = 10;

            logger.debug(`Generating solver book with inputs: oraclePrice: ${oraclePrice} skew: ${skew} scale: ${scale} linearFee: ${linearFee} proportionalFee: ${proportionalFee} adiabaticFee: ${adiabaticFee}`);
            
            // Generate order book
            const solverBook = generateSolverBook(
                oraclePrice,
                skew,
                scale,
                linearFee,
                proportionalFee,
                adiabaticFee,
                maxDepth
            );

            // Push solver book to WebSocket
            this.pushSolverBook(marketKey, solverBook);
        }
    }).catch(logger.error)
  }

  private pushSolverBook(market: SupportedMarket, solverBook: { long: any[], short: any[] }) {
    if (!this.socketConnected) {
      logger.error("WebSocket is not connected, skipping message send.")
      return
    }

    const payload = {
      type: 'quote',
      quoteID: randomUUID(),
      markets: {
        [`${this.sdkLong.currentChainId}:${ChainMarkets[this.sdkLong.currentChainId]?.[market]}`]: {
          bid: solverBook.long.map(entry => ({
            price: entry.price,
            amount: entry.quantity
          })),
          ask: solverBook.short.map(entry => ({
            price: entry.price,
            amount: entry.quantity
          }))
        }
      }
    }

    logger.debug(`Pushing solver book for ${market}: quoteID: ${payload.quoteID}. Payload: ${JSON.stringify(payload)}`)
    try {
        this.socket.send(payload)
    } catch (error) {
        logger.error("Failed to send solver book 1:", error)
    }
  }


  listen() {
    this.socket.on(WebSocketEvent.PONG, () => {
      logger.info('Received pong')
    })

    this.socket.on(WebSocketEvent.MESSAGE, data => {
      logger.info(`Received message: ${data}`)
      if (data?.type === 'intent_execution_request') {
        this.executeIntent(data.intent, data.signature, data.transaction)
      }
    })

    this.socket.on(WebSocketEvent.CONNECTION, () => {
      this.socketConnected = true
      logger.info('WebSocket connection opened')
    })

    this.socket.on(WebSocketEvent.CLOSE, (error) => {
      this.socketConnected = false
      logger.warn(`WebSocket connection closed. Code: ${error}`);
    })

    this.socket.on(WebSocketEvent.ERROR, (error) => {
      logger.error("WebSocket connection encountered an error:", error);
    })
  }

  async executeIntent(
    intent: Intent,
    signature: Hex,
    transactionData: { to: Address; data: Hex; value: string }
  ) {
    const marketKey = intent.market as SupportedMarket;
    try {
      if (this.pendingExecutions.has(marketKey)) {
        throw new Error(`There is already a pending execution for this market ${marketKey}`)
      }

      this.pendingExecutions.add(marketKey);

      const solverExposure = BigInt(intent.amount) * -1n
      const sdkToUse = solverExposure > 0n ? this.sdkLong : this.sdkShort
      if (Big6Math.abs(solverExposure) === Big6Math.fromFloatString('0.123'))
        throw new Error('Force Fail')

      const tx = await sdkToUse.walletClient?.sendTransaction({
        to: transactionData.to,
        data: transactionData.data,
        value: BigInt(transactionData.value),
        account: sdkToUse.walletClient!.account!,
        chain: arbitrumSepolia as any,
      })

      logger.info('Sent transaction', tx)

      const marketSnapshots = await sdkToUse.markets.read.marketSnapshots({ markets: [marketKey] })
      const marketData = marketSnapshots.market[marketKey];

      const marketAddress = marketData?.marketAddress
      if (!marketAddress) {
        throw new Error(`Market address is undefined for market ${marketKey}`);
      }

      const positionSide = intent.amount > 0 ? PositionSide.long : PositionSide.short

      const txAMM = await sdkToUse.markets.write.modifyPosition({
        marketAddress: marketAddress,
        address: transactionData.to,
        positionSide: positionSide,
        positionAbs: BigInt(0), // Close position by specifying 0
      });

      logger.info(`Executed AMM order for ${marketKey}, TX: ${txAMM}`);

      await new Promise(resolve => setTimeout(resolve, 10000)); // Wait 10s for safety

      this.socket.send({
        type: 'intent_execution_response',
        signature: signature,
        transactionHash: tx,
        status: 'success',
      })
    } catch (e) {
      logger.error(
        'Error executing intent',
        parseViemContractCustomError(e),
        String(e)
      )
      this.socket.send({
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
