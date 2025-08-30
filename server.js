
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

// ----------------- Routes -----------------

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
            nationalId,   // ✅ الرقم القومي
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
        return res.redirect('/dashboard.html');
    }
    res.send('خطأ في تسجيل الدخول');
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
        // ⚠️ حل مشكلة Gmail SMTP: استخدم App Password وليس كلمة السر العادية
        let transporter = nodemailer.createTransport({
            service: "gmail",
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS  // App Password
            }
        });

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: email,
            subject: 'نتيجتك',
            text: `النتيجة:\nاسم الطالب: ${student.name}\nالصف: ${student.gradeLevel}\nالنسبة: ${student.percentage}%\n\n${message || ''}`
        });

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// API للـ Dashboard
app.get('/api/results', (req, res) => {
    res.json(data);
});

// --------------------------------------------
app.listen(3000, () => console.log('Server running on http://localhost:3000'));
