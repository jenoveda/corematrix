FROM node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.server.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY tests ./tests
COPY scripts/build-web.mjs ./scripts/build-web.mjs
RUN npm run build

FROM node@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 AS api
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && mkdir -p /var/lib/corematrix \
    && chown node:node /var/lib/corematrix \
    && chmod 700 /var/lib/corematrix
COPY server ./server
COPY src ./src
USER node
CMD ["node", "server/index.ts"]

FROM nginx@sha256:970364228b1e4f932abc22d321932816782cca8a20b85a77552a7cfe9acfb3b5 AS web
COPY deploy/compose-nginx.conf /etc/nginx/nginx.conf
COPY --from=build /app/dist /usr/share/nginx/html
USER 101:101
ENTRYPOINT ["nginx"]
CMD ["-g", "daemon off;"]
