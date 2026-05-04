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
export async function renewClient(page: Page, account: string, dryRun: boolean = false): Promise<boolean> {
  console.log(`\n🔄 Iniciando renovação do cliente: ${account}`);

  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  for (let attempt = 1; attempt <= MAX_RENEW_RETRIES; attempt++) {
    console.log(`  📍 Tentativa ${attempt}/${MAX_RENEW_RETRIES}...`);

    try {
      const result = await attemptRenewal(page, account, outputDir, attempt, dryRun);
      if (result.success) {
        console.log(`  🎉 Renovação de "${account}" concluída com sucesso!`);
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
  await delay(1500);

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
    await page.screenshot({ path: path.join(outputDir, `renew_nobtn_${account}_t${attempt}.png`) });
    return { success: false, error: 'Botão de menu não encontrado' };
  }

  // Scrolla a linha para dentro da viewport antes de clicar
  await moreBtn.evaluate((el: Element) => el.scrollIntoView({ block: 'center' }));
  await delay(300);
  await moreBtn.click();
  step('✅ Menu aberto');
  await delay(1500);
  await page.screenshot({ path: path.join(outputDir, `renew_menu_${account}_t${attempt}.png`) });

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
    await page.screenshot({ path: path.join(outputDir, `renew_nomenu_${account}_t${attempt}.png`) });
    return { success: false, error: `Opção não encontrada. Menu: ${menuResult.split('|')[1] || 'vazio'}` };
  }

  step(`✅ "${menuResult.split('|')[0]}" clicado`);
  await delay(2000);

  // 5. Aguarda o modal/dialog carregar
  step('⏳ Aguardando modal...');
  await page.waitForSelector(
    '.ant-modal-content, .ant-modal-wrap:not([style*="display: none"]), .ant-modal-confirm',
    { timeout: 10000 }
  ).catch(() => {});
  await delay(2000);
  await page.screenshot({ path: path.join(outputDir, `modal_${account}_t${attempt}.png`) });

  // Detecta qual tipo de modal abriu:
  //   Tipo A: "Renew service" → diálogo simples com nome do cliente + Confirm
  //   Tipo B: "Edit" → modal com múltiplos formulários (points, buyer info, etc.)
  const modalType = await page.evaluate(() => {
    const body = document.body.innerText || '';

    // Tipo A: diálogo de confirmação do Renew (texto típico)
    const isRenewDialog = body.includes('confirm whether to renew') ||
                          body.includes('Please confirm') ||
                          body.includes('Renew service') ||
                          body.includes('Renew Service');

    // Tipo B: modal Edit (tem formulários com atributo confirmtext)
    const hasRenewForm = !!document.querySelector('form[confirmtext*="renew"]');

    if (hasRenewForm) return 'edit-modal';
    if (isRenewDialog) return 'renew-dialog';

    // Detecta pelo conteúdo do modal
    const modal = document.querySelector('.ant-modal-content, .ant-modal-confirm');
    if (modal) {
      const modalText = (modal as HTMLElement).innerText || '';
      if (modalText.includes('renew') || modalText.includes('Renew')) return 'renew-dialog';
      if (modalText.includes('total number') || modalText.includes('points')) return 'edit-modal';
    }

    // Fallback: verifica se tem input spinbutton (campo de pontos)
    const hasSpinbutton = !!document.querySelector('input[role="spinbutton"]');
    if (hasSpinbutton) return 'edit-modal';

    return 'unknown-dialog';
  });
  step(`  🔍 Tipo de modal detectado: ${modalType}`);

  // ─── FLUXO A: Renew Dialog (diálogo simples) ───
  if (modalType === 'renew-dialog' || modalType === 'unknown-dialog') {
    step('  ℹ️  Diálogo de Renew detectado — sem campo de pontos, só confirmar.');

    // Procura o botão Confirm/OK no diálogo
    const dialogConfirmResult = await page.evaluate(() => {
      const allBtns = document.querySelectorAll('button');
      for (const btn of Array.from(allBtns)) {
        const rect = btn.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const text = (btn.textContent || '').trim().toLowerCase();
        const cls = (btn.className || '').toLowerCase();
        if ((text === 'confirm' || text === 'confirmar' || text === 'ok' || text === 'sim') &&
            (cls.includes('ant-btn-primary') || cls.includes('ant-btn'))) {
          (btn as HTMLElement).click();
          return 'dialog-confirm-clicked';
        }
      }
      // Último botão primary visível
      const primaries = document.querySelectorAll('button.ant-btn-primary');
      for (let i = primaries.length - 1; i >= 0; i--) {
        const btn = primaries[i] as HTMLElement;
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          btn.click();
          return 'dialog-last-primary-clicked';
        }
      }
      return 'dialog-no-btn';
    });
    step(`  🔍 Resultado diálogo: ${dialogConfirmResult}`);

    if (dryRun) {
      step('🎯 DRY-RUN: Diálogo de Renew analisado. Nenhuma alteração feita.');
      await page.screenshot({ path: path.join(outputDir, `renew_dryrun_final_${account}_t${attempt}.png`) });
      return { success: true };
    }

    if (dialogConfirmResult === 'dialog-no-btn') {
      step('❌ Nenhum botão Confirm/OK encontrado no diálogo.');
      return { success: false, error: 'Botão Confirm não encontrado no diálogo Renew' };
    }

    // Aguarda processamento e verifica sucesso
    await delay(5000);
    await page.screenshot({ path: path.join(outputDir, `renew_after_${account}_t${attempt}.png`) });

    const bodyText = await page.evaluate(() => document.body.innerText || '');
    if (bodyText.includes('successful') || bodyText.includes('success')) {
      step('✅ Renovação confirmada com sucesso!');
      return { success: true };
    }
    step('⚠️  Renovação pode ter funcionado — verifique no painel.');
    return { success: true };
  }

  // ─── FLUXO B: Edit Modal (com formulários e campo de pontos) ───
  step('  ℹ️  Modal Edit detectado — fluxo com campo de pontos.');

  // O modal Edit tem MÚLTIPLOS formulários dependendo se abriu Edit ou Renew:
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

  // Busca o input de pontos (spinbutton) dentro do formulário de renovação
  const pointsInputSelector = '.ant-modal-content form[confirmtext*="renew"] input[role="spinbutton"]:not([disabled])';
  let inputHandle = await page.$(pointsInputSelector).catch(() => null);

  // Fallback: busca dentro de qualquer form no modal
  if (!inputHandle) {
    const forms = await page.$$('.ant-modal-content form');
    for (const form of forms) {
      const confirmtext = await form.evaluate(el => el.getAttribute('confirmtext') || '');
      if (confirmtext.includes('renew')) {
        inputHandle = await form.$('input[role="spinbutton"]:not([disabled])');
        if (inputHandle) break;
      }
    }
  }

  if (!inputHandle) {
    step('❌ Campo de pontos (spinbutton) não encontrado no formulário de renovação.');
    await page.screenshot({ path: path.join(outputDir, `renew_nopoints_${account}_t${attempt}.png`) });
    return { success: false, error: 'Campo de pontos não encontrado no formulário de renovação' };
  }

  // Estratégia: foca o input e pressiona ArrowUp (via teclado, compatível com React)
  await inputHandle.click();
  await delay(300);
  // Pressiona Backspace para limpar e depois digita 1
  await page.keyboard.press('Backspace');
  await page.keyboard.type('1', { delay: 50 });
  step('  📊 Campo de pontos preenchido com 1');

  // Verifica o valor
  const currentValue = await inputHandle.evaluate((el: HTMLInputElement) => el.value);
  step(`  📊 Valor do campo total points: "${currentValue}"`);

  await page.screenshot({ path: path.join(outputDir, `renew_filled_${account}_t${attempt}.png`) });

  // PASSO 5b: Encontra e clica no Confirm (ou apenas detecta se é dry-run)
  step('🔍 Procurando botão Confirm...');

  const confirmResult = await page.evaluate(() => {
    const modal = document.querySelector('.ant-modal-content');
    if (!modal) return 'modal-not-found';

    // Estratégia 1: form com confirmtext="renew" → botão dentro
    const forms = modal.querySelectorAll('form');
    for (const form of Array.from(forms)) {
      const ct = form.getAttribute('confirmtext') || '';
      if (ct.includes('renew')) {
        const btn = form.querySelector('button.ant-btn-primary') as HTMLElement;
        if (btn) { btn.click(); return 'confirm-clicked-inside-form'; }
        const prev = form.previousElementSibling;
        if (prev && prev.tagName === 'BUTTON' && prev.classList.contains('ant-btn-primary')) {
          (prev as HTMLElement).click(); return 'confirm-clicked-sibling';
        }
        return 'confirm-btn-not-found-in-renew-form';
      }
    }

    // Estratégia 2: qualquer botão "Confirm" visível no modal
    const allButtons = modal.querySelectorAll('button');
    for (const btn of Array.from(allButtons)) {
      const text = (btn.textContent || '').trim().toLowerCase();
      if (text === 'confirm' || text === 'confirmar') {
        const rect = btn.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          const classes = btn.className || '';
          if (classes.includes('ant-btn-primary') || classes.includes('ant-btn')) {
            (btn as HTMLElement).click();
            return 'confirm-clicked-by-text';
          }
        }
      }
    }

    // Estratégia 3: último botão primary no modal (geralmente o Confirm)
    const primaryBtns = modal.querySelectorAll('button.ant-btn-primary');
    if (primaryBtns.length > 0) {
      const last = primaryBtns[primaryBtns.length - 1] as HTMLElement;
      const text = (last.textContent || '').trim().toLowerCase();
      if (text.includes('confirm') || text.includes('confirmar')) {
        last.click();
        return 'confirm-clicked-last-primary';
      }
    }

    // Debug: lista todos os botões visíveis no modal
    const visibleBtnTexts: string[] = [];
    for (const btn of Array.from(allButtons)) {
      const rect = btn.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        const text = (btn.textContent || '').trim();
        const classes = btn.className || '';
        if (text) visibleBtnTexts.push(`${text} (${classes.slice(0, 50)})`);
      }
    }
    return `no-confirm-btn|botoes: ${visibleBtnTexts.join(' | ')}`;
  });
  step(`  🔍 Resultado Confirm: ${confirmResult}`);

  // Se for dry-run, verifica se o botão foi encontrado e para
  if (dryRun) {
    if (confirmResult.includes('clicked')) {
      step('🎯 DRY-RUN: Botão Confirm ENCONTRADO e CLICADO!');
    } else {
      step('⚠️  DRY-RUN: Botão Confirm NÃO encontrado. Verifique o screenshot.');
      step(`  → ${confirmResult}`);
    }
    step('🎯 DRY-RUN: Simulação concluída! Verifique os screenshots em output/');
    step(`   → Pontos preenchidos, modal Edit aberto, cliente "${account}" analisado.`);
    step(`   → Se fosse real, clicaria "Confirm" e "OK" no popup.`);
    await page.screenshot({ path: path.join(outputDir, `renew_dryrun_final_${account}_t${attempt}.png`) });
    return { success: true };
  }

  if (confirmResult.includes('no-confirm-btn') || confirmResult === 'confirm-btn-not-found-in-renew-form') {
    step('❌ Botão Confirm não encontrado no modal.');
    await page.screenshot({ path: path.join(outputDir, `renew_noconfirm_${account}_t${attempt}.png`) });
    return { success: false, error: `Botão Confirm não encontrado: ${confirmResult}` };
  }

  if (confirmResult === 'renew-form-not-found') {
    step('❌ Formulário de renovação não encontrado no modal.');
    return { success: false, error: 'Formulário de renovação não encontrado' };
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
