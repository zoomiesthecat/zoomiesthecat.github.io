export function serializeExitLensQuery(baseUrl, { token, amount }) {
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = '';
  url.searchParams.set('token', String(token).trim());
  url.searchParams.set('amount', String(amount).trim());
  return url.href;
}

export function parseExitLensQuery(value) {
  const url = new URL(value);
  const token = url.searchParams.get('token');
  const amount = url.searchParams.get('amount');
  return token !== null && amount !== null
    ? { token, amount }
    : null;
}

export function createExitLensPageController({
  baseUrl,
  observe,
  onState,
  onUrlChange
}) {
  let latestQuery = 0;

  async function query(input) {
    latestQuery += 1;
    const queryId = latestQuery;
    onState({ phase: 'loading', query: input });
    let result;
    try {
      result = await observe(input);
    } catch (error) {
      if (queryId !== latestQuery) return { phase: 'superseded', query: input };
      throw error;
    }
    if (queryId !== latestQuery) return { phase: 'superseded', query: input };
    const state = { phase: 'result', query: input, result };
    onState(state);
    return state;
  }

  return {
    async open(url) {
      const input = parseExitLensQuery(url);
      if (input === null) {
        latestQuery += 1;
        const state = { phase: 'idle' };
        onState(state);
        return state;
      }
      return query(input);
    },
    async submit(input) {
      onUrlChange(serializeExitLensQuery(baseUrl, input));
      return query(input);
    }
  };
}

export function renderPublicExitLensResult(result) {
  if (result.status !== 'available') {
    const code = result.failure?.code ?? 'unavailable';
    const title = FAILURE_TITLES[code] ?? 'Exit Lens unavailable';
    return `<article class="result-card result-card--failure" data-failure="${escapeHtml(code)}" aria-labelledby="result-title">
      <p class="eyebrow">Query state</p>
      <h2 id="result-title">${escapeHtml(title)}</h2>
      <p role="alert">${escapeHtml(result.failure?.message ?? 'The observation is unavailable.')}</p>
      <p class="failure-rule">Missing evidence is not a zero value.</p>
      ${failureValues(result)}
      ${failureEvidence(result)}
      <footer class="result-foot">
        <p><strong>Pons Lens by ZOOMIES</strong> is independent software, not affiliated with Pons Labs or Robinhood.</p>
        <p>Read-only observation. Not financial advice.</p>
      </footer>
    </article>`;
  }

  return `<article class="result-card" aria-labelledby="result-title">
    <header class="result-head">
      <div>
        <p class="eyebrow">Fresh amount-specific observation</p>
        <h2 id="result-title">${escapeHtml(result.token.symbol)} Exit Lens</h2>
      </div>
      <span class="state-chip">Available</span>
    </header>

    <section class="query-summary" aria-labelledby="query-summary-title">
      <h3 id="query-summary-title">Query</h3>
      <dl class="detail-list">
        <div><dt>Amount</dt><dd class="tabular">${escapeHtml(formatHumanAmount(result.token.amount))} ${escapeHtml(result.token.symbol)}</dd></div>
        <div><dt>Token</dt><dd><code>${escapeHtml(result.token.address)}</code></dd></div>
        <div><dt>Canonical pool</dt><dd><code>${escapeHtml(result.pool.address)}</code></dd></div>
      </dl>
    </section>

    <section aria-labelledby="values-title">
      <div class="section-heading">
        <h3 id="values-title">What the pool says</h3>
        <p>WETH · same amount · same block</p>
      </div>
      <dl class="value-grid">
        <div class="value-card">
          <dt>Spot-Marked Value</dt>
          <dd class="tabular">${escapeHtml(result.values.spot_marked.display)} <span>WETH</span></dd>
          <p>Marginal pool price applied to the full amount.</p>
        </div>
        <div class="value-card value-card--primary">
          <dt>Exit Quote</dt>
          <dd class="tabular">${escapeHtml(result.values.exit_quote.display)} <span>WETH</span></dd>
          <p>Amount-specific Quoter observation.</p>
        </div>
        <div class="value-card">
          <dt>Realization Gap</dt>
          <dd class="tabular">${escapeHtml(result.values.realization_gap.display)} <span>WETH</span></dd>
          <p class="gap-percent tabular">${escapeHtml(result.values.realization_gap.percentage)}%</p>
        </div>
      </dl>
      <p class="observation-note">This quote is an observation, not a guaranteed or executable exit.</p>
    </section>

    <section class="evidence-panel" aria-labelledby="evidence-title">
      <div class="section-heading">
        <h3 id="evidence-title">Evidence &amp; freshness</h3>
        <p>${escapeHtml(result.observation.freshness)}</p>
      </div>
      <dl class="detail-list">
        <div><dt>Robinhood Chain block</dt><dd class="tabular">${escapeHtml(groupInteger(result.observation.block_number))}</dd></div>
        <div><dt>Observed</dt><dd><time datetime="${escapeHtml(result.observation.observed_at)}">${escapeHtml(result.observation.observed_at)}</time></dd></div>
        ${sourceRows(result.sources)}
        <div><dt>Supplemental USD</dt><dd>${usdEvidence(result.supplemental?.usd)}</dd></div>
      </dl>
      <ul class="evidence-links">${evidenceLinks(result.evidence_urls)}</ul>
    </section>

    <footer class="result-foot">
      <p><strong>Pons Lens by ZOOMIES</strong> is independent software, not affiliated with Pons Labs or Robinhood.</p>
      <p>Read-only observation. Not financial advice. Verify current pool conditions independently.</p>
    </footer>
  </article>`;
}
function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function groupInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatHumanAmount(value) {
  const [whole, fraction] = String(value).split('.');
  return `${groupInteger(whole)}${fraction ? `.${fraction}` : ''}`;
}

function evidenceLinks(urls = {}) {
  return Object.entries(urls)
    .map(([label, value]) => {
      try {
        const url = new URL(value);
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') return '';
        return `<li><a href="${escapeHtml(url.href)}" aria-label="${escapeHtml(`${label} evidence (opens in a new tab)`)}" target="_blank" rel="external noopener noreferrer">${escapeHtml(label)} evidence <span aria-hidden="true">↗</span></a></li>`;
      } catch {
        return '';
      }
    })
    .join('');
}

function usdEvidence(usd) {
  if (!usd || usd.state === 'unknown') return 'USD reference unknown';
  if (usd.state === 'unavailable') return 'USD reference unavailable';
  if (usd.state === 'stale') {
    return `USD reference stale: $${escapeHtml(usd.price_usd)} from ${escapeHtml(usd.source)}, observed ${escapeHtml(usd.observed_at)}`;
  }
  return `USD reference: $${escapeHtml(usd.price_usd)} from ${escapeHtml(usd.source)}, observed ${escapeHtml(usd.observed_at)}`;
}

function sourceRows(sources = {}) {
  return [
    ['Launch source', sources.launch],
    ['Spot source', sources.spot],
    ['Quote source', sources.quote]
  ]
    .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
    .map(([label, value]) => `<div><dt>${label}</dt><dd>${escapeHtml(value)}</dd></div>`)
    .join('');
}

function failureValues(result) {
  const spot = result.values?.spot_marked;
  if (spot?.state !== 'available') return '';
  return `<section aria-labelledby="failure-values-title">
    <div class="section-heading">
      <h3 id="failure-values-title">What the pool still says</h3>
      <p>WETH · same amount · same block</p>
    </div>
    <dl class="value-grid value-grid--single">
      <div class="value-card">
        <dt>Spot-Marked Value</dt>
        <dd class="tabular">${escapeHtml(spot.display)} <span>WETH</span></dd>
        <p>Marginal pool price applied to the full amount. No exit quote was observed, so this is not an exit value.</p>
      </div>
    </dl>
  </section>`;
}

function failureEvidence(result) {
  const hasSources = Object.values(result.sources ?? {})
    .some((value) => typeof value === 'string' && value.trim() !== '');
  if (!result.observation && !result.pool?.address && !hasSources) return '';
  return `<section class="failure-evidence" aria-labelledby="failure-evidence-title">
    <h3 id="failure-evidence-title">Inspectable context</h3>
    <dl class="detail-list">
      ${result.observation ? `<div><dt>Robinhood Chain block</dt><dd class="tabular">${escapeHtml(groupInteger(result.observation.block_number))}</dd></div>
      <div><dt>Observed</dt><dd><time datetime="${escapeHtml(result.observation.observed_at)}">${escapeHtml(result.observation.observed_at)}</time></dd></div>` : ''}
      ${result.pool?.address ? `<div><dt>Canonical pool</dt><dd><code>${escapeHtml(result.pool.address)}</code></dd></div>` : ''}
      ${sourceRows(result.sources)}
      <div><dt>Supplemental USD</dt><dd>${usdEvidence(result.supplemental?.usd)}</dd></div>
    </dl>
    <ul class="evidence-links">${evidenceLinks(result.evidence_urls)}</ul>
  </section>`;
}

const FAILURE_TITLES = Object.freeze({
  invalid_token_address: 'Invalid token address',
  invalid_amount: 'Invalid amount',
  amount_exceeds_supply: 'Amount exceeds token supply',
  unsupported_token: 'Unsupported pons token',
  unsupported_token_decimals: 'Unsupported token decimals',
  unsupported_factory_generation: 'Unsupported pons factory',
  missing_canonical_pool: 'Canonical pool unavailable',
  spoofed_pool_relationship: 'Pool relationship rejected',
  no_usable_liquidity: 'No usable liquidity',
  stale_observation: 'Observation stale',
  clock_skew: 'Device clock out of sync',
  rpc_failure: 'RPC unavailable',
  rpc_call_error: 'Contract read failed',
  malformed_rpc_response: 'Malformed chain response',
  invalid_observation: 'Incomplete observation',
  reorg_detected: 'Observation changed during read',
  quote_unavailable: 'Exit quote unavailable',
  client_failure: 'Page read failed'
});
