# syntax=docker/dockerfile:1.7
FROM python:3.12-slim-bookworm AS build

ENV PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1
RUN python -m venv /opt/venv
ENV PATH=/opt/venv/bin:$PATH

COPY requirements.txt /tmp/requirements.txt
RUN pip install -r /tmp/requirements.txt

# spaCy English pipeline (MIT). Pinned by checksum; override both build args
# together to use a larger model such as en_core_web_md.
ARG SPACY_MODEL=en_core_web_sm
ARG SPACY_MODEL_VERSION=3.8.0
ARG SPACY_MODEL_SHA256=1932429db727d4bff3deed6b34cfc05df17794f4a52eeb26cf8928f7c1a0fb85
ADD --checksum=sha256:${SPACY_MODEL_SHA256} \
  https://github.com/explosion/spacy-models/releases/download/${SPACY_MODEL}-${SPACY_MODEL_VERSION}/${SPACY_MODEL}-${SPACY_MODEL_VERSION}-py3-none-any.whl \
  /tmp/${SPACY_MODEL}-${SPACY_MODEL_VERSION}-py3-none-any.whl
RUN pip install --no-deps /tmp/${SPACY_MODEL}-${SPACY_MODEL_VERSION}-py3-none-any.whl \
  && find /opt/venv -name '__pycache__' -prune -exec rm -rf {} + \
  && find /opt/venv -name 'tests' -path '*site-packages/*/tests' -prune -exec rm -rf {} +

FROM python:3.12-slim-bookworm

ARG SPACY_MODEL=en_core_web_sm
ENV PATH=/opt/venv/bin:$PATH \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PRIVACY_SPACY_MODEL=${SPACY_MODEL} \
    HOST=0.0.0.0 \
    PORT=3010

COPY --from=build /opt/venv /opt/venv
RUN useradd --system --uid 10001 --home-dir /app --shell /usr/sbin/nologin privacy
WORKDIR /app
COPY --chown=root:root app ./app
COPY --chown=root:root --chmod=0755 docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh

USER 10001
EXPOSE 3010
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=4 \
  CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health/readiness' % os.environ.get('PORT','3010'), timeout=4)" || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
