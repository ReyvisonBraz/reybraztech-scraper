FROM mcr.microsoft.com/playwright:v1.65.1-noble@sha256:1507cbfc550a63a6b7396791ca4f00df17beb56342d2447b3f106c306f525579

ENV CI=1 \
    NODE_ENV=test \
    POC_DOCKER_RUNTIME=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1

WORKDIR /workspace
COPY package.json package-lock.json ./
RUN chown -R pwuser:pwuser /workspace

USER pwuser
RUN npm ci --ignore-scripts --no-audit --no-fund

COPY --chown=pwuser:pwuser . .

CMD ["npm", "test"]
