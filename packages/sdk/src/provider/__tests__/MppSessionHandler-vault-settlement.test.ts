/**
 * Express mpp-session: the shared recordSessionSettlement flow must be driven
 * by the explicit `vaultSettlement` option (issue #555), never by
 * process.env, and a failed send must be reported — not silently ignored.
 * Mirrors hono-vault-settlement.test.ts against the Express handler
 * (MppSessionHandler.ts / routedockMiddleware.ts).
 */

import { mock, describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import express from 'express'
import type { Request, Response } from 'express'
import { Account, Keypair, Networks, TransactionBuilder, scValToNative, StrKey } from '@stellar/stellar-sdk'
import type { RouteDockManifest } from '../../types.js'

const payeeKeypair = Keypair.random()
const commitKeypair = Keypair.random()
const payerKeypair = Keypair.random()

const ASSET_CONTRACT = 'CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA'
const CHANNEL_CONTRACT = 'CCK4XOW3YKQUEZFONUTINKMSNW7SNMRQZURME5U3UP7E6WNGK7UHUCAH'
// `new Contract()` rejects malformed ids, so derive a valid contract id.
const VAULT_CONTRACT = StrKey.encodeContract(Keypair.random().rawPublicKey())

const closeCalls: Array<{ amount: bigint }> = []

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
    close: async (opts: { amount: bigint }) => {
      closeCalls.push({ amount: opts.amount })
      return 'mock-close-tx-hash'
    },
    stellar: { channel: () => [] },
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

const rpc = { sendReturnsError: false }
const sentTransactions: Array<{ toXDR(): string }> = []

mock.module('@stellar/stellar-sdk/rpc', {
  namedExports: {
    // '@stellar/stellar-sdk' re-exports the rpc subpath's named exports, so
    // the mock must cover the ones anything imports; only Server is replaced.
    Api: {},
    assembleTransaction: (tx: { toXDR(): string }) => tx,
    Server: class {
      async getAccount(publicKey: string) { return new Account(publicKey, '100') }
      async prepareTransaction(tx: { toXDR(): string }) { return tx }
      async sendTransaction(tx: { toXDR(): string }) {
        sentTransactions.push(tx)
        return rpc.sendReturnsError
          ? { status: 'ERROR', hash: 'express-settle-hash', errorResult: { code: 'SW_AUTH_FAILED' } }
          : { status: 'PENDING', hash: 'express-settle-hash' }
      }
      async getTransaction(hash: string) {
        if (rpc.sendReturnsError) return { status: 'FAILED', hash }
        return { status: 'SUCCESS', hash }
      }
    },
  },
})

const { routedock } = await import('../routedockMiddleware.js')

const manifest: RouteDockManifest = {
  routedock: '1.0',
  name: 'Express Vault Settlement Test',
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

/** Boots a real Express server with the mpp-session middleware. */
async function makeServer(handlers: Record<string, unknown> = {}): Promise<{ url: string; commit: Commit; close: () => Promise<void> }> {
  closeCalls.length = 0
  const app = express()
  app.use(
    routedock({
      asset: 'USDC',
      assetContract: ASSET_CONTRACT,
      payee: payeeKeypair.publicKey(),
      network: 'testnet',
      payeeSecretKey: payeeKeypair.secret(),
      commitmentPublicKey: commitKeypair.publicKey(),
      manifest,
      modes: ['mpp-session'],
      pricing: { 'mpp-session': { rate: '0.0001', channelFactory: CHANNEL_CONTRACT } },
      ...handlers,
    } as Parameters<typeof routedock>[0]),
  )
  app.get('/price', (_req: Request, res: Response) => {
    res.json({ price: '42' })
  })

  assert.ok(lastCommit, 'onVerifiedCredential mock should have captured commit during construction')
  const commit = lastCommit!

  return new Promise((resolve) => {
    const server = createServer(app)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({
        url: `http://127.0.0.1:${port}`,
        commit,
        close: () => new Promise<void>((res) => server.close(() => res())),
      })
    })
  })
}

function hostCall(tx: { toXDR(): string }): { fn: string; args: unknown[] } {
  const parsed = TransactionBuilder.fromXDR(tx.toXDR(), Networks.TESTNET)
  assert.equal(parsed.operations.length, 1, 'exactly one operation expected')
  const op = parsed.operations[0] as unknown as {
    type?: string
    func?: { invokeContract(): { functionName(): string | Buffer; args(): Array<Parameters<typeof scValToNative>[0]> } }
  }
  assert.equal(op.type, 'invokeHostFunction')
  const invoke = op.func!.invokeContract()
  const rawName = invoke.functionName()
  return {
    fn: typeof rawName === 'string' ? rawName : Buffer.from(rawName).toString(),
    args: invoke.args().map(a => scValToNative(a)),
  }
}

describe('routedock (Express) — vault settlement (issue #555)', () => {
  it('records no session_settled when the vaultSettlement option is unset', async () => {
    sentTransactions.length = 0
    const { url, commit, close } = await makeServer()
    try {
      await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
      const res = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '1000', signature: 'aa'.repeat(32) }),
      })
      assert.equal(res.status, 200)
      assert.equal(closeCalls.length, 1)
      assert.equal(sentTransactions.length, 0, 'no vault tx without the vaultSettlement option')
    } finally {
      await close()
    }
  })

  it('records session_settled with the right channel, payer, payee, amount and voucher count', async () => {
    sentTransactions.length = 0
    rpc.sendReturnsError = false
    const { url, commit, close } = await makeServer({
      vaultSettlement: { contract: VAULT_CONTRACT },
    })
    try {
      await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
      await commit({ payload: { amount: '2000', signature: 'bb'.repeat(32) }, source: payerKeypair.publicKey() })

      const res = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '2000', signature: 'bb'.repeat(32) }),
      })
      assert.equal(res.status, 200)
      assert.equal(closeCalls.length, 1)
      assert.equal(sentTransactions.length, 1)

      const parsed = TransactionBuilder.fromXDR(sentTransactions[0]!.toXDR(), Networks.TESTNET)
      assert.equal((parsed as unknown as { source: string }).source, payeeKeypair.publicKey())
      const { fn, args } = hostCall(sentTransactions[0]!)
      assert.equal(fn, 'record_session_settlement')
      assert.deepEqual(args, [
        CHANNEL_CONTRACT,
        payerKeypair.publicKey(),
        payeeKeypair.publicKey(),
        2000n,
        2,
      ])
    } finally {
      await close()
    }
  })

  it('a send that returns ERROR is reported (logged + onCallbackError) and never fails the close', async () => {
    sentTransactions.length = 0
    rpc.sendReturnsError = true
    const callbackErrors: Array<{ err: unknown; cb: string }> = []
    const errs: string[] = []
    const { url, commit, close } = await makeServer({
      vaultSettlement: { contract: VAULT_CONTRACT },
      logger: (level: string, message: string, meta: unknown) => {
        if (level === 'error') errs.push(message)
      },
      onCallbackError: (err: unknown, cb: string) => { callbackErrors.push({ err, cb }) },
    })
    try {
      await commit({ payload: { amount: '1000', signature: 'aa'.repeat(32) }, source: payerKeypair.publicKey() })
      const res = await fetch(`${url}/price`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ amount: '1000', signature: 'aa'.repeat(32) }),
      })
      assert.equal(res.status, 200, 'a failed vault record must not fail the close response')
      const json = await res.json() as { closeTxHash?: unknown }
      assert.equal(json.closeTxHash, 'mock-close-tx-hash')
      assert.equal(sentTransactions.length, 1)
      assert.ok(errs.some((m) => /record_session_settlement/.test(m)), JSON.stringify(errs))
      assert.equal(callbackErrors.length, 1)
      assert.equal(callbackErrors[0]!.cb, 'sessionSettlement')
      assert.ok(String(callbackErrors[0]!.err).includes('express-settle-hash'))
    } finally {
      await close()
    }
  })
})
