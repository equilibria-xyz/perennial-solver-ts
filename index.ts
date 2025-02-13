import { arbitrumSepolia } from 'viem/chains'
import PerennialSdk, {
  Big18Math,
  Big6Math,
  ChainMarkets,
  HermesClient,
  Intent,
  MarketMetadata,
  parseViemContractCustomError,
  SupportedMarket,
} from '@perennial/sdk'
import { createWalletClient, http, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { randomUUID } from 'crypto'
import ResilientWebSocket, { WebSocketEvent } from 'resilient-websocket'
import { Hyperliquid, type L2Book } from 'hyperliquid'
import { PythPriceClient } from './pyth-client'
import type { PriceData } from './pyth-client'
import { generateSolverBook } from './solver-utils'

const RpcUrl = Bun.env.RPC_URL!
const PriceStreamUrl = Bun.env.PYTH_URL!
const WssUrl = Bun.env.WSS_URL!
const GraphUrl = Bun.env.GRAPH_URL!
const PrivateKeyLong = Bun.env.PRIVATE_KEY_LONG!
const PrivateKeyShort = Bun.env.PRIVATE_KEY_SHORT!
const DyDxUrl = 'https://indexer.dydx.trade/v4'

const SpreadBufferLong = Big6Math.fromFloatString('1.002')
const SpreadBufferShort = Big6Math.fromFloatString('0.998')

class PerennialMarketMaker {
  private pythDirectClient: PythPriceClient

  static async create() {
    const socket = new ResilientWebSocket(WssUrl, {
      autoJsonify: true,
      autoConnect: true,
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
      // console.log('Market snapshots:', JSON.stringify(snapshots, (_, value) =>
      //  typeof value === 'bigint' ? value.toString() : value,
      //  2
      // ));
      return snapshots
    } catch (error) {
      console.error('Error fetching market snapshots:', error)
      return null
    }
  }

  async run() {
    this.listen()

    // Start Pyth direct price feed
    const priceIds = [
      '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace' // ETH/USD
    ]
    this.pythDirectClient.getPriceFeed(priceIds, async (data) => {
      console.log('Pyth price update:', JSON.stringify(data, null, 2))

      const oraclePrice = Number(Big18Math.fromFloatString(data[0].price.toString()))
      const marketAddress = ChainMarkets[this.sdkLong.currentChainId]?.[SupportedMarket.cmsqETH]

      if (!marketAddress) {
        console.error(`Market address not found for chain ID ${this.sdkLong.currentChainId}`)
        return
      }

      const marketSnapshot = await this.fetchMarketSnapshots([SupportedMarket.cmsqETH])
      if (!marketSnapshot) {
        console.error('Market snapshot retrieval failed')
        return
      }

      // Find the correct market key based on the marketAddress
      const marketKey = Object.keys(marketSnapshot.market).find(
        key => marketSnapshot.market[key as keyof typeof marketSnapshot.market]?.marketAddress?.toLowerCase() === marketAddress.toLowerCase()
      ) as keyof typeof marketSnapshot.market | undefined

      if (!marketKey) {
        console.error(`Market address ${marketAddress} not found in snapshot`)
        return
      }

      const marketData = marketSnapshot.market[marketKey]
      if (!marketData || !marketData.global) {
        console.error("Market data or global exposure is missing for the resolved market key")
        return
      }

      const skew = Number(Big18Math.fromFloatString(marketData.global.exposure.toString()))
      const riskParams = marketData.riskParameter
      const scale = Number(Big18Math.fromFloatString(riskParams.makerFee.scale.toString()))
      const linearFee = Number(Big6Math.fromFloatString(riskParams.takerFee.linearFee.toString()))
      const proportionalFee = Number(Big6Math.fromFloatString(riskParams.takerFee.proportionalFee.toString()))
      const adiabaticFee = Number(Big6Math.fromFloatString(riskParams.takerFee.adiabaticFee.toString()))
      const maxDepth = 10

      // Generate order book
      const solverBook = generateSolverBook(
        oraclePrice,
        skew,
        scale,
        linearFee,
        proportionalFee,
        adiabaticFee,
        maxDepth
      )

      console.log('Generated Solver Book:', JSON.stringify(solverBook, null, 2))

      // Push solver book to WebSocket
      this.pushSolverBook(SupportedMarket.cmsqETH, solverBook)
    }).catch(console.error)

    /*
    await this.hyperliquid.connect()
    await this.hyperliquid.subscriptions.subscribeToL2Book(
      'ETH-PERP',
      async (data: any) => {
        const res = await data
        this.pushBooks([
          {
            market: SupportedMarket.cmsqETH,
            book: this.transformHLBook(
              res.data,
              MarketMetadata['eth²'].transform
            ),
          },
        ])
      }
    )
    */

    // Poll for price updates
    // setInterval(async () => {
    //   const dydxBook = await fetch(
    //     `${DyDxUrl}/orderbooks/perpetualMarket/PAXG-USD`
    //   ).then(res => res.json())
    //   this.pushBooks([
    //     {
    //       market: SupportedMarket.xau,
    //       book: this.transformDyDxBook(dydxBook),
    //     },
    //   ])
    // }, 5000)
  }

  private pushSolverBook(market: SupportedMarket, solverBook: { long: any[], short: any[] }) {
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

    console.log(`Pushing solver book for ${market} with quoteID ${payload.quoteID}`)
    this.socket.send(payload)
  }

  pushBooks(
    books: {
      market: SupportedMarket
      book: {
        bid: { price: number; amount: number }[]
        ask: { price: number; amount: number }[]
      }
    }[]
  ) {
    const payload = {
      type: 'quote',
      quoteID: randomUUID(),
      markets: books.reduce(
        (acc, { market, book }) => ({
          ...acc,
          [`${this.sdkLong.currentChainId}:${
            ChainMarkets[this.sdkLong.currentChainId]?.[market]
          }`]: book,
        }),
        {} as Record<
          string,
          {
            bid: { price: number; amount: number }[]
            ask: { price: number; amount: number }[]
          }
        >
      ),
    }
    console.log(
      `Pushing ${books.map(b => b.market).join(',')} books with quoteID ${
        payload.quoteID
      }`
    )
    this.socket.send(payload)
  }

  transformHLBook(book: L2Book, transform: (price: bigint) => bigint) {
    return {
      bid: book.levels[0].map(level => ({
        price: Number(
          Big6Math.mul(
            transform(Big18Math.fromFloatString(level.px.toString())),
            SpreadBufferShort
          )
        ),
        amount: Number(Big6Math.fromFloatString(level.sz.toString())),
      })),
      ask: book.levels[1].map(level => ({
        price: Number(
          Big6Math.mul(
            transform(Big18Math.fromFloatString(level.px.toString())),
            SpreadBufferLong
          )
        ),
        amount: Number(Big6Math.fromFloatString(level.sz.toString())),
      })),
    }
  }

  transformDyDxBook(book: {
    bids: { price: number; size: number }[]
    asks: { price: number; size: number }[]
  }) {
    return {
      bid: book.bids
        .map((bid: any) => ({
          price: Number(
            Big6Math.mul(Big6Math.fromFloatString(bid.price), SpreadBufferShort)
          ),
          amount: Number(Big6Math.fromFloatString(bid.size)),
        }))
        .reverse(),
      ask: book.asks.map((ask: any) => ({
        price: Number(
          Big6Math.mul(Big6Math.fromFloatString(ask.price), SpreadBufferLong)
        ),
        amount: Number(Big6Math.fromFloatString(ask.size)),
      })),
    }
  }

  listen() {
    this.socket.on(WebSocketEvent.PONG, () => {
      console.log('Received pong')
    })

    this.socket.on(WebSocketEvent.MESSAGE, data => {
      console.log('Received message', data)
      if (data?.type === 'intent_execution_request') {
        this.executeIntent(data.intent, data.signature, data.transaction)
      }
    })

    this.socket.on(WebSocketEvent.CONNECTION, () => {
      console.log('WebSocket connection opened')
    })

    this.socket.on(WebSocketEvent.CLOSE, () => {
      console.log('WebSocket connection closed')
    })
  }

  async executeIntent(
    intent: Intent,
    signature: Hex,
    transactionData: { to: Address; data: Hex; value: string }
  ) {
    try {
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

      console.log('Sent transaction', tx)

      this.socket.send({
        type: 'intent_execution_response',
        signature: signature,
        transactionHash: tx,
        status: 'success',
      })
    } catch (e) {
      console.error(
        'Error executing intent',
        parseViemContractCustomError(e),
        String(e)
      )
      this.socket.send({
        type: 'intent_execution_response',
        status: 'error',
      })
    }
  }

  private pythPriceToBig6(price: bigint, expo: number) {
    const normalizedExpo = price ? 18 + expo : 0
    const normalizedPrice =
      normalizedExpo >= 0
        ? price * 10n ** BigInt(normalizedExpo)
        : price / 10n ** BigInt(Math.abs(normalizedExpo))
    return normalizedPrice / 10n ** 12n
  }
}

Bun.serve({
  port: process.env.PORT ? parseInt(process.env.PORT) : 8080,
  fetch(req) {
    return new Response('Hello World')
  },
})

const mm = await PerennialMarketMaker.create()
mm.run()
