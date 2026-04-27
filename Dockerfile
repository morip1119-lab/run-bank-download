# 本番用: クラウド（Cloud Run 等）で 24h 稼働させる想定
# Playwright（BANK_CHECK_SOURCE=mf）用に Debian + Chromium 同梱
FROM node:22-bookworm-slim
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# マネーフォワード入金チェック用ブラウザ（Gmail-only のみなら未使用）
RUN npx playwright install chromium --with-deps

COPY . .

# SQLite / MF プロファイル共に /data へ永続化する想定（Cloud Run ボリューム等）
RUN mkdir -p /data

ENV NODE_ENV=production
# 多くの PaaS が PORT を注入する
ENV PORT=3000
# コンテナ内の DB パス（永続ディスクのマウント先に合わせる）
ENV SQLITE_PATH=/data/app.db
# MF ログインセッション保存先（npm run mf-login 済みのプロファイルを置く、または都度ログイン）
ENV MF_PROFILE_DIR=/data/mf_profile

EXPOSE 3000

CMD ["node", "src/server.js"]
