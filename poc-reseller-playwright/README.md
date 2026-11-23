# Docker Playwright POC — Reseller panel

Este POC valida Playwright + Chromium em Docker usando exclusivamente uma fixture local. **Não acessa o painel real** e não implementa login, CAPTCHA/MFA, sessão persistente, busca de clientes reais ou ações de escrita.

## Requisitos

- Docker Desktop com suporte a `linux/arm64` ou `linux/amd64`.
- A imagem Playwright e as dependências npm são obtidas durante o build. A execução dos testes usa `--network=none`.
- Baseline fixada: imagem oficial `mcr.microsoft.com/playwright:v1.65.1-noble` com digest OCI multi-arquitetura `sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579`, Node `26.13.1`, `@playwright/test` `1.65.1` e Chromium `159.0.8154.6`.

## Executar

Na raiz deste diretório:

```sh
docker build -t reseller-playwright-poc:issue-9 .
docker run --rm --init --network=none --shm-size=1g reseller-playwright-poc:issue-9
```

O container executa primeiro uma guarda que exige a imagem do POC e ausência de interfaces externas, depois verifica as versões fixadas de Node, Playwright e Chromium, e por fim roda os testes da UI local. `npm test` fora do container ou com uma rede Docker ativa falha antes de abrir o browser. A imagem base está pinada por versão, digest multi-arquitetura e suporta `linux/arm64` e `linux/amd64`. O browser usa viewport fixa de 1400×900, Chromium headless, um worker e sem retries, screenshots, vídeo ou traces.

Se a porta 4173 estiver ocupada por outro processo no mesmo namespace, escolha outra porta em ambos os lados com `POC_FIXTURE_PORT`, por exemplo `-e POC_FIXTURE_PORT=4317` no `docker run`. A falha de bind termina o servidor com um código de erro explícito; não tenta outra porta silenciosamente.

## Cobertura

- Busca Account exata: encontrado, vazio, ambíguo, divergente e paginação.
- Erro de busca, timeout, erro em página subsequente e limite de páginas.
- Logs estruturados sem o identificador buscado.
- Bloqueio de rede externa e de rotas de escrita no browser.
- UI inesperada: tabela/cabeçalho/pager ausente, paginação sem avanço e estado de carregamento desconhecido falham fechados.

A fixture responde a busca por `POST`; isso demonstra que método HTTP sozinho não determina se uma operação é leitura ou escrita. O POC permite somente `POST /api/search` no servidor local de teste.

O logger é obrigatório para a função de busca; sem ele, a busca nem começa. O POC não inclui sink de log em arquivo ou console: os testes validam apenas o contrato minimizado do callback. Um sink real deverá ganhar testes de redação de stdout/stderr e artefatos antes de ser adicionado.

## Evolução autorizada

Depois de aprovar o smoke test local, uma etapa separada pode validar login e busca somente leitura no painel real com operador presente. CAPTCHA/MFA ficam para o operador; não usar solver ou bypass. Renew e demais operações de escrita não fazem parte deste POC.
