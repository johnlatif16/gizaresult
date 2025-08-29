const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const axios = require('axios');
const cookieParser = require('cookie-parser');
require('dotenv').config();

const app = express();

// استخدام cookie-parser middleware
app.use(cookieParser());
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(fileUpload());

// إنشاء مجلد uploads لو مش موجود
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);

// تحميل البيانات من JSON
const dataPath = './data.json';
let data = { requests: [], results: [] };
if (fs.existsSync(dataPath)) {
    data = JSON.parse(fs.readFileSync(dataPath));
}

// حفظ البيانات في JSON
function saveData() {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// Middleware للتحقق من تسجيل الدخول
function requireAuth(req, res, next) {
    if (req.cookies.loggedIn === 'true') {
        next();
    } else {
        res.redirect('/login.html');
    }
}

// دالة لإرسال رسالة إلى التيليجرام
async function sendTelegramMessage(message) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !process.env.TELEGRAM_CHAT_ID) {
        console.log('إعدادات التيليجرام غير مكتملة');
        return;
    }

    try {
        const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: process.env.TELEGRAM_CHAT_ID,
            text: message,
            parse_mode: 'HTML'
        });
        console.log('تم إرسال الرسالة إلى التيليجرام');
    } catch (error) {
        console.error('خطأ في إرسال الرسالة إلى التيليجرام:', error.message);
    }
}

// دالة لإرسال بريد إلكتروني
async function sendEmail(to, subject, text) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASS) {
        console.log('إعدادات البريد الإلكتروني غير مكتملة');
        return false;
    }

    try {
        let transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: to,
            subject: subject,
            text: text
        });

        console.log('تم إرسال البريد الإلكتروني إلى:', to);
        return true;
    } catch (err) {
        console.error('خطأ في إرسال البريد الإلكتروني:', err.message);
        return false;
    }
}

// ----------------- Routes -----------------

// تسجيل دخول الادمن
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        res.cookie('loggedIn', 'true', { maxAge: 24 * 60 * 60 * 1000 });
        return res.redirect('/dashboard.html');
    }
    res.send('خطأ في تسجيل الدخول');
});

// حماية dashboard
app.get('/dashboard.html', requireAuth, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// استقبال الدفع
app.post('/pay', async (req, res) => {
    const { nationalId, seatNumber, phone, email } = req.body;
    if (!req.files || !req.files.screenshot) return res.status(400).send('يجب رفع سكرين التحويل');

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    
    screenshot.mv(uploadPath, async err => {
        if (err) return res.status(500).send(err);
        
        // حفظ الطلب في البيانات
        data.requests.push({
            nationalId,
            seatNumber,
            phone,
            email,
            screenshot: filename,
            paid: false,
            created_at: new Date().toISOString()
        });
        saveData();
        
        // إرسال إشعارات
        const message = `طلب جديد للنتيجة:
- الرقم القومي: ${nationalId}
- رقم الجلوس: ${seatNumber}
- الهاتف: ${phone}
- البريد: ${email}`;
        
        // إرسال إلى التيليجرام
        await sendTelegramMessage(message);
        
        // إرسال إلى الجيميل (NOTIFICATION_EMAIL)
        if (process.env.NOTIFICATION_EMAIL) {
            await sendEmail(
                process.env.NOTIFICATION_EMAIL,
                'طلب جديد للنتيجة',
                message
            );
        } else {
            console.log('لم يتم تحديد بريد الإشعارات (NOTIFICATION_EMAIL)');
        }
        
        res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
    });
});

// فتح نتيجة لطلب محدد
app.post('/api/open-result', requireAuth, (req, res) => {
    const { seatNumber } = req.body;
    const request = data.requests.find(r => r.seatNumber === seatNumber);
    const student = data.results.find(r => r.seatNumber === seatNumber);
    if (!request || !student) return res.json({ success: false, message: 'طلب أو نتيجة غير موجودة' });
    
    request.paid = true;
    request.result = student;
    saveData();
    res.json({ success: true });
});

// استعلام بعد الدفع
app.post('/check-result', (req, res) => {
    const { phone } = req.body;
    const request = data.requests.find(r => r.phone === phone && r.paid && r.result);
    if (!request) return res.send('لم يتم الدفع أو الطلب غير موجود.');
    res.send(JSON.stringify(request.result, null, 2));
});

// إرسال النتيجة عبر البريد من dashboard
app.post('/api/send-email-dashboard', requireAuth, async (req, res) => {
    const { seatNumber, email, message } = req.body;
    const student = data.results.find(r => r.seatNumber === seatNumber);
    if (!student) return res.json({ success: false, message: 'لا يوجد نتيجة' });

    try {
        const emailText = `النتيجة:
اسم الطالب: ${student.name}
رقم الجلوس: ${student.seatNumber}
الصف: ${student.gradeLevel}
المدرسة: ${student.schoolName}
النسبة: ${student.percentage}%
الملاحظات: ${student.notes || 'لا توجد'}

${message || ''}`;

        const success = await sendEmail(email, 'نتيجتك', emailText);
        
        if (success) {
            res.json({ success: true });
        } else {
            res.json({ success: false, message: 'فشل في إرسال البريد' });
        }
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// API للـ Dashboard
app.get('/api/results', requireAuth, (req, res) => {
    res.json(data);
});

// تسجيل الخروج
app.post('/logout', (req, res) => {
    res.clearCookie('loggedIn');
    res.redirect('/login.html');
});

// --------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));