import puppeteer from 'puppeteer';
import * as fs from 'fs';
import * as path from 'path';

const outPath = path.join(__dirname, '..', 'output', 'api_logs.json');
const logs: any[] = [];

async function spyOnUser() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║   🕵️  Scraper Espião — Capturando a API     ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log('\nNavegador abrindo...');
  console.log('Faça o login normalmente, resolva o captcha, o 2FA, etc.');
  console.log('Vá até a lista de clientes, mude de página, clique nas senhas.');
  console.log('Quando terminar, apenas feche o navegador!\n');
  console.log('Estou gravando as URLs da API no fundo...');

  const browser = await puppeteer.launch({
    headless: false,
    defaultViewport: null, // Maximizado
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const page = await browser.newPage();

  // Intercepta todas as requisições e respostas
  page.on('response', async (response) => {
    const request = response.request();
    const url = request.url();

    // Filtra apenas chamadas de API (ignora imagens, css, js)
    if (url.includes('/api/') || (request.resourceType() === 'fetch' || request.resourceType() === 'xhr')) {
      try {
        let postData = request.postData();
        let body = null;
        
        // Tenta ler a resposta da API (que geralmente é JSON)
        try {
          body = await response.json();
        } catch {
          // Ignora se não for JSON
        }

        const logEntry = {
          url: url,
          method: request.method(),
          headers: request.headers(),
          postData: postData,
          responseStatus: response.status(),
          responseBody: body,
        };

        logs.push(logEntry);

        // Imprime na tela o que pegou
        if (url.includes('login')) console.log('✅ Endpoint de LOGIN capturado!');
        if (url.includes('account/list') || url.includes('client')) console.log('✅ Endpoint de LISTA DE CLIENTES capturado!');
        
      } catch (e) {
        // Ignora erros de CORS ou respostas vazias
      }
    }
  });

  // Salva no arquivo quando o navegador for fechado
  browser.on('disconnected', () => {
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, JSON.stringify(logs, null, 2));
    console.log('\n🏁 Navegador fechado!');
    console.log(`💾 O relatório completo da API foi salvo em: ${outPath}`);
    console.log('🔗 O assistente agora pode ler este arquivo para construir a chamada direta da API!');
    process.exit(0);
  });

  await page.goto('https://panel.web.starhome.vip/#/login');
}

spyOnUser().catch(console.error);
