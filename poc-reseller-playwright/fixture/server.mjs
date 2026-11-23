import { createServer } from 'node:http';

const PORT = Number(process.env.POC_FIXTURE_PORT ?? 4173);
const MAX_BODY_BYTES = 4_096;
let receivedSearchCount = 0;

if (!Number.isInteger(PORT) || PORT < 1_024 || PORT > 65_535) {
  process.stderr.write(`${JSON.stringify({ status: 'fixture_port_invalid' })}\n`);
  process.exit(1);
}

const html = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Local account search fixture</title></head>
  <body>
    <main>
      <h1>Local account search fixture</h1>
      <form id="search-form">
        <label for="account">Account</label>
        <input id="account" name="account" autocomplete="off">
        <button type="submit">Search</button>
      </form>
      <p role="status" aria-live="polite" data-state="idle" data-page="0">Ready</p>
      <table aria-label="Accounts">
        <thead><tr><th scope="col">Account</th></tr></thead>
        <tbody id="account-rows"></tbody>
      </table>
      <button id="next-page" type="button" aria-label="Next page" hidden disabled>Next page</button>
    </main>
    <script>
      const form = document.querySelector('#search-form');
      const input = document.querySelector('#account');
      const status = document.querySelector('[role="status"]');
      const rows = document.querySelector('#account-rows');
      const nextPage = document.querySelector('#next-page');
      let requestedAccount = '';
      let currentPage = 0;

      function setState(state, text) {
        status.dataset.state = state;
        status.textContent = text;
      }

      async function fetchPage() {
        setState('loading', 'Searching');
        nextPage.hidden = true;
        nextPage.disabled = true;

        try {
          const response = await fetch('/api/search', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ account: requestedAccount, page: currentPage }),
          });
          if (!response.ok) throw new Error('search_failed');

          const data = await response.json();
          status.dataset.page = String(currentPage);
          if (data.uiState) {
            setState(data.uiState, 'Unexpected state');
            return;
          }
          rows.replaceChildren(...data.accounts.map((account) => {
            const row = document.createElement('tr');
            row.dataset.accountRow = 'true';
            const cell = document.createElement('td');
            cell.textContent = account;
            row.append(cell);
            return row;
          }));

          nextPage.hidden = !data.hasNextPage;
          nextPage.disabled = !data.hasNextPage;
          setState('ready', data.accounts.length === 0 ? 'No results' : 'Search complete');
        } catch {
          status.dataset.page = String(currentPage);
          rows.replaceChildren();
          nextPage.hidden = true;
          nextPage.disabled = true;
          setState('error', 'Search failed');
        }
      }

      form.addEventListener('submit', async (event) => {
        event.preventDefault();
        requestedAccount = input.value.trim();
        currentPage = 0;
        rows.replaceChildren();
        await fetchPage();
      });

      nextPage.addEventListener('click', async () => {
        currentPage += 1;
        await fetchPage();
      });
    </script>
  </body>
</html>`;

function sendJson(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Error('request_too_large');
  }
  return JSON.parse(body);
}

function waitForResponseDelay(ms, response) {
  return new Promise((resolve) => {
    let timer;
    const finish = () => {
      if (timer) clearTimeout(timer);
      response.off('close', finish);
      resolve();
    };

    response.once('close', finish);
    timer = setTimeout(finish, ms);
  });
}

function fixtureResult(account, page) {
  const fixtures = {
    'ACC-FOUND-001': [{ accounts: ['ACC-FOUND-001'], hasNextPage: false }],
    'ACC-NONE-001': [{ accounts: [], hasNextPage: false }],
    'ACC-PARTIAL-001': [{ accounts: ['ACC-PARTIAL-001-OTHER'], hasNextPage: false }],
    'ACC-MULTI-001': [{ accounts: ['ACC-MULTI-001', 'ACC-MULTI-002'], hasNextPage: false }],
    'ACC-PAGED-001': [
      { accounts: [], hasNextPage: true },
      { accounts: ['ACC-PAGED-001'], hasNextPage: false },
    ],
    'ACC-PAGED-DUP-001': [
      { accounts: ['ACC-PAGED-DUP-001'], hasNextPage: true },
      { accounts: ['ACC-PAGED-DUP-001'], hasNextPage: false },
    ],
    'ACC-PAGED-ERROR-001': [
      { accounts: ['ACC-PAGED-ERROR-001'], hasNextPage: true },
      { status: 503 },
    ],
    'ACC-PAGED-SLOW-001': [
      { accounts: ['ACC-PAGED-SLOW-001'], hasNextPage: true },
      { delayMs: 30_000, accounts: ['ACC-PAGED-SLOW-001'], hasNextPage: false },
    ],
    'ACC-QUICK-001': [{ delayMs: 100, accounts: ['ACC-QUICK-001'], hasNextPage: false }],
    'ACC-SLOW-001': [{ delayMs: 30_000, accounts: ['ACC-SLOW-001'], hasNextPage: false }],
    'ACC-ERROR-001': [{ status: 503 }],
    'ACC-UNKNOWN-STATE-001': [{ accounts: [], hasNextPage: false, uiState: 'unexpected' }],
    'ACC-CASE-001': [{ accounts: ['acc-case-001'], hasNextPage: false }],
    'ACCOUNT-SENTINEL-DO-NOT-LOG-7F3A': [
      { accounts: ['ACCOUNT-SENTINEL-DO-NOT-LOG-7F3A'], hasNextPage: false },
    ],
  };

  return fixtures[account]?.[page] ?? { accounts: [], hasNextPage: false };
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? '/', `http://127.0.0.1:${PORT}`);

  if (request.method === 'GET' && url.pathname === '/health') {
    sendJson(response, 200, { status: 'ok' });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/__test/metrics') {
    sendJson(response, 200, { receivedSearchCount });
    return;
  }

  if (request.method === 'GET' && url.pathname === '/') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
    return;
  }

  if (request.method === 'POST' && url.pathname === '/api/search') {
    try {
      const payload = await readJson(request);
      if (
        typeof payload.account !== 'string' ||
        !Number.isInteger(payload.page) ||
        payload.page < 0
      ) {
        sendJson(response, 400, { error: 'invalid_search' });
        return;
      }

      receivedSearchCount += 1;
      const result = fixtureResult(payload.account, payload.page);
      if (result.delayMs) await waitForResponseDelay(result.delayMs, response);
      if (response.destroyed) return;
      if (result.status) {
        sendJson(response, result.status, { error: 'fixture_search_error' });
        return;
      }

      sendJson(response, 200, {
        accounts: result.accounts,
        hasNextPage: result.hasNextPage,
        ...(result.uiState ? { uiState: result.uiState } : {}),
      });
      return;
    } catch {
      sendJson(response, 400, { error: 'invalid_search' });
      return;
    }
  }

  sendJson(response, 404, { error: 'not_found' });
});

server.on('error', (error) => {
  const code = error?.code === 'EADDRINUSE' ? 'fixture_port_in_use' : 'fixture_server_error';
  process.stderr.write(`${JSON.stringify({ status: code, port: PORT })}\n`);
  process.exitCode = 1;
});

server.listen(PORT, '127.0.0.1');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
