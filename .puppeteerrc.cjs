/**
 * Configuração do Puppeteer para o ambiente Render (Linux).
 * Define o cache path onde o Chrome será instalado e encontrado.
 * 
 * No Render, o home é /opt/render/project e o cache por padrão é:
 * /opt/render/.cache/puppeteer
 * 
 * Usar a variável HOME garante compatibilidade local e em nuvem.
 */
const { join } = require('path');

module.exports = {
  // Pasta de cache onde o puppeteer vai instalar e procurar o Chrome
  cacheDirectory: process.env.PUPPETEER_CACHE_DIR 
    || join(process.env.HOME || '/opt/render', '.cache', 'puppeteer'),
  
  // Desativa o download automático ao instalar o pacote (feito via postinstall)
  skipDownload: false,
};
