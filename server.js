const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
const { google } = require('googleapis'); // ✅ إضافة Gmail API
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

// ✅ إعداد OAuth2 Client لـ Gmail API
const oAuth2Client = new google.auth.OAuth2(
  process.env.GMAIL_CLIENT_ID,
  process.env.GMAIL_CLIENT_SECRET,
  process.env.GMAIL_REDIRECT_URI
);

// ✅ تعيين credentials إذا كان متوفراً
if (process.env.GMAIL_REFRESH_TOKEN) {
  oAuth2Client.setCredentials({
    refresh_token: process.env.GMAIL_REFRESH_TOKEN
  });
}

// ✅ دالة لإنشاء Gmail transporter
async function createGmailTransporter() {
  try {
    const accessToken = await oAuth2Client.getAccessToken();
    
    return nodemailer.createTransport({
      service: 'gmail',
      auth: {
        type: 'OAuth2',
        user: process.env.GMAIL_USER,
        clientId: process.env.GMAIL_CLIENT_ID,
        clientSecret: process.env.GMAIL_CLIENT_SECRET,
        refreshToken: process.env.GMAIL_REFRESH_TOKEN,
        accessToken: accessToken.token,
      },
    });
  } catch (error) {
    console.error('Error creating Gmail transporter:', error);
    // Fallback إلى SMTP العادي
    return nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: process.env.SMTP_PORT,
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
      }
    });
  }
}

// ✅ تهيئة transporter (سنقوم بإنشائه عند الحاجة)
let transporter;

// ✅ دالة للحصول على transporter مع fallback
async function getTransporter() {
  if (!transporter) {
    transporter = await createGmailTransporter();
  }
  return transporter;
}

// ✅ Middleware للتحقق من JWT
function authenticateAdmin(req, res, next) {
  const authHeader = req.headers['authorization'];
  
  if (!authHeader) {
    console.log('لم يتم إرسال token');
    return res.status(401).json({ success: false, message: 'Unauthorized' });
  }

  const token = authHeader.split(' ')[1];
  
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

// ✅ دوال إشعارات - معدلة لاستخدام Gmail API
async function sendEmailNotification(subject, text, html = null) {
  try {
    const mailTransporter = await getTransporter();
    
    const mailOptions = {
      from: process.env.GMAIL_USER || process.env.SMTP_USER,
      to: process.env.NOTIFICATION_EMAIL,
      subject: subject,
      text: text,
      ...(html && { html: html })
    };

    await mailTransporter.sendMail(mailOptions);
    console.log('📧 Email notification sent successfully via Gmail API');
  } catch (error) {
    console.error('❌ Error sending email notification:', error);
    
    // محاولة إرسال باستخدام SMTP العادي كـ fallback
    try {
      const fallbackTransporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: process.env.SMTP_PORT,
        secure: process.env.SMTP_SECURE === "true",
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      });
      
      await fallbackTransporter.sendMail({
        from: process.env.SMTP_USER,
        to: process.env.NOTIFICATION_EMAIL,
        subject: subject,
        text: text,
        ...(html && { html: html })
      });
      console.log('📧 Email sent successfully via SMTP fallback');
    } catch (fallbackError) {
      console.error('❌ Fallback email sending also failed:', fallbackError);
    }
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
    console.log('📱 Telegram notification sent successfully.');
  } catch (error) {
    console.error('❌ Error sending Telegram notification:', error.message);
  }
}

// ✅ Route جديد لتفعيل Gmail API
app.get('/auth/gmail', (req, res) => {
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.compose'
    ],
    prompt: 'consent'
  });
  res.redirect(authUrl);
});

// ✅ Route لاستقرار الـ callback من Gmail
app.get('/auth/gmail/callback', async (req, res) => {
  const { code } = req.query;
  
  try {
    const { tokens } = await oAuth2Client.getToken(code);
    oAuth2Client.setCredentials(tokens);
    
    console.log('✅ Gmail API authenticated successfully');
    console.log('🔑 Refresh Token:', tokens.refresh_token);
    
    // حفظ الـ refresh token في البيئة (في الواقع يجب حفظه في قاعدة البيانات)
    process.env.GMAIL_REFRESH_TOKEN = tokens.refresh_token;
    
    res.send('✅ تم تفعيل Gmail API بنجاح! يمكنك إغلاق هذه الصفحة.');
  } catch (error) {
    console.error('❌ Error authenticating Gmail API:', error);
    res.status(500).send('❌ فشل في تفعيل Gmail API');
  }
});

// ✅ Route للتحقق من حالة Gmail API
app.get('/api/gmail-status', authenticateAdmin, async (req, res) => {
  try {
    const credentials = oAuth2Client.credentials;
    const isAuthenticated = !!(credentials && credentials.access_token);
    
    res.json({
      authenticated: isAuthenticated,
      hasRefreshToken: !!process.env.GMAIL_REFRESH_TOKEN,
      email: process.env.GMAIL_USER
    });
  } catch (error) {
    res.json({
      authenticated: false,
      hasRefreshToken: false,
      error: error.message
    });
  }
});

// ----------------- Routes الحالية (بدون تغيير) -----------------

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

app.get('/pay', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'pay.html'));
});

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

    const cleanPhone = phone.replace(/\D/g, '');

    const newRequest = {
      nationalId,
      seatNumber,
      phone: cleanPhone,
      email,
      screenshot: filename,
      paid: false,
      created_at: new Date().toISOString()
    };

    await db.collection('requests').add(newRequest);

    // ✅ استخدام نظام Gmail API الجديد للإشعارات
    await sendEmailNotification(
      '💰 طلب دفع جديد',
      `طلب دفع جديد:\n${JSON.stringify(newRequest, null, 2)}`,
      `
      <div dir="rtl" style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
        <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <h2 style="color: #2c3e50;">💰 طلب دفع جديد</h2>
          <div style="margin-top: 20px;">
            <p><strong>الرقم القومي:</strong> ${nationalId}</p>
            <p><strong>رقم الجلوس:</strong> ${seatNumber}</p>
            <p><strong>الهاتف:</strong> ${cleanPhone}</p>
            <p><strong>البريد الإلكتروني:</strong> ${email}</p>
            <p><strong>وقت الطلب:</strong> ${new Date().toLocaleString('ar-EG')}</p>
          </div>
        </div>
      </div>
      `
    );

    await sendTelegramNotification(
      `<b>💰 طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${cleanPhone}\nالبريد: ${email}`
    );

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (error) {
    console.error('Error in /pay:', error);
    res.status(500).send(`حدث خطأ في الخادم: ${error.message}`);
  }
});

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

    // ✅ استخدام نظام Gmail API الجديد للإشعارات
    await sendEmailNotification(
      '🎫 طلب حجز جديد',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`,
      `
      <div dir="rtl" style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
        <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <h2 style="color: #2c3e50;">🎫 طلب حجز جديد</h2>
          <div style="margin-top: 20px;">
            <p><strong>الرقم القومي:</strong> ${nationalId}</p>
            <p><strong>الهاتف:</strong> ${cleanPhone}</p>
            <p><strong>البريد الإلكتروني:</strong> ${email}</p>
            <p><strong>رقم المحول:</strong> ${cleanSenderPhone}</p>
            <p><strong>وقت الحجز:</strong> ${new Date().toLocaleString('ar-EG')}</p>
          </div>
        </div>
      </div>
      `
    );

    await sendTelegramNotification(
      `<b>🎫 طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nرقم المحول: ${cleanSenderPhone}`
    );

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (error) {
    console.error('Error in /reserve:', error);
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

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

    const cleanPhone = phone.replace(/\D/g, '');
    const cleanSenderPhone = senderPhone.replace(/\D/g, '');

    const newReservation = {
      nationalId,
      phone: cleanPhone,
      email,
      senderPhone: cleanSenderPhone,
      screenshot: filename,
      reserved_at: new Date().toISOString(),
      method: 'phone'
    };

    await db.collection('reservations').add(newReservation);

    // ✅ استخدام نظام Gmail API الجديد للإشعارات
    await sendEmailNotification(
      '📞 طلب حجز جديد عن طريق التليفون',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`,
      `
      <div dir="rtl" style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
        <div style="background: white; padding: 20px; border-radius: 10px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
          <h2 style="color: #2c3e50;">📞 طلب حجز جديد عن طريق التليفون</h2>
          <div style="margin-top: 20px;">
            <p><strong>الرقم القومي:</strong> ${nationalId}</p>
            <p><strong>الهاتف:</strong> ${cleanPhone}</p>
            <p><strong>البريد الإلكتروني:</strong> ${email}</p>
            <p><strong>رقم المحول:</strong> ${cleanSenderPhone}</p>
            <p><strong>وقت الحجز:</strong> ${new Date().toLocaleString('ar-EG')}</p>
          </div>
        </div>
      </div>
      `
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

// ... باقي الـ routes بدون تغيير (login, check-result, open-result, etc.)

app.post('/login', (req, res) => {
  const { username, password } = req.body;
  if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
    const token = jwt.sign({ username }, process.env.JWT_SECRET, { expiresIn: '24h' });
    return res.json({ 
      success: true, 
      token,
      expiresIn: '24h'
    });
  }
  res.status(401).json({ success: false, message: 'خطأ في تسجيل الدخول' });
});

app.post('/api/check-result', async (req, res) => {
  const { phone, seatNumber } = req.body;

  try {
    const requestsRef = db.collection('requests');
    let query = requestsRef.where('phone', '==', phone);
    
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

    if (requestData.result) {
      return res.json({
        success: true,
        result: requestData.result
      });
    }

    if (requestData.seatNumber) {
      const resultsRef = db.collection('results');
      const resultSnap = await resultsRef.where('seatNumber', '==', requestData.seatNumber).get();
      
      if (!resultSnap.empty) {
        const resultDoc = resultSnap.docs[0];
        const resultData = resultDoc.data();
        
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

app.post('/api/open-result', authenticateAdmin, async (req, res) => {
  const { seatNumber } = req.body;
  
  try {
    const requestsRef = db.collection('requests');
    const resultsRef = db.collection('results');

    const requestSnap = await requestsRef.where('seatNumber', '==', seatNumber).get();
    
    if (requestSnap.empty) {
      return res.status(404).json({ 
        success: false, 
        message: 'لم يتم العثور على طلب لهذا رقم الجلوس' 
      });
    }

    const requestDoc = requestSnap.docs[0];
    
    const resultSnap = await resultsRef.where('seatNumber', '==', seatNumber).get();
    
    if (resultSnap.empty) {
      return res.status(404).json({ 
        success: false, 
        message: 'لم يتم العثور على نتيجة لهذا رقم الجلوس' 
      });
    }

    const resultDoc = resultSnap.docs[0];
    const resultData = resultDoc.data();

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

// ... باقي الـ routes الإدارية (بدون تغيير)

app.post('/api/send-email-dashboard', async (req, res) => {
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

// ... باقي الـ routes الإدارية (بدون تغيير)

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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
