import { ACTIVE } from './core.mjs';

export const TOOL = 'graduation-autopsy';
export const RPC_METHODS = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_call']);
export function parseGraduationQuery(input) {
  const url = new URL(input, 'https://example.test/pons-lens/graduation-autopsy.html');
  const token = url.searchParams.get('token');
  return url.searchParams.get('tool') === TOOL && token !== null ? { token: token.trim() } : null;
}
export function serializeGraduationQuery(baseUrl, token) {
  const url = new URL(baseUrl, 'https://example.test/pons-lens/graduation-autopsy.html'); url.search = ''; url.searchParams.set('tool', TOOL); url.searchParams.set('token', String(token).trim()); return url.href;
}
export class TransportFailure extends Error {}
export function createGraduationRpcTransport({ fetchImpl = globalThis.fetch, directUrl = 'https://rpc.mainnet.chain.robinhood.com/', proxyUrl, timeoutMs = 12000 } = {}) {
  const request = async (url, method, params) => {
    if (!RPC_METHODS.has(method)) throw Error('rpc_method_not_allowed');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response; try { response = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: controller.signal }); } catch { throw new TransportFailure('network'); }
      if (!response?.ok) throw new TransportFailure('http');
      const body = await response.json(); if (!body || body.jsonrpc !== '2.0' || body.id !== 1 || Object.hasOwn(body, 'error') || !Object.hasOwn(body, 'result')) throw Error('malformed_rpc');
      return body.result;
    } finally { clearTimeout(timer); }
  };
  return async (method, params) => { try { return await request(directUrl, method, params); } catch (error) { if (!(error instanceof TransportFailure)) throw error; return request(proxyUrl, method, params); } };
}
export function createGraduationController({ baseUrl, observe, onState = () => {}, onUrlChange = () => {} } = {}) {
  const unavailable = reason => onState({ status: 'unavailable', reason });
  const run = async token => { if (!token || token.toLowerCase() !== ACTIVE.token) return unavailable('unsupported_token'); onState({ status: 'loading' }); try { onState({ status: 'result', result: await observe({ token }) }); } catch { unavailable('rpc_unavailable'); } };
  return { async open(url) { const query = parseGraduationQuery(url); if (!query) return unavailable('invalid_query'); return run(query.token); }, async submit(token) { const trimmed = String(token).trim(); onUrlChange(serializeGraduationQuery(baseUrl, trimmed)); return run(trimmed); } };
}
