import { createHmac } from "node:crypto";
import { config } from "./config.js";

const BASE_URL = "https://api.chatwork.com/v2";

function authHeaders() {
  return { "X-ChatWorkToken": config.chatworkApiToken };
}

/**
 * Chatwork Webhook の署名を検証する
 * CHATWORK_WEBHOOK_TOKEN が未設定の場合はスキップ（開発時）
 */
export function verifyChatworkSignature(rawBody, signatureHeader) {
  const token = config.chatworkWebhookToken;
  if (!token) return true;
  // Chatwork のトークンは Base64 エンコードされた鍵なのでデコードして使う
  const keyBuffer = Buffer.from(token, "base64");
  const expected = createHmac("sha256", keyBuffer)
    .update(rawBody)
    .digest("base64");
  if (expected !== signatureHeader) {
    console.warn("[cw] sig mismatch expected=%s got=%s", expected.slice(0, 20), signatureHeader.slice(0, 20));
    return false;
  }
  return true;
}

/**
 * ルームにテキストメッセージを送信する
 */
export async function sendMessage(roomId, text) {
  const res = await fetch(`${BASE_URL}/rooms/${roomId}/messages`, {
    method: "POST",
    headers: {
      ...authHeaders(),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ body: text, self_unread: "0" }),
  });
  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`Chatwork API error ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Chatwork メッセージ本文をパースして、引用テキストとコマンドに分離する
 *
 * 返信時の本文形式：
 *   [rp aid=XXX to=ROOM-MSGID][qt][qtmeta aid=XXX time=XXX]
 *   引用元テキスト
 *   [/qt]
 *   コマンドテキスト
 */
export function parseChatworkBody(body) {
  // [rp ...] 返信タグを除去
  let stripped = body.replace(/\[rp\s[^\]]*\]/g, "");
  // [To:XXX]表示名 を行ごと除去（Chatwork は "[To:ID]表示名\n" 形式で挿入する）
  stripped = stripped.replace(/\[To:\d+\][^\n]*/g, "").trim();

  const qtMatch = stripped.match(
    /\[qt\]\[qtmeta[^\]]*\]([\s\S]*?)\[\/qt\]([\s\S]*)/
  );
  if (qtMatch) {
    return {
      quotedText: qtMatch[1].trim(),
      commandText: qtMatch[2].trim(),
    };
  }

  return { quotedText: null, commandText: stripped };
}
