import * as path from 'path';
import * as fs from 'fs';
import { loginToPanel } from './login';

async function debugHTML() {
  const config = {
    url: process.env.PANEL_URL || 'https://panel.web.starhome.vip',
    account: process.env.PANEL_ACCOUNT || '',
    password: process.env.PANEL_PASSWORD || '',
    headless: false, // sempre visível para inspeção manual
  };

  const session = await loginToPanel(config);
  const page = session.page;

  const panelUrl = page.url().split('#')[0];
  const accountListUrl = `${panelUrl}#/account/list`;
  console.log(`\n✅ Login OK! Navegando para a lista de clientes...`);
  await page.goto(accountListUrl, { waitUntil: 'networkidle2', timeout: 30000 });
  await new Promise(resolve => setTimeout(resolve, 3000));

  // Salva estado inicial
  const html = await page.content();
  fs.writeFileSync(path.join(__dirname, '..', 'output', 'page_dump.html'), html);
  await page.screenshot({ path: path.join(__dirname, '..', 'output', 'page_dump.png') });
  console.log('\n📸 Screenshot salvo em output/page_dump.png');

  // Monitora navegação e salva HTML sempre que a URL mudar
  let lastUrl = page.url();
  page.on('framenavigated', async (frame) => {
    if (frame === page.mainFrame() && page.url() !== lastUrl) {
      lastUrl = page.url();
      console.log(`\n🔗 URL mudou: ${lastUrl}`);
    }
  });

  console.log('\n🖐️  Navegador aberto. Faça o que precisar no painel.');
  console.log('📌 Quando quiser capturar a tela atual, pressione ENTER no terminal.');
  console.log('📌 Para encerrar, pressione CTRL+C.\n');

  // Loop: ENTER captura screenshot + HTML do estado atual
  const readline = await import('readline');
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let snapCount = 0;
  const askForSnap = () => {
    rl.question('[ ENTER = capturar tela | CTRL+C = sair ]: ', async () => {
      snapCount++;
      const snapFile = path.join(__dirname, '..', 'output', `snap_${snapCount}.png`);
      const htmlFile = path.join(__dirname, '..', 'output', `snap_${snapCount}.html`);
      await page.screenshot({ path: snapFile, fullPage: true });
      fs.writeFileSync(htmlFile, await page.content());
      console.log(`📸 Capturado: output/snap_${snapCount}.png + snap_${snapCount}.html`);
      console.log(`🔗 URL atual: ${page.url()}\n`);
      askForSnap();
    });
  };

  askForSnap();

  // Mantém o processo vivo até CTRL+C
  await new Promise(() => {});
}

debugHTML().catch(console.error);
