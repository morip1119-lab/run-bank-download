import { Firestore } from "@google-cloud/firestore";
const db = new Firestore({ projectId: "chirashi-493513" });
const snap = await db.collection("reminders").get();
console.log(`Total: ${snap.size}`);
snap.forEach(d => console.log(d.id, JSON.stringify(d.data(), null, 2)));
