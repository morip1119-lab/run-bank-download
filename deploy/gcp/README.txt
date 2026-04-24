================================================================================
Google Cloud Run へのデプロイ手順（LINE 秘書ボット）
================================================================================

■ 前提
  - Google アカウントで GCP プロジェクトを作成済み（Calendar API 用と同じで可）
  - 課金アカウントが有効（Cloud Run は無料枠あり。従量で数十円〜のことが多い）
  - PC に Google Cloud SDK（gcloud CLI）をインストール済み
    https://cloud.google.com/sdk/docs/install

■ 注意（SQLite）
  Cloud Run のディスクはコンテナ単位で一時的です。スケールや再デプロイで
  データが消える可能性があります。本番で会話ログを残したい場合は
  後から Cloud SQL 等への移行を検討してください。まずは動作確認用途で可。

================================================================================
1. プロジェクトとリージョンの設定
================================================================================

  PowerShell 例（PROJECT_ID は自分の ID に置き換え）:

    gcloud config set project PROJECT_ID
    gcloud config set run/region asia-northeast1

  東京リージョンを使う場合は asia-northeast1 を推奨。

================================================================================
2. 必要な API を有効化
================================================================================

    gcloud services enable run.googleapis.com
    gcloud services enable artifactregistry.googleapis.com
    gcloud services enable cloudbuild.googleapis.com
    gcloud services enable secretmanager.googleapis.com

================================================================================
3. シークレットを Secret Manager に登録（推奨）
================================================================================

  改行なしで値だけ入れる例:

    echo -n "あなたのLINEチャネルシークレット" | gcloud secrets create line-channel-secret --data-file=-

  既にある場合はバージョン追加:

    echo -n "値" | gcloud secrets versions add line-channel-secret --data-file=-

  client_secret.json と token.json はファイルごと:

    gcloud secrets create google-client-secret-json --data-file=client_secret.json
    gcloud secrets create google-token-json --data-file=token.json

================================================================================
4. Artifact Registry（Docker 置き場）を作成（初回だけ）
================================================================================

    gcloud artifacts repositories create line-secretary-repo ^
      --repository-format=docker ^
      --location=asia-northeast1 ^
      --description="LINE bot"

  （PowerShell では行継続は ` でなく ^ を使う例。1行で書いてもよい）

================================================================================
5. イメージをビルドしてプッシュ
================================================================================

  リポジトリのルート（Dockerfile がある場所）で:

    set LOCATION=asia-northeast1
    set PROJECT_ID=あなたのPROJECT_ID
    set REPO=line-secretary-repo
    set IMAGE=line-secretary-calendar

    gcloud auth configure-docker %LOCATION%-docker.pkg.dev

    docker build -t %LOCATION%-docker.pkg.dev/%PROJECT_ID%/%REPO%/%IMAGE%:latest .

    docker push %LOCATION%-docker.pkg.dev/%PROJECT_ID%/%REPO%/%IMAGE%:latest

  Docker Desktop が必要です。無い場合は次節の「ソースから直接デプロイ」でも可。

================================================================================
6. Cloud Run にデプロイ
================================================================================

【A】Docker イメージを指定する場合

    set LOCATION=asia-northeast1
    set PROJECT_ID=あなたのPROJECT_ID
    set REPO=line-secretary-repo
    set IMAGE=line-secretary-calendar

    gcloud run deploy %IMAGE% ^
      --image %LOCATION%-docker.pkg.dev/%PROJECT_ID%/%REPO%/%IMAGE%:latest ^
      --region %LOCATION% ^
      --allow-unauthenticated ^
      --port 8080 ^
      --memory 512Mi ^
      --set-secrets "LINE_CHANNEL_SECRET=line-channel-secret:latest" ^
      --set-env-vars "LINE_CHANNEL_ACCESS_TOKEN=長期トークン,ALLOWED_LINE_USER_ID=Uxxxx,GOOGLE_CLIENT_SECRET_PATH=/secrets/client_secret.json,GOOGLE_TOKEN_PATH=/secrets/token.json,GOOGLE_OAUTH_REDIRECT_URI=http://127.0.0.1:8765/" ^
      --update-secrets "/secrets/client_secret.json=google-client-secret-json:latest,/secrets/token.json=google-token-json:latest"

  LINE_CHANNEL_ACCESS_TOKEN と ALLOWED_LINE_USER_ID は長いので Secret に入れて
  --set-secrets にしてもよいです。

【B】ソースからビルドする場合（Dockerfile 使用）

  リポジトリルートで:

    gcloud run deploy line-secretary-calendar ^
      --source . ^
      --region asia-northeast1 ^
      --allow-unauthenticated ^
      --memory 512Mi

  その後、コンソールまたは gcloud run services update で環境変数とシークレットを追加。

================================================================================
7. デプロイ後の URL を LINE に登録
================================================================================

  デプロイ完了時に表示される URL 例:

    https://line-secretary-calendar-xxxxx-an.a.run.app

  LINE Developers → Messaging API → Webhook URL:

    https://（上記ホスト）/callback

  「接続確認」を成功させる。

================================================================================
8. 環境変数の整理（必須）
================================================================================

  LINE_CHANNEL_SECRET          … Secret 推奨
  LINE_CHANNEL_ACCESS_TOKEN      … 環境変数 or Secret
  ALLOWED_LINE_USER_ID           … 環境変数
  GOOGLE_CLIENT_SECRET_PATH      … /secrets/client_secret.json 等
  GOOGLE_TOKEN_PATH              … /secrets/token.json 等

  LOG_WEBHOOK_EVENTS は本番では 0 か未設定。

================================================================================
9. トラブル時
================================================================================

  - ログ: Cloud Console → Cloud Run → 該当サービス → ログ
  - 502: 環境変数不足、シークレットのパス不一致、PORT（通常 8080 は Cloud Run が注入）
  - 署名エラー: LINE_CHANNEL_SECRET の取り違え

  公式: https://cloud.google.com/run/docs

================================================================================
10. Cloud Scheduler の設定（cron ジョブ）
================================================================================

  ▼ 必要な API を有効化（初回のみ）

    gcloud services enable cloudscheduler.googleapis.com

  ▼ 【受信請求書チェック】10時間ごと（0時・10時・20時）

    set SERVICE_URL=https://line-secretary-calendar-xxxxx-an.a.run.app
    set CRON_SECRET=あなたのCRON_SECRET

    gcloud scheduler jobs create http check-invoices ^
      --schedule "0 */10 * * *" ^
      --uri "%SERVICE_URL%/cron/check-invoices" ^
      --message-body "{}" ^
      --headers "Content-Type=application/json,Authorization=Bearer %CRON_SECRET%" ^
      --http-method POST ^
      --time-zone "Asia/Tokyo" ^
      --location asia-northeast1

  ▼ 【銀行入金チェック】毎朝10時（既存）

    gcloud scheduler jobs create http bank-check ^
      --schedule "0 10 * * *" ^
      --uri "%SERVICE_URL%/cron/bank-check" ^
      --message-body "{}" ^
      --headers "Content-Type=application/json,Authorization=Bearer %CRON_SECRET%" ^
      --http-method POST ^
      --time-zone "Asia/Tokyo" ^
      --location asia-northeast1

  ▼ スケジュール変更したい場合

    gcloud scheduler jobs update http check-invoices ^
      --schedule "0 */10 * * *" ^
      --location asia-northeast1

  ▼ 手動で今すぐ実行（テスト用）

    gcloud scheduler jobs run check-invoices --location asia-northeast1

  ▼ cron 式の早見表
    0 */10 * * *   毎10時間（0時・10時・20時）
    0 */1  * * *   毎1時間
    0 9    * * *   毎朝9時のみ
    0 9,18 * * *   毎朝9時と18時

================================================================================
