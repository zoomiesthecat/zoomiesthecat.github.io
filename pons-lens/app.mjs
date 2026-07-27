import {
  PUBLIC_ROBINHOOD_RPC,
  buildLiveExitLensArtifact,
  createFallbackRpcRequest,
  createJsonRpcRequest
} from './runtime/live/index.mjs';
import {
  createExitLensPageController,
  parseExitLensQuery,
  renderPublicExitLensResult,
  serializeExitLensQuery
} from './page.mjs';

const form = /** @type {HTMLFormElement} */ (document.querySelector('#exit-query'));
const tokenInput = /** @type {HTMLInputElement} */ (document.querySelector('#token'));
const amountInput = /** @type {HTMLInputElement} */ (document.querySelector('#amount'));
const status = /** @type {HTMLElement} */ (document.querySelector('#query-status'));
const result = /** @type {HTMLElement} */ (document.querySelector('#result'));
const submitButton = /** @type {HTMLButtonElement} */ (form.querySelector('[type="submit"]'));
const submitLabel = /** @type {HTMLElement} */ (submitButton.querySelector('.primary-button__label'));
const copyButton = /** @type {HTMLButtonElement} */ (document.querySelector('#copy-query'));
const exampleButton = /** @type {HTMLButtonElement} */ (document.querySelector('#use-example'));
const brandMedia = /** @type {HTMLImageElement | null} */ (document.querySelector('.brand-media'));
const idleMarkup = result.innerHTML;

const request = createFallbackRpcRequest({
  primary: createJsonRpcRequest({ url: PUBLIC_ROBINHOOD_RPC }),
  fallback: createJsonRpcRequest({
    url: new URL('rpc', document.baseURI).href,
    timeoutMs: 20_000
  })
});
const baseUrl = new URL('./', document.baseURI).href;

if (brandMedia !== null) {
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  let visible = true;

  function syncBrandMotion() {
    const animated = visible
      && document.visibilityState === 'visible'
      && !reducedMotion.matches;
    const source = animated
      ? brandMedia.dataset.animatedSrc
      : brandMedia.dataset.staticSrc;
    brandMedia.dataset.motion = animated ? 'animated' : 'static';
    if (source && brandMedia.getAttribute('src') !== source) {
      brandMedia.setAttribute('src', source);
    }
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver(([entry]) => {
      visible = entry?.isIntersecting ?? true;
      syncBrandMotion();
    });
    observer.observe(brandMedia);
  }
  reducedMotion.addEventListener?.('change', syncBrandMotion);
  document.addEventListener('visibilitychange', syncBrandMotion);
  syncBrandMotion();
}

function loadingMarkup() {
  return `<div class="loading-state" aria-hidden="true">
    <p class="eyebrow">Reading Robinhood Chain</p>
    <div class="skeleton-line skeleton-line--short"></div>
    <div class="skeleton-line skeleton-line--long"></div>
    <div class="skeleton-line"></div>
  </div>`;
}

function publicFailure() {
  return {
    status: 'unavailable',
    failure: {
      code: 'client_failure',
      message: 'The page could not complete this read. No value has been assumed.'
    },
    values: {
      spot_marked: { state: 'unknown' },
      exit_quote: { state: 'unknown' },
      realization_gap: { state: 'unknown' }
    },
    supplemental: { usd: { state: 'unknown' } }
  };
}

// The query behind the rendered result, so a shared link never describes
// whatever the input boxes have been edited to since.
let sharedQuery = null;

function renderState(state) {
  tokenInput.removeAttribute('aria-invalid');
  amountInput.removeAttribute('aria-invalid');

  if (state.phase === 'idle') {
    sharedQuery = null;
    form.setAttribute('aria-busy', 'false');
    submitButton.disabled = false;
    submitLabel.textContent = 'Read current pool';
    result.setAttribute('aria-busy', 'false');
    copyButton.hidden = true;
    status.textContent = 'Ready for a token and amount.';
    result.innerHTML = idleMarkup;
    return;
  }

  if (state.phase === 'loading') {
    sharedQuery = state.query;
    form.setAttribute('aria-busy', 'true');
    submitButton.disabled = true;
    submitLabel.textContent = 'Reading pool…';
    result.setAttribute('aria-busy', 'true');
    copyButton.hidden = true;
    status.textContent = 'Reading a fresh Robinhood Chain observation…';
    result.innerHTML = loadingMarkup();
    return;
  }

  form.setAttribute('aria-busy', 'false');
  submitButton.disabled = false;
  submitLabel.textContent = 'Read current pool';
  result.setAttribute('aria-busy', 'false');
  result.innerHTML = renderPublicExitLensResult(state.result);
  copyButton.hidden = sharedQuery === null;
  if (state.result.failure?.code === 'invalid_token_address') {
    tokenInput.setAttribute('aria-invalid', 'true');
  }
  if (['invalid_amount', 'amount_exceeds_supply'].includes(state.result.failure?.code)) {
    amountInput.setAttribute('aria-invalid', 'true');
  }
  status.textContent = state.result.status === 'available'
    ? `Fresh result loaded at block ${state.result.observation.block_number}.`
    : `${state.result.failure.message}`;
}

const controller = createExitLensPageController({
  baseUrl,
  observe: async ({ token, amount }) => {
    const artifact = await buildLiveExitLensArtifact({
      tokenAddress: token,
      amount,
      request
    });
    return artifact.result;
  },
  onState: renderState,
  onUrlChange: (url) => history.pushState(null, '', url)
});

function syncInputsFromUrl(url) {
  const query = parseExitLensQuery(url);
  if (query === null) {
    tokenInput.value = '';
    amountInput.value = '';
    return;
  }
  tokenInput.value = query.token;
  amountInput.value = query.amount;
}

async function run(action) {
  try {
    await action();
  } catch {
    renderState({ phase: 'result', result: publicFailure() });
  }
}

form.addEventListener('submit', (event) => {
  event.preventDefault();
  const input = {
    token: tokenInput.value.trim(),
    amount: amountInput.value.trim()
  };
  run(() => controller.submit(input));
});

exampleButton.addEventListener('click', () => {
  tokenInput.value = exampleButton.dataset.token;
  amountInput.value = exampleButton.dataset.amount;
  amountInput.focus();
});

copyButton.addEventListener('click', async () => {
  if (sharedQuery === null) return;
  const url = serializeExitLensQuery(baseUrl, sharedQuery);
  try {
    await navigator.clipboard.writeText(url);
    status.textContent = 'Query link copied. Opening it will request fresh data.';
  } catch {
    status.textContent = 'Copy unavailable. Use the token-and-amount URL in the address bar.';
  }
});

window.addEventListener('popstate', () => {
  syncInputsFromUrl(window.location.href);
  run(() => controller.open(window.location.href));
});

syncInputsFromUrl(window.location.href);
run(() => controller.open(window.location.href));
