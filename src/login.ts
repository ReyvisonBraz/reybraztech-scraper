import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import * as fs from 'fs';
import * as path from 'path';
import { solveCaptcha } from './captcha';
import { sendTelegramMessage } from './telegram';
import { waitFor2FACode } from './twofa';
import { debugScreenshot } from './cleanup';
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

function normalizeUiText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase();
}

function isSendCodeLabel(text: string): boolean {
  const normalized = normalizeUiText(text);
  return normalized.includes('send')
    || normalized.includes('enviar')
    || normalized.includes('get code')
    || normalized.includes('obter codigo')
    || normalized.includes('发送')
    || normalized.includes('获取验证码');
}

async function waitForCodeDispatchFeedback(page: Page): Promise<boolean> {
  try {
    await page.waitForFunction(() => {
      const selectors = [
        '.el-message',
        '.el-notification',
        '.ant-message',
        '.ant-notification',
        '[role="alert"]',
      ];
      const text = selectors
        .flatMap(selector => Array.from(document.querySelectorAll(selector)))
        .map(element => element.textContent || '')
        .join(' ')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();

      return text.includes('sent')
        || text.includes('enviado')
        || text.includes('enviada')
        || text.includes('success')
        || text.includes('sucesso');
    }, { timeout: 6000, polling: 250 });
    return true;
  } catch {
    return false;
  }
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
    if (isSendCodeLabel(text)) {
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

  // PASSO 1: Selecionar a opção de E-mail
  try {
    console.log('  🔄 Tentando selecionar a opção de E-mail invés de SMS...');
    
    // Tenta primeiro abrir um possível dropdown de tipo de verificação
    const verifyMethodInputs = await page.$$('.el-select');
    if (verifyMethodInputs.length > 0) {
      await verifyMethodInputs[0].click().catch(() => {});
      await new Promise(r => setTimeout(r, 800)); // Espera a animação do dropdown
    }

    // Procura a opção "Email" ou "E-mail" para clicar
    const elementsWithEmail = await page.$$('li.el-select-dropdown__item, span, label, div.el-radio, span.el-radio__label');
    for (const el of elementsWithEmail) {
      const text = await el.evaluate(e => e.textContent || '');
      const hasEmailText = text.toLowerCase().includes('email') || text.toLowerCase().includes('e-mail');
      const isShort = text.trim().length < 40; // Evita clicar em divs gigantes que contêm a palavra
      
      if (hasEmailText && isShort) {
        const isVisible = await el.evaluate((e: any) => {
          const s = window.getComputedStyle(e);
          return s.display !== 'none' && s.visibility !== 'hidden' && e.getBoundingClientRect().height > 0 && e.getBoundingClientRect().width > 0;
        });
        if (isVisible) {
          await (el as any).click();
          console.log('  📧 Opção de E-mail selecionada com sucesso!');
          await new Promise(r => setTimeout(r, 800));
          break;
        }
      }
    }
  } catch (err) {
    console.log('  ⚠️ Não foi possível selecionar Email automaticamente (ou já estava selecionado).');
  }

  // PASSO 2: Clica no botão "Send" para o sistema disparar o e-mail
  let sendClicked = false;
  const allButtons = await page.$$('button, span.text-primary, a.text-primary');
  for (const btn of allButtons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (isSendCodeLabel(text)) {
      const isClickable = await btn.evaluate((el: any) => {
        const s = window.getComputedStyle(el);
        const clickable = el.closest('button, a') || el;
        return s.display !== 'none'
          && s.visibility !== 'hidden'
          && el.getBoundingClientRect().height > 0
          && !clickable.disabled
          && clickable.getAttribute('aria-disabled') !== 'true';
      });
      if (isClickable) {
        await btn.evaluate((el: any) => {
          const clickable = el.closest('button, a') || el;
          clickable.scrollIntoView({ block: 'center', inline: 'center' });
          clickable.click();
        });
        console.log('  📤 Clique no botão de envio do código acionado.');
        sendClicked = true;
        break;
      }
    }
  }

  if (!sendClicked) {
    console.log('  ❌ Botão de envio do código não foi encontrado ou estava desabilitado.');
    await sendTelegramMessage(
      '❌ <b>Não foi possível solicitar o código 2FA.</b>\n\n' +
      'O botão de envio do StarHome não foi encontrado ou estava desabilitado. O job será encerrado sem afirmar que o e-mail foi enviado.'
    ).catch(() => {});
    return false;
  }

  const dispatchConfirmed = await waitForCodeDispatchFeedback(page);
  console.log(dispatchConfirmed
    ? '  ✅ O painel exibiu uma confirmação após solicitar o código.'
    : '  ⚠️ Clique acionado, mas o painel não exibiu confirmação verificável de envio.');

  // PASSO 3: Notifica pelo Telegram. O código deve ser entregue pelo Console Admin.
  await sendTelegramMessage(
    '🔐 <b>Código 2FA (E-mail) necessário!</b>\n\n' +
    'O painel StarHome detectou um novo dispositivo.\n' +
    (dispatchConfirmed
      ? '📧 O painel confirmou a solicitação do código por e-mail.\n\n'
      : '⚠️ O clique de envio foi acionado, mas o painel não mostrou confirmação. Confira também Spam e Promoções.\n\n') +
    '➡️ <b>Digite o código de 6 dígitos no campo amarelo do Console Admin.</b>'
  ).catch(() => {});

  // Aguarda o código entregue por POST /2fa a partir do Console Admin.
  const code = (await waitFor2FACode(300000, 'código 2FA (E-mail)')) ?? '';

  if (!code) {
    console.log('  ⚠️  Nenhum código recebido. Cancelando tentativa de 2FA...');
    return false;
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
        codeInserted = true;
        break;
      }
    }
  }

  if (!codeInserted) {
    console.log('  ❌ Campo para inserir o código 2FA não foi encontrado.');
    return false;
  }

  // Clica no botão "Confirm"
  const buttons = await page.$$('button');
  let confirmClicked = false;
  for (const btn of buttons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (text.includes('Confirm') || text.includes('确认') || text.includes('Confirmar') || text.includes('Verify')) {
      await btn.click();
      console.log('  ✅ Código 2FA inserido e confirmado!');
      confirmClicked = true;
      break;
    }
  }

  if (!confirmClicked) {
    console.log('  ❌ Botão de confirmação do 2FA não foi encontrado.');
    return false;
  }

  await delay(5000);
  const stillOnSecurityPage = page.url().includes('/info/accountSecurity');
  if (stillOnSecurityPage) {
    console.log('  ❌ O painel permaneceu na tela de segurança após confirmar o código.');
    return false;
  }

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
  proxy?: string; // Ex: http://ip:port
  proxyAuth?: { username: string; password: string; };
}): Promise<{ browser: Browser; page: Page }> {
  console.log('\n🚀 Iniciando login no painel StarHome...\n');

  const isLinux = process.platform === 'linux';
  let chromePath: string | undefined;

  if (process.env.PUPPETEER_EXECUTABLE_PATH) {
    chromePath = process.env.PUPPETEER_EXECUTABLE_PATH;
    console.log(`  🔧 Chrome path (env): ${chromePath}`);
  } else if (isLinux) {
    // Tenta o puppeteer built-in primeiro (instalado pelo postinstall)
    try {
      const puppeteerCore = await import('puppeteer');
      const builtInPath = puppeteerCore.default.executablePath();
      if (builtInPath && fs.existsSync(builtInPath)) {
        chromePath = builtInPath;
        console.log(`  🔧 Chrome path (puppeteer built-in): ${chromePath}`);
      }
    } catch {}

    // Fallback: @sparticuz/chromium (empacotado para serverless)
    if (!chromePath) {
      try {
        chromePath = await chromium.executablePath();
        console.log(`  🔧 Chrome path (@sparticuz/chromium): ${chromePath}`);
      } catch {}
    }

    // Fallback final: paths conhecidos do Render/Debian
    if (!chromePath) {
      const knownPaths = [
        '/opt/render/.cache/puppeteer/chrome/linux-*/chrome-linux64/chrome',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium-browser',
        '/usr/bin/chromium',
      ];
      for (const p of knownPaths) {
        if (fs.existsSync(p)) {
          chromePath = p;
          console.log(`  🔧 Chrome path (known fallback): ${chromePath}`);
          break;
        }
      }
    }

    if (!chromePath) {
      console.log('  ⚠️  Chrome não encontrado em nenhum path conhecido. Deixando puppeteer resolver automaticamente.');
    }
  }

  const extraArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-features=IsolateOrigins,site-per-process',
    '--window-size=1920,1080',
  ];

  let args = isLinux
    ? [...chromium.args, ...extraArgs]
    : [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-extensions',
        '--no-first-run',
        ...extraArgs,
      ];

  // Adiciona Proxy se configurado (ótimo para contornar bloqueios de IP como Cloudflare)
  if (config.proxy) {
    const proxyArg = `--proxy-server=${config.proxy}`;
    args.push(proxyArg);
  }

  const launchOptions: Parameters<typeof puppeteer.launch>[0] = {
    headless: config.headless,
    executablePath: chromePath,
    defaultViewport: { width: 1920, height: 1080 },
    timeout: 60000,
    args: args,
  };

  const browser = await puppeteer.launch(launchOptions);
  let page = await browser.newPage();
  
  // Autenticação do proxy, caso seja proxy privado
  if (config.proxyAuth && config.proxyAuth.username) {
    await page.authenticate({ 
      username: config.proxyAuth.username, 
      password: config.proxyAuth.password 
    });
  }

  // User agent realista e atualizado
  await page.setUserAgent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
  );

  // Otimização: bloqueia recursos desnecessários para acelerar carregamento
  // NOTA: NÃO bloqueamos durante Cloudflare challenge (estilos/imgs podem ser necessários)
  await page.setRequestInterception(true);
  page.on('request', (req: any) => {
    const type = req.resourceType();
    // Só bloqueia fontes — imagens e CSS podem ser necessários para Cloudflare e renderização SPA
    if (type === 'font') {
      req.abort();
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
  // NOTA: Usamos 'domcontentloaded' em vez de 'networkidle2' porque o Cloudflare
  // mantém conexões WebSocket/keep-alive abertas que impedem o idle da rede.
  console.log(`  🌐 Acessando ${config.url}/#/login`);
  try {
    await page.goto(`${config.url}/#/login`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  } catch (err: any) {
    console.log(`  ⚠️ Aviso no page.goto: ${err.message}. Tentando prosseguir mesmo assim...`);
  }

  // Aguarda o Cloudflare Challenge ser resolvido (se existir)
  await page.waitForFunction(
    () => {
      if (!document.body) return true; // body ainda não existe = página ainda carregando, espera
      const bodyText = document.body.innerText || '';
      const isCloudflare = bodyText.includes('Checking your browser') ||
                           bodyText.includes('Just a moment') ||
                           bodyText.includes('DDoS') ||
                           bodyText.includes('protection');
      return !isCloudflare;
    },
    { timeout: 60000, polling: 1000 }
  ).catch(() => {
    console.log('  ⚠️ Cloudflare challenge pode ainda estar ativo, tentando prosseguir...');
  });

  // Verifica PRIMEIRO se cookies já estão válidos (caminho rápido)
  let alreadyLoggedIn = false;
  try {
    await page.waitForFunction(
      () => !window.location.href.includes('login'),
      { timeout: 8000, polling: 500 }
    );
    alreadyLoggedIn = true;
  } catch {
    // Ainda na tela de login — precisa preencher o formulário
  }

  if (alreadyLoggedIn) {
    console.log('  ✅ Já autenticado via cookies salvos!');
    return { browser, page };
  }

  // Aguarda o formulário de login renderizar
  console.log('  ⏳ Aguardando formulário de login...');
  await delay(2000);
  try {
    await page.waitForFunction(
      () => {
        const inputs = document.querySelectorAll('input[type="text"], input[type="password"]');
        return inputs.length >= 2;
      },
      { timeout: 30000 }
    );
    console.log('  ✅ Inputs do formulário de login detectados');
  } catch {
    console.log('  ⚠️ Inputs de login não encontrados, tentando seletor CSS...');
  }

  // Espera o formulário de login aparecer
  try {
    await page.waitForSelector('.el-form, .login-form, form, input[type="password"]', { timeout: 30000 });
    console.log('  ✅ Formulário de login detectado');
  } catch {
    console.log('  ⚠️ Formulário não encontrado diretamente, procurando inputs...');
  }

  await delay(1000);

  let loginSuccessful = false;
  let loginAttempts = 0;
  const maxLoginAttempts = 5; // Tenta até 5 vezes antes do fallback manual

  while (!loginSuccessful && loginAttempts < maxLoginAttempts) {
    loginAttempts++;
    console.log(`\n  📝 [Tentativa ${loginAttempts}/${maxLoginAttempts}] Preenchendo formulário de login...`);

    // Limpa campos antes de preencher (suporta ElementUI e Ant Design)
    const inputs = await page.$$('input.el-input__inner, input.ant-input, input[type="text"], input[type="password"]');
    console.log(`  📋 Inputs encontrados: ${inputs.length}`);
    if (inputs.length >= 3) {
      for (const input of inputs) {
          await input.click({ clickCount: 3 });
          await page.keyboard.press('Backspace');
      }

      // Preenche os campos de forma "humana"
      const { sendTelegramMessage } = await import('./telegram');
      await sendTelegramMessage('🤖 <b>Automação:</b> Preenchendo dados de login no painel...');
      
      await humanDelay(500, 1500);
      await inputs[0].click();
      await inputs[0].type(config.account, { delay: Math.floor(Math.random() * 50) + 50 });
      console.log('    ✅ Account preenchido');

      await humanDelay(300, 800);
      await inputs[1].click();
      await inputs[1].type(config.password, { delay: Math.floor(Math.random() * 50) + 40 });
      console.log('    ✅ Password preenchido');

      await sendTelegramMessage('🧩 <b>Automação:</b> Extraindo e resolvendo o Captcha do painel...');
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
      await sendTelegramMessage('🔑 <b>Automação:</b> Clique de Login disparado. Aguardando resposta do Starhome...');
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
      const twoFACompleted = await handle2FA(page);
      await delay(2000);

      // Verifica sucesso
      const currentUrl = page.url();
      const stillOnLogin = currentUrl.includes('login');
      const stillOnSecurity = currentUrl.includes('/info/accountSecurity');
      if (!stillOnLogin && !stillOnSecurity) {
        loginSuccessful = true;
      } else {
        const reason = stillOnSecurity && !twoFACompleted
          ? '2FA não concluído'
          : 'captcha incorreto ou sessão expirada';
        console.log(`    ⚠️ [${loginAttempts}/${maxLoginAttempts}] Login falhou — ${reason}.`);
        console.log(`    🔄 Renovando captcha para próxima tentativa...`);
        // Salva screenshot para debug
        await debugScreenshot(page, path.join(__dirname, '..', 'output', `login_fail_attempt_${loginAttempts}.png`));
        // Clica na imagem do captcha para gerar um novo código
        const captchaImgSelectors = ['img[src*="captcha"]', '.code-img', 'form img'];
        for (const sel of captchaImgSelectors) {
          const captchaImg = await page.$(sel);
          if (captchaImg) { await captchaImg.click(); break; }
        }
        await delay(2000); // Aguarda nova imagem carregar
      }
    } else {
        console.log(`    ❌ Encontrados apenas ${inputs.length} campos de input ao invés de 3.`);
        console.log('    📸 Tirando screenshot da tela para ver o erro (Cloudflare block?)...');
        const errPath = path.join(__dirname, '..', 'output', `login_error_view.png`);
        await page.screenshot({ path: errPath, fullPage: true });

        try {
          const { sendCaptchaToTelegram } = await import('./telegram');
          await sendCaptchaToTelegram(
             errPath,
             `🚨 <b>Alerta do Scraper!</b>\nNão consegui encontrar os formulários de login do painel.\nIsso geralmente significa que a página demorou muito para carregar ou o Cloudflare barrou (IP do Render).\n\nAqui está exatamente o que o bot está "vendo" agora:`
          );
        } catch(e) {}

        // Tenta recarregar a página antes de desistir
        if (loginAttempts < maxLoginAttempts) {
          console.log(`    🔄 Recarregando página e aguardando mais ${loginAttempts * 5}s...`);
          await delay(loginAttempts * 5000);
          try {
            await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
            await delay(5000); // Aguarda SPA renderizar após reload
          } catch {}
          await delay(3000);
          continue;
        }

        break;
    }
  }

  const finalUrl = page.url();
  let successful = loginSuccessful
    || (!finalUrl.includes('login') && !finalUrl.includes('/info/accountSecurity'));
  
  if (successful) {
    // Só persiste cookies depois que login e 2FA realmente terminaram.
    await saveCookies(page);
    console.log('\n  ✅ Login realizado com sucesso!');
    console.log(`  📍 Página atual: ${finalUrl}\n`);
  } else {
    console.log('\n  ⚠️  Parece que o login não foi concluído.');
    if (config.headless) {
      throw new Error('Login do StarHome não concluído: autenticação ou 2FA pendente.');
    }

    console.log('  📍 Verifique a janela do navegador e faça login manualmente se necessário.');
    console.log('  ⏳ Aguardando 30 segundos para login manual...\n');
    await delay(30000);

    const manualUrl = page.url();
    successful = !manualUrl.includes('login') && !manualUrl.includes('/info/accountSecurity');
    if (!successful) {
      throw new Error('Login manual do StarHome não foi concluído dentro do prazo.');
    }
    await saveCookies(page);
  }

  return { browser, page };
}
