import * as fs from 'fs';
import * as path from 'path';
import type { Page, ElementHandle } from 'puppeteer';
import { Solver } from '@2captcha/captcha-solver';
import { askCaptchaTerminal } from './telegram';

// NOTA: A API key é lida dinamicamente dentro das funções para garantir
// que o dotenv.config() já foi executado antes desta variável ser acessada.

/**
 * Exibe um timer animado no terminal enquanto espera o 2Captcha resolver.
 * Retorna uma função de cancelamento (stop) para parar o timer.
 *
 * Exemplo visual:
 *   ⏳ 2Captcha resolvendo... [████████████░░░░░░░░] 12s / ~30s
 */
function startCaptchaTimer(expectedSeconds = 30): () => void {
  const barLength = 20;
  let seconds = 0;

  const interval = setInterval(() => {
    seconds++;
    const filled = Math.min(Math.floor((seconds / expectedSeconds) * barLength), barLength);
    const empty = barLength - filled;
    const bar = '█'.repeat(filled) + '░'.repeat(empty);
    // \r volta ao início da linha para atualizar no lugar (efeito loading)
    process.stdout.write(`\r  ⏳ 2Captcha resolvendo... [${bar}] ${seconds}s / ~${expectedSeconds}s`);
  }, 1000);

  // Retorna função para parar o timer
  return () => {
    clearInterval(interval);
    process.stdout.write('\n'); // Quebra linha após o timer parar
  };
}

/**
 * Captura a imagem do captcha do DOM como Base64 PNG.
 * Aplica filtro P&B + Scale 2x para melhor compatibilidade.
 */
async function captureCaptchaImage(
  page: Page,
  captchaElement: ElementHandle,
  captchaPath: string
): Promise<void> {
  try {
    const base64Data = await page.evaluate((el: any) => {
      if (el.tagName && (el.tagName.toLowerCase() === 'img' || el.tagName.toLowerCase() === 'canvas')) {
        const originalWidth = el.width || el.naturalWidth || 100;
        const originalHeight = el.height || el.naturalHeight || 40;

        const canvas = document.createElement('canvas');
        canvas.width = originalWidth * 2; // Scale 2x
        canvas.height = originalHeight * 2;

        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.imageSmoothingEnabled = false;
          ctx.drawImage(el, 0, 0, canvas.width, canvas.height);
          return canvas.toDataURL('image/png');
        }
      }
      // Se o src já for base64 inline (data:image/...)
      if (el.tagName?.toLowerCase() === 'img' && el.src?.startsWith('data:image')) {
        return el.src;
      }
      return null;
    }, captchaElement);

    if (base64Data) {
      const base64Image = (base64Data as string).replace(/^data:image\/\w+;base64,/, '');
      fs.writeFileSync(captchaPath, base64Image, 'base64');
      console.log('  📥 Imagem do captcha extraída do DOM.');
    } else {
      // Fallback: screenshot direto do elemento
      await captchaElement.screenshot({ path: captchaPath });
      console.log('  📸 Captcha capturado via screenshot (fallback).');
    }
  } catch {
    await captchaElement.screenshot({ path: captchaPath });
    console.log('  📸 Captcha capturado via screenshot (fallback após erro).');
  }
}

/**
 * Resolve o captcha usando o serviço 2Captcha.
 * Envia a imagem como Base64 e aguarda a resolução humana com timer animado.
 */
async function solveWith2Captcha(captchaPath: string): Promise<string | null> {
  // Lê dinamicamente para garantir que o dotenv já foi carregado
  const apiKey = process.env.TWO_CAPTCHA_API_KEY || '';

  if (!apiKey || apiKey === 'SUA_CHAVE_AQUI') {
    console.log('  ⚠️  TWO_CAPTCHA_API_KEY não configurada no .env');
    return null;
  }

  const solver = new Solver(apiKey);

  // Lê a imagem e converte para Base64
  const imageBuffer = fs.readFileSync(captchaPath);
  const imageBase64 = imageBuffer.toString('base64');

  console.log('  🚀 Enviando captcha para o 2Captcha...');
  const stopTimer = startCaptchaTimer(30); // Timer de 30s (média do serviço)

  try {
    const result = await solver.imageCaptcha({
      body: imageBase64,           // Imagem em Base64
      numeric: 4,                  // Indica que é numérico (4 dígitos)
      min_len: 4,
      max_len: 4,
    });

    stopTimer();
    const code = result.data?.trim() || '';
    console.log(`  ✅ 2Captcha resolveu: "${code}"`);
    return code.replace(/[^0-9]/g, ''); // Garante apenas dígitos
  } catch (error) {
    stopTimer();
    console.log(`  ❌ 2Captcha falhou: ${error}`);
    return null;
  }
}

/**
 * Função principal: captura e resolve o captcha da página de login.
 * Fluxo: DOM → 2Captcha (com timer) → Terminal (fallback)
 */
export async function solveCaptcha(page: Page): Promise<string> {
  console.log('🔍 Capturando captcha...');

  // Aguarda o captcha aparecer na tela
  await page.waitForSelector(
    '.verify-code-area img, canvas, .code-img, .captcha-img, img[src*="captcha"], img[src*="code"]',
    { timeout: 10000 }
  ).catch(() => null);

  // Tenta localizar o elemento do captcha
  const captchaSelectors = [
    '.verify-code-area img',
    '.code-img',
    '.captcha-img',
    'img[src*="captcha"]',
    'img[src*="code"]',
    'img[src*="verify"]',
  ];

  let captchaElement: ElementHandle | null = null;

  for (const selector of captchaSelectors) {
    captchaElement = await page.$(selector);
    if (captchaElement) {
      console.log(`  ✅ Captcha encontrado: ${selector}`);
      break;
    }
  }

  // Fallback: busca qualquer imagem no formulário de login
  if (!captchaElement) {
    const images = await page.$$('form img, .login-form img, .el-form img');
    if (images.length > 0) {
      captchaElement = images[images.length - 1];
      console.log('  ✅ Captcha localizado no formulário (fallback de seletor).');
    }
  }

  if (!captchaElement) {
    console.log('  ❌ Captcha não encontrado. Digitação manual necessária.');
    return await askCaptchaTerminal();
  }

  // Garante que o diretório de output existe
  const outputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }
  const captchaPath = path.join(outputDir, 'captcha.png');

  // Captura a imagem do captcha
  await captureCaptchaImage(page, captchaElement, captchaPath);

  // Tenta resolver com 2Captcha
  const code2Captcha = await solveWith2Captcha(captchaPath);
  if (code2Captcha && code2Captcha.length === 4) {
    return code2Captcha;
  }

  // Fallback final: pede ao usuário no terminal
  console.log('  🔄 Fallback: inserção manual no terminal...');
  console.log(`\n  📷 Veja o captcha em: ${captchaPath}`);
  console.log('  📺 O navegador está aberto — veja o captcha na tela.\n');
  const manualCode = await askCaptchaTerminal();
  console.log(`  ✅ Código inserido manualmente: ${manualCode}`);
  return manualCode;
}
