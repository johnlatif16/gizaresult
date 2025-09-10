const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const mysql = require('mysql2/promise');
require('dotenv').config();

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(fileUpload());

// 📂 uploads dir
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// 🔹 MySQL Connection
let db;
(async () => {
  db = await mysql.createPool({
    host: process.env.MYSQLHOST,
    user: process.env.MYSQLUSER,
    password: process.env.MYSQLPASSWORD,
    database: process.env.MYSQLDATABASE,
    port: process.env.MYSQLPORT
  });
})();

// 🔹 Email setup
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
    console.log('Email notification sent successfully.');
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
    console.log('Telegram notification sent successfully.');
  } catch (error) {
    console.error('Error sending Telegram notification:', error.message);
  }
}

// ----------------- Routes -----------------

// ✅ GET Requests
app.get('/api/requests', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM requests");
    res.json({ requests: rows });
  } catch (error) {
    console.error(error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ Pay Page
app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

// ✅ Pay Upload
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
      paid: false
    };

    await db.query(
      "INSERT INTO requests (nationalId, seatNumber, phone, email, screenshot, paid) VALUES (?, ?, ?, ?, ?, ?)",
      [nationalId, seatNumber, phone, email, filename, false]
    );

    await sendEmailNotification(
      'طلب دفع جديد',
      `طلب دفع جديد:\n${JSON.stringify(newRequest, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${phone}\nالبريد: ${email}`
    );

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (error) {
    console.error('Error in /pay:', error);
    res.status(500).send(`حدث خطأ في الخادم: ${error.message}`);
  }
});

// ✅ Reservation
app.post('/reserve', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone } = req.body;
    if (!nationalId || !phone || !email || !senderPhone) {
      return res.status(400).send('البيانات غير مكتملة');
    }

    if (!req.files || !req.files.screenshot) {
      return res.status(400).send('يجب رفع سكرين التحويل');
    }

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    await screenshot.mv(uploadPath);

    await db.query(
      "INSERT INTO reservations (nationalId, phone, email, senderPhone, screenshot) VALUES (?, ?, ?, ?, ?)",
      [nationalId, phone, email, senderPhone, filename]
    );

    await sendEmailNotification(
      'طلب حجز جديد',
      `طلب حجز جديد:\n${JSON.stringify({ nationalId, phone, email, senderPhone }, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${phone}\nالبريد: ${email}\nرقم المحول: ${senderPhone}`
    );

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (error) {
    console.error('Error in /reserve:', error);
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

// ✅ Login
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    return res.redirect('/dashboard.html');
  }
  res.send('خطأ في تسجيل الدخول');
});

// ✅ Check Result
app.post('/api/check-result', async (req, res) => {
  const { phone } = req.body;

  try {
    const [rows] = await db.query("SELECT * FROM requests WHERE phone = ?", [phone]);
    if (rows.length === 0) {
      return res.status(404).json({ success: false, message: 'لم يتم العثور على نتيجة لهذا الرقم أو لم يتم الدفع بعد' });
    }

    const requestData = rows[0];

    if (!requestData.paid) {
      return res.status(402).json({ success: false, message: 'لم يتم الدفع بعد' });
    }

    if (requestData.result) {
      return res.json({ success: true, result: JSON.parse(requestData.result) });
    }

    res.json({
      success: true,
      result: {
        name: requestData.name || "غير متوفر",
        seatNumber: requestData.seatNumber || "غير متوفر",
        stage: requestData.stage || "غير متوفر",
        gradeLevel: requestData.gradeLevel || "غير متوفر",
        schoolName: requestData.schoolName || "غير متوفر",
        notes: requestData.notes || "لا توجد",
        mainSubjects: requestData.mainSubjects ? JSON.parse(requestData.mainSubjects) : [],
        additionalSubjects: requestData.additionalSubjects ? JSON.parse(requestData.additionalSubjects) : [],
        totalScore: requestData.totalScore || 0,
        totalOutOf: requestData.totalOutOf || 0,
        percentage: requestData.percentage || 0
      }
    });
  } catch (error) {
    console.error('Error in /api/check-result:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ في الخادم: ' + error.message });
  }
});

// ✅ Open Result
app.post('/api/open-result', async (req, res) => {
  const { seatNumber } = req.body;
  try {
    const [reqRows] = await db.query("SELECT * FROM requests WHERE seatNumber = ?", [seatNumber]);
    const [resRows] = await db.query("SELECT * FROM results WHERE seatNumber = ?", [seatNumber]);

    if (reqRows.length === 0 || resRows.length === 0) {
      return res.json({ success: false, message: 'طلب أو نتيجة غير موجودة' });
    }

    await db.query("UPDATE requests SET paid = ?, result = ? WHERE id = ?", [
      true,
      JSON.stringify(resRows[0]),
      reqRows[0].id
    ]);

    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.json({ success: false, message: error.message });
  }
});

// ✅ Debug
app.get('/api/debug-requests', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM requests");
    res.json({ requests: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ✅ Dashboard APIs
app.get('/api/results', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM results");
    res.json({ results: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.get('/api/reservations', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM reservations");
    res.json({ reservations: rows });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/reservations/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM reservations WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/requests/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM requests WHERE id = ?", [req.params.id]);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));