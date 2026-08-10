import * as path from 'path';
import 'dotenv/config'; // Adicionado para desenvolvimento local, será ignorado inofensivamente no Render caso falhe (embora o ideal seja garantir que não trave se não achar o arquivo)
import { loginToPanel } from './login';
import { scrapeClients, searchAndExtractClient } from './scrape';
import { exportAll } from './export';
import { updateDatabase, updateSingleClient } from './update-db';
import { renewClient } from './renew';
import { cleanupOutput } from './cleanup';
import { notifySyncStart, notifySyncComplete, notifyRenewStart, notifyRenewComplete, notifyError, notifyScraperStarted } from './telegram';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    search: '',
    renew: '',
    searchBy: 'account' as 'account' | 'buyer_name' | 'phone',
    sync: false,
    dryRun: false,
  };

  for (const arg of args) {
    if (arg.startsWith('--search=')) {
      config.search = arg.replace('--search=', '').trim();
    } else if (arg.startsWith('--search ') || arg.startsWith('--search')) {
      const match = arg.match(/--search\s+(.+)/);
      if (match) config.search = match[1].trim();
    } else if (arg.startsWith('--renew=')) {
      config.renew = arg.replace('--renew=', '').trim();
    } else if (arg.startsWith('--by=')) {
      const by = arg.replace('--by=', '').trim().toLowerCase();
      if (by === 'nome' || by === 'name' || by === 'buyer_name') config.searchBy = 'buyer_name';
      else if (by === 'telefone' || by === 'phone') config.searchBy = 'phone';
      else config.searchBy = 'account';
    } else if (arg === '--sync') {
      config.sync = true;
    } else if (arg === '--dry-run' || arg === '--simulate') {
      config.dryRun = true;
    }
  }

  return config;
}

/**
 * Função principal do scraper (exportada para ser usada no bot ou terminal)
 */
export async function runScraper() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🕷️  Scraper ResellerSystem - StarHome      ║');
  console.log('║   📦 Reybraztech — Extração de Clientes     ║');
  console.log('╚══════════════════════════════════════════════╝');

  const args = parseArgs();

  const config = {
    url: process.env.PANEL_URL || 'https://panel.web.starhome.vip',
    account: process.env.PANEL_ACCOUNT || '',
    password: process.env.PANEL_PASSWORD || '',
    headless: process.env.HEADLESS
      ? process.env.HEADLESS === 'true'
      : (process.env.NODE_ENV === 'production' || process.platform === 'linux'),
    itemsPerPage: parseInt(process.env.ITEMS_PER_PAGE || '500'),
    proxyServer: process.env.PROXY_SERVER || '',
    proxyUser: process.env.PROXY_USERNAME || '',
    proxyPass: process.env.PROXY_PASSWORD || '',
  };

  if (!config.account || !config.password) {
    console.error('\n❌ PANEL_ACCOUNT e PANEL_PASSWORD são obrigatórios no .env');
    console.error('   Crie um arquivo .env com as variáveis necessárias.\n');
    process.exit(1);
  }

  console.log(`\n📋 Configuração:`);
  console.log(`   URL: ${config.url}`);
  console.log(`   Account: ${config.account}`);
  console.log(`   Headless: ${config.headless}`);
  console.log(`   Itens/página: ${config.itemsPerPage}`);

  if (args.search) {
    console.log(`\n🔍 Modo BUSCA RÁPIDA:`);
    console.log(`   Query: "${args.search}"`);
    console.log(`   Tipo: ${args.searchBy}`);
  } else if (args.renew) {
    console.log(`\n🔄 Modo RENOVAÇÃO${args.dryRun ? ' (SIMULAÇÃO/DRY-RUN)' : ''}:`);
    console.log(`   Query: "${args.renew}"`);
    console.log(`   Tipo: ${args.searchBy}`);
    if (args.dryRun) console.log(`   ⚠️  DRY-RUN: Não confirmará a renovação no painel!`);
  } else if (args.sync) {
    console.log(`\n🔄 Modo SINCRONIZAÇÃO COMPLETA:`);
  } else {
    console.log(`\n⚠️  Nenhum modo especificado. Use --search, --renew ou --sync`);
    console.log(`   Exemplo: npm run scraper -- --search=conta123`);
    console.log(`   Exemplo: npm run scraper -- --renew="João Silva" --by=name`);
    console.log(`   Exemplo: npm run scraper -- --sync`);
    return [];
  }

  let browser;

  try {
    const startTime = Date.now();
    const session = await loginToPanel({
      url: config.url,
      account: config.account,
      password: config.password,
      headless: config.headless,
      proxy: config.proxyServer ? config.proxyServer : undefined,
      proxyAuth: config.proxyUser ? { username: config.proxyUser, password: config.proxyPass } : undefined,
    });
    browser = session.browser;

    // Notifica que o scraper está online
    notifyScraperStarted().catch(() => {});

    let clients: any[] = [];

    if (args.renew) {
      const fs = await import('fs');
      const outputPath = path.join(__dirname, '..', 'output', 'renew_result.json');

      let targetAccount = '';
      let clientName = '';

      if (args.searchBy === 'account') {
        // Account direto — pula a busca, sem ambiguidade
        targetAccount = args.renew;
        clientName = args.renew;
        console.log(`\n🔄 Renovando account direto: ${targetAccount}`);
      } else {
        // Busca por nome para achar o account
        const client = await searchAndExtractClient(session.page, args.renew, args.searchBy);
        if (!client) {
          console.log(`\n❌ Cliente não encontrado: "${args.renew}"`);
          fs.writeFileSync(outputPath, JSON.stringify({ success: false, error: `Cliente não encontrado: "${args.renew}"` }, null, 2));
          return [];
        }
        targetAccount = client.account;
        clientName = client.buyer_name;
        console.log(`\n✅ Cliente encontrado: ${clientName} (${targetAccount})`);
        console.log(`   Dias restantes: ${client.days_remaining} | Status: ${client.in_use}`);
        console.log(`\n🔄 Iniciando renovação...`);
      }

      await notifyRenewStart(clientName, targetAccount);

      const success = await renewClient(session.page, targetAccount, args.dryRun);

      if (success) {
        if (args.dryRun) {
          console.log(`\n🎯 Simulação concluída! Tudo pronto para renovar ${clientName} (${targetAccount})`);
          console.log(`   ⚠️  Nenhuma alteração foi feita no painel.`);
          fs.writeFileSync(outputPath, JSON.stringify({ success: true, dryRun: true, account: targetAccount, clientName }, null, 2));
        } else {
          console.log(`\n✅ Renovação concluída: ${clientName} (${targetAccount})`);

          // Busca dados frescos do cliente (com retry — a tabela pode estar recarregando)
          let freshClient = null;
          if (process.env.DATABASE_URL) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                console.log(`\n💾 Atualizando ${targetAccount} no banco... (tentativa ${attempt}/3)`);
                await new Promise(r => setTimeout(r, attempt === 1 ? 3000 : 4000));
                // Força recarga da SPA para resetar o filtro anterior e a tabela.
                // page.reload() (e não goto) porque a URL já pode ser #/account/list.
                await session.page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                await new Promise(r => setTimeout(r, 2500));
                freshClient = await searchAndExtractClient(session.page, targetAccount, 'account');
                if (freshClient) break;
                console.log(`   ⚠️  Busca pós-renew voltou vazia (tentativa ${attempt}), tentando de novo...`);
              } catch (searchErr: any) {
                console.log(`   ⚠️  Erro na busca pós-renew: ${searchErr.message}`);
              }
            }
          }

          const daysNow = freshClient?.days_remaining ?? 0;

          // Notifica com os dias reais (não mais 0 fixo)
          notifyRenewComplete(clientName, targetAccount, daysNow).catch(() => {});

          // Atualiza só o cliente no banco
          if (process.env.DATABASE_URL && freshClient) {
            try {
              await updateSingleClient(freshClient);
              fs.writeFileSync(outputPath, JSON.stringify({
                success: true,
                account: targetAccount,
                clientName: freshClient.buyer_name || clientName,
                days_remaining: freshClient.days_remaining,
              }, null, 2));
            } catch (dbErr: any) {
              console.error(`   ⚠️  Erro ao atualizar banco pós-renew: ${dbErr.message}`);
              fs.writeFileSync(outputPath, JSON.stringify({ success: true, account: targetAccount, clientName, days_remaining: daysNow }, null, 2));
            }
          } else if (process.env.DATABASE_URL) {
            console.error(`   ⚠️  Não foi possível obter dados frescos de ${targetAccount} após o renew.`);
            fs.writeFileSync(outputPath, JSON.stringify({ success: true, account: targetAccount, clientName, days_remaining: 0 }, null, 2));
          } else {
            fs.writeFileSync(outputPath, JSON.stringify({ success: true, account: targetAccount, clientName, days_remaining: daysNow }, null, 2));
          }
        }
      } else {
        console.log(`\n❌ Falha na renovação de: ${clientName} (${targetAccount})`);
        fs.writeFileSync(outputPath, JSON.stringify({ success: false, account: targetAccount, clientName, error: 'Processo de renovação falhou no painel' }, null, 2));
      }
      return [];
    }

    if (args.search) {
      const client = await searchAndExtractClient(session.page, args.search, args.searchBy);
      if (client) {
        clients = [client];
        console.log(`\n✅ Cliente encontrado!`);
        console.log(`   Account: ${client.account}`);
        console.log(`   Nome: ${client.buyer_name}`);
        console.log(`   Senha: [redacted]`);
        console.log(`   Pacote: ${client.package_name}`);
        console.log(`   Dias restantes: ${client.days_remaining}`);
        console.log(`   Status: ${client.in_use}`);
      } else {
        console.log(`\n❌ Cliente não encontrado: "${args.search}"`);
      }
    } else {
      await notifySyncStart();
      clients = await scrapeClients(session.page, config.itemsPerPage);
    }

    if (clients.length === 0) {
      console.log('\n⚠️  Nenhum cliente encontrado. Verifique se o login foi bem sucedido.');
      return [];
    }

    if (args.search) {
      const fs = await import('fs');
      const outputPath = path.join(__dirname, '..', 'output', 'client_search.json');
      
      if (clients.length > 0) {
        fs.writeFileSync(outputPath, JSON.stringify(clients, null, 2));
        console.log(`  💾 output/client_search.json`);
      } else {
        fs.writeFileSync(outputPath, JSON.stringify([], null, 2));
        console.log(`  💾 output/client_search.json (vazio - não encontrado)`);
      }
      
      return clients;
    }

    const { json, csv } = exportAll(clients);

    console.log('\n💾 Atualizando banco de dados...');
    await updateDatabase(clients);

    console.log('╔══════════════════════════════════════════════╗');
    console.log('║            ✅ EXTRAÇÃO CONCLUÍDA             ║');
    console.log('╠══════════════════════════════════════════════╣');
    console.log(`║  Total de clientes: ${String(clients.length).padEnd(24)}║`);
    console.log(`║  JSON: ${path.basename(json).padEnd(37)}║`);
    console.log(`║  CSV:  ${path.basename(csv).padEnd(37)}║`);
    console.log('╚══════════════════════════════════════════════╝');

    const active = clients.filter((c) => c.in_use === 'Used').length;
    const inactive = clients.filter((c) => c.in_use === 'Unused').length;
    const expiring = clients.filter((c) => c.days_remaining <= 3 && c.days_remaining > 0).length;
    const expired = clients.filter((c) => c.days_remaining <= 0 || c.expired === 'Expired').length;

    console.log('\n📊 Estatísticas:');
    console.log(`   🟢 Ativos (Used): ${active}`);
    console.log(`   ⚪ Inativos (Unused): ${inactive}`);
    console.log(`   🟡 Vencendo em 3 dias: ${expiring}`);
    console.log(`   🔴 Expirados: ${expired}\n`);

    // Notifica conclusão no Telegram
    const duration = ((Date.now() - startTime) / 1000).toFixed(0) + 's';
    notifySyncComplete({
      total: clients.length,
      active,
      inactive,
      expiring,
      expired,
      updated: clients.length,
      errors: 0,
      duration,
    }).catch(() => {});

    return clients;

  } catch (error: any) {
    console.error('\n❌ Erro durante a execução:', error);
    notifyError('Scraper', error.message || String(error)).catch(() => {});
    throw error;
  } finally {
    if (browser) {
      console.log('🔒 Fechando navegador...');
      await browser.close();
    }
    cleanupOutput();
  }
}

// Se o arquivo for rodado diretamente (não importado)
if (require.main === module) {
  runScraper().catch(() => process.exit(1));
}
