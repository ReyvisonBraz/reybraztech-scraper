import type { Page } from 'puppeteer';
import * as path from 'path';
import * as fs from 'fs';

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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
export async function renewClient(page: Page, account: string): Promise<boolean> {
  console.log(`\n🔄 Iniciando renovação do cliente: ${account}`);

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_RENEW_RETRIES; attempt++) {
    console.log(`  📍 Tentativa ${attempt}/${MAX_RENEW_RETRIES}...`);

    try {
      const result = await attemptRenewal(page, account, outputDir, attempt);
      if (result.success) {
        console.log(`  🎉 Renovação de "${account}" concluída com sucesso!`);
        return true;
      }
      console.log(`  ⚠️  Falhou na tentativa ${attempt}: ${result.error}`);
      if (attempt < MAX_RENEW_RETRIES) {
        console.log(`  🔄 Recarregando página para tentar novamente...`);
        const panelUrl = page.url().split('#')[0];
        await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'networkidle2', timeout: 60000 });
        await delay(3000);
      }
    } catch (err: any) {
      console.log(`  ❌ Erro na tentativa ${attempt}: ${err.message}`);
      if (attempt < MAX_RENEW_RETRIES) {
        const panelUrl = page.url().split('#')[0];
        await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'networkidle2', timeout: 60000 }).catch(() => {});
        await delay(3000);
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
  attempt: number
): Promise<{ success: boolean; error?: string }> {
  const step = (msg: string) => console.log(`  ${msg}`);

  // 1. Navega para a lista de contas
  const panelUrl = page.url().split('#')[0];
  if (attempt === 1 || !page.url().includes('/account/list')) {
    step('🌐 Navegando para lista de contas...');
    await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'networkidle2', timeout: 60000 });
    await delay(3000);
  }

  await page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {
    step('⚠️  Tabela não carregou em 20s');
  });
  await delay(1000);

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

  // 3. Clica nas 3 bolinhas
  step('🖱️  Abrindo menu de ações...');
  const moreBtn = await page.$('tr[data-target-account="true"] .icon-more') ||
                  await page.$('tr[data-target-account="true"] .anticon-more') ||
                  await page.$('tr[data-target-account="true"] [aria-label="more"]');

  if (!moreBtn) {
    step('❌ Botão "..." não encontrado na linha do cliente.');
    await page.screenshot({ path: path.join(outputDir, `renew_nobtn_${account}_t${attempt}.png`) });
    return { success: false, error: 'Botão de menu não encontrado' };
  }

  await moreBtn.click();
  step('✅ Menu aberto');
  await delay(1500);

  // 4. Clica em "Edit" (NÃO "Renew service" — esse cria contas novas!)
  step('🔍 Clicando "Edit"...');
  const editClicked = await page.evaluate(() => {
    const spans = document.querySelectorAll('span.ml-1');
    for (const span of Array.from(spans)) {
      if ((span.textContent || '').trim().toLowerCase() === 'edit') {
        (span as HTMLElement).click();
        return true;
      }
    }
    const items = document.querySelectorAll('.ant-dropdown-menu-item');
    for (const item of Array.from(items)) {
      if ((item.textContent || '').trim().toLowerCase() === 'edit') {
        (item as HTMLElement).click();
        return true;
      }
    }
    return false;
  });

  if (!editClicked) {
    step('❌ "Edit" não encontrado no menu.');
    await page.screenshot({ path: path.join(outputDir, `renew_noedit_${account}_t${attempt}.png`) });
    return { success: false, error: 'Opção Edit não encontrada no menu' };
  }

  step('✅ "Edit" clicado');
  await delay(2000);

  // 5. Aguarda o modal Edit carregar
  step('⏳ Aguardando modal Edit...');
  await page.waitForSelector('.ant-modal-content', { timeout: 10000 }).catch(() => {});
  await delay(2000);
  await page.screenshot({ path: path.join(outputDir, `edit_modal_${account}_t${attempt}.png`) });

  // O modal Edit tem MÚLTIPLOS formulários:
  //   - Formulário de CRIAÇÃO de contas
  //   - Formulário de RENOVAÇÃO (com confirmtext="Please confirm whether to renew...")
  //   - Formulário de EDIÇÃO (buyer info, password)
  //
  // Precisamos:
  // 1. Preencher "total number of points" = 1 no formulário de RENOVAÇÃO
  // 2. Clicar no Confirm DAQUELE formulário (não de outro)
  // 3. Clicar OK no popup "Please confirm whether to renew this account."

  // PASSO 5a: Preencher o campo de pontos no formulário de renovação
  step('📝 Preenchendo campo de pontos na seção de renovação...');

  const upResult = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'modal-not-found';

    const forms = modal.querySelectorAll('form');
    let renewForm: Element | null = null;
    for (const form of Array.from(forms)) {
      if (form.getAttribute('confirmtext')?.includes('renew')) {
        renewForm = form;
        break;
      }
    }

    if (!renewForm) return 'renew-form-not-found';

    const upBtn = renewForm.querySelector('.ant-input-number-handler-up') as HTMLElement;
    if (upBtn) {
      upBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      upBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'up-clicked-in-renew-form';
    }

    const spinbutton = renewForm.querySelector('input[role="spinbutton"]:not([disabled])') as HTMLElement;
    if (spinbutton) {
      spinbutton.focus();
      spinbutton.click();
      return 'focused-spinbutton-in-renew-form';
    }

    return 'no-spinbutton-in-renew-form';
  });
  step(`  📊 InputNumber: ${upResult}`);

  if (upResult === 'renew-form-not-found') {
    step('❌ Formulário de renovação não encontrado no modal.');
    await page.screenshot({ path: path.join(outputDir, `renew_noform_${account}_t${attempt}.png`) });
    return { success: false, error: 'Formulário de renovação não encontrado' };
  }

  if (upResult === 'focused-spinbutton-in-renew-form') {
    await page.keyboard.press('ArrowUp');
  }
  await delay(500);

  // Verifica o valor
  const currentValue = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'no-modal';
    const forms = modal.querySelectorAll('form');
    for (const form of Array.from(forms)) {
      if (form.getAttribute('confirmtext')?.includes('renew')) {
        const input = form.querySelector('input[role="spinbutton"]:not([disabled])') as HTMLInputElement;
        return input ? `value="${input.value}"` : 'no-input';
      }
    }
    return 'no-renew-form';
  });
  step(`  📊 Valor do campo total points: ${currentValue}`);

  await page.screenshot({ path: path.join(outputDir, `renew_filled_${account}_t${attempt}.png`) });

  // PASSO 5b: Clica no Confirm do formulário de RENOVAÇÃO
  step('🔍 Clicando Confirm da seção de renovação...');
  const confirmResult = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'modal-not-found';

    const forms = modal.querySelectorAll('form');
    for (const form of Array.from(forms)) {
      if (form.getAttribute('confirmtext')?.includes('renew')) {
        const btn = form.querySelector('button.ant-btn-primary') as HTMLElement;
        if (btn) {
          btn.click();
          return 'confirm-clicked-inside-form';
        }
        const prev = form.previousElementSibling;
        if (prev && prev.tagName === 'BUTTON' && prev.classList.contains('ant-btn-primary')) {
          (prev as HTMLElement).click();
          return 'confirm-clicked-sibling';
        }
        return 'confirm-btn-not-found-in-renew-form';
      }
    }
    return 'renew-form-not-found';
  });
  step(`  🔍 Resultado Confirm: ${confirmResult}`);

  if (confirmResult === 'confirm-btn-not-found-in-renew-form') {
    step('❌ Botão Confirm não encontrado no formulário de renovação.');
    return { success: false, error: 'Botão Confirm não encontrado' };
  }

  // PASSO 6: Aguarda o popup "Please confirm whether to renew this account." e clica OK
  step('⏳ Aguardando popup de confirmação...');
  await delay(2000);
  await page.screenshot({ path: path.join(outputDir, `renew_popup_${account}_t${attempt}.png`) });

  const okResult = await page.evaluate(() => {
    const body = document.body.innerText || '';
    if (body.includes('confirm whether to renew') || body.includes('Please confirm')) {
      const buttons = document.querySelectorAll('button.ant-btn-primary.ant-btn-sm');
      for (const btn of Array.from(buttons)) {
        if ((btn.textContent || '').trim() === 'OK') {
          (btn as HTMLElement).click();
          return 'ok-clicked';
        }
      }
      const allBtns = document.querySelectorAll('button');
      for (const btn of Array.from(allBtns)) {
        if ((btn.textContent || '').trim() === 'OK' && btn.classList.contains('ant-btn-primary')) {
          (btn as HTMLElement).click();
          return 'ok-fallback-clicked';
        }
      }
      return 'popup-found-no-ok';
    }
    return 'no-confirm-popup';
  });
  step(`  🔍 Resultado popup OK: ${okResult}`);

  if (okResult === 'popup-found-no-ok') {
    step('❌ Popup apareceu mas botão OK não encontrado.');
    return { success: false, error: 'Popup sem botão OK' };
  }

  // Aguarda processamento
  await delay(5000);
  await page.screenshot({ path: path.join(outputDir, `renew_after_${account}_t${attempt}.png`) });

  // Verifica resultado final
  const result = await page.evaluate(() => {
    const body = document.body.innerText || '';
    if (body.includes('successful') || body.includes('success')) {
      const buttons = document.querySelectorAll('button');
      for (const btn of Array.from(buttons)) {
        const text = (btn.textContent || '').trim().toLowerCase();
        if (text === 'got it' || text === 'ok') {
          (btn as HTMLElement).click();
          return 'success';
        }
      }
      return 'success';
    }
    const modal = document.querySelector('.ant-modal-wrap:not([style*="display: none"])');
    return modal ? 'modal-still-open' : 'modal-closed';
  });
  step(`  🔍 Resultado final: ${result}`);

  if (result.includes('success') || okResult.includes('ok-clicked')) {
    step('🎉 Renovação concluída com sucesso!');
    return { success: true };
  } else if (result === 'modal-closed') {
    step('🎉 Renovação concluída (modal fechado)!');
    return { success: true };
  } else {
    step(`⚠️  Renovação pode não ter funcionado — verifique no painel.`);
    return { success: false, error: `Resultado inesperado: ${result}` };
  }
}
