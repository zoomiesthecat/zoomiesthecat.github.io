function groupInteger(value) {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatHumanAmount(value) {
  const [whole, fraction] = value.split('.');
  return `${groupInteger(whole)}${fraction ? `.${fraction}` : ''}`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'https:'
      && parsed.username === ''
      && parsed.password === ''
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function evidenceLinks(urls = {}) {
  return Object.entries(urls)
    .map(([label, url]) => {
      const safeUrl = safeHttpUrl(url);
      return safeUrl
        ? `<li><a href="${escapeHtml(safeUrl)}" rel="external noopener">${escapeHtml(label)}</a></li>`
        : '';
    })
    .join('');
}

function contextEvidence(result) {
  if (!result.observation || !result.pool) return '';
  return `
    <section aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">Recorded context</h2>
      <dl>
        <dt>Network</dt><dd>Robinhood Chain (${escapeHtml(result.observation.chain_id)})</dd>
        <dt>Block</dt><dd>${escapeHtml(groupInteger(result.observation.block_number))}</dd>
        <dt>Observed</dt><dd><time datetime="${escapeHtml(result.observation.observed_at)}">${escapeHtml(result.observation.observed_at)}</time></dd>
        <dt>Canonical pool</dt><dd><code>${escapeHtml(result.pool.address)}</code></dd>
      </dl>
      <ul>${evidenceLinks(result.evidence_urls)}</ul>
    </section>`;
}

function renderUnavailable(result) {
  const heading = result.status === 'stale' ? 'Query stale' : 'Query unavailable';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Read-only, amount-specific pons exit observation">
  <title>${heading} — Pons Lens by ZOOMIES</title>
</head>
<body>
  <main>
    <p>Pons Lens by ZOOMIES</p>
    <h1>${heading}</h1>
    <p role="alert">${escapeHtml(result.failure.message)}</p>
    <p>Missing or invalid evidence is not a zero value.</p>${contextEvidence(result)}
    <p>Pons Lens is independent software by ZOOMIES and is not affiliated with Pons Labs or Robinhood.</p>
    <p>Read-only observation. Not financial advice.</p>
  </main>
</body>
</html>
`;
}

function renderAvailable(result) {
  const { token, pool, observation, values, sources, evidence_urls: urls } = result;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="description" content="Read-only, amount-specific pons exit observation">
  <title>Pons Lens by ZOOMIES</title>
</head>
<body>
  <main>
    <header>
      <p>Pons Lens by ZOOMIES</p>
      <h1>${escapeHtml(token.symbol)} Exit Lens</h1>
      <p>Pons Lens is independent software by ZOOMIES and is not affiliated with Pons Labs or Robinhood.</p>
    </header>
    <section aria-labelledby="query-heading">
      <h2 id="query-heading">Query</h2>
      <dl>
        <dt>Token amount</dt><dd>${escapeHtml(formatHumanAmount(token.amount))} ${escapeHtml(token.symbol)}</dd>
        <dt>Token</dt><dd><code>${escapeHtml(token.address)}</code></dd>
        <dt>Canonical pool</dt><dd><code>${escapeHtml(pool.address)}</code></dd>
      </dl>
    </section>
    <section aria-labelledby="values-heading">
      <h2 id="values-heading">Amount-specific values</h2>
      <dl>
        <dt>Spot-Marked Value</dt><dd>${escapeHtml(values.spot_marked.display)} WETH</dd>
        <dt>Exit Quote</dt><dd>${escapeHtml(values.exit_quote.display)} WETH</dd>
        <dt>Realization Gap</dt><dd>${escapeHtml(values.realization_gap.display)} WETH${values.realization_gap.percentage_state === 'available' ? ` (${escapeHtml(values.realization_gap.percentage)}%)` : ''}</dd>
        ${values.realization_gap.percentage_state === 'available' ? '' : '<dt>Realization Gap percentage</dt><dd>Percentage unavailable at wei precision</dd>'}
      </dl>
      <p>This quote is an observation, not a guaranteed or executable exit.</p>
    </section>
    ${result.supplemental?.usd
      ? `<section aria-labelledby="supplemental-heading">
      <h2 id="supplemental-heading">Supplemental reference</h2>
      <p>${['available', 'stale'].includes(result.supplemental.usd.state)
        ? `WETH/USD reference${result.supplemental.usd.state === 'stale' ? ' (stale)' : ''}: ${escapeHtml(result.supplemental.usd.price_usd)}; source: ${escapeHtml(result.supplemental.usd.source)}; observed: <time datetime="${escapeHtml(result.supplemental.usd.observed_at)}">${escapeHtml(result.supplemental.usd.observed_at)}</time>`
        : result.supplemental.usd.state === 'unknown'
          ? 'USD conversion unknown.'
          : 'USD conversion unavailable.'}</p>
    </section>`
      : ''}
    <section aria-labelledby="evidence-heading">
      <h2 id="evidence-heading">Evidence and freshness</h2>
      <dl>
        <dt>Network</dt><dd>Robinhood Chain (${escapeHtml(observation.chain_id)})</dd>
        <dt>Block</dt><dd>${escapeHtml(groupInteger(observation.block_number))}</dd>
        <dt>Observed</dt><dd><time datetime="${escapeHtml(observation.observed_at)}">${escapeHtml(observation.observed_at)}</time></dd>
        <dt>Launch source</dt><dd>${escapeHtml(sources.launch)}</dd>
        <dt>Spot source</dt><dd>${escapeHtml(sources.spot)}</dd>
        <dt>Quote source</dt><dd>${escapeHtml(sources.quote)}</dd>
      </dl>
      <ul>${evidenceLinks(urls)}</ul>
    </section>
    <footer>
      <p>Read-only observation. Not financial advice. Verify addresses and current pool conditions independently.</p>
    </footer>
  </main>
</body>
</html>
`;
}

export function renderExitLensHtml(result) {
  return result.status === 'available'
    ? renderAvailable(result)
    : renderUnavailable(result);
}
