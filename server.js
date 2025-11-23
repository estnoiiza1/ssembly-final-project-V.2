// ==========================================
//  ASSEMBLY APP BACKEND (V28 - Production Ready)
// ==========================================

const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb'); 
const admin = require('firebase-admin'); 
const path = require('path'); // (ใหม่!) นำเข้า path เพื่อจัดการไฟล์
require('dotenv').config(); 

// --- 1. การตั้งค่า (Configuration) ---

// (⚠️ อย่าลืมเช็คชื่อไฟล์ .json ของคุณให้ตรงเป๊ะๆ นะครับ!)
const serviceAccount = require('./assembly-app-project-firebase-adminsdk-fbsvc-f975284913.json'); 
const mongoUri = process.env.MONGO_URI;

const app = express();
// (สำคัญสำหรับ Render) ใช้ PORT จาก Environment หรือ 3000
const PORT = process.env.PORT || 3000;

// --- 2. เริ่มต้น Firebase & MongoDB ---

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const client = new MongoClient(mongoUri, {
  serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true }
});

let db; 

app.use(cors());
app.use(express.json());

// --- (ใหม่!) ตั้งค่าให้ Server เสิร์ฟไฟล์หน้าบ้าน (HTML/JS) ---
// บรรทัดนี้สำคัญมาก! มันทำให้ Render รู้จักไฟล์ index.html, admin.html ฯลฯ
app.use(express.static(path.join(__dirname, '.')));


// --- 3. ฟังก์ชันเชื่อมต่อฐานข้อมูล ---
async function connectToDatabase() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected!");
    db = client.db('assembly_db'); 
  } catch (err) {
    console.error("❌ MongoDB Connection Error:", err);
    process.exit(1); 
  }
}

// ==========================================
//               API ROUTES
// ==========================================

// (ใหม่!) Route หน้าแรก (/) -> ส่ง index.html
app.get('/', (req, res) => {
   res.sendFile(path.join(__dirname, 'Index.html'));
});

// 1. สมัครสมาชิก
app.post('/register', async (req, res) => {
  try {
    const { username, password, full_name, role, department, employee_id } = req.body;
    if (!username || !password || !full_name) return res.status(400).send({ error: 'กรอกข้อมูลไม่ครบ' });
    
    const existingUser = await db.collection('users').findOne({ username });
    if (existingUser) return res.status(400).send({ error: 'Username ซ้ำ' });

    const newUser = {
      username, password, full_name, role: role || 'operator', 
      department: department || 'General', employee_id: employee_id || '', 
      is_active: true, is_online: false, created_at: new Date()
    };
    await db.collection('users').insertOne(newUser);
    res.status(201).send({ message: 'User Created' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 2. เข้าสู่ระบบ
app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (!user || user.password !== password) return res.status(401).send({ error: 'Login Failed' });
    if (!user.is_active) return res.status(403).send({ error: 'Account Disabled' });
    
    await db.collection('users').updateOne({ _id: user._id }, { $set: { is_online: true, last_login: new Date() } });
    const token = await admin.auth().createCustomToken(user._id.toString());
    
    res.send({ message: 'OK', token, user: { ...user, _id: user._id } });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 3. ออกจากระบบ
app.post('/logout', async (req, res) => {
    try {
        const { userId } = req.body;
        if(userId) await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { is_online: false } });
        res.send({ message: 'Logged out' });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 4. ดึงรายชื่อคน Online
app.get('/get-active-users', async (req, res) => {
    try {
        const users = await db.collection('users').find({ is_online: true }).project({ full_name: 1, last_login: 1 }).toArray();
        res.send(users);
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 5. บันทึก QC
app.post('/log-qc', async (req, res) => {
  try {
    const { model, part_code, status, defect, userId, username, side } = req.body;
    const newLogEntry = {
      model, part_code: part_code || null, status, defect: defect || null,
      side: side || null, timestamp: new Date(), user_id: new ObjectId(userId), username
    };
    await db.collection('qc_log').insertOne(newLogEntry);
    console.log(`✅ QC: ${username} -> ${status}`);
    res.status(201).send({ message: 'Saved' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 6. Undo
app.post('/undo-last-qc', async (req, res) => {
    try {
      const { userId } = req.body;
      const lastEntry = await db.collection('qc_log').find({ user_id: new ObjectId(userId) }).sort({ timestamp: -1 }).limit(1).toArray();
      if (lastEntry.length === 0) return res.status(404).send({ error: 'Not found' });
      await db.collection('qc_log').deleteOne({ _id: lastEntry[0]._id });
      res.status(200).send({ message: 'Deleted', deletedEntry: lastEntry[0] });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 7. Reset Day
app.post('/reset-today', async (req, res) => {
    try {
      const { userId } = req.body;
      const today = new Date(); today.setHours(0,0,0,0);
      const result = await db.collection('qc_log').deleteMany({ user_id: new ObjectId(userId), timestamp: { $gte: today } });
      res.status(200).send({ message: 'Reset Done' });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 8. Get Stats (Operator)
app.get('/get-stats/:userId', async (req, res) => {
  try {
    const { userId } = req.params; const { model } = req.query;
    const today = new Date(); today.setHours(0,0,0,0);
    let q = { user_id: new ObjectId(userId), timestamp: { $gte: today } };
    if (model) q.model = model;

    const [ok, ng, rework] = await Promise.all([
      db.collection('qc_log').countDocuments({ ...q, status: 'OK' }),
      db.collection('qc_log').countDocuments({ ...q, status: 'NG' }),
      db.collection('qc_log').countDocuments({ ...q, status: 'REWORK' })
    ]);
    const okLeft = await db.collection('qc_log').countDocuments({ ...q, status: 'OK', side: 'L' });
    const okRight = await db.collection('qc_log').countDocuments({ ...q, status: 'OK', side: 'R' });

    res.send({ ok, ng, rework, total: ok+ng+rework, okLeft, okRight });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 9. Set Plan
app.post('/set-plan', async (req, res) => {
  try {
    const { date_string, model, shift, target_quantity } = req.body;
    await db.collection('production_plans').updateOne(
      { date_string, model, shift }, 
      { $set: { date_string, model, shift, target_quantity: parseInt(target_quantity) } }, 
      { upsert: true }
    );
    res.status(201).send({ message: 'Plan Saved' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 10. Admin Dashboard
app.get('/get-admin-dashboard', async (req, res) => {
  try {
    const { start, end, model, shift } = req.query; 
    let planDateStr = new Date().toISOString().split('T')[0]; 
    let selectedShift = shift || 'day';
    let startDateObj = start ? new Date(start) : new Date();
    let endDateObj = end ? new Date(end) : new Date();
    
    if (start && end) { planDateStr = start; } 
    else { startDateObj = new Date(); endDateObj = new Date(); }

    if (selectedShift === 'day') {
        startDateObj.setHours(8, 0, 0, 0); endDateObj.setHours(20, 0, 0, 0);
    } else {
        startDateObj.setHours(20, 0, 0, 0);
        endDateObj.setDate(endDateObj.getDate() + 1); endDateObj.setHours(8, 0, 0, 0);
    }
    
    let qcQuery = { timestamp: { $gte: startDateObj, $lt: endDateObj } };
    let planQuery = { date_string: planDateStr, shift: selectedShift }; 

    if (model && model !== "") { qcQuery.model = model; planQuery.model = model; }

    const totalOK = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'OK' });
    const totalNG = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'NG' });
    const totalRework = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'REWORK' });

    const plans = await db.collection('production_plans').find(planQuery).toArray();
    let totalPlan = 0;
    plans.forEach(p => totalPlan += p.target_quantity);

    const defectSummary = await db.collection('qc_log').aggregate([
      { $match: { ...qcQuery, status: 'NG' } },
      { $group: { _id: "$defect", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    const hourlySummary = await db.collection('qc_log').aggregate([
      { $match: qcQuery },
      { $project: { hour: { $hour: { date: "$timestamp", timezone: "Asia/Bangkok" } }, status: "$status" } },
      { $group: { 
          _id: "$hour", 
          ok: { $sum: { $cond: [{ $eq: ["$status", "OK"] }, 1, 0] } },
          ng: { $sum: { $cond: [{ $eq: ["$status", "NG"] }, 1, 0] } },
          rework: { $sum: { $cond: [{ $eq: ["$status", "REWORK"] }, 1, 0] } }
      }},
      { $sort: { _id: 1 } }
    ]).toArray();

    const rackSummary = await db.collection('qc_log').aggregate([
      { $match: { ...qcQuery, status: 'OK' } }, 
      { $group: { 
          _id: { model: "$model", part_code: "$part_code" }, 
          total_ok: { $sum: 1 } 
      }}, 
      { $project: {
          model: "$_id.model", part_code: "$_id.part_code", total_ok: 1,
          full_racks: { $floor: { $divide: ["$total_ok", 8] } },
          pending_pieces: { $mod: ["$total_ok", 8] }
      }},
      { $sort: { part_code: 1 } }
    ]).toArray();

    res.send({
      kpi: { plan: totalPlan, ok: totalOK, ng: totalNG, rework: totalRework, variance: totalOK - totalPlan },
      defects: defectSummary, hourly: hourlySummary, racks: rackSummary 
    });

  } catch (err) { res.status(500).send({ error: 'Dashboard Error' }); }
});

// 11. Rework List
app.get('/get-rework-list', async (req, res) => {
  try {
    const reworkList = await db.collection('qc_log').find({ status: 'REWORK' }).sort({ timestamp: -1 }).toArray();
    res.status(200).send(reworkList);
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// 12. Update Rework
app.post('/update-rework', async (req, res) => {
  try {
    const { id, newStatus, inspector } = req.body;
    const result = await db.collection('qc_log').updateOne({ _id: new ObjectId(id) }, { $set: { status: newStatus, rework_checked_by: inspector, rework_checked_at: new Date() } });
    if (result.modifiedCount === 0) return res.status(404).send({ error: 'Not found' });
    res.status(200).send({ message: 'Updated' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- สตาร์ท Server ---
async function startServer() {
  await connectToDatabase();
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server (V28) running on port ${PORT}`));
}
startServer();



