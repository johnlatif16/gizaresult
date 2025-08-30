const express = require('express');
const fileUpload = require('express-fileupload');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
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

// Middleware للتحقق من المصادقة
const requireAuth = (req, res, next) => {
    // هنا يمكنك إضافة منطق التحقق من الجلسات أو التوكن
    // للتبسيط، سنستخدم تحقق أساسي من خلال query parameter أو header
    const authToken = req.query.auth || req.headers.authorization;
    
    // هذا مثال بسيط، في التطبيق الحقيقي استخدم جلسات أو JWT
    if (req.path.includes('/dashboard') && !authToken) {
        return res.redirect('/login.html');
    }
    next();
};

app.use(requireAuth);

// ----------------- Routes -----------------

// الصفحة الرئيسية
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// منع الوصول المباشر إلى dashboard
app.get('/dashboard.html', (req, res) => {
    res.redirect('/login.html');
});

// استقبال الدفع
app.post('/pay', (req, res) => {
    const { nationalId, seatNumber, phone, email } = req.body;
    if (!req.files || !req.files.screenshot) return res.status(400).send('يجب رفع سكرين التحويل');

    const screenshot = req.files.screenshot;
    const filename = Date.now() + path.extname(screenshot.name);
    const uploadPath = path.join(uploadsDir, filename);
    screenshot.mv(uploadPath, err => {
        if (err) return res.status(500).send(err);
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
        res.send('تم تسجيل طلبك، سيتم التأكد من الدفع قريبًا.');
    });
});

// تسجيل دخول الادمن
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
        // إنشاء توكن بسيط (في التطبيق الحقيقي استخدم JWT)
        const authToken = Buffer.from(`${username}:${password}`).toString('base64');
        return res.redirect(`/admin-dashboard.html?auth=${authToken}`);
    }
    res.send('خطأ في تسجيل الدخول');
});

// لوحة التحكم الآمنة
app.get('/admin-dashboard.html', (req, res) => {
    const authToken = req.query.auth;
    if (!authToken) {
        return res.redirect('/login.html');
    }
    
    // التحقق من التوكن (تبسيطي)
    try {
        const decoded = Buffer.from(authToken, 'base64').toString('utf-8');
        const [username, password] = decoded.split(':');
        
        if (username === process.env.ADMIN_USER && password === process.env.ADMIN_PASS) {
            return res.sendFile(path.join(__dirname, 'public', 'admin-dashboard.html'));
        }
    } catch (error) {
        // في حالة خطأ في التوكن
    }
    
    res.redirect('/login.html');
});

// فتح نتيجة لطلب محدد
app.post('/api/open-result', (req, res) => {
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
app.post('/api/send-email-dashboard', async (req, res) => {
    const { seatNumber, email, message } = req.body;
    const student = data.results.find(r => r.seatNumber === seatNumber);
    if (!student) return res.json({ success: false, message: 'لا يوجد نتيجة' });

    try {
        // إعدادات SMTP مع خيارات أكثر مرونة
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST || 'smtp.gmail.com',
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_SECURE === 'true', // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            },
            tls: {
                // لا تفشل على شهادات SSL غير صالحة
                rejectUnauthorized: false
            }
        });

        // التحقق من اتصال SMTP
        await transporter.verify();

        const emailText = `
        نتيجتك:
        اسم الطالب: ${student.name}
        رقم الجلوس: ${student.seatNumber}
        الصف: ${student.gradeLevel}
        المدرسة: ${student.schoolName}
        النسبة: ${student.percentage}%
        الملاحظات: ${student.notes || 'لا يوجد'}
        
        ${message || 'شكراً لاستخدامك خدمتنا'}
        `;

        const emailHtml = `
        <div dir="rtl" style="font-family: Arial, sans-serif; line-height: 1.6; color: #333;">
            <h2 style="color: #1e40af;">نتيجتك</h2>
            <p><strong>اسم الطالب:</strong> ${student.name}</p>
            <p><strong>رقم الجلوس:</strong> ${student.seatNumber}</p>
            <p><strong>الصف:</strong> ${student.gradeLevel}</p>
            <p><strong>المدرسة:</strong> ${student.schoolName}</p>
            <p><strong>النسبة:</strong> ${student.percentage}%</p>
            <p><strong>الملاحظات:</strong> ${student.notes || 'لا يوجد'}</p>
            <hr>
            <p>${message || 'شكراً لاستخدامك خدمتنا'}</p>
        </div>
        `;

        await transporter.sendMail({
            from: process.env.SMTP_FROM || process.env.SMTP_USER,
            to: email,
            subject: 'نتيجتك - نظام إدارة النتائج',
            text: emailText,
            html: emailHtml
        });

        res.json({ success: true, message: 'تم إرسال البريد بنجاح' });
    } catch (err) {
        console.error('Error sending email:', err);
        res.json({ 
            success: false, 
            message: `فشل في إرسال البريد: ${err.message}` 
        });
    }
});

// API للـ Dashboard
app.get('/api/results', (req, res) => {
    res.json(data);
});

// --------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));