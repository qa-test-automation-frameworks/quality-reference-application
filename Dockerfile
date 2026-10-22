FROM node:26.12.0-alpine3.23@sha256:2ae3a23c9c5d2129398f4844c7c43400c061faf6973852f0fa837323bff9a5a8

ARG APP_SOURCE_SHA=working-tree
ENV NODE_ENV=production
ENV APP_SOURCE_SHA=${APP_SOURCE_SHA}
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm install --global npm@10.9.4 \
  && npm ci --omit=dev \
  && npm cache clean --force \
  && rm -rf /usr/local/lib/node_modules/npm node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx package.json package-lock.json
COPY src ./src
COPY migrations ./migrations
COPY public ./public
USER node
EXPOSE 4300
CMD ["node", "src/server.js"]
