import type { Page } from 'puppeteer';
import * as path from 'path';

/** Estrutura de dados de um cliente extraído do painel */
export interface ClientData {
  index: number;
  account: string;
  password: string;
  days_remaining: number;
  package_name: string;
  buyer_name: string;
  first_login: string | null;
  expiration_date: string | null;
  creation_time: string | null;
  in_use: string;
  expired: string;
}

/** Espera N milissegundos */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Navega para a página de Account List e extrai os dados dos clientes.
 */
export async function scrapeClients(page: Page, itemsPerPage: number = 100): Promise<ClientData[]> {
  console.log('\n📊 Iniciando extração de dados dos clientes...\n');

  // Navega para Account List
  const panelUrl = page.url().split('#')[0];
  const accountListUrl = `${panelUrl}#/account/list`;
  console.log(`  🌐 Navegando para: ${accountListUrl}`);
  await page.goto(accountListUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(3000);

  await setItemsPerPage(page, itemsPerPage);

  // Aguarda a tabela aparecer com dados
  await page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {
    console.log('  ⚠️  Linhas da tabela não apareceram em 20s.');
  });
  await delay(2000);

  // Extração direta e automática (sem interação humana)
  // Mecanismo confirmado: senha está em <span style="display: none;"> sem font-size no DOM
  console.log('\n  🤖 Iniciando extração automática (modo background)...');

  // =====================================================================
  // EXTRAÇÃO: Lê senhas ocultas direto do DOM sem nenhum clique
  // =====================================================================
  const allClients: ClientData[] = [];
  let currentPage = 1;
  let hasNextPage = true;

  const pageLimit = parseInt(process.env.PAGE_LIMIT || '0'); // 0 = sem limite

  while (hasNextPage) {
    console.log(`\n  📄 Extraindo página ${currentPage}...`);

    const pageClients = await extractTableData(page);
    console.log(`    ✅ ${pageClients.length} clientes extraídos na página ${currentPage}`);

    allClients.push(...pageClients);

    // Para se atingiu o limite de páginas (útil para testes)
    if (pageLimit > 0 && currentPage >= pageLimit) {
      console.log(`  🛑 Limite de ${pageLimit} página(s) atingido.`);
      break;
    }

    hasNextPage = await goToNextPage(page);
    if (hasNextPage) {
      currentPage++;
      await delay(2500);
      await page.waitForSelector('.ant-table-row', { timeout: 10000 }).catch(() => {});
    }
  }

  console.log(`\n  🎉 Extração concluída! Total: ${allClients.length} clientes.`);

  const fs = await import('fs');
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}h${String(now.getMinutes()).padStart(2,'0')}`;

  // Salva em output/ (working dir)
  const outputPath = path.join(__dirname, '..', 'output', 'clients_extracted.json');
  fs.writeFileSync(outputPath, JSON.stringify(allClients, null, 2));

  // Salva em docs/ com timestamp (histórico permanente)
  const docsDir = path.join(__dirname, '..', '..', 'docs');
  if (!fs.existsSync(docsDir)) fs.mkdirSync(docsDir, { recursive: true });
  const docsPath = path.join(docsDir, `clients_${timestamp}.json`);
  fs.writeFileSync(docsPath, JSON.stringify(allClients, null, 2));

  console.log(`  💾 output/clients_extracted.json`);
  console.log(`  💾 docs/clients_${timestamp}.json`);

  return allClients;
}

/**
 * Configura a quantidade de itens por página.
 */
async function setItemsPerPage(page: Page, items: number): Promise<void> {
  console.log(`  🔍 Rolando para o rodapé e buscando componente ElementUI para a quantia de ${items}...`);
  try {
    // Força o viewport exibir toda a janela para que a paginação apareça
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await delay(1000);

    const pageSizeSelectors = [
      '.ant-pagination-options-size-changer', // Ant Design
      '.ant-select-selector', // Ant Design genérico
      '.el-pagination__sizes .el-select',
      '.el-pagination .el-select',
    ];

    for (const selector of pageSizeSelectors) {
      const dropdown = await page.$(selector);
      if (dropdown) {
        // Encontrou a caixa sem prever pixels na tela; ele acha o Elemento
        await dropdown.click();
        console.log(`  🎯 Elemento clique exato: ${selector}`);
        await delay(1000); // Animação renderizar o popover

        // Pega as opções renderedas no HTML
        const options = await page.$$('li.el-select-dropdown__item span, .ant-select-item-option-content');
        let configFeita = false;
        
        for (const option of options) {
          const text = await option.evaluate((el: Element) => el.textContent || '');
          if (text.includes(String(items)) || text.includes('100')) {
            // Sem coordenadas XY; o driver calcula e atira no centro desse 'span'
            await option.click();
            console.log(`  📐 Clicado no node: ${text.trim()}`);
            configFeita = true;
            await delay(3000); // Carrega os 100 itens da rede (backend deles)
            break;
          }
        }
        
        if (configFeita) return;
        break;
      }
    }

    console.log('  ℹ️  Seletor el-pagination__sizes não encontrado, usando visualização padrão.');
  } catch (error) {
    console.log(`  ⚠️  Erro no DOM durante click da paginação: ${error}`);
  }
}

/**
 * Extrai os dados da tabela de contas da página atual.
 *
 * MECANISMO DAS SENHAS (confirmado via MutationObserver):
 *  - Span com senha: style="display: none;" (sem font-size) — contém a senha real
 *  - Basta ler o textContent do span com display:none e sem font-size
 *
 * Versão melhorada com múltiplos fallbacks para diferentes frameworks.
 */
async function extractTableData(page: Page): Promise<ClientData[]> {
  try {
    const clients = await page.evaluate(function () {
      var results: any[] = [];
      
      var rowSelectors = [
        'tr.ant-table-row',
        'tr.el-table__row',
        'table tbody tr',
        '.ant-table-tbody > tr',
      ];
      
      var rows: NodeListOf<Element> | null = null;
      for (var rs of rowSelectors) {
        rows = document.querySelectorAll(rs);
        if (rows.length > 0) break;
      }
      
      if (!rows || rows.length === 0) return results;

      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td');
        if (cells.length < 5) continue;

        var col1 = cells[1] ? (cells[1].textContent || '').trim() : '';
        var col2 = cells[2] ? (cells[2].textContent || '').trim() : '';
        var col4 = cells[4] ? (cells[4].textContent || '').trim() : '';
        var col5 = cells[5] ? (cells[5].textContent || '').trim() : '';
        var col6 = cells[6] ? (cells[6].textContent || '').trim() : '';
        var col7 = cells[7] ? (cells[7].textContent || '').trim() : '';
        var col8 = cells[8] ? (cells[8].textContent || '').trim() : '';
        var col9 = cells[9] ? (cells[9].textContent || '').trim() : '';
        var col10 = cells[10] ? (cells[10].textContent || '').trim() : '';
        var col11 = cells[11] ? (cells[11].textContent || '').trim() : '';

        if (!col2) continue; // Sem account, ignora

        var pwd = '***';
        var pwdCell = cells[3];
        if (pwdCell) {
          var spans = pwdCell.querySelectorAll('span');
          for (var j = 0; j < spans.length; j++) {
            var s = spans[j] as HTMLElement;
            var st = s.getAttribute('style') || '';
            var val = (s.textContent || '').trim();
            if (st.indexOf('display: none') >= 0 && st.indexOf('font-size') < 0 && val.length > 0) {
              pwd = val;
              break;
            }
          }
          if (pwd === '***') {
            for (var k = 0; k < spans.length; k++) {
              var t2 = (spans[k].textContent || '').trim();
              if (t2.length > 0 && t2 !== '***') {
                pwd = t2;
                break;
              }
            }
          }
        }

        results.push({
          index: parseInt(col1, 10) || 0,
          account: col2,
          password: pwd,
          days_remaining: parseInt(col4, 10) || 0,
          package_name: col5,
          buyer_name: col6,
          first_login: col7,
          expiration_date: col8,
          creation_time: col9,
          in_use: col10,
          expired: col11,
        });
      }

      return results;
    });

    const result = (clients || []) as ClientData[];
    console.log(`    → Extraídos ${result.length} clientes da tabela`);
    return result;
  } catch (error) {
    console.log(`    ⚠️  Erro ao extrair dados da tabela: ${error}`);
    return [];
  }
}

/**
 * Clica nas senhas mascaradas para revelar a senha real de cada cliente.
 * Versão melhorada com try/catch robusto.
 */
async function revealPasswords(page: Page, clients: ClientData[]): Promise<ClientData[]> {
  console.log('  🔓 Revelando senhas...');

  try {
    const passwordCellSelectors = [
      '.el-table__body-wrapper table tbody tr td:nth-child(4)',
      '.ant-table-tbody tr td:nth-child(4)',
      'table tbody tr td:nth-child(4)',
    ];

    let passwordCells: any[] = [];
    for (const selector of passwordCellSelectors) {
      const cells = await page.$$(selector);
      if (cells.length > 0) {
        passwordCells = cells;
        break;
      }
    }

    if (passwordCells.length === 0) {
      console.log('  ⚠️  Células de senha não encontradas');
      return clients;
    }

    for (let i = 0; i < passwordCells.length && i < clients.length; i++) {
      try {
        const cellText = await passwordCells[i].evaluate((el: Element) => el.textContent || '');

        if (cellText.includes('***') || cellText.includes('•') || cellText.includes('···')) {
          await passwordCells[i].click();
          await delay(600);

          const revealed = await passwordCells[i].evaluate((el: Element) => el.textContent || '');
          if (revealed && !revealed.includes('***') && !revealed.includes('•') && !revealed.includes('···')) {
            clients[i].password = revealed.trim();
          }
        } else if (cellText && cellText !== '') {
          clients[i].password = cellText.trim();
        }
      } catch (err) {
        console.log(`  ⚠️  Erro ao revelar senha ${i}: ${err}`);
      }
    }

    const revealed = clients.filter((c) => c.password !== '***').length;
    console.log(`  ✅ ${revealed}/${clients.length} senhas reveladas`);
  } catch (error) {
    console.log(`  ⚠️  Erro geral ao revelar senhas: ${error}`);
  }

  return clients;
}

/**
 * Busca um cliente usando a barra de pesquisa nativa do painel.
 * 
 * Fluxo:
 * 1. Navega para #/account/list
 * 2. Localiza a barra de pesquisa nativa
 * 3. Insere a query e clica em Search
 * 4. Aguarda resposta da API (waitForResponse)
 * 5. Extrai dados da tabela filtrada
 * 
 * @param page - Puppeteer Page
 * @param query - Termo de busca (account, nome ou telefone)
 * @param searchBy - Tipo de busca: 'account' | 'buyer_name' | 'phone'
 * @returns ClientData ou null se não encontrar
 */
export async function searchAndExtractClient(
  page: Page,
  query: string,
  searchBy: 'account' | 'buyer_name' | 'phone' = 'account'
): Promise<ClientData | null> {
  console.log(`\n🔍 Buscando cliente: "${query}" (tipo: ${searchBy})`);

  const panelUrl = page.url().split('#')[0];
  const accountListUrl = `${panelUrl}#/account/list`;
  
  console.log(`  🌐 Navegando para: ${accountListUrl}`);
  await page.goto(accountListUrl, { waitUntil: 'networkidle2', timeout: 30000 });

  try {
    await page.waitForSelector('.ant-table-row', { timeout: 20000 }).catch(() => {
      console.log('  ⚠️  Tabela não apareceu');
    });
  } catch (err) {
    console.log(`  ⚠️  Erro ao carregar página: ${err}`);
  }

  if (searchBy === 'buyer_name' || searchBy === 'phone') {
    console.log(`  🔍 Busca por ${searchBy} - alterando o filtro nativo da página...`);
    let filterChanged = false;
    try {
      const clickedBox = await page.evaluate(() => {
        const selects = document.querySelectorAll('.ant-select-selector, .el-input__inner');
        for (let i = 0; i < selects.length; i++) {
          const s = selects[i];
          if (!s.closest('.ant-pagination') && !s.closest('.el-pagination')) {
            (s as HTMLElement).click();
            return true;
          }
        }
        return false;
      });

      if (clickedBox) {
        console.log(`  🎯 Filtro dropdown acessado (primeiro elemento não-paginação)`);
        await delay(1000);
      }

      if (clickedBox) {
        const optSelectors = ['li.el-select-dropdown__item span', 'li.el-select-dropdown__item', '.ant-select-item-option-content'];
        const target = searchBy === 'buyer_name' ? 'name' : 'phone';
        for (const optSel of optSelectors) {
          const opts = await page.$$(optSel);
          for (const opt of opts) {
            const txt = await opt.evaluate((el: Element) => el.textContent?.trim().toLowerCase() || '');
            if (txt.includes(target) || (searchBy === 'buyer_name' && txt.includes('nome'))) {
              await opt.click();
              console.log(`  🎯 Filtro nativo alterado para: ${txt.trim()}`);
              filterChanged = true;
              await delay(1000); // aguarda a página repintar o input do placeholder novo
              break;
            }
          }
          if (filterChanged) break;
        }
      }
    } catch(e) {
      console.log(`  ⚠️ Erro ao tentar alterar o filtro nativo: ${e}`);
    }

    if (!filterChanged) {
      console.log(`  ⚠️ Filtro nativo não encontrado, fazendo fallback para busca manual em 100 itens...`);
      console.log(`  🔍 Busca por nome/telefone - configurando 100 por página...`);
      await setItemsPerPage(page, 100);
      await delay(2000);
      console.log(`  🔍 Busca por nome/telefone - fazendo busca manual na tabela...`);
      return searchManuallyInTable(page, query, searchBy);
    }
  }

  console.log(`  🔎 Localizando barra de pesquisa...`);
  
  const searchInputSelectors = [
    'input.ant-input[placeholder*="Search"]',
    'input.ant-input[placeholder*="search"]',
    'input.ant-input.ant-input-sm',
    '.ant-input-search input',
    'input[placeholder*="Search"]',
    'input[type="search"]',
    '.ant-table-filter-dropdown input',
  ];

  let searchInput = null;
  for (const selector of searchInputSelectors) {
    const input = await page.$(selector);
    if (input) {
      const isVisible = await input.evaluate((el: Element) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && (el as HTMLInputElement).offsetParent !== null;
      });
      if (isVisible) {
        searchInput = input;
        console.log(`  ✅ Input encontrado: ${selector}`);
        break;
      }
    }
  }

  if (!searchInput) {
    console.log(`  ⚠️  Barra de pesquisa não encontrada. Tentando busca manual na tabela...`);
    return searchManuallyInTable(page, query);
  }

  await searchInput.click();
  await searchInput.type(query, { delay: 30 });

  await delay(500);

  const searchButtonSelectors = [
    'button.ant-input-search-button',
    '.ant-input-search .ant-input-search-button',
    'button:has(.anticon-search)',
    'button:has(.anticon-search)',
    'span.ant-input-search-icon',
    'button.ant-btn-icon-only',
  ];

  let searchClicked = false;
  for (const selector of searchButtonSelectors) {
    const btn = await page.$(selector);
    if (btn) {
      const isVisible = await btn.evaluate((el: Element) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden';
      });
      if (isVisible) {
        await btn.click();
        console.log(`  ✅ Botão Search clicado: ${selector}`);
        searchClicked = true;
        break;
      }
    }
  }

  if (!searchClicked) {
    await page.keyboard.press('Enter');
    console.log(`  ✅ Enter pressionado para buscar`);
  }

  await delay(2000);

  const clients = await extractTableData(page);
  
  if (clients.length === 0) {
    console.log(`  ❌ Nenhum cliente encontrado para "${query}"`);
    
    const shouldSearchManually = await promptFallback(page, query);
    if (shouldSearchManually) {
      return searchManuallyInTable(page, query);
    }
    return null;
  }

  const exactMatch = clients.find(c => {
    if (searchBy === 'account') return c.account === query;
    if (searchBy === 'buyer_name') return c.buyer_name.toLowerCase() === query.toLowerCase();
    if (searchBy === 'phone') return c.buyer_name.includes(query);
    return false;
  });

  if (exactMatch) {
    console.log(`  ✅ Cliente encontrado: ${exactMatch.account} - ${exactMatch.buyer_name}`);
    return exactMatch;
  }

  let bestMatch: ClientData | null = null;
  const searchByStr = searchBy as string;
  
  if (searchByStr === 'buyer_name') {
    const queryLower = query.toLowerCase();
    const partialMatches = clients.filter(c => 
      c.buyer_name && c.buyer_name.toLowerCase().includes(queryLower)
    );
    
    if (partialMatches.length > 0) {
      partialMatches.sort((a, b) => {
        const aExact = a.buyer_name.toLowerCase().startsWith(queryLower);
        const bExact = b.buyer_name.toLowerCase().startsWith(queryLower);
        if (aExact && !bExact) return -1;
        if (!aExact && bExact) return 1;
        if (a.in_use === 'Used' && b.in_use !== 'Used') return -1;
        if (a.in_use !== 'Used' && b.in_use === 'Used') return 1;
        return b.days_remaining - a.days_remaining;
      });
      bestMatch = partialMatches[0];
      console.log(`  ✅ Melhor correspondência: ${bestMatch.account} - ${bestMatch.buyer_name}`);
      return bestMatch;
    }
  }

  const similarClients = clients.slice(0, 5);
  console.log(`  ℹ️  Nenhuma correspondência exata. Encontrados ${clients.length} resultados.`);
  
  if (similarClients.length > 0) {
    console.log(`  📋 Clientes similares:`);
    similarClients.forEach((c, i) => {
      console.log(`     ${i + 1}. ${c.account} - ${c.buyer_name || '(sem nome)'} - ${c.in_use}`);
    });
  }

  const usedMatches = similarClients.filter(c => c.in_use === 'Used');
  if (usedMatches.length > 0) {
    console.log(`  ✅ Retornando cliente ativo: ${usedMatches[0].account}`);
    return usedMatches[0];
  }

  const validMatches = similarClients.filter(c => c.buyer_name && c.buyer_name.trim() !== '');
  if (validMatches.length > 0) {
    console.log(`  ✅ Retornando cliente com nome: ${validMatches[0].account}`);
    return validMatches[0];
  }

  console.log(`  ❌ Nenhuma correspondência válida encontrada`);
  return null;
}

/**
 * Busca manual na tabela (fallback quando a barra de pesquisa não funciona).
 * Percorre TODAS as linhas de TODAS as páginas procurando correspondência.
 */
async function searchManuallyInTable(page: Page, query: string, searchBy: 'account' | 'buyer_name' | 'phone' = 'account'): Promise<ClientData | null> {
  console.log(`  🔍 Fazendo busca manual completa por ${searchBy}...`);
  
  const queryLower = query.toLowerCase();
  let pageNum = 1;
  let hasNextPage = true;
  let foundDebug = false;
  
  while (hasNextPage) {
    await delay(1500);
    
    const allRows = await page.$$('tr.ant-table-row');
    console.log(`  📄 Página ${pageNum}: ${allRows.length} linhas...`);
    
    for (const row of allRows) {
      const cells = await row.$$('td');
      if (cells.length < 7) continue;
      
      let cellText = '';
      let matchFound = false;
      let accountText = '';
      
      if (searchBy === 'account') {
        accountText = await cells[2].evaluate((el: Element) => el.textContent || '');
        const cellTextTrimmed = accountText.trim();
        if (cellTextTrimmed === query || cellTextTrimmed.toLowerCase().includes(queryLower)) {
          matchFound = true;
          cellText = cellTextTrimmed;
        }
      } else if (searchBy === 'buyer_name' || searchBy === 'phone') {
        const nameCell = cells[6];
        if (nameCell) {
          cellText = await nameCell.evaluate((el: Element) => el.textContent || '');
          const cellTextTrimmed = cellText.trim().toLowerCase();
          if (cellTextTrimmed.includes(queryLower)) {
            matchFound = true;
            accountText = await cells[2].evaluate((el: Element) => el.textContent?.trim() || '');
          }
        }
      }
      
      if (matchFound) {
        const clientData = await extractTableData(page);
        const match = clientData.find(c => c.account === accountText);
        if (match) return match;
      }
    }
    
    hasNextPage = await goToNextPage(page);
    if (hasNextPage) {
      pageNum++;
    }
  }

  console.log(`  ❌ Busca manual não encontrou correspondência em ${pageNum} páginas`);
  return null;
}

/**
 * Pergunta se o usuário quer fazer busca manual (fallback).
 * Como não temos input interativo, retorna true para continuar ou false para parar.
 */
async function promptFallback(page: Page, query: string): Promise<boolean> {
  console.log(`\n  ⚠️  Não foi possível encontrar "${query}" usando a barra de pesquisa.`);
  console.log(`  Deseja tentar busca manual na tabela? (s/n)`);
  console.log(`  → Para aceitar, o script continuará automaticamente...`);
  return true;
}

/**
 * Tenta ir para a próxima página da tabela.
 * Versão melhorada com try/catch robusto.
 */
async function goToNextPage(page: Page): Promise<boolean> {
  try {
    const nextButtonSelectors = [
      '.el-pagination .btn-next:not(.disabled):not([disabled])',
      '.el-pagination button.btn-next:not(.is-disabled)',
      'li.ant-pagination-next:not(.ant-pagination-disabled) button',
      'li.ant-pagination-next:not(.ant-pagination-disabled)',
      '.ant-pagination .ant-pagination-next:not(.ant-pagination-disabled)',
      'button.ant-pagination-next',
    ];

    let nextButton = null;
    for (const selector of nextButtonSelectors) {
      const btn = await page.$(selector);
      if (btn) {
        const isVisible = await btn.evaluate((el: Element) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden';
        });
        if (isVisible) {
          nextButton = btn;
          break;
        }
      }
    }

    if (nextButton) {
      const isDisabled = await nextButton.evaluate((el: Element) => {
        return el.classList.contains('disabled') ||
               el.classList.contains('is-disabled') ||
               el.classList.contains('ant-pagination-disabled') ||
               el.hasAttribute('disabled') || 
               el.parentElement?.classList.contains('ant-pagination-disabled');
      });

      if (!isDisabled) {
        await nextButton.click();
        console.log('  ➡️  Indo para próxima página...');
        return true;
      }
    }
  } catch (error) {
    console.log(`  ⚠️  Erro ao navegar para próxima página: ${error}`);
  }

  console.log('  📋 Última página alcançada');
  return false;
}
