import axios from 'axios';
import * as fs from 'fs';
import FormData from 'form-data';
import * as readline from 'readline';

// =====================================================================
// FUNÇÕES GENÉRICAS (usadas para 2FA e notificações)
// =====================================================================

/**
 * Envia uma mensagem de texto simples para o Telegram.
 */
export async function sendTelegramMessage(text: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('  ⚠️  Telegram não configurado no .env');
    return false;
  }

  try {
    await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    });
    console.log('  📱 Mensagem enviada para o Telegram!');
    return true;
  } catch (error: any) {
    console.log(`  ❌ Erro ao enviar mensagem Telegram: ${error.message}`);
    return false;
  }
}

/**
 * Aguarda qualquer resposta de texto do usuário no Telegram.
 * Aceita qualquer mensagem (código 2FA, texto livre, etc).
 *
 * @param timeoutMs Tempo máximo de espera em ms (padrão: 5 min)
 * @param label Label para o console (ex: "código 2FA", "captcha")
 */
export async function waitForTelegramReply(
  timeoutMs: number = 300000,
  label: string = 'resposta'
): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return null;

  console.log(`  ⏳ Aguardando ${label} pelo Telegram (timeout: ${Math.round(timeoutMs / 1000)}s)...`);

  const startTime = Date.now();
  let lastUpdateId = 0;

  // Limpa updates antigos para não pegar mensagens velhas
  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`);
    if (res.data?.ok && res.data.result.length > 0) {
      lastUpdateId = res.data.result[res.data.result.length - 1].update_id;
    }
  } catch (e: any) {
    if (e.response?.status === 409) {
      console.log('  ⚠️  Telegram com conflito de Webhook. Crie um bot sem Webhook via BotFather.');
      return null;
    }
  }

  // Timer visual no console
  const timerLog = setInterval(() => {
    const elapsed = Math.round((Date.now() - startTime) / 1000);
    process.stdout.write(`\r  ⏳ Aguardando ${label}... ${elapsed}s / ${Math.round(timeoutMs / 1000)}s`);
  }, 1000);

  try {
    while (Date.now() - startTime < timeoutMs) {
      try {
        const res = await axios.get(
          `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
        );

        if (res.data.ok && res.data.result.length > 0) {
          for (const update of res.data.result) {
            lastUpdateId = update.update_id;

            if (update.message && String(update.message.chat.id) === String(chatId)) {
              const text = (update.message.text || '').trim();
              if (text) {
                clearInterval(timerLog);
                process.stdout.write('\n');
                console.log(`  ✅ ${label} recebido do Telegram: "${text}"`);

                // Confirma o recebimento
                await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                  chat_id: chatId,
                  text: `✅ Recebido: <b>${text}</b>\nRetomando processo...`,
                  parse_mode: 'HTML',
                }).catch(() => {});

                return text;
              }
            }
          }
        }
      } catch {
        // Ignora erros de rede temporários
      }

      await new Promise(r => setTimeout(r, 2000));
    }
  } finally {
    clearInterval(timerLog);
    process.stdout.write('\n');
  }

  console.log(`  ⏰ Timeout: nenhum ${label} recebido pelo Telegram.`);
  return null;
}

// =====================================================================
// FUNÇÕES DE CAPTCHA (captcha por imagem + 4 dígitos)
// =====================================================================

/**
 * Envia uma foto do captcha para o Telegram.
 */
export async function sendCaptchaToTelegram(imagePath: string, message: string): Promise<boolean> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) {
    console.log('  ⚠️  TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID não configurados no .env.');
    return false;
  }

  try {
    const form = new FormData();
    form.append('chat_id', chatId);
    form.append('caption', message);
    form.append('photo', fs.createReadStream(imagePath));

    await axios.post(`https://api.telegram.org/bot${token}/sendPhoto`, form, {
      headers: form.getHeaders(),
    });

    console.log(`  📱 Captcha enviado para o Telegram (Chat ID: ${chatId})!`);
    return true;
  } catch (error: any) {
    console.log(`  ❌ Erro ao enviar para o Telegram: ${error.message}`);
    return false;
  }
}

/**
 * Aguarda o usuário enviar exatamente 4 dígitos no Telegram (para captcha numérico).
 */
export async function waitForCaptchaFromTelegram(timeoutMs: number = 60000): Promise<string | null> {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;

  if (!token || !chatId) return null;

  console.log(`  ⏳ Aguardando 4 dígitos pelo Telegram (timeout: ${timeoutMs / 1000}s)...`);

  const startTime = Date.now();
  let lastUpdateId = 0;

  try {
    const res = await axios.get(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`);
    if (res.data?.ok && res.data.result.length > 0) {
      lastUpdateId = res.data.result[0].update_id;
    }
  } catch (e: any) {
    if (e.response?.status === 409) {
      console.log('  ⚠️  Bot do Telegram em conflito com Webhook.');
      return null;
    }
  }

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${token}/getUpdates?offset=${lastUpdateId + 1}&timeout=5`
      );

      if (res.data.ok && res.data.result.length > 0) {
        for (const update of res.data.result) {
          lastUpdateId = update.update_id;

          if (update.message && String(update.message.chat.id) === String(chatId)) {
            const text = (update.message.text || '').trim();

            if (/^\d{4}$/.test(text)) {
              console.log(`  ✅ Captcha [${text}] recebido do Telegram!`);
              await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: `✅ Captcha ${text} recebido. Retomando login...`,
              }).catch(() => {});
              return text;
            } else if (text) {
              await axios.post(`https://api.telegram.org/bot${token}/sendMessage`, {
                chat_id: chatId,
                text: '⚠️ Envie apenas os 4 dígitos numéricos do captcha.',
              }).catch(() => {});
            }
          }
        }
      }
    } catch {
      // Ignora erros temporários
    }

    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('  ⏰ Tempo esgotado aguardando captcha pelo Telegram.');
  return null;
}

// =====================================================================
// FALLBACK: digitação manual pelo terminal
// =====================================================================

/**
 * Pede o captcha pelo terminal como último recurso.
 */
export async function askCaptchaTerminal(): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question('\n  ➡️  Digite os 4 dígitos do captcha: ', (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}
