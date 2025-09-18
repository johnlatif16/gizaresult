const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// ✅ Firebase
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});
const db = admin.firestore();

// ✅ Express
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(fileUpload());
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ✅ Static files
app.use('/uploads', express.static(uploadsDir));
app.use(express.static('public'));

// ✅ Nodemailer
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

// ================= Middleware =================
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  if (!authHeader) return res.status(401).json({ success: false, message: 'Unauthorized' });
  const token = authHeader.split(' ')[1];
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Forbidden' });
    req.admin = decoded;
    next();
  });
}

// ================= Helper functions =================
async function sendEmailNotification(subject, text) {
  try {
    await transporter.sendMail({
      from: process.env.SMTP_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject,
      text
    });
  } catch (err) {
    console.error('Email error:', err);
  }
}

async function sendTelegramNotification(message) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;
  try {
    await axios.post(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      chat_id: chatId,
      text: message,
      parse_mode: 'HTML'
    });
  } catch (err) {
    console.error('Telegram error:', err.message);
  }
}

// ================= Routes =================

// ======== Admin login ========
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    return res.json({ success: true, token });
  }
  res.status(401).json({ success: false, message: 'خطأ في تسجيل الدخول' });
});

// ======== Protect dashboard.html ========
app.get('/dashboard.html', authenticateAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// ======== Pay route ========
app.post('/pay', async (req, res) => {
  try {
    const { nationalId, seatNumber, phone, email } = req.body;
    if (!req.files || !req.files.screenshot) return res.status(400).send('يجب رفع سكرين التحويل');

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    await screenshot.mv(uploadPath);

    const newRequest = {
      nationalId, seatNumber, phone, email,
      screenshot: filename, paid: false,
      created_at: new Date().toISOString()
    };

    await db.collection('requests').add(newRequest);
    await sendEmailNotification('طلب دفع جديد', JSON.stringify(newRequest, null, 2));
    await sendTelegramNotification(
      `<b>طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${phone}\nالبريد: ${email}`
    );

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (err) {
    console.error(err);
    res.status(500).send('حدث خطأ في الخادم');
  }
});

// ======== Reserve route ========
app.post('/reserve', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone } = req.body;
    if (!nationalId || !phone || !email || !senderPhone) return res.status(400).send('البيانات غير مكتملة');
    if (!req.files || !req.files.screenshot) return res.status(400).send('يجب رفع سكرين التحويل');

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    await screenshot.mv(path.join(uploadsDir, filename));

    const newReservation = {
      nationalId, phone, email, senderPhone,
      screenshot: filename, reserved_at: new Date().toISOString()
    };

    await db.collection('reservations').add(newReservation);
    await sendEmailNotification('طلب حجز جديد', JSON.stringify(newReservation, null, 2));
    await sendTelegramNotification(
      `<b>طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${phone}\nالبريد: ${email}\nرقم المحول: ${senderPhone}`
    );

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (err) {
    console.error(err);
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

// ======== Student check result ========
app.post('/api/check-result', async (req, res) => {
  const { phone } = req.body;
  try {
    const snap = await db.collection('requests').where('phone', '==', phone).get();
    if (snap.empty) return res.status(404).json({ success: false, message: 'لم يتم العثور على نتيجة' });

    const requestData = snap.docs[0].data();
    if (!requestData.paid) return res.status(402).json({ success: false, message: 'لم يتم الدفع بعد' });

    res.json({
      success: true,
      result: requestData.result || {
        name: requestData.name || "غير متوفر",
        seatNumber: requestData.seatNumber || "غير متوفر",
        stage: requestData.stage || "غير متوفر",
        gradeLevel: requestData.gradeLevel || "غير متوفر",
        schoolName: requestData.schoolName || "غير متوفر",
        notes: requestData.notes || "لا توجد",
        mainSubjects: requestData.mainSubjects || [],
        additionalSubjects: requestData.additionalSubjects || [],
        totalScore: requestData.totalScore || 0,
        totalOutOf: requestData.totalOutOf || 0,
        percentage: requestData.percentage || 0
      }
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم' });
  }
});

// ======== Admin APIs (protected) ========
app.get('/api/results', authenticateAdmin, async (req, res) => {
  const snap = await db.collection('results').get();
  res.json({ results: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
});

app.get('/api/requests', authenticateAdmin, async (req, res) => {
  const snap = await db.collection('requests').get();
  res.json({ requests: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
});

app.get('/api/reservations', authenticateAdmin, async (req, res) => {
  const snap = await db.collection('reservations').get();
  res.json({ reservations: snap.docs.map(doc => ({ id: doc.id, ...doc.data() })) });
});

app.get('/api/chat-inquiries', authenticateAdmin, async (req, res) => {
  const snap = await db.collection('chat_inquiries').orderBy('created_at', 'desc').get();
  res.json({ inquiries: snap.docs.map(doc => {
    const data = doc.data();
    return {
      id: doc.id,
      message: data.message,
      userName: data.userData?.name || 'غير معروف',
      userPhone: data.userData?.phone || 'غير معروف',
      userEmail: data.userData?.email || 'غير معروف',
      created_at: data.created_at,
      status: data.status
    };
  })});
});

// Delete routes
app.delete('/api/requests/:id', authenticateAdmin, async (req, res) => {
  await db.collection('requests').doc(req.params.id).delete();
  res.json({ success: true });
});

app.delete('/api/reservations/:id', authenticateAdmin, async (req, res) => {
  await db.collection('reservations').doc(req.params.id).delete();
  res.json({ success: true });
});

app.delete('/api/chat-inquiries/:id', authenticateAdmin, async (req, res) => {
  await db.collection('chat_inquiries').doc(req.params.id).delete();
  res.json({ success: true });
});

// ============ Start server ============
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
