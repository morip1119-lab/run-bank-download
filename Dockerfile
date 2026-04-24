# 本番用: クラウド（Render / Fly.io / VPS 等）で 24h 稼働させる想定
FROM node:22-alpine
WORKDIR /app

RUN apk add --no-cache libc6-compat

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# SQLite 永続化用（ホストやディスクを /data にマウントする想定）
RUN mkdir -p /data

ENV NODE_ENV=production
# 多くの PaaS が PORT を注入する
ENV PORT=3000
# コンテナ内の DB パス（永続ディスクのマウント先に合わせる）
ENV SQLITE_PATH=/data/app.db

EXPOSE 3000

CMD ["node", "src/server.js"]
