import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import chromium from '@sparticuz/chromium';
import * as fs from 'fs';
import * as path from 'path';
import { solveCaptcha } from './captcha';
import { sendTelegramMessage } from './telegram';
import { waitFor2FACode, new2FASessionId, set2FAState } from './twofa';
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
 * Retorna um estado explícito:
 *  - 'not-required' — nenhum desafio 2FA detectado
 *  - 'completed'    — 2FA concluído e autenticado
 *  - 'failed'       — 2FA falhou (envio, espera, código, confirmação ou modal pendente)
 */
async function handle2FA(page: Page, sessionId: string): Promise<'not-required' | 'completed' | 'failed'> {
  await delay(2000);

  const { codePlaceholders } = TWOFA_SIGNALS;
  const url = page.url();
  const isSecurityPage = url.includes('/info/accountSecurity');

  // DECISÃO ÚNICA: o estágio é decidido pelo MESMO classificador serializado que
  // o roteador de login usa. Nada de heurística duplicada aqui — captcha do login
  // (login-form) nunca entra no protocolo, seja com placeholder "verification code".
  const stage = await page.evaluate(detectLoginStage, TWOFA_SIGNALS);
  if (stage === 'login-form') {
    // Formulário real de login (senha + campo não-código): captcha, não 2FA.
    return 'not-required';
  }

  // - awaitingCode: já há um campo de código visível (fase de digitação), cujo
  //   handle é PRESERVADO para reutilizar na inserção (mesma heurística, sem
  //   divergência). Normalização idêntica à do classificador (código→codigo).
  // - needDispatch: há controle visível de SOLICITAR código (fase de envio).
  const allInputs = await page.$$('input');
  let awaitingCode = false;
  let codeInputHandle: any = null;
  for (const input of allInputs) {
    const visible = await input.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    });
    if (!visible) continue;
    const isCode = await input.evaluate((el, terms) => {
      const ph = (el.getAttribute('placeholder') || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .trim().toLowerCase();
      return terms.some((t: string) => ph.includes(t)) || !!el.closest('.code-input');
    }, codePlaceholders);
    if (isCode) { awaitingCode = true; codeInputHandle = input; break; }
  }

  const sendButtons = await page.$$('button, span.text-primary, a.text-primary');
  let needDispatch = false;
  for (const btn of sendButtons) {
    const text = await btn.evaluate((el: Element) => el.textContent || '');
    if (!isSendCodeLabel(text)) continue;
    const visible = await btn.evaluate((el) => {
      const s = window.getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && el.getBoundingClientRect().height > 0;
    });
    if (visible) { needDispatch = true; break; }
  }

  // Nenhum 2FA real: estágio não-twofa, sem input de código e sem envio.
  if (stage !== 'twofa' && !awaitingCode && !needDispatch && !isSecurityPage) {
    return 'not-required';
  }
  if (stage !== 'twofa' && !awaitingCode && !needDispatch) {
    // É (ou parece) a tela de security, mas sem nenhum sinal de desafio ativo.
    return 'not-required';
  }

  console.log('\n  🔒 Verificação de 2FA detectada! (Dispositivo / Navegador desconhecido)');

  // Estado de envio para a mensagem do Telegram (três valores, sem afirmar o que
  // não foi observado):
  //  - 'already-awaiting' — campo de código já aberto; nenhum clique/feedback vistos.
  //  - 'confirmed'        — envio clicado e feedback confirmado.
  //  - 'unconfirmed'      — envio clicado, mas sem feedback observável.
  let dispatchState: 'already-awaiting' | 'confirmed' | 'unconfirmed' = 'already-awaiting';

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

  // PASSO 2: Disparar o envio do código — SÓ se ainda não há um campo de código.
  // Estágio "awaiting-code" (código já enviado/modal reaberto) pula direto para a
  // espera; não clica em botão e não afirma confirmação que não observou.
  if (!awaitingCode && needDispatch) {
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
      return 'failed';
    }

    dispatchState = (await waitForCodeDispatchFeedback(page)) ? 'confirmed' : 'unconfirmed';
    console.log(dispatchState === 'confirmed'
      ? '  ✅ O painel exibiu uma confirmação após solicitar o código.'
      : '  ⚠️ Clique acionado, mas o painel não exibiu confirmação verificável de envio.');
  }

  // PASSO 3: Notifica pelo Telegram. O código deve ser entregue pelo Console Admin.
  const dispatchNote = dispatchState === 'already-awaiting'
    ? 'O painel já estava aguardando o código; não foi possível observar o disparo nesta execução.'
    : dispatchState === 'confirmed'
      ? '📧 O painel confirmou a solicitação do código por e-mail.'
      : '⚠️ O clique de envio foi acionado, mas o painel não mostrou confirmação. Confira também Spam e Promoções.';
  await sendTelegramMessage(
    '🔐 <b>Código 2FA (E-mail) necessário!</b>\n\n' +
    'O painel StarHome detectou um novo dispositivo.\n' +
    dispatchNote + '\n\n' +
    '➡️ <b>Digite o código de 6 dígitos no campo amarelo do Console Admin.</b>'
  ).catch(() => {});

  // Aguarda o código entregue por POST /2fa a partir do Console Admin.
  const code = (await waitFor2FACode(sessionId, 300000, 'código 2FA (E-mail)')) ?? '';

  if (!code) {
    console.log('  ⚠️  Nenhum código recebido. Cancelando tentativa de 2FA...');
    return 'failed';
  }

  // Encontra o campo de input do código e preenche
  let codeInserted = false;
  // Preferência: o MESMO handle do input detectado como "awaitingCode" no início
  // desta execução. Evita uma segunda heurística divergente que deixaria de achar
  // campos como "Verification token" que iniciaram a espera.
  if (codeInputHandle) {
    try {
      await codeInputHandle.click({ clickCount: 3 });
      await codeInputHandle.type(code);
      await mark2FAChallengeInput(page, codeInputHandle);
      codeInserted = true;
    } catch {
      codeInserted = false;
    }
  }

  if (!codeInserted) {
    const codeInputSelectors = [
      '.el-dialog input[type="text"]',
      '.el-dialog input',
      'input[placeholder*="code"]',
      'input[placeholder*="codigo"]',
      'input[placeholder*="Code"]',
      'input[placeholder*="verification"]',
      '.code-input input'
    ];

    for (const selector of codeInputSelectors) {
      const input = await page.$(selector);
      if (input) {
        await input.click({ clickCount: 3 });
        await input.type(code);
        await mark2FAChallengeInput(page, input);
        codeInserted = true;
        break;
      }
    }
  }

  // Fallback se não achou o input (mesma normalização do classificador)
  if (!codeInserted) {
    const allInputs = await page.$$('input[type="text"]');
    for (const input of allInputs) {
      const ph = await input.evaluate(el => (el.getAttribute('placeholder') || '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase());
      if (ph.includes('code') || ph.includes('codigo') || ph.includes('verification')) {
        await input.click({ clickCount: 3 });
        await input.type(code);
        await mark2FAChallengeInput(page, input);
        codeInserted = true;
        break;
      }
    }
  }

  if (!codeInserted) {
    console.log('  ❌ Campo para inserir o código 2FA não foi encontrado.');
    return 'failed';
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
    return 'failed';
  }

  await delay(5000);
  const stillOnSecurityPage = page.url().includes('/info/accountSecurity');
  if (stillOnSecurityPage) {
    console.log('  ❌ O painel permaneceu na tela de segurança após confirmar o código.');
    return 'failed';
  }

  // Em um desafio renderizado como modal sobre uma rota autenticada, a URL não
  // prova nada. Exige que o desafio realmente tenha sumido: nenhum input de
  // código 2FA visível. Se ainda houver, o código foi recusado ou o modal segue
  // aberto — trata como falha para não persistir cookies de sessão pendente.
  const challengeCleared = await waitForChallengeToClear(page, 8000);
  if (!challengeCleared) {
    console.log('  ❌ Modal/input de 2FA ainda visível após confirmar o código — código recusado ou pendente.');
    return 'failed';
  }

  return 'completed';
}

/**
 * Marca o elemento exato do desafio 2FA (o input de código usado e seu
 * modal/container mais próximo) com um atributo temporário. Recebe o próprio
 * handle do input para nunca acompanhar o elemento errado (fallback) nem
 * depender de idioma (chinês/inglês) ou de varrer a página por texto.
 */
async function mark2FAChallengeInput(page: Page, input: any): Promise<void> {
  const marker = 'data-traycer-2fa';
  await input.evaluate((el: Element, markerName: string) => {
    el.setAttribute(markerName, '1');
    const dialog = el.closest('.el-dialog, .el-dialog__wrapper, [role="dialog"], .modal');
    if (dialog) dialog.setAttribute(markerName, '1');
  }, marker);
}

/**
 * Espera o desafio 2FA desaparecer. Retorna true quando:
 *  - nenhum elemento marcado com `data-traycer-2fa` está visível; e
 *  - nenhum diálogo/modal visível ainda contém um input (cobre o caso de o
 *    framework remontar o modal após código recusado, perdendo o marcador).
 * A checagem estrutural é restrita a diálogos, para não disparar falso
 * negativo em um campo comum chamado "code" na rota autenticada.
 */
async function waitForChallengeToClear(page: Page, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const stillBlocked = await page.evaluate(() => {
      const isVisible = (el: Element) => {
        const s = window.getComputedStyle(el);
        return s.display !== 'none' && s.visibility !== 'hidden'
          && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0;
      };
      // 1) Elemento marcado ainda visível (input/modal do desafio).
      const marked = Array.from(document.querySelectorAll('[data-traycer-2fa]'));
      if (marked.some(isVisible)) return true;
      // 2) Desafio remontado: diálogo visível que ainda contém input.
      const dialogs = Array.from(document.querySelectorAll('.el-dialog, .el-dialog__wrapper, [role="dialog"], .modal'));
      for (const d of dialogs) {
        if (!isVisible(d)) continue;
        const hasInput = Array.from(d.querySelectorAll('input')).some(isVisible);
        if (hasInput) return true;
      }
      return false;
    });
    if (!stillBlocked) return true;
    await delay(500);
  }
  return false;
}

/**
 * Estágios possíveis da tela de login/autenticação do painel.
 *  - 'login-form' — formulário de credenciais (conta + senha + captcha)
 *  - 'twofa'      — desafio de Security Account / 2FA (input de código)
 *  - 'dashboard'  — sessão autenticada (sem formulário nem 2FA)
 *  - 'unknown'    — tela ainda não identificada (carregando/Cloudflare)
 */
type LoginStage = 'login-form' | 'twofa' | 'dashboard' | 'unknown';

/**
 * Lê o DOM atual e decide o estágio do login pela TELA, não pela URL.
 * Mantido como função pura (invocada dentro de page.evaluate).
 */
// ---------------------------------------------------------------------------
// Sinais de 2FA/segurança — FONTE ÚNICA DE VERDADE, compartilhada entre o
// classificador DOM (serializado para page.evaluate) e o handler Node.
// Toda correspondência textual de "campo de código" e "controle de solicitar"
// usa estes arrays; nunca duplique termos fora daqui.
// ---------------------------------------------------------------------------

const TWOFA_SIGNALS = {
  // Placeholders que identificam um campo onde o CÓDIGO 2FA deve ser digitado.
  // "verification" pode ser captcha do login; por isso a precedência ao
  // formulário com senha deve vir ANTES (ver detectLoginStage).
  codePlaceholders: ['code', 'codigo', 'verification'],
  // Apenas termos de SOLICITAR o envio do código (disparo inicial). Não inclui
  // verify/confirmar/确认, que são a etapa de CONFIRMAR o código digitado.
  sendTerms: ['send', 'obter codigo', '获取验证码', '发送', 'enviar', 'get code'],
  // Texto de HEADING de área de segurança/verificação. Usado como sinal
  // COMBINADO com um controle de enviar para não deixar um botão genérico
  // ("Send message", "Enviar aviso") virar 2FA no dashboard.
  securityHeadingTerms: ['account security', 'security account', 'security settings',
    'twofactor', 'two factor', '2fa', 'verify identity', 'verification',
    'seguranca da conta', 'autenticacao', '安全账户', '验证', '安全中心'],
} as const;

type TwofaSignals = typeof TWOFA_SIGNALS;

/**
 * Reconhece um controle de SOLICITAR código (início do desafio), pelos termos
 * de envio. Usado no lado Node (handle2FA) com os mesmos sinais do classificador.
 */
function isSendCodeLabel(text: string): boolean {
  const normalized = normalizeUiText(text);
  return TWOFA_SIGNALS.sendTerms.some(term => normalized.includes(term));
}

/**
 * Lê o DOM atual e decide o estágio do login pela TELA, não pela URL.
 * Os sinais são passados como parâmetro serializável (page.evaluate(detectLoginStage, TWOFA_SIGNALS))
 * para que o mesmo vocabulário do handler seja usado — os predicados são
 * definidos AQUI DENTRO (auto-contidos), porque page.evaluate serializa só o
 * corpo desta função, sem o escopo do módulo.
 */
function detectLoginStage(signals: TwofaSignals): LoginStage {
  const { codePlaceholders, sendTerms, securityHeadingTerms } = signals;
  const isVisible = (el: Element) => {
    const s = window.getComputedStyle(el);
    return s.display !== 'none' && s.visibility !== 'hidden'
      && el.getBoundingClientRect().height > 0 && el.getBoundingClientRect().width > 0;
  };
  const norm = (t: string) => t.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  const isCodeInput = (el: HTMLInputElement) =>
    codePlaceholders.some(t => norm(el.getAttribute('placeholder') || '').includes(t))
    || !!el.closest('.code-input');
  const isPlainField = (el: HTMLInputElement) =>
    el.type !== 'password' && (el.type === 'text' || el.type === 'email' || el.type === 'tel')
    && !isCodeInput(el);
  const isSendCtrl = (el: Element) =>
    sendTerms.some(t => norm(el.textContent || '').includes(t));
  const dialogs = Array.from(document.querySelectorAll('.el-dialog, .el-dialog__wrapper, [role="dialog"], .modal')).filter(isVisible);
  const visibleInputs = Array.from(document.querySelectorAll('input')).filter(isVisible);
  const bodyText = norm(document.body.innerText || '');

  // 1) MAIOR precedência: dialog/modal 2FA visível com sinal específico
  //    (campo de código OU controle de solicitar). Modal 2FA sobre o formulário
  //    ainda visível é twofa, NÃO login-form.
  for (const d of dialogs) {
    const dCode = Array.from(d.querySelectorAll('input')).filter(isVisible).some(isCodeInput);
    const dSend = Array.from(d.querySelectorAll('button, span.text-primary, a.text-primary')).some(el => isVisible(el) && isSendCtrl(el));
    if (dCode || dSend) return 'twofa';
  }

  // 2) Login form COMPLETO, por ESTRUTURA: senha + um campo não-senha que NÃO
  //    seja código (conta/captcha, qualquer placeholder, inclusive "Please enter").
  //    Tem precedência sobre placeholder genérico "code/verification": captcha do
  //    login não é 2FA. Um 2FA de Security Account (senha + código, sem conta)
  //    não satisfaz — código é excluído, então só sobra senha → não é login-form.
  const hasPass = visibleInputs.some(i => i.type === 'password' || i.getAttribute('type') === 'password');
  const hasPlainField = visibleInputs.some(isPlainField);
  if (hasPass && hasPlainField) return 'login-form';

  // 3) Input de código, FORA de um formulário de login (tela de digitação do 2FA).
  if (visibleInputs.some(isCodeInput)) {
    return 'twofa';
  }

  // 4) Etapa Send de Security Account (tela cheia, ainda sem input de código):
  //    controle visível de SOLICITAR código COMBINADO com heading de segurança.
  //    Requer os DOIS sinais para não deixar um botão genérico de dashboard
  //    ("Send message", "Enviar aviso") iniciar um falso 2FA.
  const hasSecurityHeading = securityHeadingTerms.some(t => bodyText.includes(t));
  const hasVisibleSendArea = Array.from(document.querySelectorAll('button, span.text-primary, a.text-primary'))
    .some(el => isVisible(el) && isSendCtrl(el));
  if (hasVisibleSendArea && hasSecurityHeading) {
    return 'twofa';
  }

  // 5) Formulário de login em montagem: vários inputs de texto + texto de login.
  const textInputs = visibleInputs.filter(el => el.type === 'text' || el.tagName === 'INPUT');
  if (textInputs.length >= 2) {
    if (bodyText.includes('login') || document.querySelector('.login-form, .el-form')) {
      return 'login-form';
    }
  }

  // 6) Dashboard: sem formulário de login nem 2FA, com menu lateral real.
  const hasVisibleMenu = Array.from(document.querySelectorAll('aside, .el-menu, .sidebar, nav')).some(isVisible);
  if (hasVisibleMenu) {
    return 'dashboard';
  }

  return 'unknown';
}

/**
 * Estágios que, uma vez estáveis, são terminais: o roteador pode agir neles.
 * 'unknown' NÃO é terminal — a tela ainda pode estar carregando (Cloudflare,
 * SPA) e evoluir para um dos estágios conhecidos, então continuamos amostrando
 * até o deadline para não decidir cedo demais.
 */
const TERMINAL_LOGIN_STAGES: ReadonlySet<LoginStage> =
  new Set(['login-form', 'twofa', 'dashboard']);

/**
 * Amostra a tela até o estágio do login estabilizar (ficar o mesmo por um
 * intervalo consecutivo) OU o deadline expirar.
 * - Estágios conhecidos (login-form/twofa/dashboard) retornam assim que ficam
 * 2500ms estáveis.
 * - 'unknown' continua sendo amostrado até o deadline; no timeout retorna
 *   'unknown' (fail-closed) — NUNCA um valor visto apenas uma vez, para não
 *   virar sucesso por um vislumbre instável de dashboard.
 */
async function waitForLoginStage(page: Page, timeoutMs: number): Promise<LoginStage> {
  const deadline = Date.now() + timeoutMs;
  let current: LoginStage = 'unknown';
  let stableSince: number | null = null;
  while (Date.now() < deadline) {
    const stage = await page.evaluate(detectLoginStage, TWOFA_SIGNALS);
    if (stage !== current || stableSince === null) {
      current = stage;
      stableSince = Date.now();
    } else if (TERMINAL_LOGIN_STAGES.has(stage) && Date.now() - stableSince >= 2500) {
      // Estágio conhecido estável por tempo suficiente: decidir.
      return stage;
    }
    await delay(600);
  }
  return 'unknown';
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

  // Identifica esta tentativa de login; usado pelo canal 2FA (memória/arquivo).
  const sessionId = new2FASessionId();

  // Sinaliza que ALGUMA etapa 2FA falhou (timeout/código recusado). Marcado só
  // quando o 2FA é realmente exigido e não conclui. Proíbe sucesso/cookies:
  // nenhum caminho que observou 2FA pendente pode virar "login ok" por URL.
  let any2FAFailed = false;

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
  try {
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

  // Verifica PRIMEIRO o estágio real da tela (não a URL). A decisão de
  // 'já autenticado' não pode vir de checagem de URL: quando a sessão cai e o
  // painel volta para a tela de Security Account/2FA, a URL pode não conter
  // 'login' nem '/info/accountSecurity' e o fast path assumiria logado sem
  // detectar o 2FA pendente. Aqui lemos o DOM, identificamos o estágio e
  // aguardamos a tela estabilizar antes de decidir.
  const stage = await waitForLoginStage(page, 15000);

  if (stage === 'dashboard') {
    console.log('  ✅ Já autenticado (tela de dashboard) — reuso de sessão, sem 2FA');
    sendTelegramMessage(
      '✅ <b>Sessão reutilizada</b>\n\n' +
      'O scraper já estava autenticado no painel (login recente ou sessão que não expirou), ' +
      'então prosseguiu <b>sem 2FA</b> nesta operação.'
    ).catch(() => {});
    return { browser, page };
  }

  // Tela de Security Account/2FA reconhecida por leitura do DOM: trata o 2FA
  // antes de seguir para o formulário (mesmo fluxo centralizado de um login novo).
  if (stage === 'twofa') {
    const twoFAState = await handle2FA(page, sessionId);
    if (twoFAState === 'completed') {
      console.log('  ✅ 2FA concluído a partir da sessão por cookies.');
      return { browser, page };
    }
    // 2FA exigido mas não concluído (timeout/código recusado/confirm. pendente):
    // marca para proibir sucesso por URL no fechamento, antes de tentar o form.
    if (twoFAState === 'failed') {
      any2FAFailed = true;
    }
    // Se falhou, segue para o formulário de login.
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
      const twoFAState = await handle2FA(page, sessionId);
      await delay(2000);

      // Estado do desafio MAIS RECENTE: 'completed' comprovado limpa uma falha
      // anterior (permite recuperação entre tentativas); 'failed' marca a atual.
      // 'not-required' NÃO limpa uma falha pendente — só um 2FA de fato concluído.
      if (twoFAState === 'completed') {
        any2FAFailed = false;
      } else if (twoFAState === 'failed') {
        any2FAFailed = true;
      }

      // Verifica sucesso: só conta como sucesso se 2FA não falhou e saiu da
      // tela de login/segurança. Um 2FA falho nunca é promovido a sucesso.
      const currentUrl = page.url();
      const stillOnLogin = currentUrl.includes('login');
      const stillOnSecurity = currentUrl.includes('/info/accountSecurity');
      const twoFAFailed = twoFAState === 'failed';
      if (!stillOnLogin && !stillOnSecurity && !twoFAFailed) {
        loginSuccessful = true;
      } else {
        const reason = stillOnSecurity || twoFAFailed
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
  // O sucesso final é decidido pela TELA, não por URL. Usa waitForLoginStage
  // (com estabilização) para não gerar falso-negativo enquanto o dashboard
  // ainda está montando. Exigimos:
  //  - nenhuma etapa 2FA pendente/falha no desafio mais recente, e
  //  - a tela final é um dashboard autenticado detectado pelo DOM.
  // Uma tela de Security Account/2FA em qualquer rota, ou 'unknown' não
  // detectado, nunca é promovido a sucesso por engano.
  const finalStage = await waitForLoginStage(page, 10000);
  let successful = !any2FAFailed && finalStage === 'dashboard';

  if (successful) {
    // Só persiste cookies depois que login e 2FA realmente terminaram.
    await saveCookies(page);
    set2FAState(sessionId, 'accepted');
    console.log('\n  ✅ Login realizado com sucesso!');
    console.log(`  📍 Página atual: ${finalUrl}\n`);
  } else {
    set2FAState(sessionId, 'rejected');
    console.log('\n  ⚠️  Parece que o login não foi concluído.');
    if (config.headless) {
      throw new Error('Login do StarHome não concluído: autenticação ou 2FA pendente.');
    }

    console.log('  📍 Verifique a janela do navegador e faça login manualmente se necessário.');
    console.log('  ⏳ Aguardando 30 segundos para login manual...\n');
    await delay(30000);

    // No modo manual, também decidimos pela TELA (dashboard) e pela ausência de
    // 2FA pendente — NUNCA por URL. Assim uma Security Account em outra rota
    // (inclusive após timeout/código recusado) não é salva como sessão válida.
    const manualStage = await waitForLoginStage(page, 10000);
    // Um dashboard ESTÁVEL que aparece depois que oferecemos a janela ao usuário
    // é conclusão MANUAL explícita do desafio: limpa a flag sticky para que essa
    // resolução manual não seja rejeitada.
    if (manualStage === 'dashboard') {
      any2FAFailed = false;
    }
    successful = manualStage === 'dashboard';
    if (!successful) {
      throw new Error('Login manual do StarHome não foi concluído dentro do prazo.');
    }
    // Aceito manualmente: registra o estado externo como aceito (sai de
    // 'rejected' gravado antes de oferecer a janela), simétrico ao sucesso auto.
    set2FAState(sessionId, 'accepted');
    await saveCookies(page);
  }

  return { browser, page };
  } catch (err) {
    // Nunca deixar o Chromium órfão: fecha o browser em todo caminho que lança.
    try { await browser.close(); } catch {}
    throw err;
  }
}
