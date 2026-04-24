import { Firestore } from "@google-cloud/firestore";

const firestore = new Firestore({ projectId: process.env.GOOGLE_CLOUD_PROJECT || "chirashi-493513" });
const col = firestore.collection("reminders");

/**
 * @param {{ platform: "line"|"chatwork", chatId: string, remindAt: number, message: string }} p
 * @returns {Promise<string>} docId
 */
export async function addReminder({ platform, chatId, remindAt, message }) {
  const ref = await col.add({
    platform,
    chatId,
    remindAt,
    message,
    sentAt: null,
    createdAt: Date.now(),
  });
  return ref.id;
}

/**
 * @returns {Promise<Array<{ id: string, platform: string, chatId: string, remindAt: number, message: string }>>}
 */
export async function getDueReminders() {
  // sentAt との複合クエリを避けてインデックス不要にする
  const snap = await col
    .where("remindAt", "<=", Date.now())
    .get();
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .filter((r) => r.sentAt === null || r.sentAt === undefined);
}

/**
 * @param {string} id
 */
export async function markReminderSent(id) {
  await col.doc(id).update({ sentAt: Date.now() });
}
