/**
 * Configuração do Puppeteer.
 * Define o cache path onde o Chrome será instalado e encontrado.
 * 
 * No Render (Linux): usa PUPPETEER_CACHE_DIR do ambiente (/opt/render/.cache/puppeteer)
 * No Windows/Mac: usa ~/.cache/puppeteer (padrão do SO)
 */
const { join } = require('path');

const isLinux = process.platform === 'linux';

module.exports = {
  cacheDirectory: (isLinux && process.env.PUPPETEER_CACHE_DIR)
    || join(process.env.HOME || '', '.cache', 'puppeteer'),
  
  skipDownload: false,
};
