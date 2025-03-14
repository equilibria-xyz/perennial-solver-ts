import { addDays } from 'date-fns'
import { config as dotenvConfig } from 'dotenv'
import type { Hex } from 'viem'
import { createWalletClient, getAddress, http, zeroAddress } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import PerennialSdk, {
  Big6Math,
  ChainMarkets,
  perennialSepolia,
  SupportedMarket,
  timeToSeconds,
} from '@perennial/sdk'

dotenvConfig({ path: '.env' })
;(BigInt.prototype as any).toJSON = function () {
  return this.toString()
}

const IntentURLBase = process.env.INTENT_URL_BASE

async function run() {
  const markets = [SupportedMarket.eth]
  const walletClient = createWalletClient({
    account: privateKeyToAccount(process.env.PRIVATE_KEY! as Hex),
    chain: perennialSepolia,
    transport: http(process.env.RPC_URL!),
  })

  const address = walletClient.account.address
  const originator = zeroAddress // Order originator receives a cut of the subtractive fee
  const solver = zeroAddress // Order Solver API receives a cut of the subtractive fee

  const amount = Big6Math.fromFloatString('-0.001111')

  const sdk = new PerennialSdk({
    chainId: perennialSepolia.id,
    rpcUrl: process.env.RPC_URL!,
    graphUrl: process.env.GRAPH_URL!,
    pythUrl: process.env.PYTH_URL!,
    cryptexUrl: process.env.CRYPTEX_URL!,
    supportedMarkets: markets,
    walletClient,
  })

  const marketID = `${sdk.currentChainId}:${
    ChainMarkets[sdk.currentChainId].eth
  }`
  const quoteRes = await fetch(
    `${IntentURLBase}/quotes/market?marketID=${marketID}&amount=${amount}`
  )
  if (!quoteRes.ok)
    throw new Error(
      `Failed to get quote for ${marketID}: ${
        quoteRes.statusText
      }: ${await quoteRes.text()}`
    )
  const quote = await quoteRes.json()
  console.log('Received quote', quote)

  // Buffer amount based on market price to immediately execute
  const price =
    BigInt(quote.price) +
    (amount < 0n ? -1n : 1n) * Big6Math.fromFloatString('10')
  const {
    intent: { message: intent },
    signature,
  } = await sdk.markets.sign.intent({
    intent: {
      amount: BigInt(amount),
      price,
      fee: Big6Math.fromFloatString('0.1'),
      originator,
      solver,
      collateralization: 0n,
    },
    market: SupportedMarket.eth,
    address,
    expiry: timeToSeconds(addDays(new Date(), 30).getTime(), true),
  })

  console.log('Intent signed', intent)
  console.log('Intent signature', signature)
  console.log('MarketId', marketID)
  const body = JSON.stringify([
    {
      chainID: String(perennialSepolia.id),
      marketID,
      intent,
      signature,
      executedAt: 0,
      expiry: Number(intent.common.expiry),
      status: '',
    },
  ])
  const res = await fetch(`${IntentURLBase}/orders/limit`, {
    method: 'POST',
    body,
  })
  if (!res.ok)
    throw new Error(
      `Failed to place limit order: ${res.statusText}: ${await res.text()}`
    )

  const response = await res.json()
  console.log('Limit Order placed', response)
}

run()
