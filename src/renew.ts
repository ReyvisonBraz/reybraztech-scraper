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

/**
 * Renova o serviço de um cliente no painel StarHome.
 *
 * Fluxo:
 * 1. Navega para a lista de contas
 * 2. Encontra a linha do cliente pelo account
 * 3. Clica nas "3 bolinhas" (menu de ações)
 * 4. Clica em "Renew Service"
 * 5. Clica em "Confirm" no modal
 */
export async function renewClient(page: Page, account: string): Promise<boolean> {
  console.log(`\n🔄 Iniciando renovação do cliente: ${account}`);

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  // 1. Navega para a lista de contas
  const panelUrl = page.url().split('#')[0];
  await page.goto(`${panelUrl}#/account/list`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  await page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {
    console.log('  ⚠️  Tabela não carregou em 20s');
  });
  await delay(1000);

  // 2. Encontra a linha do cliente
  console.log(`  🔍 Procurando conta "${account}"...`);
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
    console.log(`  ❌ Conta "${account}" não encontrada.`);
    return false;
  }
  console.log(`  ✅ Conta encontrada!`);

  // 3. Clica nas 3 bolinhas
  const moreBtn = await page.$('tr[data-target-account="true"] .icon-more') ||
                  await page.$('tr[data-target-account="true"] .anticon-more') ||
                  await page.$('tr[data-target-account="true"] [aria-label="more"]');

  if (!moreBtn) {
    console.log(`  ❌ Botão "..." não encontrado.`);
    return false;
  }

  await moreBtn.click();
  console.log(`  🖱️  Menu aberto`);
  await delay(1500);

  // 4. Clica em "Edit" (NÃO "Renew service" — esse cria contas novas!)
  const editClicked = await page.evaluate(() => {
    // Procura no menu dropdown o item "Edit"
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
    console.log(`  ❌ "Edit" não encontrado no menu.`);
    await page.screenshot({ path: path.join(outputDir, `renew_menu_fail_${account}.png`) });
    return false;
  }

  console.log(`  ✅ "Edit" clicado`);
  await delay(2000);

  // 5. Aguarda o modal Edit carregar
  await page.waitForSelector('.ant-modal-content', { timeout: 10000 }).catch(() => {});
  await delay(2000);
  await page.screenshot({ path: path.join(outputDir, `edit_modal_${account}.png`) });

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
  // O formulário de renovação tem "Account allocation of package duration" (não "Each account...")
  console.log(`  📝 Preenchendo campo de pontos na seção de renovação...`);

  const upResult = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'modal-not-found';

    // Encontra o formulário de renovação pelo atributo confirmtext
    const forms = modal.querySelectorAll('form');
    let renewForm: Element | null = null;
    for (const form of Array.from(forms)) {
      if (form.getAttribute('confirmtext')?.includes('renew')) {
        renewForm = form;
        break;
      }
    }

    if (!renewForm) return 'renew-form-not-found';

    // Clica no botão "seta para cima" do InputNumber DENTRO do formulário de renovação
    const upBtn = renewForm.querySelector('.ant-input-number-handler-up') as HTMLElement;
    if (upBtn) {
      upBtn.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      upBtn.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
      return 'up-clicked-in-renew-form';
    }

    // Fallback: foca no spinbutton do formulário de renovação
    const spinbutton = renewForm.querySelector('input[role="spinbutton"]:not([disabled])') as HTMLElement;
    if (spinbutton) {
      spinbutton.focus();
      spinbutton.click();
      return 'focused-spinbutton-in-renew-form';
    }

    return 'no-spinbutton-in-renew-form';
  });
  console.log(`    InputNumber: ${upResult}`);

  if (upResult === 'focused-spinbutton-in-renew-form') {
    await page.keyboard.press('ArrowUp');
    console.log(`    Pressionou ArrowUp`);
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
  console.log(`    Campo total points: ${currentValue}`);

  await page.screenshot({ path: path.join(outputDir, `renew_filled_${account}.png`) });

  // PASSO 5b: Clica no Confirm do formulário de RENOVAÇÃO (não de criação!)
  console.log(`  🔍 Clicando Confirm da seção de renovação...`);
  const confirmResult = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'modal-not-found';

    const forms = modal.querySelectorAll('form');
    for (const form of Array.from(forms)) {
      if (form.getAttribute('confirmtext')?.includes('renew')) {
        // O botão Confirm fica ANTES do form (como sibling) ou dentro dele
        // Procura o botão Confirm mais próximo deste formulário
        const btn = form.querySelector('button.ant-btn-primary') as HTMLElement;
        if (btn) {
          btn.click();
          return 'confirm-clicked-inside-form';
        }
        // Fallback: o botão pode ser sibling anterior do form
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
  console.log(`  🔍 Confirm: ${confirmResult}`);

  // PASSO 6: Aguarda o popup "Please confirm whether to renew this account." e clica OK
  console.log(`  ⏳ Aguardando popup de confirmação de renovação...`);
  await delay(2000);
  await page.screenshot({ path: path.join(outputDir, `renew_confirm_popup_${account}.png`) });

  const okResult = await page.evaluate(() => {
    const body = document.body.innerText || '';
    if (body.includes('confirm whether to renew') || body.includes('Please confirm')) {
      // Clica no OK (ant-btn-primary ant-btn-sm)
      const buttons = document.querySelectorAll('button.ant-btn-primary.ant-btn-sm');
      for (const btn of Array.from(buttons)) {
        if ((btn.textContent || '').trim() === 'OK') {
          (btn as HTMLElement).click();
          return 'ok-clicked';
        }
      }
      // Fallback
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
  console.log(`  🔍 Popup OK: ${okResult}`);

  // Aguarda processamento
  await delay(5000);
  await page.screenshot({ path: path.join(outputDir, `renew_after_${account}.png`) });

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
  console.log(`  🔍 Resultado final: ${result}`);

  if (result.includes('success') || okResult.includes('ok-clicked')) {
    console.log(`  🎉 Renovação de "${account}" concluída com sucesso!`);
    return true;
  } else if (result === 'modal-closed') {
    console.log(`  🎉 Renovação de "${account}" concluída!`);
    return true;
  } else {
    console.log(`  ⚠️  Renovação pode não ter funcionado — verifique no painel.`);
    return false;
  }
}
