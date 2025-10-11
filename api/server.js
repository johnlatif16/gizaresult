const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken'); // ✅ إضافة JWT
require('dotenv').config();

// ✅ قراءة JSON الخاص بـ Firebase من متغير البيئة FIREBASE_CONFIG
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

// إعداد nodemailer مع بيانات SMTP من .env
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,       // مثلاً smtp.gmail.com
  port: process.env.SMTP_PORT,       // غالباً 465 (SSL) أو 587 (TLS)
  secure: process.env.SMTP_SECURE === 'true', // true لو SSL
  auth: {
    user: process.env.SMTP_USER,     // إيميل الإرسال
    pass: process.env.SMTP_PASS      // كلمة سر التطبيق (App Password)
  }
});
// ✅ Middleware للتحقق من JWT - معدل
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    console.log('لم يتم إرسال token');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1]; // "Bearer TOKEN"
  
  if (!token) {
    console.log('صيغة Authorization header غير صحيحة');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err, decoded) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      
      if (err.name === 'TokenExpiredError') {
        return res.status(403).json({ success: false, message: 'Token منتهي الصلاحية' });
      } else if (err.name === 'JsonWebTokenError') {
        return res.status(403).json({ success: false, message: 'Token غير صالح' });
      } else {
        return res.status(403).json({ success: false, message: 'Forbidden' });
      }
    }
    
    req.admin = decoded;
    next();
  });
}

// دوال إشعارات
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

// ----------------- API الطلبات -----------------
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
    console.error(error);
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

    // تنظيف رقم الهاتف قبل الحفظ
    const cleanPhone = phone.replace(/\D/g, '');

    const newRequest = {
      nationalId,
      seatNumber,
      phone: cleanPhone, // حفظ رقم الهاتف بعد التنظيف
      email,
      screenshot: filename,
      paid: false,
      created_at: new Date().toISOString()
    };

    await db.collection('requests').add(newRequest);

    await sendEmailNotification(
      'طلب دفع جديد',
      `طلب دفع جديد:\n${JSON.stringify(newRequest, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${cleanPhone}\nالبريد: ${email}`
    );

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (error) {
    console.error('Error in /pay:', error);
    res.status(500).send(`حدث خطأ في الخادم: ${error.message}`);
  }
});

// الحجز
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

    // تنظيف أرقام الهواتف قبل الحفظ
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanSenderPhone = senderPhone.replace(/\D/g, '');

    const newReservation = {
      nationalId,
      phone: cleanPhone,
      email,
      senderPhone: cleanSenderPhone,
      screenshot: filename,
      reserved_at: new Date().toISOString()
    };

    await db.collection('reservations').add(newReservation);

    await sendEmailNotification(
      'طلب حجز جديد',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nرقم المحول: ${cleanSenderPhone}`
    );

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (error) {
    console.error('Error in /reserve:', error);
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

// ✅ API جديدة للحجز عن طريق التليفون
app.post('/api/reserve-by-phone', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone } = req.body;
    if (!nationalId || !phone || !email || !senderPhone) {
      return res.status(400).json({ success: false, message: 'البيانات غير مكتملة' });
    }

    if (!req.files || !req.files.screenshot) {
      return res.status(400).json({ success: false, message: 'يجب رفع سكرين التحويل' });
    }

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);

    await screenshot.mv(uploadPath);

    // تنظيف أرقام الهواتف قبل الحفظ
    const cleanPhone = phone.replace(/\D/g, '');
    const cleanSenderPhone = senderPhone.replace(/\D/g, '');

    const newReservation = {
      nationalId,
      phone: cleanPhone,
      email,
      senderPhone: cleanSenderPhone,
      screenshot: filename,
      reserved_at: new Date().toISOString(),
      method: 'phone' // ✅ عشان نفرق انه حجز بالتليفون
    };

    await db.collection('reservations').add(newReservation);

    // إشعارات
    await sendEmailNotification(
      '📞 طلب حجز جديد عن طريق التليفون',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>📞 طلب حجز جديد عن طريق التليفون:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nرقم المحول: ${cleanSenderPhone}`
    );

    res.json({ success: true, message: 'تم تسجيل الحجز بنجاح.' });
  } catch (error) {
    console.error('Error in /api/reserve-by-phone:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الحجز' });
  }
});

// تسجيل الدخول للادمن => توليد JWT
app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    // زيادة مدة الصلاحية إلى 24 ساعة
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '24h' });
    return res.json({ 
      success: true, 
      token,
      expiresIn: '24h'
    });
  }
  res.status(401).json({ success: false, message: 'خطأ في تسجيل الدخول' });
});

// ✅ التحقق من النتيجة للطالب (إصدار محسّن)
app.post('/api/check-result', async (req, res) => {
  const { phone, seatNumber } = req.body;

  try {
    const requestsRef = db.collection('requests');
    let query = requestsRef.where('phone', '==', phone);
    
    // إضافة البحث برقم الجلوس إذا كان متوفراً
    if (seatNumber) {
      query = requestsRef.where('seatNumber', '==', seatNumber);
    }

    const snap = await query.get();

    if (snap.empty) {
      return res.status(404).json({
        success: false,
        message: 'لم يتم العثور على نتيجة لهذا الرقم أو لم يتم الدفع بعد'
      });
    }

    const requestDoc = snap.docs[0];
    const requestData = requestDoc.data();

    if (!requestData.paid) {
      return res.status(402).json({
        success: false,
        message: 'لم يتم الدفع بعد'
      });
    }

    // إذا كانت النتيجة مخزنة مباشرة في الطلب
    if (requestData.result) {
      return res.json({
        success: true,
        result: requestData.result
      });
    }

    // إذا كانت النتيجة في مجموعة منفصلة (results)
    if (requestData.seatNumber) {
      const resultsRef = db.collection('results');
      const resultSnap = await resultsRef.where('seatNumber', '==', requestData.seatNumber).get();
      
      if (!resultSnap.empty) {
        const resultDoc = resultSnap.docs[0];
        const resultData = resultDoc.data();
        
        // تحديث الطلب بتفاصيل النتيجة
        await requestDoc.ref.update({
          result: resultData
        });
        
        return res.json({
          success: true,
          result: resultData
        });
      }
    }

    res.status(404).json({
      success: false,
      message: 'النتيجة غير متوفرة بعد، يرجى المحاولة لاحقاً'
    });

  } catch (error) {
    console.error('Error in /api/check-result:', error);
    res.status(500).json({
      success: false,
      message: 'حدث خطأ في الخادم: ' + error.message
    });
  }
});

// ✅ فتح نتيجة (إدارة فقط) - إصدار محسّن
app.post('/api/open-result', authenticateAdmin, async (req, res) => {
  const { seatNumber } = req.body;
  
  try {
    const requestsRef = db.collection('requests');
    const resultsRef = db.collection('results');

    // البحث عن الطلب باستخدام رقم الجلوس
    const requestSnap = await requestsRef.where('seatNumber', '==', seatNumber).get();
    
    if (requestSnap.empty) {
      return res.status(404).json({ 
        success: false, 
        message: 'لم يتم العثور على طلب لهذا رقم الجلوس' 
      });
    }

    const requestDoc = requestSnap.docs[0];
    
    // البحث عن النتيجة باستخدام رقم الجلوس
    const resultSnap = await resultsRef.where('seatNumber', '==', seatNumber).get();
    
    if (resultSnap.empty) {
      return res.status(404).json({ 
        success: false, 
        message: 'لم يتم العثور على نتيجة لهذا رقم الجلوس' 
      });
    }

    const resultDoc = resultSnap.docs[0];
    const resultData = resultDoc.data();

    // تحديث الطلب بحالة الدفع والنتيجة
    await requestDoc.ref.update({
      paid: true,
      result: resultData,
      openedAt: new Date().toISOString()
    });

    res.json({ 
      success: true,
      message: 'تم فتح النتيجة بنجاح'
    });
    
  } catch (error) {
    console.error('Error in /api/open-result:', error);
    res.status(500).json({ 
      success: false, 
      message: error.message 
    });
  }
});

// إضافة رسالة الرد (الإيميل والرسالة) من الادمن (محمي) + إرسال إيميل فعلي
app.post('/api/send-admin-message', authenticateAdmin, async (req, res) => {
  const { email, message } = req.body;
  if (!email || !message) {
    return res.status(400).json({ error: 'البريد الإلكتروني والرسالة مطلوبين' });
  }

  try {
    // إرسال الإيميل
    await transporter.sendMail({
      from: `"gizaresult" <${process.env.SMTP_USER}>`,
      to: email,
      subject: 'gizaresult',
      text: message,
      html: `<p>${message}</p>`
    });

    // حفظ الرسالة بعد الإرسال
    adminMessages.push({ email, message, sentAt: new Date() });

    res.json({ message: 'تم إرسال الرسالة بنجاح' });
  } catch (err) {
    console.error('خطأ في إرسال الإيميل:', err);
    res.status(500).json({ error: 'حدث خطأ أثناء إرسال الإيميل' });
  }
});

// إرسال رسالة للادمن من الدردشة وحفظها في Firestore
app.post('/api/send-admin-message', async (req, res) => {
  const { message, userData } = req.body;
  if (!message) return res.json({ success: false, message: 'الرسالة فارغة' });

  try {
    const newChatInquiry = {
      message,
      userData: userData || {},
      created_at: new Date().toISOString(),
      status: 'new'
    };

    const docRef = await db.collection('chat_inquiries').add(newChatInquiry);

    // إرسال إشعار للادمن
    const telegramMessage = `
<b>استفسار جديد من الدردشة:</b>
👤 <b>الاسم:</b> ${userData.name || "غير معروف"}
📞 <b>الهاتف:</b> ${userData.phone || "غير معروف"}
📧 <b>البريد:</b> ${userData.email || "غير معروف"}

💬 <b>الرسالة:</b>
${message}
    `;
    await sendTelegramNotification(telegramMessage);

    res.json({ success: true, id: docRef.id });
  } catch (error) {
    console.error('Error sending admin message:', error);
    res.json({ success: false });
  }
});

// ========== APIs إدارية (محميّة بـ JWT) ==========
app.get('/api/chat-inquiries', authenticateAdmin, async (req, res) => {
  try {
    const snap = await db.collection('chat_inquiries').orderBy('created_at', 'desc').get();
    const inquiries = snap.docs.map(doc => {
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
    });
    res.json({ inquiries });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/chat-inquiries/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.collection('chat_inquiries').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/chat-inquiries/:id/read', authenticateAdmin, async (req, res) => {
  try {
    await db.collection('chat_inquiries').doc(req.params.id).update({ status: 'read' });
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

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

app.delete('/api/reservations/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.collection('reservations').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.delete('/api/requests/:id', authenticateAdmin, async (req, res) => {
  try {
    await db.collection('requests').doc(req.params.id).delete();
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ==============================================
const port = process.env.PORT || 3000;
module.exports = app;