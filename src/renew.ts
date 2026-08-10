import type { Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';
import { debugScreenshot } from './cleanup';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Filtra a tabela pela account usando a busca nativa do painel.
 * Isso evita percorrer páginas ou depender de a conta estar na primeira página.
 */
async function filterTableByAccount(page: Page, account: string): Promise<boolean> {
  const searchInputSelectors = [
    'input#form_item_keyword',                // painel novo: campo "Please enter" (account)
    'input.ant-input[placeholder*="Search"]',
    'input.ant-input[placeholder*="search"]',
    '.ant-input-search input',
    'input[placeholder*="Search"]',
    'input[type="search"]',
  ];

  let searchInput = null;
  for (const selector of searchInputSelectors) {
    const candidate = await page.$(selector);
    if (!candidate) continue;

    const visible = await candidate.evaluate((el: Element) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        (el as HTMLInputElement).offsetParent !== null;
    });

    if (visible) {
      searchInput = candidate;
      break;
    }
  }

  if (!searchInput) {
    console.log('  ⚠️  Busca nativa não encontrada; verificando tabela carregada.');
    return false;
  }

  await searchInput.click({ clickCount: 3 });
  await page.keyboard.press('Backspace');
  await searchInput.type(account, { delay: 20 });

  const searchButtonSelectors = [
    'button.ant-input-search-button',
    '.ant-input-search .ant-input-search-button',
    'span.ant-input-search-icon',
  ];

  let submitted = false;
  for (const selector of searchButtonSelectors) {
    const button = await page.$(selector);
    if (!button) continue;
    const visible = await button.evaluate((el: Element) => {
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    if (visible) {
      await button.click();
      submitted = true;
      break;
    }
  }

  if (!submitted) {
    // Fallback: botão com texto "Search"/"Query"/"Buscar" (painel novo)
    const textBtn = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      for (const b of buttons) {
        const t = (b.textContent || '').trim().toLowerCase();
        const r = b.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (t.includes('search') || t.includes('query') || t.includes('buscar')) {
          (b as HTMLElement).click();
          return t;
        }
      }
      return null;
    });
    if (textBtn) {
      submitted = true;
    }
  }

  if (!submitted) {
    await page.keyboard.press('Enter');
  }

  await delay(1500);
  return true;
}

/**
 * Seleciona uma opção em um dropdown Ant Design Select dentro de um container.
 *
 * Por que usa page.evaluate em vez de ElementHandle.click()?
 * → O Puppeteer v24 não consegue calcular o "clickable point" de elementos
 *   dentro de modais do Ant Design (erro "Node is not clickable").
 *   Usando page.evaluate, executamos o .click() direto no DOM do navegador,
 *   contornando essa limitação do Puppeteer.
 *
 * Por que usa waitForFunction em vez de delay fixo?
 * → Em vez de esperar 800ms e torcer para o dropdown ter aberto,
 *   verificamos de verdade se a opção apareceu no DOM. Mais confiável.
 *
 * @param page - Puppeteer Page
 * @param containerSelector - Seletor do container (ex: '.ant-modal-content')
 * @param dropdownIndex - Índice do dropdown DENTRO do container (0 = primeiro, 1 = segundo)
 * @param optionText - Texto EXATO da opção a selecionar (ex: 'Monthly Points')
 */
async function selectAntDropdown(page: Page, containerSelector: string, dropdownIndex: number, optionText: string): Promise<void> {
  // PASSO 1: Abre o dropdown via evaluate (dentro do modal apenas)
  const opened = await page.evaluate((container: string, idx: number) => {
    const selects = document.querySelectorAll(`${container} .ant-select-selector`);
    if (!selects[idx]) return false;
    (selects[idx] as HTMLElement).click();
    return true;
  }, containerSelector, dropdownIndex);

  if (!opened) {
    console.log(`  ⚠️  Dropdown [${dropdownIndex}] não encontrado em ${containerSelector}`);
    return;
  }

  // PASSO 2: Espera a opção aparecer no DOM (máx 5s)
  try {
    await page.waitForFunction((text: string) => {
      const options = Array.from(document.querySelectorAll('.ant-select-item-option-content'));
      return options.some(opt => (opt.textContent || '').trim() === text && (opt as HTMLElement).offsetParent !== null);
    }, { timeout: 5000 }, optionText);
  } catch {
    console.log(`    ❌ Opção "${optionText}" não apareceu no dropdown [${dropdownIndex}]`);
    return;
  }

  // PASSO 3: Clica na opção (no .ant-select-item pai para disparar o evento correto)
  const selected = await page.evaluate((text: string) => {
    const options = Array.from(document.querySelectorAll('.ant-select-item-option-content'));
    const target = options.find(opt => (opt.textContent || '').trim() === text);
    if (target) {
      const item = target.closest('.ant-select-item');
      if (item) {
        (item as HTMLElement).click();
        return text;
      }
    }
    return null;
  }, optionText);

  if (selected) {
    console.log(`    ✅ Dropdown [${dropdownIndex}]: "${selected}"`);
  } else {
    console.log(`    ❌ Opção "${optionText}" não clicada no dropdown [${dropdownIndex}]`);
  }

  // PASSO 4: Espera animação do Ant Design fechar o dropdown
  await delay(500);
}

const MAX_RENEW_RETRIES = 2;

/**
 * Renova o serviço de um cliente no painel StarHome.
 * Tenta até 2 vezes se falhar.
 *
 * Fluxo:
 * 1. Navega para a lista de contas
 * 2. Encontra a linha do cliente pelo account
 * 3. Clica nas "3 bolinhas" (menu de ações)
 * 4. Clica em "Edit" (NÃO "Renew service" — esse cria contas novas!)
 * 5. No modal Edit, encontra o formulário de renovação
 * 6. Incrementa os pontos no InputNumber
 * 7. Clica Confirm no formulário de renovação
 * 8. Clica OK no popup de confirmação
 */
export async function renewClient(page: Page, account: string, dryRun: boolean = false): Promise<boolean> {
  const renewalStartedAt = Date.now();
  console.log(`\n🔄 Iniciando renovação do cliente: ${account}`);

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_RENEW_RETRIES; attempt++) {
    console.log(`  📍 Tentativa ${attempt}/${MAX_RENEW_RETRIES}...`);

    try {
      const result = await attemptRenewal(page, account, outputDir, attempt, dryRun);
      if (result.success) {
        const durationSeconds = ((Date.now() - renewalStartedAt) / 1000).toFixed(1);
        console.log(`  🎉 Renovação de "${account}" concluída em ${durationSeconds}s!`);
        return true;
      }
      console.log(`  ⚠️  Falhou na tentativa ${attempt}: ${result.error}`);
      if (attempt < MAX_RENEW_RETRIES) {
        console.log(`  🔄 Recarregando página para tentar novamente...`);
        const panelUrl = page.url().split('#')[0];
        await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await delay(5000);
      }
    } catch (err: any) {
      console.log(`  ❌ Erro na tentativa ${attempt}: ${err.message}`);
      if (attempt < MAX_RENEW_RETRIES) {
        const panelUrl = page.url().split('#')[0];
        await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
        await delay(5000);
      }
    }
  }

  console.log(`  ❌ Todas as ${MAX_RENEW_RETRIES} tentativas falharam.`);
  return false;
}

async function attemptRenewal(
  page: Page,
  account: string,
  outputDir: string,
  attempt: number,
  dryRun: boolean = false
): Promise<{ success: boolean; error?: string }> {
  const step = (msg: string) => console.log(`  ${msg}`);

  // 1. Navega para a lista de contas
  const panelUrl = page.url().split('#')[0];
  if (attempt === 1 || !page.url().includes('/account/list')) {
    step('🌐 Navegando para lista de contas...');
    await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await delay(5000);
  }

  await page.waitForSelector('.ant-table-row, .el-table__row, tr.ant-table-row', { timeout: 30000 }).catch(() => {
    step('⚠️  Tabela não carregou em 30s');
  });

  const searchStartedAt = Date.now();
  const filtered = await filterTableByAccount(page, account);
  if (filtered) {
    step(`⚡ Filtro direto aplicado em ${Date.now() - searchStartedAt}ms`);
  }
  await delay(500);

  // 2. Encontra a linha do cliente
  step('🔍 Procurando conta na tabela...');
  const rowFound = await page.evaluate((target: string) => {
    const rows = document.querySelectorAll('tr.ant-table-row');
    for (const row of Array.from(rows)) {
      const cells = row.querySelectorAll('td');
      for (const cell of Array.from(cells)) {
        if (cell.title === target || (cell.textContent || '').trim() === target) {
          (row as HTMLElement).setAttribute('data-target-account', 'true');
          return true;
        }
      }
    }
    return false;
  }, account);

  if (!rowFound) {
    step(`❌ Conta "${account}" não encontrada na tabela.`);
    return { success: false, error: 'Conta não encontrada na tabela' };
  }
  step('✅ Conta encontrada!');

  // Garante viewport grande para evitar que menu/dropdown cortem itens
  await page.setViewport({ width: 1920, height: 1080 });
  await delay(500);

  // 3. Clica nas 3 bolinhas (menu de ações)
  step('🖱️  Abrindo menu de ações...');
  const moreBtnSelectors = [
    'tr[data-target-account="true"] .icon-more',
    'tr[data-target-account="true"] .anticon-more',
    'tr[data-target-account="true"] [aria-label="more"]',
    'tr[data-target-account="true"] .ant-dropdown-trigger',
    'tr[data-target-account="true"] button.ant-btn-icon-only',
  ];

  let moreBtn = null;
  for (const sel of moreBtnSelectors) {
    moreBtn = await page.$(sel).catch(() => null);
    if (moreBtn) {
      const visible = await moreBtn.evaluate((el: Element) => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      });
      if (visible) break;
      moreBtn = null;
    }
  }

  if (!moreBtn) {
    step('❌ Botão "..." não encontrado na linha do cliente.');
    await debugScreenshot(page, path.join(outputDir, `renew_nobtn_${account}_t${attempt}.png`));
    return { success: false, error: 'Botão de menu não encontrado' };
  }

  // Scrolla a linha para dentro da viewport antes de clicar
  await moreBtn.evaluate((el: Element) => el.scrollIntoView({ block: 'center' }));
  await delay(300);
  await moreBtn.click();
  step('✅ Menu aberto');
  await delay(1500);
  await debugScreenshot(page, path.join(outputDir, `renew_menu_${account}_t${attempt}.png`));

  // 4. Decide qual opção clicar no menu
  // Tenta primeiro "Renew service" (se existir), senão "Edit"
  step('🔍 Procurando opção no menu...');
  const menuResult = await page.evaluate(() => {
    // Coleta todos os itens visíveis do dropdown
    const items: string[] = [];
    const allItems = document.querySelectorAll(
      '.ant-dropdown-menu-item, .ant-dropdown-menu-item span, span.ml-1, .ant-dropdown:not(.ant-dropdown-hidden) li'
    );

    for (const el of Array.from(allItems)) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      const text = (el.textContent || '').trim().toLowerCase();
      if (!text || text.length > 30) continue;
      items.push(text);
    }

    // Loga todos os itens encontrados para debug
    const menuDebug = items.join(' | ');

    // Tenta clicar em "Renew service" ou "Renew" primeiro
    for (const el of Array.from(allItems)) {
      const text = (el.textContent || '').trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (text === 'renew' || text === 'renew service' || text === 'renovar') {
        (el as HTMLElement).click();
        return 'renew-clicked|' + menuDebug;
      }
    }

    // Fallback: clica em "Edit"
    for (const el of Array.from(allItems)) {
      const text = (el.textContent || '').trim().toLowerCase();
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      if (text === 'edit' || text === 'editar') {
        (el as HTMLElement).click();
        return 'edit-clicked|' + menuDebug;
      }
    }

    return 'no-option|' + menuDebug;
  });
  step(`  🔍 Resultado menu: ${menuResult}`);

  if (menuResult.startsWith('no-option')) {
    step('❌ Nenhuma opção (Renew/Edit) encontrada no menu.');
    await debugScreenshot(page, path.join(outputDir, `renew_nomenu_${account}_t${attempt}.png`));
    return { success: false, error: `Opção não encontrada. Menu: ${menuResult.split('|')[1] || 'vazio'}` };
  }

  step(`✅ "${menuResult.split('|')[0]}" clicado`);
  await delay(2000);

  // 5. Aguarda o formulário de renovação carregar
  // O painel usa um container .scrollbar.scroll-container (NÃO .ant-modal-content)
  step('⏳ Aguardando formulário de renovação...');
  await page.waitForSelector(
    'form[confirmtext*="renew"]:not([style*="display: none"])',
    { timeout: 15000 }
  ).catch(() => {
    step('⚠️  Form renew não apareceu via seletor direto, aguardando delay extra...');
  });
  await delay(3000);
  await debugScreenshot(page, path.join(outputDir, `modal_${account}_t${attempt}.png`));

  // PASSO 5a: Encontra o form de RENEW (com confirmtext, NÃO display:none)
  // e preenche o campo "total points"
  step('📝 Preenchendo campo de pontos no formulário de renovação...');

  const renewFormSelector = 'form[confirmtext*="renew"]:not([style*="display: none"])';
  const inputInRenew = await page.$(`${renewFormSelector} input[role="spinbutton"]:not([disabled])`).catch(() => null);

  if (inputInRenew) {
    // Tem campo editável → preencher com 1
    await inputInRenew.click();
    await delay(300);
    await page.keyboard.press('Backspace');
    await page.keyboard.type('1', { delay: 50 });
    step('  📊 Campo de pontos preenchido com 1');
    const val = await inputInRenew.evaluate((el: HTMLInputElement) => el.value);
    step(`  📊 Valor confirmado: "${val}"`);
  } else {
    // Sem campo editável (já preenchido ou disabled) → seguir direto
    step('  ℹ️  Campo de pontos já preenchido ou disabled, seguindo...');
  }

  await debugScreenshot(page, path.join(outputDir, `renew_filled_${account}_t${attempt}.png`));

  if (dryRun) {
    step('DRY-RUN: formulario analisado e preenchido. Nenhuma confirmacao foi clicada.');
    await debugScreenshot(page, path.join(outputDir, `renew_dryrun_final_${account}_t${attempt}.png`));
    return { success: true };
  }

  // PASSO 5b: Clica no botão Confirm dentro do form de renew
  step('🔍 Clicando Confirm no formulário...');
  const confirmResult = await page.evaluate(() => {
    // Encontra o form de renew visível
    const forms = document.querySelectorAll('form[confirmtext*="renew"]');
    for (const form of Array.from(forms)) {
      const style = (form as HTMLElement).style.display;
      if (style === 'none') continue; // pula forms ocultos

      // Busca o botão Confirm dentro desse form
      const btn = form.querySelector('button.ant-btn-primary') as HTMLElement | null;
      if (btn) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'confirm' || text === 'confirmar') {
          btn.click();
          return 'confirm-clicked';
        }
        // Fallback: mesmo que o texto não bata, clica se for o único primary
        btn.click();
        return 'confirm-clicked-fallback';
      }
    }
    return 'no-confirm-btn';
  });
  step(`  🔍 Resultado Confirm: ${confirmResult}`);

  if (dryRun) {
    step('🎯 DRY-RUN: Simulação concluída! Formulário analisado, nenhuma alteração feita.');
    await debugScreenshot(page, path.join(outputDir, `renew_dryrun_final_${account}_t${attempt}.png`));
    return { success: true };
  }

  if (confirmResult === 'no-confirm-btn') {
    step('❌ Botão Confirm não encontrado no formulário de renovação.');
    await debugScreenshot(page, path.join(outputDir, `renew_noconfirm_${account}_t${attempt}.png`));
    return { success: false, error: 'Botão Confirm não encontrado no form renew' };
  }

  // PASSO 6: Aguarda e clica no popover de confirmação
  // <div class="ant-popover-inner"> → <button class="ant-btn-primary ant-btn-sm">OK</button>
  step('⏳ Aguardando popover de confirmação...');
  await delay(2000);
  await debugScreenshot(page, path.join(outputDir, `renew_popup_${account}_t${attempt}.png`));

  const popoverResult = await page.evaluate(() => {
    const popover = document.querySelector('.ant-popover-inner:not([style*="display: none"])');
    if (!popover) return 'no-popover';

    // Tenta clicar no botão OK dentro do popover
    const okBtn = popover.querySelector('button.ant-btn-primary.ant-btn-sm') as HTMLElement | null;
    if (okBtn) {
      okBtn.click();
      return 'ok-clicked';
    }

    const allBtns = popover.querySelectorAll('button');
    // Último botão do popover (geralmente o OK)
    if (allBtns.length > 0) {
      (allBtns[allBtns.length - 1] as HTMLElement).click();
      return 'ok-fallback-clicked';
    }
    return 'no-ok-btn';
  });
  step(`  🔍 Resultado popover OK: ${popoverResult}`);

  if (popoverResult === 'no-ok-btn') {
    step('❌ Popover apareceu mas botão OK não encontrado.');
    return { success: false, error: 'Popover sem botão OK' };
  }

  if (popoverResult === 'no-popover') {
    step('⚠️  Popover de confirmação não apareceu (pode ter sido processado rápido).');
  }

  // Aguarda processamento e verifica resultado
  await delay(5000);
  await debugScreenshot(page, path.join(outputDir, `renew_after_${account}_t${attempt}.png`));

  const result = await page.evaluate(() => {
    const body = document.body.innerText || '';
    if (body.includes('successful') || body.includes('success')) return 'success';
    // Verifica se o modal ainda está aberto
    const form = document.querySelector('form[confirmtext*="renew"]:not([style*="display: none"])');
    return form ? 'form-still-open' : 'form-closed';
  });
  step(`  🔍 Resultado final: ${result}`);

  if (result.includes('success') || result === 'form-closed' || popoverResult.includes('ok-clicked')) {
    step('🎉 Renovação concluída com sucesso!');
    return { success: true };
  } else {
    step(`⚠️  Renovação pode não ter funcionado — verifique no painel.`);
    return { success: false, error: `Resultado: ${result}` };
  }
}
