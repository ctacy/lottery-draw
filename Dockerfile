# 依赖层（含 devDependencies，供测试用）
FROM node:22-alpine AS deps
ARG NPM_REGISTRY=https://registry.npmjs.org
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund --registry="$NPM_REGISTRY"

# 测试层：docker build --target test .（失败即中止发布）
FROM deps AS test
COPY . .
RUN npm test

# 运行层
FROM node:22-alpine
ARG NPM_REGISTRY=https://registry.npmjs.org
ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund --registry="$NPM_REGISTRY" && npm cache clean --force
COPY server.js ./
COPY src ./src
COPY public ./public
RUN mkdir -p /app/data && chown node:node /app/data
USER node
EXPOSE 8201
HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8201/admin/ || exit 1
CMD ["node", "server.js"]
