# Node 24 LTS: this tag always points at the newest 24.x release, including security patches.
# docker-compose builds with "pull: true", so every rebuild (docker compose up -d --build) picks them up.
FROM node:24-alpine

ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
WORKDIR /app
COPY package.json server.js ./
COPY web ./web
RUN mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s CMD wget -qO- http://127.0.0.1:8080/api/status >/dev/null || exit 1
CMD ["node", "--use-system-ca", "--disable-warning=ExperimentalWarning", "server.js"]
