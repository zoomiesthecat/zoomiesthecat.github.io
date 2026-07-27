import { ACTIVE, decodeStatus } from './core.mjs';
import { TransportFailure } from './page.mjs';
export const RPC_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call']);
const hash = value => typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value);
const quantity = value => typeof value === 'string' && /^0x[0-9a-f]+$/i.test(value) ? BigInt(value) : null;
const calldata = `${ACTIVE.selector}${ACTIVE.token.slice(2).padStart(64, '0')}`;
export async function readLiveStatus(request) {
  try {
    const chain = await request('eth_chainId', []); if (quantity(chain)?.toString() !== ACTIVE.chainId) return { status: 'unavailable', reason: 'chain_mismatch' };
    const headNumber = quantity(await request('eth_blockNumber', [])); if (headNumber === null) throw Error('malformed_status');
    const block = await request('eth_getBlockByNumber', [`0x${headNumber.toString(16)}`, false]); const timestamp = quantity(block?.timestamp); if (!block || quantity(block.number) !== headNumber || !hash(block.hash) || timestamp === null || timestamp > BigInt(Number.MAX_SAFE_INTEGER)) throw Error('malformed_status');
    const rawReturn = await request('eth_call', [{ to: ACTIVE.statusTarget, data: calldata }, { blockHash: block.hash, requireCanonical: true }]);
    const after = await request('eth_getBlockByNumber', [`0x${headNumber.toString(16)}`, false]); if (!after || after.hash?.toLowerCase() !== block.hash.toLowerCase()) return { status: 'unavailable', reason: 'reorg' };
    const value = decodeStatus(rawReturn); return { status: value.isGraduated ? 'above_threshold' : 'below_threshold', block: { number: headNumber.toString(), hash: block.hash, timestamp: block.timestamp }, rawReturn, ...value };
  } catch (error) {
    if (error instanceof TransportFailure) return { status: 'unavailable', reason: 'rpc_unavailable' };
    if (error?.message === 'malformed_status') return { status: 'unavailable', reason: 'malformed_status' };
    throw error;
  }
}
