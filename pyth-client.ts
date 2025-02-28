// src/pyth-client.ts
import { EventEmitter } from 'events'
import { ETH_USD_PRICE_ID, BTC_USD_PRICE_ID } from './constants'

export interface PriceData {
  price_id: string
  price: number
  conf: number
  publish_time: number
  slot: number
}

interface PythPriceUpdate {
  binary: {
    encoding: string
    data: string[]
  }
  parsed: Array<{
    id: string
    price: {
      price: string
      conf: string
      expo: number
      publish_time: number
    }
    ema_price: {
      price: string
      conf: string
      expo: number
      publish_time: number
    }
    metadata: {
      slot: number
      proof_available_time: number
      prev_publish_time: number
    }
  }>
}

export class PythPriceClient extends EventEmitter {
  private baseUrl: string
  private reconnectDelay: number = 5000 // 5 seconds

  constructor(network: 'mainnet' | 'testnet' = 'mainnet') {
    super()
    this.baseUrl = network === 'mainnet' 
      ? 'https://hermes.pyth.network'
      : 'https://hermes-beta.pyth.network'
  }

  async getPriceFeed(priceIds: string[], callback?: (data: PriceData[]) => void) {
    while (true) {
      try {
        const params = new URLSearchParams()
        priceIds.forEach(id => params.append('ids[]', id))
        const sseUrl = `${this.baseUrl}/v2/updates/price/stream?${params.toString()}`

        console.log(`Connecting to Pyth SSE endpoint: ${sseUrl}`)
        const response = await fetch(sseUrl, {
          headers: { Accept: 'text/event-stream' }
        })

        if (!response.ok) {
          throw new Error(`Failed to connect: ${response.status}`)
        }

        const reader = response.body?.getReader()
        if (!reader) {
          throw new Error('No response body')
        }

        let buffer = ''
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += new TextDecoder().decode(value)
          const lines = buffer.split('\n')
          buffer = lines.pop() || ''

          for (const line of lines) {
            if (!line || line.startsWith(':')) continue
            if (line.startsWith('data:')) {
              const data = JSON.parse(line.slice(5)) as PythPriceUpdate
              const parsedData = this.parsePriceUpdate(data)
              if (parsedData && callback) {
                callback(parsedData)
              }
            }
          }
        }
      } catch (error) {
        console.error('Error in pulling price feed:', error)
        await new Promise(resolve => setTimeout(resolve, this.reconnectDelay))
      }
    }
  }

  private parsePriceUpdate(data: PythPriceUpdate): PriceData[] | null {
    try {
      return data.parsed.map(item => {
        const price = item.price
        const expo = Math.pow(10, price.expo)
        return {
          price_id: item.id,
          price: parseFloat(price.price) * expo,
          conf: parseFloat(price.conf) * expo,
          publish_time: price.publish_time,
          slot: item.metadata.slot,
        }
      })
    } catch (error) {
      console.error('Error in parsing price data:', error)
      return null
    }
  }
}

// Example usage:
async function main() {
  const priceIds = [BTC_USD_PRICE_ID, ETH_USD_PRICE_ID]

  const client = new PythPriceClient()
  await client.getPriceFeed(priceIds, (data) => {
    console.log('Parsed price update:', JSON.stringify(data, null, 2))
  })
}

if (import.meta.main) {
  main().catch(console.error)
}
