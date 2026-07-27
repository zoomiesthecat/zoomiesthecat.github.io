import { observeFeeLedger } from './runtime/fee-ledger/live.mjs';

const TOKEN = '0xb1f161a45e9f745412e5b10407463fb3fc7e46f9';
const WETH = '0x0bd7d308f8e1639fab988df18a8011f41eacad73';
const form = document.querySelector('#fee-query'); const input = document.querySelector('#token'); const status = document.querySelector('#query-status'); const result = document.querySelector('#result'); const copy = document.querySelector('#copy-query');
const rpcRequest = (id, method, params) => ({ jsonrpc: '2.0', id, method, params });
const hasOnlyResult = payload => Object.hasOwn(payload, 'result') && !Object.hasOwn(payload, 'error');
const hasOnlyError = payload => Object.hasOwn(payload, 'error') && !Object.hasOwn(payload, 'result');
const retryableMetadataError = error => error?.code === -32000 && /^metadata is not found(?:,\s*\d+)?$/i.test(error.message ?? '');
const retryableMetadataItems = (payload, length) => {
  if (!Array.isArray(payload) || payload.length !== length) return null;
  const ids = new Set();
  const retryable = [];
  for (const item of payload) {
    if (!item || typeof item !== 'object' || item.jsonrpc !== '2.0' || !Number.isSafeInteger(item.id) || item.id < 1 || item.id > length || ids.has(item.id) || (!hasOnlyResult(item) && !hasOnlyError(item))) return null;
    ids.add(item.id);
    if (hasOnlyError(item)) {
      if (!retryableMetadataError(item.error)) return null;
      retryable.push(item);
    }
  }
  return retryable.length > 0 && ids.size === length ? retryable : null;
};
class RpcTransportError extends Error {}
const RPC_TIMEOUT_MS = 12_000;
const rpcEndpoint = url => async body => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  let response;
  try {
    try { response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }); } catch { throw new RpcTransportError('rpc'); }
    if (!response || !response.ok) throw new RpcTransportError('rpc');
    try { return await response.json(); } catch { if (controller.signal.aborted) throw new RpcTransportError('rpc'); throw Error('rpc'); }
  } finally { clearTimeout(timer); }
};
const directRpc = rpcEndpoint('https://rpc.mainnet.chain.robinhood.com/');
const proxyRpc = rpcEndpoint(new URL('rpc', document.baseURI));
const sendRpc = async body => { try { return { payload: await directRpc(body), direct: true }; } catch (error) { if (!(error instanceof RpcTransportError)) throw error; return { payload: await proxyRpc(body), direct: false }; } };
export const rpc = async (method, params) => { const { payload } = await sendRpc(rpcRequest(1, method, params)); if (!payload || payload.jsonrpc !== '2.0' || payload.id !== 1 || !hasOnlyResult(payload)) throw Error('rpc'); return payload.result; };
rpc.batch = async calls => {
  if (!Array.isArray(calls) || calls.length === 0 || calls.length > 16) throw Error('rpc');
  const requests = calls.map(([method, params], index) => rpcRequest(index + 1, method, params));
  const initial = await sendRpc(requests);
  let payload = initial.payload;
  const repairs = initial.direct && retryableMetadataItems(payload, requests.length);
  if (repairs) {
    const repaired = new Map();
    for (const item of [...repairs].sort((a, b) => a.id - b.id)) {
      const request = requests[item.id - 1];
      const response = await directRpc(request);
      if (!response || response.jsonrpc !== '2.0' || response.id !== request.id || !hasOnlyResult(response)) throw Error('rpc');
      repaired.set(item.id, response);
    }
    payload = payload.map(item => repaired.get(item.id) ?? item);
  }
  if (!Array.isArray(payload) || payload.length !== requests.length) throw Error('rpc');
  const byId = new Map();
  for (const item of payload) {
    if (!item || item.jsonrpc !== '2.0' || !Number.isSafeInteger(item.id) || item.id < 1 || item.id > requests.length || byId.has(item.id) || !hasOnlyResult(item)) throw Error('rpc');
    byId.set(item.id, item.result);
  }
  if (byId.size !== requests.length) throw Error('rpc');
  return requests.map(request => byId.get(request.id));
};
const group = value => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
const share = value => { const url = new URL(location.href); url.search = ''; url.searchParams.set('tool', 'fee-ledger'); url.searchParams.set('token', value.toLowerCase()); return url.href; };
function unavailable(message) { result.innerHTML = `<article class="result-card result-card--failure"><h2>Fee Ledger unavailable</h2><p role="alert">${message}</p><p class="failure-rule">Missing evidence is not a zero value.</p></article>`; status.textContent = message; }
function assetLabel(asset) { const canonicalAsset = asset.toLowerCase(); if (canonicalAsset === WETH) return 'WETH'; if (canonicalAsset === TOKEN) return 'ZOOMIES'; return 'Asset'; }
function available(ledger) { const cards = Object.entries(ledger.values.claimed.assets).map(([asset, value]) => `<div class="value-card"><dt>${assetLabel(asset)} <code title="${asset}">${asset.slice(0, 10)}…${asset.slice(-8)}</code></dt><dd class="tabular">${group(value.totalAmount)}</dd><p>Creator ${group(value.recipientAmount)} · protocol ${group(value.protocolAmount)}</p></div>`).join(''); const proof = ledger.proof; const scan = `${proof.chunkCount} chunks · ${proof.claimCount} claims · ${proof.reconciliationCount} reconciliations · ${proof.mechanicsCallCount} mechanics calls`; result.innerHTML = `<article class="result-card"><h2>ZOOMIES Fee Ledger</h2><p>Fresh, exact bounded <code>FeesClaimed</code> evidence only.</p><dl class="value-grid">${cards}</dl><dl class="detail-list"><div><dt>Scan</dt><dd>${scan}</dd></div><div><dt>Inclusive scan</dt><dd class="tabular">${group(ledger.range.fromBlock)} – ${group(ledger.range.toBlock)}</dd></div><div><dt>Terminal block hash</dt><dd><code>${ledger.toBlockHash}</code></dd></div><div><dt>Unclaimed fees</dt><dd>unavailable</dd></div><div><dt>Fee origin</dt><dd>unproven</dd></div></dl><ul class="evidence-links">${Object.entries(ledger.evidenceUrls).map(([label, url]) => `<li><a href="${url}" target="_blank" rel="noopener noreferrer">${label} evidence</a></li>`).join('')}</ul><p>Creator WETH may fund legitimate ZOOMIES project costs. Creator ZOOMIES rewards are burned; no Lab or product wallet.</p></article>`; status.textContent = 'Fresh bounded fee evidence loaded.'; }
async function read() { result.setAttribute('aria-busy', 'true'); status.textContent = 'Reading fresh bounded fee evidence…'; try { const ledger = await observeFeeLedger({ rpc }); if (ledger.status !== 'available') return unavailable('Fresh chain evidence was incomplete or changed. No total has been assumed.'); available(ledger); } catch { unavailable('Fresh chain evidence is unavailable. No total has been assumed.'); } finally { result.setAttribute('aria-busy', 'false'); } }
function open() { const token = new URL(location.href).searchParams.get('token'); if (!token) return; input.value = token; copy.hidden = false; if (token.toLowerCase() !== TOKEN) return unavailable('Only canonical active ZOOMIES is supported; legacy or other tokens are unavailable.'); read(); }
form.addEventListener('submit', event => { event.preventDefault(); const token = input.value.trim(); history.pushState(null, '', share(token)); copy.hidden = false; if (token.toLowerCase() !== TOKEN) return unavailable('Only canonical active ZOOMIES is supported; legacy or other tokens are unavailable.'); read(); });
copy.addEventListener('click', () => navigator.clipboard?.writeText(share(input.value.trim()))); window.addEventListener('popstate', open); open();
