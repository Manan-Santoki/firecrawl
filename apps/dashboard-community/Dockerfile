FROM node:22-alpine AS deps
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH NEXT_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@11.22.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:22-alpine AS runtime
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    DASHBOARD_BUILD_SHA=${GIT_SHA}
WORKDIR /app
RUN addgroup -S dashboard && adduser -S -G dashboard dashboard
COPY --from=build --chown=dashboard:dashboard /app/.next/standalone ./
COPY --from=build --chown=dashboard:dashboard /app/.next/static ./.next/static
COPY --from=build --chown=dashboard:dashboard /app/public ./public
USER dashboard
EXPOSE 3000
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>{if(!r.ok)process.exit(1)}).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
