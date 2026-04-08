import * as path from 'path';
import { loginToPanel } from './login';
import { renewClient } from './renew';

async function main() {
  const account = 'ft3mhk';

  console.log('='.repeat(50));
  console.log(`🚀 TESTE DE RENOVAÇÃO — Conta: ${account}`);
  console.log('='.repeat(50));

  const config = {
    url: process.env.PANEL_URL || 'https://panel.web.starhome.vip',
    account: process.env.PANEL_ACCOUNT || '',
    password: process.env.PANEL_PASSWORD || '',
    headless: true, // background — viewport = coordenadas reais
  };

  const { browser, page } = await loginToPanel(config);

  try {
    const success = await renewClient(page, account);

    if (success) {
      console.log(`\n✅ RENOVAÇÃO CONCLUÍDA: ${account}`);
    } else {
      console.log(`\n❌ RENOVAÇÃO FALHOU: ${account}`);
      console.log('   Verifique os screenshots em scraper/output/');
    }
  } finally {
    console.log('\n⏳ Fechando navegador em 5 segundos...');
    await new Promise(r => setTimeout(r, 5000));
    await browser.close();
  }
}

main().catch(console.error);
