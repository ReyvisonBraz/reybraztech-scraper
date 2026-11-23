const DEFAULT_TIMEOUT_MS = 1_500;
const DEFAULT_ACTION_TIMEOUT_MS = 1_500;
const DEFAULT_MAX_PAGES = 20;

function isTimeout(error) {
  return error?.name === 'TimeoutError';
}

async function waitForTerminalState(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const status = document.querySelector('[role="status"]');
      return status && ['ready', 'error'].includes(status.dataset.state);
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function readStatus(page) {
  return page.getByRole('status').getAttribute('data-state');
}

async function reportResult(logger, result, startedAt, errorCode) {
  const event = {
    stage: 'account_search',
    ...result,
    durationMs: Date.now() - startedAt,
  };
  if (errorCode) event.errorCode = errorCode;

  try {
    await logger(event);
    return result;
  } catch {
    return { status: 'audit_error', resultCount: 0 };
  }
}

export async function searchAccount(
  page,
  account,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    actionTimeoutMs = DEFAULT_ACTION_TIMEOUT_MS,
    maxPages = DEFAULT_MAX_PAGES,
    logger,
  } = {},
) {
  const target = typeof account === 'string' ? account.trim() : '';
  const startedAt = Date.now();
  let result = { status: 'invalid_input', resultCount: 0 };
  let errorCode;

  if (typeof logger !== 'function') {
    return { status: 'audit_error', resultCount: 0 };
  }

  if (
    !target ||
    !Number.isFinite(timeoutMs) ||
    timeoutMs <= 0 ||
    !Number.isFinite(actionTimeoutMs) ||
    actionTimeoutMs <= 0 ||
    !Number.isInteger(maxPages) ||
    maxPages <= 0
  ) {
    return reportResult(logger, result, startedAt, 'invalid_input_or_options');
  }

  const accounts = [];
  let pageNumber = 0;

  try {
    await page.getByRole('textbox', { name: 'Account', exact: true }).fill(target, { timeout: actionTimeoutMs });
    await page.getByRole('button', { name: 'Search', exact: true }).click({ timeout: actionTimeoutMs });
    await waitForTerminalState(page, timeoutMs);

    while (true) {
      const statuses = page.getByRole('status');
      if (await statuses.count() !== 1) {
        errorCode = 'status_count';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      const pageState = await readStatus(page);
      if (pageState === 'error') {
        result = {
          status: pageNumber === 0 ? 'search_error' : 'incomplete',
          resultCount: accounts.length,
        };
        break;
      }
      if (pageState !== 'ready') {
        errorCode = 'unexpected_status';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      const tables = page.getByRole('table', { name: 'Accounts', exact: true });
      if (await tables.count() !== 1) {
        errorCode = 'accounts_table_count';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      const table = tables.first();
      const headers = table.getByRole('columnheader');
      const bodies = table.locator('tbody');
      if (
        await headers.count() !== 1 ||
        (await headers.first().innerText()).trim() !== 'Account' ||
        await bodies.count() !== 1
      ) {
        errorCode = 'accounts_table_structure';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      const pageValue = await statuses.getAttribute('data-page');
      if (!/^\d+$/.test(pageValue ?? '') || Number(pageValue) !== pageNumber) {
        errorCode = 'page_marker_mismatch';
        result = { status: 'incomplete', resultCount: accounts.length };
        break;
      }

      const rows = table.locator('tbody tr[data-account-row]');
      const rowCount = await rows.count();
      const statusText = (await statuses.innerText()).trim();
      if (
        (rowCount === 0 && statusText !== 'No results') ||
        (rowCount > 0 && statusText !== 'Search complete')
      ) {
        errorCode = 'status_text_mismatch';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      for (let index = 0; index < rowCount; index += 1) {
        const cells = rows.nth(index).locator('td');
        if (await cells.count() !== 1) {
          errorCode = 'account_cell_count';
          result = { status: 'ui_error', resultCount: accounts.length };
          break;
        }
        const accountText = (await cells.first().innerText()).trim();
        if (!accountText) {
          errorCode = 'account_cell_empty';
          result = { status: 'ui_error', resultCount: accounts.length };
          break;
        }
        accounts.push(accountText);
      }
      if (result.status === 'ui_error') break;

      const nextPage = page.getByRole('button', {
        name: 'Next page',
        exact: true,
        includeHidden: true,
      });
      if (await nextPage.count() !== 1) {
        errorCode = 'pager_count';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }

      const nextPageVisible = await nextPage.isVisible();
      const nextPageEnabled = await nextPage.isEnabled();
      if (nextPageVisible !== nextPageEnabled) {
        errorCode = 'pager_state_mismatch';
        result = { status: 'ui_error', resultCount: accounts.length };
        break;
      }
      const hasNextPage = nextPageVisible && nextPageEnabled;
      if (!hasNextPage) {
        if (accounts.length === 0) {
          result = { status: 'not_found', resultCount: 0 };
        } else if (accounts.length > 1) {
          result = { status: 'ambiguous', resultCount: accounts.length };
        } else if (accounts[0] !== target) {
          result = { status: 'mismatch', resultCount: accounts.length };
        } else {
          result = { status: 'found', resultCount: 1 };
        }
        break;
      }

      if (pageNumber + 1 >= maxPages) {
        errorCode = 'page_limit_reached';
        result = { status: 'incomplete', resultCount: accounts.length };
        break;
      }

      pageNumber += 1;
      await nextPage.click({ timeout: actionTimeoutMs });
      await waitForTerminalState(page, timeoutMs);
      const advancedPage = await statuses.getAttribute('data-page');
      if (!/^\d+$/.test(advancedPage ?? '') || Number(advancedPage) !== pageNumber) {
        errorCode = 'page_did_not_advance';
        result = { status: 'incomplete', resultCount: accounts.length };
        break;
      }
    }
  } catch (error) {
    const timedOut = isTimeout(error);
    result = {
      status: timedOut ? 'timeout' : 'ui_error',
      resultCount: accounts.length,
    };
    errorCode = timedOut ? 'ui_timeout' : 'ui_unexpected';
  }

  return reportResult(logger, result, startedAt, errorCode);
}
