const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
require('dotenv').config();

const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(fileUpload());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// إعداد البريد
let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

async function sendEmailNotification(subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: subject,
      text: text
    });
  } catch (error) {
    console.error('Error sending email notification:', error);
  }
}

async function sendTelegramNotification(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const telegramApiUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
  try {
    await axios.post(telegramApiUrl, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
  }
}

// ================= API الطلبات =================
app.get('/api/requests', async (req, res) => {
  try {
    const snap = await db.collection('requests').get();
    const requests = snap.docs.map(doc => {
      const data = doc.data();
      if (data.screenshot && data.screenshot !== '') {
        data.screenshot = `/uploads/${data.screenshot}`;
      } else {
        data.screenshot = null;
      }
      return { id: doc.id, ...data };
    });
    res.json({ requests });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// صفحة الدفع
app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// رفع طلب الدفع
app.post('/pay', async (req, res) => {
  try {
    const { nationalId, seatNumber, phone, email } = req.body;
    if (!req.files || !req.files.screenshot) {
      return res.status(400).send('يجب رفع سكرين التحويل');
    }

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    await screenshot.mv(uploadPath);

    const newRequest = {
      nationalId,
      seatNumber,
      phone,
      email,
      screenshot: filename,
      paid: false,
      created_at: new Date().toISOString()
    };

    await db.collection('requests').add(newRequest);

    await sendEmailNotification('طلب دفع جديد', `طلب دفع جديد:\n${JSON.stringify(newRequest, null, 2)}`);
    await sendTelegramNotification(`<b>طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${phone}\nالبريد: ${email}`);

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (error) {
    res.status(500).send(`حدث خطأ في الخادم: ${error.message}`);
  }
});

// الحجز (شامل الهاتف والتليفون في نفس القسم)
app.post('/reserve', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone } = req.body;
    if (!nationalId || !phone || !senderPhone) {
      return res.status(400).send('البيانات غير مكتملة');
    }
    if (!req.files || !req.files.screenshot) {
      return res.status(400).send('يجب رفع سكرين التحويل');
    }

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    await screenshot.mv(uploadPath);

    const newReservation = {
      nationalId,
      phone,
      email: email || null,
      senderPhone,
      screenshot: filename,
      reserved_at: new Date().toISOString()
    };

    await db.collection('reservations').add(newReservation);

    await sendEmailNotification('طلب حجز جديد', `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`);
    await sendTelegramNotification(`<b>طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${phone}\nالبريد: ${email || "N/A"}\nرقم المحول: ${senderPhone}`);

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (error) {
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

// تسجيل الدخول للادمن
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return res.redirect('/dashboard.html');
  }
  res.send('خطأ في تسجيل الدخول');
});

// التحقق من النتيجة
app.post('/api/check-result', async (req, res) => {
  const { phone } = req.body;
  try {
    const requestsRef = db.collection('requests');
    const snap = await requestsRef.where('phone', '==', phone).get();

    if (snap.empty) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على نتيجة' });
    }

    const requestDoc = snap.docs[0];
    const requestData = requestDoc.data();

    if (!requestData.paid) {
      return res.status(402).json({ success: false, message: 'لم يتم الدفع بعد' });
    }

    res.json({ success: true, result: requestData.result || {} });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// فتح نتيجة
app.post('/api/open-result', async (req, res) => {
  const { seatNumber } = req.body;
  try {
    const requestsRef = db.collection('requests');
    const resultsRef = db.collection('results');

    const requestSnap = await requestsRef.where('seatNumber', '==', seatNumber).get();
    const resultSnap = await resultsRef.where('seatNumber', '==', seatNumber).get();

    if (requestSnap.empty || resultSnap.empty) {
      return res.json({ success: false, message: 'طلب أو نتيجة غير موجودة' });
    }

    const requestDoc = requestSnap.docs[0];
    const resultDoc = resultSnap.docs[0];

    await requestDoc.ref.update({
      paid: true,
      result: resultDoc.data()
    });

    res.json({ success: true });
  } catch (error) {
    res.json({ success: false, message: error.message });
  }
});

// ================= APIs للداشبورد =================
app.get('/api/results', async (req, res) => {
  try {
    const snap = await db.collection('results').get();
    const results = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    const snap = await db.collection('reservations').get();
    const reservations = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ reservations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// حذف حجز
app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await db.collection('reservations').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// حذف طلب
app.delete('/api/requests/:id', async (req, res) => {
  try {
    await db.collection('requests').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// تخزين توكنات الأجهزة
app.post('/api/register-token', async (req, res) => {
  const { token, userId } = req.body;
  if (!token) return res.status(400).json({ success: false, message: 'Token required' });

  await db.collection('deviceTokens').doc(userId).set({ token });
  res.json({ success: true });
});

// إرسال إشعار عند الضغط على "إظهار"
app.post('/api/notification/show', async (req, res) => {
  showNotification = true;

  const tokensSnap = await db.collection('deviceTokens').get();
  const tokens = tokensSnap.docs.map(doc => doc.data().token);

  if (tokens.length > 0) {
    const message = {
      notification: {
        title: 'إشعار جديد',
        body: 'النتيجة ظهرت 🎉'
      },
      tokens: tokens
    };

    try {
      const response = await admin.messaging().sendMulticast(message);
      console.log('Push sent:', response);
    } catch (error) {
      console.error('Error sending push:', error);
    }
  }

  res.json({ success: true });
});

// ================= API إشعار داخلي =================
let showNotification = false;

app.get('/api/notification', (req, res) => {
  res.json({ show: showNotification });
});

app.post('/api/notification/show', (req, res) => {
  showNotification = true;
  res.json({ success: true });
});

app.post('/api/notification/hide', (req, res) => {
  showNotification = false;
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
