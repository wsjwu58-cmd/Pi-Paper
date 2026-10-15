# syntax=docker/dockerfile:1
FROM node:24-bookworm AS build
WORKDIR /workspace
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
COPY pi-main/ pi-main/
COPY pi-paper-web/ pi-paper-web/
COPY pi-paper-desktop/ pi-paper-desktop/
RUN npm ci --prefix pi-main --ignore-scripts \
    && npm ci --prefix pi-paper-desktop \
    && node pi-paper-desktop/scripts/restore-model-data.cjs \
    && npm run build --prefix pi-main --workspace=@earendil-works/pi-telemetry \
    && npm run build:offline --prefix pi-main --workspace=@earendil-works/pi-ai \
    && npm run build --prefix pi-main --workspace=@earendil-works/pi-agent-core \
    && pnpm --dir pi-paper-web install --frozen-lockfile \
    && npm run build:package --prefix pi-paper-desktop
WORKDIR /workspace/pi-paper-desktop
RUN npx electron-builder --config electron-builder.cjs --linux --x64 --dir --publish never

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates curl dbus-x11 gnome-keyring gosu \
      libgtk-3-0 libnss3 libatk-bridge2.0-0 libdrm2 libxkbcommon0 \
      libgbm1 libasound2 libxss1 libsecret-1-0 libglib2.0-bin \
      xvfb x11-utils x11vnc novnc websockify openbox xdotool procps \
      fonts-noto-cjk fonts-noto-color-emoji ffmpeg \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 1000 pi-paper \
    && useradd --uid 1000 --gid pi-paper --create-home --shell /bin/bash pi-paper \
    && mkdir /projects \
    && chown pi-paper:pi-paper /projects
COPY --from=build /workspace/pi-paper-desktop/release/linux-unpacked/ /opt/pi-paper/
COPY --from=build /workspace/pi-paper-desktop/scripts/smoke-package.cjs /opt/pi-paper/smoke/smoke-package.cjs
COPY --from=build /workspace/pi-paper-desktop/scripts/smoke-agent-worker.cjs /opt/pi-paper/smoke/smoke-agent-worker.cjs
COPY docker/ /opt/pi-paper/docker/
RUN chmod +x /opt/pi-paper/docker/*.sh
ENV HOME=/home/pi-paper \
    DISPLAY=:99 \
    XDG_RUNTIME_DIR=/tmp/pi-paper-runtime \
    VIBEPAPER_FFMPEG_PATH=/usr/bin/ffmpeg
WORKDIR /projects
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD /opt/pi-paper/docker/healthcheck.sh
ENTRYPOINT ["/opt/pi-paper/docker/start-desktop.sh"]
