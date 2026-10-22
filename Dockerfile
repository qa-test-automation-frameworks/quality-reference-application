FROM node:24.21.0-alpine3.23@sha256:9ec4a2e289874ed0d722e1772ec2de45d2801541db8612f3638b26f128c69ac2

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
