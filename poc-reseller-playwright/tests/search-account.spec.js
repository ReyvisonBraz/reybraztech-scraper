import { expect, test } from '@playwright/test';
import { searchAccount } from '../src/search-account.js';

const FIXTURE_PORT = Number(process.env.POC_FIXTURE_PORT ?? 4173);
const FIXTURE_ORIGIN = `http://127.0.0.1:${FIXTURE_PORT}`;
const testLogger = () => {};
let blockedRequests;
let searchRequestCount;

test.beforeEach(async ({ page }) => {
  blockedRequests = [];
  searchRequestCount = 0;
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.origin === FIXTURE_ORIGIN && url.pathname === '/api/search' && request.method() === 'POST') {
      searchRequestCount += 1;
    }
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    const allowed =
      url.origin === FIXTURE_ORIGIN &&
      ((route.request().method() === 'GET' && ['/', '/health', '/__test/metrics'].includes(url.pathname)) ||
        (route.request().method() === 'POST' && url.pathname === '/api/search'));

    if (allowed) {
      await route.continue();
      return;
    }

    blockedRequests.push({ method: route.request().method(), path: url.pathname });
    await route.abort('blockedbyclient');
  });

  await page.goto('/');
});

function search(page, account, options = {}) {
  return searchAccount(page, account, { logger: testLogger, ...options });
}

async function readFixtureMetrics() {
  const response = await fetch(`${FIXTURE_ORIGIN}/__test/metrics`);
  if (!response.ok) throw new Error('fixture_metrics_unavailable');
  return response.json();
}

test.afterEach(async () => {
  expect(blockedRequests).toEqual([]);
});

test('reports one exact Account match without returning the identifier', async ({ page }) => {
  const events = [];
  const result = await search(page, 'ACC-FOUND-001', { logger: (event) => events.push(event) });

  expect(result).toEqual({ status: 'found', resultCount: 1 });
  expect(events).toEqual([
    expect.objectContaining({ stage: 'account_search', status: 'found', resultCount: 1 }),
  ]);
});

test('requires an audit logger before searching', async ({ page }) => {
  const result = await searchAccount(page, 'ACC-FOUND-001');

  expect(result).toEqual({ status: 'audit_error', resultCount: 0 });
  expect(searchRequestCount).toBe(0);
});

test('rejects invalid inputs and fails closed if audit logging fails', async ({ page }) => {
  await expect(search(page, '   ')).resolves.toEqual({
    status: 'invalid_input',
    resultCount: 0,
  });
  await expect(search(page, 'ACC-FOUND-001', { maxPages: 0 })).resolves.toEqual({
    status: 'invalid_input',
    resultCount: 0,
  });
  await expect(
    searchAccount(page, 'ACC-FOUND-001', { logger: () => { throw new Error('audit unavailable'); } }),
  ).resolves.toEqual({ status: 'audit_error', resultCount: 0 });
  await expect(
    searchAccount(page, 'ACC-FOUND-001', {
      logger: async () => { throw new Error('audit unavailable'); },
    }),
  ).resolves.toEqual({ status: 'audit_error', resultCount: 0 });
});

test('distinguishes no results from a search error', async ({ page }) => {
  await expect(search(page, 'ACC-NONE-001')).resolves.toEqual({
    status: 'not_found',
    resultCount: 0,
  });
  await expect(search(page, 'ACC-ERROR-001')).resolves.toEqual({
    status: 'search_error',
    resultCount: 0,
  });
});

test('blocks multiple matches and non-exact results', async ({ page }) => {
  await expect(search(page, 'ACC-MULTI-001')).resolves.toEqual({
    status: 'ambiguous',
    resultCount: 2,
  });
  await expect(search(page, 'ACC-PARTIAL-001')).resolves.toEqual({
    status: 'mismatch',
    resultCount: 1,
  });
});

test('scans all pages before accepting a unique exact match', async ({ page }) => {
  await expect(search(page, 'ACC-PAGED-001')).resolves.toEqual({
    status: 'found',
    resultCount: 1,
  });
  await expect(search(page, 'ACC-PAGED-DUP-001')).resolves.toEqual({
    status: 'ambiguous',
    resultCount: 2,
  });
});

test('fails closed when a later page errors or the page limit is reached', async ({ page }) => {
  await expect(search(page, 'ACC-PAGED-ERROR-001')).resolves.toEqual({
    status: 'incomplete',
    resultCount: 1,
  });
  await expect(search(page, 'ACC-PAGED-001', { maxPages: 1 })).resolves.toEqual({
    status: 'incomplete',
    resultCount: 0,
  });
});

test('handles a response within the bound and fails safely on timeout', async ({ page }) => {
  await expect(search(page, 'ACC-QUICK-001', { timeoutMs: 1_000 })).resolves.toEqual({
    status: 'found',
    resultCount: 1,
  });
  const timeoutEvents = [];
  const metricsBeforeTimeout = await readFixtureMetrics();
  const timeoutPromise = searchAccount(page, 'ACC-SLOW-001', {
    timeoutMs: 2_000,
    actionTimeoutMs: 5_000,
    logger: (event) => timeoutEvents.push(event),
  });
  await expect.poll(async () => (await readFixtureMetrics()).receivedSearchCount, { timeout: 5_000 })
    .toBe(metricsBeforeTimeout.receivedSearchCount + 1);
  await expect(timeoutPromise).resolves.toEqual({
    status: 'timeout',
    resultCount: 0,
  });
  expect(timeoutEvents[0].errorCode).toBe('ui_timeout');
});

test('preserves partial read count when a later page times out, without accepting it', async ({ page }) => {
  const events = [];
  const metricsBefore = await readFixtureMetrics();
  const resultPromise = search(page, 'ACC-PAGED-SLOW-001', {
    timeoutMs: 2_000,
    actionTimeoutMs: 5_000,
    logger: (event) => events.push(event),
  });
  await expect.poll(async () => (await readFixtureMetrics()).receivedSearchCount, { timeout: 5_000 })
    .toBe(metricsBefore.receivedSearchCount + 2);
  const result = await resultPromise;

  expect(result).toEqual({ status: 'timeout', resultCount: 1 });
  expect(events[0]).toEqual(expect.objectContaining({ status: 'timeout', resultCount: 1 }));
});

test('never writes the search identifier to structured logs', async ({ page }) => {
  const events = [];
  const sentinel = 'ACCOUNT-SENTINEL-DO-NOT-LOG-7F3A';
  const result = await searchAccount(page, sentinel, { logger: (event) => events.push(event) });

  expect(result).toEqual({ status: 'found', resultCount: 1 });
  expect(JSON.stringify(events)).not.toContain(sentinel);
  expect(events).toEqual([
    expect.objectContaining({ stage: 'account_search', status: 'found', resultCount: 1 }),
  ]);
});

test('trims outer whitespace but keeps Account matching case-sensitive', async ({ page }) => {
  await expect(search(page, ' ACC-FOUND-001 ')).resolves.toEqual({
    status: 'found',
    resultCount: 1,
  });
  await expect(search(page, 'ACC-CASE-001')).resolves.toEqual({
    status: 'mismatch',
    resultCount: 1,
  });
});

test('fails closed if the result table is missing', async ({ page }) => {
  await page.evaluate(() => document.querySelector('table[aria-label="Accounts"]').remove());
  await expect(search(page, 'ACC-FOUND-001')).resolves.toEqual({ status: 'ui_error', resultCount: 0 });
});

test('fails closed if the table header changes', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('table th').textContent = 'Unexpected header';
  });
  await expect(search(page, 'ACC-FOUND-001')).resolves.toEqual({ status: 'ui_error', resultCount: 0 });
});

test('fails closed if the pager is missing', async ({ page }) => {
  await page.evaluate(() => document.querySelector('#next-page').remove());
  await expect(search(page, 'ACC-PAGED-001')).resolves.toEqual({ status: 'ui_error', resultCount: 0 });
});

test('fails closed when the hidden pager is enabled', async ({ page }) => {
  await page.evaluate(() => {
    const status = document.querySelector('[role="status"]');
    const pager = document.querySelector('#next-page');
    const observer = new MutationObserver(() => {
      if (status.dataset.state === 'ready') {
        pager.hidden = true;
        pager.disabled = false;
      }
    });
    observer.observe(status, { attributes: true, attributeFilter: ['data-state'] });
  });

  await expect(search(page, 'ACC-FOUND-001')).resolves.toEqual({ status: 'ui_error', resultCount: 1 });
});

test('fails closed when a visible pager is disabled', async ({ page }) => {
  await page.evaluate(() => {
    const status = document.querySelector('[role="status"]');
    const pager = document.querySelector('#next-page');
    const observer = new MutationObserver(() => {
      if (status.dataset.state === 'ready') {
        pager.hidden = false;
        pager.disabled = true;
      }
    });
    observer.observe(status, { attributes: true, attributeFilter: ['data-state'] });
  });

  await expect(search(page, 'ACC-PAGED-001')).resolves.toEqual({ status: 'ui_error', resultCount: 0 });
});

test('fails closed if a visible pager does not advance', async ({ page }) => {
  await page.evaluate(() => {
    document.querySelector('#next-page').addEventListener(
      'click',
      (event) => event.stopImmediatePropagation(),
      { capture: true },
    );
  });
  await expect(search(page, 'ACC-PAGED-001')).resolves.toEqual({ status: 'incomplete', resultCount: 0 });
});

test('times out on an unrecognized UI state instead of reporting no results', async ({ page }) => {
  await expect(search(page, 'ACC-UNKNOWN-STATE-001', { timeoutMs: 100 })).resolves.toEqual({
    status: 'timeout',
    resultCount: 0,
  });
});

test('blocks external requests and write-like routes before they reach a server', async ({ page }) => {
  await page.evaluate(async () => {
    await fetch('https://example.invalid/').catch(() => undefined);
    await fetch('/api/renew', { method: 'POST' }).catch(() => undefined);
  });

  expect(blockedRequests).toEqual([
    { method: 'GET', path: '/' },
    { method: 'POST', path: '/api/renew' },
  ]);
  blockedRequests = [];
});
