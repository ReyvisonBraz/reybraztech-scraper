import axios from 'axios';
import { runScraper } from './index';
import { sendTelegramMessage } from './telegram';

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
  console.error('❌ TELEGRAM_BOT_TOKEN e/ou TELEGRAM_CHAT_ID não definidos no .env');
  process.exit(1);
}

// Variável para evitar rodar múltiplos scrapers simultaneamente
let isScraping = false;

/**
 * Função principal que fica em loop(long-polling) aguardando comandos do Telegram
 */
async function startBot() {
  console.log('🤖 Bot assistente iniciado e ouvindo comandos no Telegram...');
  let lastUpdateId = 0;

  // Limpa atualizações antigas antes de iniciar
  try {
    const res = await axios.get(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=-1`);
    if (res.data?.ok && res.data.result.length > 0) {
      lastUpdateId = res.data.result[res.data.result.length - 1].update_id;
    }
  } catch (e: any) {
    if (e.response?.status === 409) {
      console.error('⚠️  Conflito de webhook no Telegram. Verifique se há outro bot ativo usando o mesmo token.');
      process.exit(1);
    }
  }

  // Loop eterno
  while (true) {
    if (isScraping) {
      // Se o scraper estiver rodando, o bot pausa o seu long-polling 
      // para não roubar mensagens (getUpdates) do script de 2FA do Telegram.
      await new Promise(r => setTimeout(r, 5000));
      continue;
    }

    try {
      const res = await axios.get(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?offset=${lastUpdateId + 1}&timeout=30`
      );

      if (res.data?.ok && res.data.result.length > 0) {
        for (const update of res.data.result) {
          lastUpdateId = update.update_id;

          // Processa apenas mensagens vindas do chat_id autorizado
          if (update.message && String(update.message.chat.id) === String(TELEGRAM_CHAT_ID)) {
            const text = (update.message.text || '').trim();
            await processCommand(text);
          }
        }
      }
    } catch (e: any) {
      // Falhas normais de timeout ou rede, ignora e tenta novamente
      if (e.response?.status !== 502) {
        // console.error(`[Bot Error] ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, 1000));
  }
}

/**
 * Processamento central de comandos recebidos
 */
async function processCommand(command: string) {
  // Ignora mensagens vazias ou respostas sem barra inicial (como o código 2FA que é processado em telegram.ts)
  if (!command.startsWith('/')) return;

  const cmd = command.toLowerCase().split(' ')[0];

  console.log(`\n📥 Comando recebido: ${cmd}`);

  switch (cmd) {
    case '/start':
    case '/help':
      await sendTelegramMessage(
        '👋 <b>Olá! Sou o seu assistente automatizado.</b>\n\n' +
        'Comandos disponíveis:\n' +
        '▶️ /atualizarbanco - Extrai clientes do StarHome e salva os dados.'
      );
      break;

    case '/atualizarbanco':
      if (isScraping) {
        await sendTelegramMessage('⚠️ <b>Aviso:</b> O scraper já está rodando no momento. Aguarde finalizar.');
        return;
      }
      
      try {
        isScraping = true;
        await sendTelegramMessage('⏳ <b>Iniciando extração...</b>\nAcessando painel StarHome. Avisarei quando terminar.');
        
        // Dispara o scraper
        const clientes = await runScraper();
        
        // Aqui no futuro entra o upload pro Supabase
        
        await sendTelegramMessage(`✅ <b>Extração Concluída!</b>\n\nTotal extraído: ${clientes.length} clientes.\n\n<i>Pronto para novos comandos.</i>`);
      } catch (error: any) {
        console.error('Erro na extração:', error);
        await sendTelegramMessage(`❌ <b>Ocorreu um erro no Scraper:</b>\n${error.message}`);
      } finally {
        isScraping = false;
      }
      break;

    default:
      await sendTelegramMessage('❓ Comando desconhecido. Digite /help para ver a lista de comandos.');
      break;
  }
}

// Inicia o bot
startBot().catch(console.error);
