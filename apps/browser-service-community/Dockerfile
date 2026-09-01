FROM mcr.microsoft.com/playwright:v1.62.1-noble

ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:/app/node_modules/.bin:/opt/firecrawl-python/bin:$PATH \
    NODE_ENV=production \
    PYTHON_EXECUTABLE=/opt/firecrawl-python/bin/python

RUN corepack enable && corepack prepare pnpm@11.4.0 --activate \
    && apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv \
    && python3 -m venv /opt/firecrawl-python \
    && /opt/firecrawl-python/bin/pip install --no-cache-dir playwright==1.62.0 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm build && mkdir -p /data/profiles && chown -R pwuser:pwuser /app /data

USER pwuser
ENV BROWSER_PROFILE_ROOT=/data/profiles
EXPOSE 3006
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3006/health/liveness').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "dist/index.js"]
