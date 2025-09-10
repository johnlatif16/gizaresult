const admin = require("firebase-admin");
const fs = require("fs");
const path = require("path");

// تحميل مفتاح الخدمة من Firebase (حمله من Project settings > Service accounts)
const serviceAccount = require("./serviceAccountKey.json");

// تشغيل Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

// قراءة data.json
const dataPath = path.join(__dirname, "data.json");
const rawData = fs.readFileSync(dataPath);
const jsonData = JSON.parse(rawData);

async function importResults() {
  try {
    if (!jsonData.results || !Array.isArray(jsonData.results)) {
      throw new Error("ملف data.json لا يحتوي على results!");
    }

    for (const result of jsonData.results) {
      // نخلي seatNumber هو الـ Document ID
      await db.collection("results")
        .doc(result.seatNumber.toString())
        .set(result);

      console.log(`✅ تم إضافة النتيجة برقم جلوس: ${result.seatNumber}`);
    }

    console.log("🎉 كل النتائج اتضافت لـ Firestore بنجاح!");
    process.exit(0);
  } catch (error) {
    console.error("❌ خطأ أثناء رفع النتائج:", error);
    process.exit(1);
  }
}

importResults();
