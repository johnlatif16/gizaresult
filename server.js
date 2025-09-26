const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const admin = require('firebase-admin');
const jwt = require('jsonwebtoken');
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

let transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: process.env.SMTP_PORT,
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

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
    const { nationalId, seatNumber, phone, email, orderId } = req.body;
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
      orderId: orderId || null,
      created_at: new Date().toISOString()
    };

    await db.collection('requests').add(newRequest);

    await sendEmailNotification(
      'طلب دفع جديد',
      `طلب دفع جديد:\n${JSON.stringify(newRequest, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب دفع جديد:</b>\nالرقم القومي: ${nationalId}\nرقم الجلوس: ${seatNumber}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nOrder ID: ${orderId || 'غير محدد'}`
    );

    res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
  } catch (error) {
    console.error('Error in /pay:', error);
    res.status(500).send(`حدث خطأ في الخادم: ${error.message}`);
  }
});

app.post('/reserve', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone, orderId } = req.body;
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
      orderId: orderId || null,
      reserved_at: new Date().toISOString()
    };

    await db.collection('reservations').add(newReservation);

    await sendEmailNotification(
      'طلب حجز جديد',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>طلب حجز جديد:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nرقم المحول: ${cleanSenderPhone}\nOrder ID: ${orderId || 'غير محدد'}`
    );

    res.send('تم تسجيل الحجز بنجاح.');
  } catch (error) {
    console.error('Error in /reserve:', error);
    res.status(500).send('حدث خطأ أثناء معالجة الحجز');
  }
});

app.post('/api/reserve-by-phone', async (req, res) => {
  try {
    const { nationalId, phone, email, senderPhone, orderId } = req.body;
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
      orderId: orderId || null,
      reserved_at: new Date().toISOString(),
      method: 'phone'
    };

    await db.collection('reservations').add(newReservation);

    await sendEmailNotification(
      '📞 طلب حجز جديد عن طريق التليفون',
      `طلب حجز جديد:\n${JSON.stringify(newReservation, null, 2)}`
    );
    await sendTelegramNotification(
      `<b>📞 طلب حجز جديد عن طريق التليفون:</b>\nالرقم القومي: ${nationalId}\nالهاتف: ${cleanPhone}\nالبريد: ${email}\nرقم المحول: ${cleanSenderPhone}\nOrder ID: ${orderId || 'غير محدد'}`
    );

    res.json({ success: true, message: 'تم تسجيل الحجز بنجاح.' });
  } catch (error) {
    console.error('Error in /api/reserve-by-phone:', error);
    res.status(500).json({ success: false, message: 'حدث خطأ أثناء معالجة الحجز' });
  }
});

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

// ========== APIs OPay - الإصدار النهائي ==========
app.post('/api/opay-pay', async (req, res) => {
  try {
    const { amount, description, orderId } = req.body;

    if (!amount || !description || !orderId) {
      return res.status(400).json({ 
        success: false, 
        message: 'بيانات الدفع غير مكتملة' 
      });
    }

    if (!process.env.OPAY_MERCHANT_ID || !process.env.OPAY_API_KEY) {
      console.error('❌ تكوين OPay غير مكتمل');
      return res.status(500).json({ 
        success: false, 
        message: 'تكوين نظام الدفع غير مكتمل' 
      });
    }

    const isDevelopment = process.env.NODE_ENV === 'development';
    
    if (isDevelopment) {
      console.log('وضع التطوير - إنشاء جلسة دفع وهمية');
      return res.json({ 
        success: true, 
        paymentUrl: `/?status=test&orderId=${orderId}&amount=${amount}`,
        isTest: true
      });
    }

    console.log('🚀 بدء عملية دفع حقيقية عبر OPay:', { orderId, amount, description });

    const baseUrl = process.env.OPAY_CALLBACK_URL.replace('/api/opay-webhook', '');
    const callbackUrl = `${baseUrl}/api/opay-webhook`;
    const returnUrl = `${baseUrl}/?status=success&orderId=${orderId}`;
    const cancelUrl = `${baseUrl}/?status=cancel&orderId=${orderId}`;

    const opayRequest = {
      merchantId: process.env.OPAY_MERCHANT_ID,
      orderId: orderId,
      amount: amount.toString(),
      currency: "EGP",
      description: description,
      callbackUrl: callbackUrl,
      returnUrl: returnUrl,
      cancelUrl: cancelUrl,
      customer: {
        email: "customer@example.com",
        name: "Customer"
      }
    };

    console.log('📤 إرسال طلب إلى OPay:', opayRequest);

    const opayResponse = await axios.post(
      "https://api.opaycheckout.com/api/v1/international/cashier/create", 
      opayRequest, 
      {
        headers: {
          "Authorization": `Bearer ${process.env.OPAY_API_KEY}`,
          "Content-Type": "application/json",
          "MerchantId": process.env.OPAY_MERCHANT_ID
        },
        timeout: 15000
      }
    );

    console.log('📥 استجابة OPay:', opayResponse.data);

    if (opayResponse.data && opayResponse.data.code === '00000') {
      if (opayResponse.data.data && opayResponse.data.data.cashierUrl) {
        res.json({ 
          success: true, 
          paymentUrl: opayResponse.data.data.cashierUrl,
          orderId: orderId
        });
      } else {
        throw new Error('رابط الدفع غير متوفر في استجابة OPay');
      }
    } else {
      throw new Error(opayResponse.data.message || `خطأ من OPay: ${opayResponse.data.code}`);
    }

  } catch (error) {
    console.error("❌ خطأ في إنشاء عملية الدفع عبر OPay:", error.message);
    
    let errorMessage = 'فشل في الاتصال بنظام الدفع';
    
    if (error.response) {
      const opayError = error.response.data;
      errorMessage = `خطأ من نظام الدفع: ${opayError.message || `كود الخطأ: ${opayError.code}`}`;
    }
    
    res.status(500).json({ 
      success: false, 
      message: errorMessage
    });
  }
});

app.post('/api/opay-webhook', async (req, res) => {
  try {
    console.log('🔔 استلام ويب هوك من OPay:', req.body);
    
    const { orderId, status, transactionId, amount } = req.body;
    
    if (status === "SUCCESS" || status === "success") {
      const requestsRef = db.collection('requests');
      const reservationsRef = db.collection('reservations');
      
      let snap = await requestsRef.where('orderId', '==', orderId).get();
      
      if (!snap.empty) {
        const requestDoc = snap.docs[0];
        await requestDoc.ref.update({
          paid: true,
          paymentMethod: "OPay",
          transactionId: transactionId,
          paidAt: new Date().toISOString(),
          amount: amount
        });
        console.log('✅ تم تحديث حالة الطلب:', orderId);
      } else {
        snap = await reservationsRef.where('orderId', '==', orderId).get();
        
        if (!snap.empty) {
          const reservationDoc = snap.docs[0];
          await reservationDoc.ref.update({
            paid: true,
            paymentMethod: "OPay",
            transactionId: transactionId,
            paidAt: new Date().toISOString(),
            amount: amount
          });
          console.log('✅ تم تحديث حالة الحجز:', orderId);
        }
      }
      
      await sendEmailNotification("تم الدفع بنجاح عبر OPay", `تم الدفع للطلب: ${orderId}`);
      await sendTelegramNotification(`✅ تم الدفع بنجاح عبر OPay: ${orderId}`);
    }
    
    res.status(200).send("OK");
  } catch (error) {
    console.error("❌ خطأ في معالجة ويب هوك OPay:", error);
    res.status(500).send("Error");
  }
});

app.get('/api/check-payment-status', async (req, res) => {
  const { orderId } = req.query;
  
  try {
    const requestsRef = db.collection('requests');
    const reservationsRef = db.collection('reservations');
    
    let snap = await requestsRef.where('orderId', '==', orderId).get();
    
    if (!snap.empty) {
      const requestDoc = snap.docs[0];
      const requestData = requestDoc.data();
      
      return res.json({
        status: requestData.paid ? 'SUCCESS' : 'PENDING',
        orderId: orderId,
        type: 'request'
      });
    }
    
    snap = await reservationsRef.where('orderId', '==', orderId).get();
    
    if (!snap.empty) {
      const reservationDoc = snap.docs[0];
      const reservationData = reservationDoc.data();
      
      return res.json({
        status: reservationData.paid ? 'SUCCESS' : 'PENDING',
        orderId: orderId,
        type: 'reservation'
      });
    }
    
    res.json({
      status: 'NOT_FOUND',
      orderId: orderId
    });
    
  } catch (error) {
    console.error('Error checking payment status:', error);
    res.status(500).json({
      status: 'ERROR',
      message: error.message
    });
  }
});

app.get('/api/orders', authenticateAdmin, async (req, res) => {
  try {
    const requestsSnap = await db.collection('requests').where('orderId', '!=', null).get();
    const reservationsSnap = await db.collection('reservations').where('orderId', '!=', null).get();
    
    const orders = [];
    
    requestsSnap.docs.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        type: 'request',
        orderId: data.orderId,
        nationalId: data.nationalId,
        phone: data.phone,
        paid: data.paid || false,
        createdAt: data.created_at,
        ...data
      });
    });
    
    reservationsSnap.docs.forEach(doc => {
      const data = doc.data();
      orders.push({
        id: doc.id,
        type: 'reservation',
        orderId: data.orderId,
        nationalId: data.nationalId,
        phone: data.phone,
        paid: data.paid || false,
        createdAt: data.reserved_at,
        ...data
      });
    });
    
    orders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    
    res.json({ orders });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

app.put('/api/orders/:orderId/mark-paid', authenticateAdmin, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { transactionId } = req.body;
    
    const requestsRef = db.collection('requests');
    const reservationsRef = db.collection('reservations');
    
    let snap = await requestsRef.where('orderId', '==', orderId).get();
    
    if (!snap.empty) {
      const requestDoc = snap.docs[0];
      await requestDoc.ref.update({
        paid: true,
        paymentMethod: "Manual",
        transactionId: transactionId || 'manual',
        paidAt: new Date().toISOString()
      });
    } else {
      snap = await reservationsRef.where('orderId', '==', orderId).get();
      
      if (!snap.empty) {
        const reservationDoc = snap.docs[0];
        await reservationDoc.ref.update({
          paid: true,
          paymentMethod: "Manual",
          transactionId: transactionId || 'manual',
          paidAt: new Date().toISOString()
        });
      } else {
        return res.status(404).json({ success: false, message: 'لم يتم العثور على الطلب' });
      }
    }
    
    await sendEmailNotification("تم تحديث حالة الدفع يدوياً", `تم تحديث حالة الدفع للطلب: ${orderId}`);
    await sendTelegramNotification(`✅ تم تحديث حالة الدفع يدوياً للطلب: ${orderId}`);
    
    res.json({ success: true, message: 'تم تحديث حالة الدفع بنجاح' });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// صفحة الرئيسية مع دعم callback
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
