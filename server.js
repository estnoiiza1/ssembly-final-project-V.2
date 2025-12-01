// ================================================================
//  ASSEMBLY APP BACKEND (V38 - Ultimate Full Option)
// ================================================================

const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb'); 
const admin = require('firebase-admin'); 
const path = require('path'); 
const fs = require('fs');
require('dotenv').config(); 

// --- 1. Configuration ---
const serviceAccount = require('./assembly-app-project-firebase-adminsdk-fbsvc-f975284913.json'); 
const mongoUri = process.env.MONGO_URI;

const app = express();
const PORT = process.env.PORT || 3000;

// --- 2. Init ---
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const client = new MongoClient(mongoUri, { serverApi: { version: ServerApiVersion.v1, strict: true, deprecationErrors: true } });
let db; 

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.'))); // Serve frontend files

// --- 3. DB Connection ---
async function connectToDatabase() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
    console.log("✅ MongoDB Connected!");
    db = client.db('assembly_db'); 
  } catch (err) { console.error("❌ DB Error:", err); process.exit(1); }
}

// ==========================================
//               API ROUTES
// ==========================================

// --- Root Route (Fix Case Sensitivity) ---
app.get('/', (req, res) => {
    const p1 = path.join(__dirname, 'Index.html');
    const p2 = path.join(__dirname, 'Index.html');
    if (fs.existsSync(p1)) res.sendFile(p1);
    else if (fs.existsSync(p2)) res.sendFile(p2);
    else res.status(404).send("❌ Error: index.html not found");
});

// --- User Management ---
app.post('/register', async (req, res) => {
  try {
    const { requester_id, username, password, full_name, role, department, employee_id } = req.body;
    if(requester_id) {
        const requester = await db.collection('users').findOne({ _id: new ObjectId(requester_id) });
        if (requester && requester.role === 'leader' && (role === 'admin' || role === 'leader')) {
            return res.status(403).send({ error: 'Leader cannot create Admin/Leader' });
        }
    }
    if (!username || !password || !full_name) return res.status(400).send({ error: 'Missing Data' });
    const existing = await db.collection('users').findOne({ username });
    if (existing) return res.status(400).send({ error: 'Username Exists' });
    
    await db.collection('users').insertOne({ 
        username, password, full_name, role: role || 'operator', 
        department: department || 'General', employee_id: employee_id || '', 
        is_active: true, is_online: false, created_at: new Date() 
    });
    res.status(201).send({ message: 'User Created' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

app.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await db.collection('users').findOne({ username });
    if (!user || user.password !== password) return res.status(401).send({ error: 'Login Failed' });
    if (!user.is_active) return res.status(403).send({ error: 'Disabled' });
    await db.collection('users').updateOne({ _id: user._id }, { $set: { is_online: true, last_login: new Date() } });
    const token = await admin.auth().createCustomToken(user._id.toString());
    res.send({ message: 'OK', token, user: { ...user, _id: user._id } });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

app.post('/logout', async (req, res) => {
    try {
        const { userId } = req.body;
        if(userId) await db.collection('users').updateOne({ _id: new ObjectId(userId) }, { $set: { is_online: false } });
        res.send({ message: 'Logged out' });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

app.get('/get-all-users', async (req, res) => {
    try { const users = await db.collection('users').find({}).sort({ created_at: -1 }).toArray(); res.send(users); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.post('/delete-user', async (req, res) => {
    try { await db.collection('users').deleteOne({ _id: new ObjectId(req.body.userId) }); res.send({ message: 'Deleted' }); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.post('/update-user', async (req, res) => {
    try { const { id, ...data } = req.body; if(data.password) delete data.password; await db.collection('users').updateOne({ _id: new ObjectId(id) }, { $set: data }); res.send({ message: 'Updated' }); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.get('/get-active-users', async (req, res) => {
    try { const users = await db.collection('users').find({ is_online: true }).project({ _id: 1, full_name: 1, last_login: 1 }).toArray(); res.send(users); } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- QC & Production ---
app.post('/log-qc', async (req, res) => {
  try {
    const { model, part_code, status, defect, userId, username, side, serial_number } = req.body;
    await db.collection('qc_log').insertOne({ 
        model, part_code: part_code || null, serial_number: serial_number || '-', 
        status, defect: defect || null, side: side || null, 
        timestamp: new Date(), user_id: new ObjectId(userId), username 
    });
    res.status(201).send({ message: 'Saved' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

app.post('/undo-last-qc', async (req, res) => {
    try {
      const last = await db.collection('qc_log').find({ user_id: new ObjectId(req.body.userId) }).sort({ timestamp: -1 }).limit(1).toArray();
      if (last.length === 0) return res.status(404).send({ error: 'Not found' });
      await db.collection('qc_log').deleteOne({ _id: last[0]._id });
      res.status(200).send({ message: 'Deleted', deletedEntry: last[0] });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

app.post('/reset-today', async (req, res) => {
    try {
      const today = new Date(); today.setHours(0,0,0,0);
      await db.collection('qc_log').deleteMany({ user_id: new ObjectId(req.body.userId), timestamp: { $gte: today } });
      res.status(200).send({ message: 'Reset Done' });
    } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- (V38 Update) Get Stats with Details ---
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

    // (V38) รายละเอียดแยก Model/Part
    const details = await db.collection('qc_log').aggregate([
        { $match: q },
        { $group: { _id: { model: "$model", part_code: "$part_code" }, total_inspect: { $sum: 1 }, total_ok: { $sum: { $cond: [{ $eq: ["$status", "OK"] }, 1, 0] } } } },
        { $project: { model: "$_id.model", part_code: "$_id.part_code", total_inspect: 1, total_ok: 1, full_racks: { $floor: { $divide: ["$total_ok", 8] } }, pending: { $mod: ["$total_ok", 8] } } },
        { $sort: { model: 1 } }
    ]).toArray();

    res.send({ ok, ng, rework, total: ok+ng+rework, okLeft, okRight, details });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- Planning ---
app.post('/set-plan', async (req, res) => {
  try {
    const { date_string, model, part_code, shift, target_quantity, cycle_time } = req.body;
    const pCode = part_code || "General";
    await db.collection('production_plans').updateOne(
      { date_string, model, shift, part_code: pCode }, 
      { $set: { date_string, model, shift, part_code: pCode, target_quantity: parseInt(target_quantity), cycle_time: parseInt(cycle_time)||0 }}, 
      { upsert: true }
    );
    res.status(201).send({ message: 'Plan Saved' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// (V37) Import Excel Plans
app.post('/import-plans', async (req, res) => {
  try {
    const plans = req.body; 
    if (!Array.isArray(plans) || plans.length === 0) return res.status(400).send({ error: 'No Data' });
    const updates = plans.map(p => {
        const pCode = p.part_code || "General";
        return db.collection('production_plans').updateOne(
            { date_string: p.date, model: p.model, shift: p.shift, part_code: pCode }, 
            { $set: { date_string: p.date, model: p.model, shift: p.shift, part_code: pCode, target_quantity: parseInt(p.target), cycle_time: parseInt(p.cycle_time)||0 }},
            { upsert: true }
        );
    });
    await Promise.all(updates);
    res.status(200).send({ message: `Imported ${plans.length} items` });
  } catch (err) { res.status(500).send({ error: 'Import Error' }); }
});

// --- Admin Dashboard (The Core) ---
app.get('/get-admin-dashboard', async (req, res) => {
  try {
    const { start, end, model, shift } = req.query; 
    let planDateStr = new Date().toISOString().split('T')[0]; 
    let selectedShift = shift || 'day';
    let startDateObj, endDateObj;
    
    if (start && end) { planDateStr = start; } 

    const getThaiDate = (dateStr, hour) => {
        const d = new Date(dateStr);
        d.setUTCHours(hour - 7, 0, 0, 0);
        return d;
    };
    if (selectedShift === 'day') {
        startDateObj = getThaiDate(planDateStr, 8); endDateObj = getThaiDate(planDateStr, 20);   
    } else {
        startDateObj = getThaiDate(planDateStr, 20); 
        const nextDay = new Date(startDateObj);
        nextDay.setDate(nextDay.getDate() + 1);
        endDateObj = getThaiDate(nextDay.toISOString().split('T')[0], 8); 
    }
    
    let qcQuery = { timestamp: { $gte: startDateObj, $lt: endDateObj } };
    let planQuery = { date_string: planDateStr, shift: selectedShift }; 
    if (model && model !== "") { qcQuery.model = model; planQuery.model = model; }

    const totalOK = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'OK' });
    const totalNG = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'NG' });
    const totalRework = await db.collection('qc_log').countDocuments({ ...qcQuery, status: 'REWORK' });

    const plans = await db.collection('production_plans').find(planQuery).toArray();
    let totalPlan = 0; let weightedCycleTime = 0;
    plans.forEach(p => { totalPlan += p.target_quantity; if (p.cycle_time > 0) weightedCycleTime = p.cycle_time; });

    // Efficiency Calc
    let efficiency = 0; let timeVariance = 0; let status = "On Track";
    if (weightedCycleTime > 0) {
        const now = new Date();
        let workingSeconds = 0;
        if (now >= startDateObj && now <= endDateObj) workingSeconds = (now - startDateObj) / 1000;
        else if (now > endDateObj) workingSeconds = (endDateObj - startDateObj) / 1000;
        
        if (workingSeconds > 0) {
            const expectedQty = Math.floor(workingSeconds / weightedCycleTime);
            if (expectedQty > 0) efficiency = ((totalOK / expectedQty) * 100).toFixed(1);
            timeVariance = Math.round(((totalOK - expectedQty) * weightedCycleTime) / 60);
            if (timeVariance > 5) status = "Fast 🚀"; else if (timeVariance < -5) status = "Slow 🐢";
        }
    }

    const defectSummary = await db.collection('qc_log').aggregate([{ $match: { ...qcQuery, status: 'NG' } }, { $group: { _id: "$defect", count: { $sum: 1 } } }, { $sort: { count: -1 } }]).toArray();
    const hourlySummary = await db.collection('qc_log').aggregate([{ $match: qcQuery }, { $project: { hour: { $hour: { date: "$timestamp", timezone: "Asia/Bangkok" } }, status: "$status" } }, { $group: { _id: "$hour", ok: { $sum: { $cond: [{ $eq: ["$status", "OK"] }, 1, 0] } }, ng: { $sum: { $cond: [{ $eq: ["$status", "NG"] }, 1, 0] } }, rework: { $sum: { $cond: [{ $eq: ["$status", "REWORK"] }, 1, 0] } } } }, { $sort: { _id: 1 } }]).toArray();
    const rackSummary = await db.collection('qc_log').aggregate([{ $match: { ...qcQuery, status: 'OK' } }, { $group: { _id: { model: "$model", part_code: "$part_code" }, total_ok: { $sum: 1 } } }, { $project: { model: "$_id.model", part_code: "$_id.part_code", total_ok: 1, full_racks: { $floor: { $divide: ["$total_ok", 8] } }, pending_pieces: { $mod: ["$total_ok", 8] } } }, { $sort: { part_code: 1 } }]).toArray();
    
    // (V29 Fix) Rework Items (งานค้างทั้งหมด)
    const reworkItems = await db.collection('qc_log').find({ status: 'REWORK' }).sort({ timestamp: -1 }).toArray();

    res.send({
      kpi: { plan: totalPlan, ok: totalOK, ng: totalNG, rework: totalRework, variance: totalOK - totalPlan, efficiency, timeVariance, status, cycleTime: weightedCycleTime },
      defects: defectSummary, hourly: hourlySummary, racks: rackSummary, reworks: reworkItems 
    });
  } catch (err) { res.status(500).send({ error: 'Dashboard Error' }); }
});

// --- Rework System ---
app.get('/get-rework-list', async (req, res) => {
  try { const reworkList = await db.collection('qc_log').find({ status: 'REWORK' }).sort({ timestamp: -1 }).toArray(); res.status(200).send(reworkList); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.post('/update-rework', async (req, res) => {
  try { const { id, newStatus, inspector } = req.body; await db.collection('qc_log').updateOne({ _id: new ObjectId(id) }, { $set: { status: newStatus, rework_checked_by: inspector, rework_checked_at: new Date() } }); res.status(200).send({ message: 'Updated' }); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.get('/get-rework-history', async (req, res) => {
  try {
    const { start, end } = req.query;
    let startDate = new Date(); let endDate = new Date();
    if (start && end) { startDate = new Date(start); endDate = new Date(end); endDate.setDate(endDate.getDate() + 1); } 
    else { startDate.setHours(0, 0, 0, 0); }
    const query = { timestamp: { $gte: startDate, $lt: endDate }, $or: [ { status: 'REWORK' }, { rework_checked_at: { $exists: true } } ] };
    const history = await db.collection('qc_log').find(query).sort({ timestamp: -1 }).toArray();
    res.status(200).send(history);
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});

// --- (V38) Andon System ---
app.post('/trigger-andon', async (req, res) => {
  try {
    const { type, userId, username } = req.body;
    await db.collection('andon_logs').insertOne({ type, userId: new ObjectId(userId), username, status: 'OPEN', created_at: new Date() });
    res.status(200).send({ message: 'Alert Sent' });
  } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.get('/get-active-andon', async (req, res) => {
  try { const alerts = await db.collection('andon_logs').find({ status: 'OPEN' }).sort({ created_at: 1 }).toArray(); res.send(alerts); } catch (err) { res.status(500).send({ error: 'Error' }); }
});
app.post('/resolve-andon', async (req, res) => {
  try { const { id, resolver } = req.body; await db.collection('andon_logs').updateOne({ _id: new ObjectId(id) }, { $set: { status: 'RESOLVED', resolved_by: resolver, resolved_at: new Date() } }); res.status(200).send({ message: 'Resolved' }); } catch (err) { res.status(500).send({ error: 'Error' }); }
});

async function startServer() {
  await connectToDatabase();
  app.listen(PORT, '0.0.0.0', () => console.log(`✅ Server (V38 Final) running on port ${PORT}`));
}
startServer();
