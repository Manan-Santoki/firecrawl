FROM python:3.12-slim-trixie

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    AVGRAB_DATA_DIR=/data \
    PORT=8080

RUN apt-get update \
    && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --system --uid 10001 --create-home --home-dir /home/avgrab avgrab

WORKDIR /app
COPY requirements.txt ./
RUN pip install -r requirements.txt && yt-dlp --version && deno --version
COPY avgrab ./avgrab
RUN mkdir -p /data && chown -R avgrab:avgrab /data

USER avgrab
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --retries=5 CMD python -c "import os,urllib.request; urllib.request.urlopen('http://127.0.0.1:%s/health' % os.environ.get('PORT','8080'), timeout=2)" || exit 1
CMD ["sh", "-c", "exec uvicorn --factory avgrab.main:build --host 0.0.0.0 --port \"${PORT}\" --no-server-header --timeout-graceful-shutdown 10"]
