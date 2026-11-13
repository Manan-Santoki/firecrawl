# The Playwright 1.62.1 image ships Chromium revision 1234, which is the same
# build patchright 1.62.1 drives, so no second browser download is needed.
FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/app/node_modules/.bin:$PATH \
    NODE_ENV=production

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json THIRD_PARTY_NOTICES.md ./
COPY third_party ./third_party
COPY src ./src
RUN pnpm build && pnpm prune --prod && chown -R pwuser:pwuser /app

USER pwuser
ENV PORT=3010
EXPOSE 3010
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3010/health/liveness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
