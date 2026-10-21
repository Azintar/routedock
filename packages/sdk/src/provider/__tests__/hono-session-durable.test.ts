/**
 * Hono mpp-session: session state (cumulative, signature, payer, voucher
 * count, opened flag) must survive rebuilding routedockHono over the same
 * session store (issues #211/#310). Before the fix, a rebuilt instance
 * started `voucherCount`, `sessionOpened` and the voucher record from zero,
 * so a DELETE close broadcast the client's body amount instead of the highest
 * stored voucher, onSessionOpen refired for a live session, and onVoucher
 * indices restarted at 1.
 *
 * This file mocks '@stellar/mpp/channel/server' the same way as
 * hono-verified-voucher.test.ts (close records its arguments, the stellar
 * channel factory captures each instance's wrapped store) and additionally
 * mocks '../mppCompatibility.js' to capture the `commit` callback — identical
 * to the module-mocking pattern hono-verified-voucher.test.ts uses. Feeding a
 * voucher to an instance means writing a cumulative entry through the
 * captured wrapped store (what mppx does) and invoking commit (what
 * onVerifiedCredential does after a successful verify).
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { Hono } from 'hono'
import { Keypair } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'

let closeCalls: Array<{ amount: bigint; signature: Uint8Array }> = []
let capturedStores: Array<{
  get: (key: string) => Promise<unknown>
  put: (key: string, value: unknown) => Promise<void>
}> = []

mock.module('@stellar/mpp/channel/server', {
  namedExports: {
    Store: {
      memory: () => {
        const m = new Map<string, unknown>()
        return {
          async get(k: string) { return m.get(k) },
          async put(k: string, v: unknown) { m.set(k, v) },
          async delete(k: string) { m.delete(k) },
          update(k: string, fn: (v: unknown) => unknown) { m.set(k, fn(m.get(k))) },
        }
      },
    },
    close: async (opts: { amount: bigint; signature: Uint8Array }) => {
      closeCalls.push({ amount: opts.amount, signature: opts.signature })
      return 'mock-close-tx-hash'
    },
    // mppChannel: each routedockHono construction passes its wrapped store as
    // `store` — capture it so tests can write cumulative entries the way mppx
    // does when it verifies a voucher.
    stellar: (opts: { store: { get: (k: string) => Promise<unknown>; put: (k: string, v: unknown) => Promise<void> } }) => {
      capturedStores.push(opts.store)
      return []
    },
  },
})

const actualCompat = await import('../mppCompatibility.js')
type Commit = (credential: { payload?: unknown; source?: string }) => void | Promise<void>
let lastCommit: Commit | null = null
mock.module('../mppCompatibility.js', {
  namedExports: {
    channelAuthorizer: actualCompat.channelAuthorizer,
    withTypedChannelErrors: actualCompat.withTypedChannelErrors,
    formatMppError: actualCompat.formatMppError,
    onVerifiedCredential: (method: unknown, commit: Commit) => {
      lastCommit = commit
      return method
    },
  },
})

const { routedockHono } = await import('../hono.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Test Service',
  description: 'Unit test provider',
  modes: ['mpp-session'],
  network: 'testnet',
  asset: 'USDC',
  asset_contract: ASSET_CONTRACT,
  payee: payeeKeypair.publicKey(),
  pricing: {
    'mpp-session': {
      rate: '0.0001',
      per: 'voucher',
      channel_factory: CHANNEL_CONTRACT,
      min_deposit: '0.10',
      refund_waiting_period_ledgers: 17280,
    },
  },
  endpoints: { price: { method: 'GET', path: '/price' } },
  tags: ['test'],
}

interface MapStore {
  get: (key: string) => Promise<unknown>
  put: (key: string, value: unknown) => Promise<void>
  delete: (key: string) => Promise<void>
  map: Map<string, unknown>
}

/** A Map-backed durable store shared across rebuilt handler instances. */
function mapStore(): MapStore {
  const m = new Map<string, unknown>()
  return {
    map: m,
    async get(k: string) { return m.get(k) },
    async put(k: string, v: unknown) { m.set(k, v) },
    async delete(k: string) { m.delete(k) },
  }
}

/**
 * Builds a routedockHono app over `store` — a new, independent handler
 * closure just like a rebuilt Durable Object would get — and returns it with
 * the `commit` callback and wrapped store this instance registered.
 */
function buildInstance(
  store: MapStore,
  handlers: {
    onSessionOpen?: (channelId: string, payer: string | null) => Promise<void>
    onVoucher?: (channelId: string, voucherIndex: number, cumulativeAmount: string, signature: string) => Promise<void>
    onOrphaned?: (channelId: string, info: { cumulativeAmount: string; lastSignature: string; voucherCount: number; reason: string }) => Promise<void>
  } = {},
): { app: Hono; commit: Commit; wrappedStore: NonNullable<(typeof capturedStores)[number]> } {
  closeCalls = []
  capturedStores = []
  const app = new Hono()
  app.use(
    '*',
    routedockHono({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      sessionStore: store,
      ...handlers,
    }),
  )
  assert.ok(lastCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = lastCommit!
  assert.ok(capturedStores.length >= 1, 'stellar channel factory mock should have captured the wrapped store')
  const wrappedStore = capturedStores[capturedStores.length - 1]!
  return { app, commit, wrappedStore }
}

const CUMULATIVE_KEY = `stellar:channel:cumulative:${CHANNEL_CONTRACT}`

async function deleteReq(app: Hono, amount: string, signature: string): Promise<Response> {
  return app.request('/price', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ amount, signature }),
  })
}

/** Feeds one voucher to an instance the way mppx + onVerifiedCredential do. */
async function feedVoucher(
  inst: { commit: Commit; wrappedStore: { put: (key: string, value: unknown) => Promise<void> } },
  stroops: string,
  signature: string,
): Promise<void> {
  await inst.wrappedStore.put(CUMULATIVE_KEY, { amount: stroops })
  await inst.commit({ payload: { amount: stroops, signature }, source: payerKeypair.publicKey() })
}

describe('routedockHono — session state survives a rebuild over the same store (issues #211/#310)', () => {
  it('a DELETE on a rebuilt instance never closes below the highest stored voucher', async () => {
    const store = mapStore()
    const a = buildInstance(store, {})
    for (let i = 1; i <= 5; i++) {
      await feedVoucher(a, String(1000 * i), 'ff'.repeat(i))
    }

    // Instance B is a fresh closure over the same persistent store — the
    // rebuilt Durable Object scenario.
    const b = buildInstance(store, {})
    const res = await deleteReq(b.app, '1000', 'deadbeef')
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.ok(closeCalls[0], 'close must have been called exactly once')
    assert.ok(
      closeCalls[0]!.amount >= 5000n,
      `close must never broadcast below the stored voucher; got ${closeCalls[0]!.amount}`,
    )
    assert.equal(closeCalls[0]!.amount, 5000n)
  })

  it('a DELETE on a rebuilt instance closes at the stored amount with the stored signature', async () => {
    const store = mapStore()
    const a = buildInstance(store, {})
    // Vouchers 1000–4000 get per-voucher signatures; voucher 5000's signature
    // is 'abcd' — the last signature the provider verified for this channel.
    for (let i = 1; i <= 4; i++) {
      await feedVoucher(a, String(1000 * i), 'ff'.repeat(i))
    }
    await feedVoucher(a, '5000', 'abcd')

    const b = buildInstance(store, {})
    const res = await deleteReq(b.app, '1000', 'deadbeef')
    assert.equal(res.status, 200)
    assert.equal(closeCalls.length, 1)
    assert.ok(closeCalls[0])
    assert.equal(closeCalls[0]!.amount, 5000n)
    assert.deepEqual(
      Buffer.from(closeCalls[0]!.signature).toString('hex'),
      'abcd',
    )
  })

  it('with only mppx cumulative in the store and no routedock record, a low DELETE returns 409 and never closes', async () => {
    // Sessions open when the fix ships have a cumulative entry but no routedock
    // record: the floor must still protect them.
    const store = mapStore()
    await store.put(CUMULATIVE_KEY, { amount: '5000' })

    const b = buildInstance(store, {})
    const res = await deleteReq(b.app, '1000', 'deadbeef')
    assert.equal(res.status, 409)
    const json = await res.json() as { closeTxHash: unknown; error?: string }
    assert.equal(json.closeTxHash, null)
    assert.ok(json.error)
    assert.equal(closeCalls.length, 0)
  })

  it('a voucher on the rebuilt instance continues the count and never re-announces the session', async () => {
    const store = mapStore()
    let aOpens = 0
    const a = buildInstance(store, {
      onSessionOpen: async () => { aOpens++ },
    })
    for (let i = 1; i <= 5; i++) {
      await feedVoucher(a, String(1000 * i), 'ff'.repeat(i))
    }
    assert.equal(aOpens, 1)

    let bOpens = 0
    const voucherIndices: number[] = []
    const b = buildInstance(store, {
      onSessionOpen: async () => { bOpens++ },
      onVoucher: async (_id, idx) => { voucherIndices.push(idx) },
    })
    await feedVoucher(b, '6000', 'ff'.repeat(6))

    assert.equal(bOpens, 0, 'a rebuilt instance must not re-fire onSessionOpen for a live session')
    assert.equal(aOpens, 1)
    assert.deepEqual(voucherIndices, [6])
  })

  it('after a clean close, a fresh instance over the same store reports the session as new', async () => {
    const store = mapStore()
    const a = buildInstance(store, {})
    for (let i = 1; i <= 5; i++) {
      await feedVoucher(a, String(1000 * i), 'ff'.repeat(i))
    }
    const closeRes = await deleteReq(a.app, '5000', 'abcd')
    assert.equal(closeRes.status, 200)

    let cOpens = 0
    const voucherIndices: number[] = []
    const c = buildInstance(store, {
      onSessionOpen: async () => { cOpens++ },
      onVoucher: async (_id, idx) => { voucherIndices.push(idx) },
    })
    await feedVoucher(c, '6000', 'ff'.repeat(6))

    assert.equal(cOpens, 1, 'a fresh session over the same channel must be announced again')
    assert.deepEqual(voucherIndices, [1], 'voucher indices must restart after a clean close')
  })

  it('after a clean close the store holds no routedock record or stale cumulative floor', async () => {
    const store = mapStore()
    const a = buildInstance(store, {})
    await feedVoucher(a, '5000', 'abcd')
    assert.equal(store.map.has(CUMULATIVE_KEY), true)
    const recordKey = `routedock:session:voucher:${CHANNEL_CONTRACT}`
    assert.equal(store.map.has(recordKey), true)

    const res = await deleteReq(a.app, '5000', 'abcd')
    assert.equal(res.status, 200)
    assert.equal(store.map.has(recordKey), false, 'routedock record must be cleared on a clean close')
    assert.equal(store.map.has(CUMULATIVE_KEY), false, 'stale cumulative floor must be cleared on a clean close')
  })
})
