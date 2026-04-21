import * as path from 'path';
import 'dotenv/config'; // Adicionado para desenvolvimento local, será ignorado inofensivamente no Render caso falhe (embora o ideal seja garantir que não trave se não achar o arquivo)
import { loginToPanel } from './login';
import { scrapeClients, searchAndExtractClient } from './scrape';
import { exportAll } from './export';
import { updateDatabase } from './update-db';
import { renewClient } from './renew';

function parseArgs() {
  const args = process.argv.slice(2);
  const config = {
    search: '',
    renew: '',
    searchBy: 'account' as 'account' | 'buyer_name' | 'phone',
    sync: false,
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
    headless: process.env.HEADLESS === 'true',
    itemsPerPage: parseInt(process.env.ITEMS_PER_PAGE || '100'),
    proxyServer: process.env.PROXY_SERVER || '',
    proxyUser: process.env.PROXY_USERNAME || '',
    proxyPass: process.env.PROXY_PASSWORD || '',
  };

  if (!config.account || !config.password) {
    throw new Error('PANEL_ACCOUNT e PANEL_PASSWORD são obrigatórios no .env');
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
    console.log(`\n🔄 Modo RENOVAÇÃO:`);
    console.log(`   Query: "${args.renew}"`);
    console.log(`   Tipo: ${args.searchBy}`);
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
    const session = await loginToPanel({
      url: config.url,
      account: config.account,
      password: config.password,
      headless: config.headless,
      proxy: config.proxyServer ? config.proxyServer : undefined,
      proxyAuth: config.proxyUser ? { username: config.proxyUser, password: config.proxyPass } : undefined,
    });
    browser = session.browser;

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

      const success = await renewClient(session.page, targetAccount);

      if (success) {
        console.log(`\n✅ Renovação concluída: ${clientName} (${targetAccount})`);
        fs.writeFileSync(outputPath, JSON.stringify({ success: true, account: targetAccount, clientName }, null, 2));
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
        console.log(`   Senha: ${client.password}`);
        console.log(`   Pacote: ${client.package_name}`);
        console.log(`   Dias restantes: ${client.days_remaining}`);
        console.log(`   Status: ${client.in_use}`);
      } else {
        console.log(`\n❌ Cliente não encontrado: "${args.search}"`);
      }
    } else {
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

    return clients;

  } catch (error) {
    console.error('\n❌ Erro durante a execução:', error);
    throw error;
  } finally {
    if (browser) {
      console.log('🔒 Fechando navegador...');
      await browser.close();
    }
  }
}

// Se o arquivo for rodado diretamente (não importado)
if (require.main === module) {
  runScraper().catch(() => process.exit(1));
}
