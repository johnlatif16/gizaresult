const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
require('dotenv').config();

// ✅ Firebase config
const serviceAccount = JSON.parse(process.env.FIREBASE_CONFIG);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(cookieParser());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(fileUpload());

const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// ✅ إعداد البريد
let transporter = nodemailer.createTransport({
  service: "gmail",
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

// ✅ Middleware للتحقق من JWT من الكوكيز
function authenticateAdmin(req, res, next) {
  const token = req.cookies.admin_token;
  if (!token) return res.status(401).json({ success: false, message: 'Unauthorized' });

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) return res.status(403).json({ success: false, message: 'Forbidden' });
    req.admin = decoded;
    next();
  });
}

// ----------------- Auth -----------------

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '2h' });
    res.cookie("admin_token", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      maxAge: 2 * 60 * 60 * 1000
    });
    return res.redirect("/dashboard.html");
  }
  res.status(401).send("خطأ في تسجيل الدخول");
});

// ----------------- Routes -----------------

// ✅ طلبات الدفع
app.post('/pay', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    let screenshotName = '';
    if (req.files && req.files.screenshot) {
      const screenshot = req.files.screenshot;
      screenshotName = `${Date.now()}_${screenshot.name}`;
      await screenshot.mv(path.join(uploadsDir, screenshotName));
    }

    const newRequest = { name, phone, email, screenshot: screenshotName, status: 'pending', createdAt: new Date() };
    await db.collection('requests').add(newRequest);

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');

    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL,
          subject: "طلب دفع جديد",
          text: `اسم: ${name}\nهاتف: ${phone}\nبريد: ${email}`
        });

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `طلب دفع جديد:\nالاسم: ${name}\nالهاتف: ${phone}\nالبريد: ${email}`
        });
      } catch (err) {
        console.error("Notification error:", err.message);
      }
    });

  } catch (error) {
    res.status(500).send("حدث خطأ أثناء تسجيل الطلب");
  }
});

// ✅ الحجز
app.post('/reserve', async (req, res) => {
  try {
    const { name, phone, email } = req.body;
    const newReservation = { name, phone, email, createdAt: new Date() };
    await db.collection('reservations').add(newReservation);

    res.send('تم تسجيل حجزك بنجاح.');

    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL,
          subject: "حجز جديد",
          text: `اسم: ${name}\nهاتف: ${phone}\nبريد: ${email}`
        });

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `حجز جديد:\nالاسم: ${name}\nالهاتف: ${phone}\nالبريد: ${email}`
        });
      } catch (err) {
        console.error("Notification error:", err.message);
      }
    });

  } catch (error) {
    res.status(500).send("حدث خطأ أثناء تسجيل الحجز");
  }
});

// ✅ فحص النتيجة
app.post('/check-result', async (req, res) => {
  try {
    const { seatNumber } = req.body;
    const result = await db.collection('results').doc(seatNumber).get();
    if (!result.exists) return res.status(404).send("لا توجد نتيجة لهذا الرقم");
    res.json(result.data());
  } catch (error) {
    res.status(500).send("حدث خطأ أثناء البحث عن النتيجة");
  }
});

// ✅ فتح النتيجة
app.post('/open-result', async (req, res) => {
  try {
    const { seatNumber } = req.body;
    const resultRef = db.collection('results').doc(seatNumber);
    const result = await resultRef.get();
    if (!result.exists) return res.status(404).send("لا توجد نتيجة لهذا الرقم");
    await resultRef.update({ opened: true });
    res.json({ success: true, data: result.data() });
  } catch (error) {
    res.status(500).send("حدث خطأ أثناء فتح النتيجة");
  }
});

// ✅ رسائل الاستفسارات
app.post('/api/chat-inquiries', async (req, res) => {
  try {
    const { name, phone, email, message } = req.body;
    const newInquiry = { name, phone, email, message, createdAt: new Date() };
    await db.collection('inquiries').add(newInquiry);

    res.send("تم استلام استفسارك بنجاح.");

    setImmediate(async () => {
      try {
        await transporter.sendMail({
          from: process.env.SMTP_USER,
          to: process.env.ADMIN_EMAIL,
          subject: "استفسار جديد",
          text: `اسم: ${name}\nهاتف: ${phone}\nبريد: ${email}\nرسالة: ${message}`
        });

        await axios.post(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          chat_id: process.env.TELEGRAM_CHAT_ID,
          text: `استفسار جديد:\nالاسم: ${name}\nالهاتف: ${phone}\nالبريد: ${email}\nالرسالة: ${message}`
        });
      } catch (err) {
        console.error("Notification error:", err.message);
      }
    });

  } catch (error) {
    res.status(500).send("حدث خطأ أثناء إرسال الاستفسار");
  }
});

// ✅ APIs للإدارة (محميه)
app.get('/api/results', authenticateAdmin, async (req, res) => {
  try {
    const snap = await db.collection('results').get();
    const results = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ results });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reservations', authenticateAdmin, async (req, res) => {
  try {
    const snap = await db.collection('reservations').get();
    const reservations = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ reservations });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/requests', authenticateAdmin, async (req, res) => {
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

app.get('/api/inquiries', authenticateAdmin, async (req, res) => {
  try {
    const snap = await db.collection('inquiries').get();
    const inquiries = snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ inquiries });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ----------------- Start -----------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
