# syntax=docker/dockerfile:1
FROM node:22-bookworm AS build
WORKDIR /app
COPY center-contract/ center-contract/
COPY center-web/ center-web/
RUN npm ci --prefix center-web && npm run --prefix center-web build
COPY center-server/ center-server/
RUN npm ci --prefix center-server --omit=dev
COPY host-core/ host-core/
RUN npm ci --prefix host-core --omit=dev

FROM node:22-bookworm
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /app/center-contract/ ./center-contract/
COPY --from=build --chown=node:node /app/center-server/ ./center-server/
COPY --from=build --chown=node:node /app/center-web/ ./center-web/
COPY --from=build --chown=node:node /app/host-core/ ./host-core/
COPY --chown=node:node LICENSE THIRD_PARTY_NOTICES.md ./
COPY --chown=node:node licenses/ ./licenses/
COPY --chown=node:node plugins/ ./plugins/
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8443 8790
CMD ["node", "center-server/cli.js"]
