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
app.use(fileUpload());

// تحميل البيانات من JSON
const dataPath = './data.json';
let data = { requests: [], results: [] };
if (fs.existsSync(dataPath)) {
    data = JSON.parse(fs.readFileSync(dataPath));
}

function saveData() {
    fs.writeFileSync(dataPath, JSON.stringify(data, null, 2));
}

// ----------------- Routes -----------------

// استعراض البيانات كاملة للـ Dashboard
app.get('/api/results', (req, res) => {
    res.json(data);
});

// فتح نتيجة طالب
app.post('/api/open-result', (req, res) => {
    const { seatNumber } = req.body;
    const request = data.requests.find(r => r.seatNumber === seatNumber);
    if (request) request.paid = true;
    saveData();
    res.json({ success: true });
});

// إرسال النتيجة عبر البريد
app.post('/api/send-email', async (req, res) => {
    const { seatNumber, email, message } = req.body;
    const result = data.results.find(r => r.seatNumber === seatNumber);
    if (!result) return res.json({ success: false, message: 'لا يوجد نتيجة لإرسالها' });

    try {
        let transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT,
            secure: true,
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });

        await transporter.sendMail({
            from: process.env.SMTP_USER,
            to: email,
            subject: 'نتيجتك',
            text: `نتيجتك:\nاسم الطالب: ${result.name}\nالصف: ${result.gradeLevel}\nالنسبة: ${result.percentage}%\n\n${message}`
        });

        res.json({ success: true });
    } catch (err) {
        res.json({ success: false, message: err.message });
    }
});

// --------------------------------------------
app.listen(3000, () => console.log('Server running on http://localhost:3000'));
