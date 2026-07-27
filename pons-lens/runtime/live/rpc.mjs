import { LiveObservationError } from './contracts.mjs';

const READ_ONLY_METHODS = new Set([
  'eth_chainId',
  'eth_blockNumber',
  'eth_getBlockByNumber',
  'eth_getCode',
  'eth_call'
]);

export const PUBLIC_ROBINHOOD_RPC = 'https://rpc.mainnet.chain.robinhood.com';
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const DATA = /^0x(?:[0-9a-fA-F]{2})*$/;
const BLOCK_TAG = /^0x(?:0|[1-9a-fA-F][0-9a-fA-F]*)$/;
const NETWORK_ATTEMPTS = 3;
const MAX_BATCH_CALLS = 16;

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function hasOnlyKeys(value, expected) {
  return value !== null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === expected.length
    && expected.every((key) => Object.hasOwn(value, key));
}

function validateReadParams(method, params) {
  if (!Array.isArray(params)) throw new TypeError('JSON-RPC params must be an array');
  if (method === 'eth_chainId' || method === 'eth_blockNumber') {
    if (params.length !== 0) throw new TypeError(`${method} does not accept params`);
    return;
  }
  if (method === 'eth_getBlockByNumber') {
    if (params.length !== 2 || !BLOCK_TAG.test(params[0]) || params[1] !== false) {
      throw new TypeError('eth_getBlockByNumber requires one numeric block tag and false');
    }
    return;
  }
  if (method === 'eth_getCode') {
    if (params.length !== 2 || !ADDRESS.test(params[0]) || !BLOCK_TAG.test(params[1])) {
      throw new TypeError('eth_getCode requires one address and one numeric block tag');
    }
    return;
  }
  if (method === 'eth_call') {
    const call = params[0];
    if (params.length !== 2
      || !hasOnlyKeys(call, ['to', 'data'])
      || !ADDRESS.test(call.to)
      || !DATA.test(call.data)
      || !BLOCK_TAG.test(params[1])) {
      throw new TypeError('eth_call requires only to, data, and one numeric block tag');
    }
  }
}

function validateRpcUrl(value) {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)
    || parsed.username !== ''
    || parsed.password !== '') {
    throw new TypeError('RPC URL must be an HTTP(S) URL without embedded credentials');
  }
  return parsed.href;
}

export function createJsonRpcRequest({
  url = PUBLIC_ROBINHOOD_RPC,
  fetchImpl = globalThis.fetch,
  timeoutMs = 10_000
} = {}) {
  const rpcUrl = validateRpcUrl(url);
  if (typeof fetchImpl !== 'function') throw new TypeError('fetchImpl must be a function');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('timeoutMs must be a positive integer');
  }
  let nextId = 1;

  function prepareCall(method, params) {
    if (!READ_ONLY_METHODS.has(method)) {
      throw new Error(`JSON-RPC method is not allowed: ${method}`);
    }
    validateReadParams(method, params);
    const id = nextId;
    nextId += 1;
    return { jsonrpc: '2.0', id, method, params };
  }

  async function send(calls, isBatch) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      let response;
      for (let attempt = 1; attempt <= NETWORK_ATTEMPTS; attempt += 1) {
        try {
          response = await fetchImpl(rpcUrl, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(isBatch ? calls : calls[0]),
            signal: controller.signal
          });
          break;
        } catch (error) {
          if (controller.signal.aborted || attempt === NETWORK_ATTEMPTS) {
            throw new LiveObservationError(
              'rpc_failure',
              'Robinhood Chain RPC request failed.',
              error
            );
          }
          await wait(attempt * 100);
        }
      }
      if (!response || response.ok !== true) {
        throw new LiveObservationError(
          'rpc_failure',
          `Robinhood Chain RPC returned HTTP ${response?.status ?? 'failure'}.`
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch (error) {
        throw new LiveObservationError(
          'malformed_rpc_response',
          'RPC returned malformed JSON.',
          error
        );
      }
      const responses = isBatch ? payload : [payload];
      if (!Array.isArray(responses) || responses.length !== calls.length) {
        throw new LiveObservationError(
          'malformed_rpc_response',
          'RPC returned an invalid JSON-RPC response.'
        );
      }
      const byId = new Map();
      for (const item of responses) {
        if (!item
          || item.jsonrpc !== '2.0'
          || !Number.isSafeInteger(item.id)
          || byId.has(item.id)
          || (!Object.hasOwn(item, 'error') && !Object.hasOwn(item, 'result'))
          || (Object.hasOwn(item, 'error') && Object.hasOwn(item, 'result'))) {
          throw new LiveObservationError(
            'malformed_rpc_response',
            'RPC returned an invalid JSON-RPC response.'
          );
        }
        byId.set(item.id, item);
      }

      return calls.map(({ id }) => {
        const item = byId.get(id);
        if (!item) {
          throw new LiveObservationError(
            'malformed_rpc_response',
            'RPC returned an invalid JSON-RPC response.'
          );
        }
        return Object.hasOwn(item, 'error')
          ? new LiveObservationError('rpc_call_error', 'RPC call returned an error.')
          : item.result;
      });
    } finally {
      clearTimeout(timer);
    }
  }

  async function request(method, params = []) {
    const [result] = await send([prepareCall(method, params)], false);
    if (result instanceof Error) throw result;
    return result;
  }

  request.batch = async (calls) => {
    if (!Array.isArray(calls)
      || calls.length === 0
      || calls.length > MAX_BATCH_CALLS) {
      throw new TypeError(`JSON-RPC batch must contain 1-${MAX_BATCH_CALLS} calls`);
    }
    const prepared = calls.map((call) => {
      if (!hasOnlyKeys(call, ['method', 'params'])) {
        throw new TypeError('JSON-RPC batch calls require only method and params');
      }
      return prepareCall(call.method, call.params);
    });
    return send(prepared, true);
  };

  return request;
}

export function createFallbackRpcRequest({ primary, fallback }) {
  if (typeof primary !== 'function' || typeof fallback !== 'function') {
    throw new TypeError('primary and fallback must be request functions');
  }
  let primaryUnavailable = false;

  async function request(method, params = []) {
    if (primaryUnavailable) return fallback(method, params);
    try {
      return await primary(method, params);
    } catch (error) {
      if (!(error instanceof LiveObservationError) || error.code !== 'rpc_failure') {
        throw error;
      }
      primaryUnavailable = true;
      return fallback(method, params);
    }
  }

  async function runBatch(adapter, calls) {
    if (typeof adapter.batch === 'function') return adapter.batch(calls);
    const results = [];
    for (const { method, params } of calls) {
      try {
        results.push(await adapter(method, params));
      } catch (error) {
        if (error instanceof LiveObservationError && error.code === 'rpc_failure') {
          throw error;
        }
        results.push(error);
      }
    }
    return results;
  }

  request.batch = async (calls) => {
    if (primaryUnavailable) return runBatch(fallback, calls);
    try {
      return await runBatch(primary, calls);
    } catch (error) {
      if (!(error instanceof LiveObservationError) || error.code !== 'rpc_failure') {
        throw error;
      }
      primaryUnavailable = true;
      return runBatch(fallback, calls);
    }
  };

  return request;
}
