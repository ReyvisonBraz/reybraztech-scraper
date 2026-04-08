import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import * as fs from 'fs';
import * as path from 'path';
import { solveCaptcha } from './captcha';
import { sendTelegramMessage } from './telegram';
import { waitFor2FACode } from './twofa';
import type { Page, Browser } from 'puppeteer';

// Configura o plugin Stealth para evitar detecção por bots (ex: Cloudflare)
puppeteer.use(StealthPlugin());

const COOKIES_DIR = path.join(__dirname, '..', 'cookies');
const COOKIES_FILE = path.join(COOKIES_DIR, 'session.json');

/** Espera um tempo fixo mínimo mais um valor aleatório para simular lentidão humana */
function humanDelay(minMs: number = 300, maxMs: number = 1200): Promise<void> {
  const delay = Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

/** Espera exatos N milissegundos */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


/**
 * Salva os cookies da sessão atual para reusar depois (evita 2FA repetido).
 */
async function saveCookies(page: Page): Promise<void> {
  if (!fs.existsSync(COOKIES_DIR)) {
    fs.mkdirSync(COOKIES_DIR, { recursive: true });
  }
  const cookies = await page.cookies();
  fs.writeFileSync(COOKIES_FILE, JSON.stringify(cookies, null, 2));
  console.log('  💾 Cookies salvos para próximas sessões');
}

/**
 * Carrega cookies salvos previamente.
 */
async function loadCookies(page: Page): Promise<boolean> {
  if (fs.existsSync(COOKIES_FILE)) {
    try {
      const cookies = JSON.parse(fs.readFileSync(COOKIES_FILE, 'utf-8'));
      await page.setCookie(...cookies);
      console.log('  🍪 Cookies carregados de sessão anterior');
      return true;
    } catch {
      console.log('  ⚠️  Falha ao carregar cookies, fazendo login normal');
    }
  }
  return false;
}



/**
 * Verifica se a tela de 2FA apareceu (seja modal ou redirecionamento) e lida com ela.
 */
async function handle2FA(page: Page): Promise<boolean> {
  await delay(2000);

  // Procura o botão de enviar código ou o input de código para confirmar que é realmente 2FA
  let has2FAElements = false;
  
  const detectButtons = await page.$$('button, span.text-primary, a.text-primary');
  for (const btn of detectButtons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (text.includes('Send') || text.includes('Enviar') || text.includes('Get code')) {
      const isVisible = await btn.evaluate((el) => {
        const style = window.getComputedStyle(el);
        return style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
      });
      if (isVisible) {
        has2FAElements = true;
        break;
      }
    }
  }

  if (!has2FAElements) {
     const inputs = await page.$$('input[type="text"]');
     for (const input of inputs) {
       const isVisible = await input.evaluate((el) => {
         const style = window.getComputedStyle(el);
         return style.display !== 'none' && style.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
       });
       if (isVisible) {
         const ph = await input.evaluate(el => el.getAttribute('placeholder') || '');
         if (ph.toLowerCase().includes('code') || ph.toLowerCase().includes('código')) {
           has2FAElements = true;
           break;
         }
       }
     }
  }

  const url = page.url();
  let isSecurityPage = url.includes('/info/accountSecurity');

  if (!has2FAElements && !isSecurityPage) {
    return false;
  }
  
  if (!has2FAElements) {
     // Even if it's security page, if no 2FA elements are visible, it was probably just a dashboard that looks like security page
     return false;
  }

  console.log('\n  🔒 Verificação de 2FA detectada! (Dispositivo / Navegador desconhecido)');

  // PASSO 1: Clica no botão "Send" para o sistema disparar o SMS/e-mail
  let sendClicked = false;
  const allButtons = await page.$$('button, span.text-primary, a.text-primary');
  for (const btn of allButtons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (text.includes('Send') || text.includes('Enviar') || text.includes('Get code')) {
      const isVisible = await btn.evaluate((el: any) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
      });
      if (isVisible) {
        await (btn as any).click();
        console.log('  📤 Botão "Send" clicado — SMS/e-mail sendo enviado pelo painel...');
        sendClicked = true;
        await new Promise(r => setTimeout(r, 1500));
        break;
      }
    }
  }

  if (!sendClicked) {
    console.log('  ⚠️  Botão "Send" não encontrado — o painel pode já ter enviado o código.');
  }

  // PASSO 2: Notifica pelo Telegram (aviso apenas, não espera resposta)
  await sendTelegramMessage(
    '🔐 <b>Código 2FA necessário!</b>\n\n' +
    'O painel StarHome detectou um novo dispositivo.\n' +
    '📱 O SMS/e-mail já foi disparado pelo painel.\n\n' +
    '<b>Acesse o painel Admin → Console e use o campo 2FA</b>'
  ).catch(() => {}); // Não bloqueia se Telegram falhar

  // Aguarda 2FA via arquivo compartilhado (painel Admin) ou terminal (local)
  const code = (await waitFor2FACode(300000, 'código 2FA')) ?? '';

  if (!code) {
    console.log('  ⚠️  Nenhum código recebido. Tentando continuar sem 2FA...');
  }

  // Encontra o campo de input do código e preenche
  const codeInputSelectors = [
    '.el-dialog input[type="text"]',
    '.el-dialog input',
    'input[placeholder*="code"]',
    'input[placeholder*="código"]',
    'input[placeholder*="Code"]',
    '.code-input input'
  ];

  let codeInserted = false;
  for (const selector of codeInputSelectors) {
    const input = await page.$(selector);
    if (input) {
      await input.click({ clickCount: 3 });
      await input.type(code);
      codeInserted = true;
      break;
    }
  }

  // Fallback se não achou o input
  if (!codeInserted) {
    const allInputs = await page.$$('input[type="text"]');
    for (const input of allInputs) {
      const ph = await input.evaluate(el => el.getAttribute('placeholder') || '');
      if (ph.toLowerCase().includes('code') || ph.toLowerCase().includes('código')) {
        await input.click({ clickCount: 3 });
        await input.type(code);
        break;
      }
    }
  }

  // Clica no botão "Confirm"
  const buttons = await page.$$('button');
  for (const btn of buttons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (text.includes('Confirm') || text.includes('确认') || text.includes('Confirmar') || text.includes('Verify')) {
      await btn.click();
      console.log('  ✅ Código 2FA inserido e confirmado!');
      break;
    }
  }

  await delay(3000);
  return true;
}

/**
 * Faz login no painel ResellerSystem.
 */
export async function loginToPanel(config: {
  url: string;
  account: string;
  password: string;
  headless: boolean;
}): Promise<{ browser: Browser; page: Page }> {
  console.log('\n🚀 Iniciando login no painel StarHome...\n');

  const isLinux = process.platform === 'linux';

  const browser = await puppeteer.launch({
    headless: config.headless,
    defaultViewport: { width: 1280, height: 900 },
    timeout: 60000,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-extensions',
      '--no-first-run',
      '--window-size=1280,900',
      // Flags críticas para containers Linux (Render/Docker) — NÃO usar no Windows
      ...(isLinux ? [
        '--no-zygote',
        '--single-process',
        '--disable-software-rasterizer',
        '--disable-background-networking',
        '--disable-default-apps',
      ] : []),
    ],
  });

  const page = await browser.newPage();

  // User agent realista e atualizado
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
  );

  // Evita carregamento de recursos inúteis para focar na velocidade do humanizado
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
      if (['image', 'stylesheet', 'font'].includes(req.resourceType()) && !req.url().includes('captcha')) {
          req.continue(); // Por enquanto deixamos continuar tudo, mas podemos bloquear lixo se der timeout
      } else {
          req.continue();
      }
  });

  // Esconde sinais de automação adicionais (O stealth plugin já faz muito disso, mas redundância ajuda)
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });

  // Carrega cookies se existirem
  await loadCookies(page);

  // Navega para a página de login
  console.log(`  🌐 Acessando ${config.url}/#/login`);
  await page.goto(`${config.url}/#/login`, { waitUntil: 'networkidle2', timeout: 30000 });
  await delay(2000);

  // Verifica se já está logado (cookies funcionaram)
  const currentUrl = page.url();
  if (!currentUrl.includes('login')) {
    console.log('  ✅ Já autenticado via cookies salvos!');
    return { browser, page };
  }

  let loginSuccessful = false;
  let loginAttempts = 0;
  const maxLoginAttempts = 5; // Tenta até 5 vezes antes do fallback manual

  while (!loginSuccessful && loginAttempts < maxLoginAttempts) {
    loginAttempts++;
    console.log(`\n  📝 [Tentativa ${loginAttempts}/${maxLoginAttempts}] Preenchendo formulário de login...`);

    // Limpa campos antes de preencher
    const inputs = await page.$$('input.el-input__inner, input[type="text"], input[type="password"]');
    if (inputs.length >= 3) {
      for (const input of inputs) {
          await input.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
      }

      // Preenche os campos de forma "humana"
      await humanDelay(500, 1500);
      await inputs[0].click();
      await inputs[0].type(config.account, { delay: Math.floor(Math.random() * 50) + 50 });
      console.log('    ✅ Account preenchido');

      await humanDelay(300, 800);
      await inputs[1].click();
      await inputs[1].type(config.password, { delay: Math.floor(Math.random() * 50) + 40 });
      console.log('    ✅ Password preenchido');

      // Tenta resolver o captcha
      const captchaCode = await solveCaptcha(page);
      await humanDelay(300, 800);
      await inputs[2].click();
      await inputs[2].type(captchaCode, { delay: Math.floor(Math.random() * 100) + 50 });
      console.log('    ✅ Captcha preenchido');

      // Marca Remember Me se for a primeira vez
      if (loginAttempts === 1) {
        console.log('    📌 Marcando "Remember me"...');
        const checkboxes = await page.$$('input[type="checkbox"]');
        if (checkboxes.length > 0) {
          await page.evaluate((el: any) => el.click(), checkboxes[0]);
        }
      }

      // Clica no Login
      console.log('    🔑 Clicando em Login...');
      const btns = await page.$$('button');
      for (const btn of btns) {
        const text = await btn.evaluate((el: Element) => el.textContent || '');
        if (text.includes('Login') || text.includes('Entrar')) {
          await btn.click();
          break;
        }
      }

      console.log('    ⏳ Aguardando resposta do servidor...');
      await delay(3000);

      // Trata 2FA se aparecer
      await handle2FA(page);
      await delay(2000);

      // Verifica sucesso
      const currentUrl = page.url();
      if (!currentUrl.includes('login') || currentUrl.includes('/info/accountSecurity')) {
        loginSuccessful = true;
      } else {
        console.log(`    ⚠️ [${loginAttempts}/${maxLoginAttempts}] Login falhou — captcha incorreto ou sessão expirada.`);
        console.log(`    🔄 Renovando captcha para próxima tentativa...`);
        // Salva screenshot para debug
        await page.screenshot({ path: path.join(__dirname, '..', 'output', `login_fail_attempt_${loginAttempts}.png`) });
        // Clica na imagem do captcha para gerar um novo código
        const captchaImgSelectors = ['img[src*="captcha"]', '.code-img', 'form img'];
        for (const sel of captchaImgSelectors) {
          const captchaImg = await page.$(sel);
          if (captchaImg) { await captchaImg.click(); break; }
        }
        await delay(2000); // Aguarda nova imagem carregar
      }
    } else {
        console.log('    ❌ Não encontrei os campos de input de login.');
        break;
    }
  }

  // Salva cookies para próximas sessões
  await saveCookies(page);

  const finalUrl = page.url();
  const successful = loginSuccessful || (!finalUrl.includes('login') || finalUrl.includes('/info/accountSecurity'));
  
  if (successful) {
    console.log('\n  ✅ Login realizado com sucesso!');
    console.log(`  📍 Página atual: ${finalUrl}\n`);
  } else {
    console.log('\n  ⚠️  Parece que o login não foi concluído.');
    console.log('  📍 Verifique a janela do navegador e faça login manualmente se necessário.');
    console.log('  ⏳ Aguardando 30 segundos para login manual...\n');
    await delay(30000);
    await saveCookies(page);
  }

  return { browser, page };
}
