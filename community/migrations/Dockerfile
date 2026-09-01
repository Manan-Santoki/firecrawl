FROM node:22-alpine

RUN apk add --no-cache postgresql-client \
    && addgroup -S migrator \
    && adduser -S -G migrator migrator

WORKDIR /migrations
COPY --chown=migrator:migrator . .
USER migrator

ENTRYPOINT ["node", "/migrations/migrate.mjs"]
CMD ["apply"]
