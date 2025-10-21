const express = require("express");
const fs = require("fs");
const multer = require("multer");
const path = require("path");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json({ limit: '50mb' })); // Increase JSON limit for large video uploads
app.use(cors());

// Root status endpoint for platform health and manual checks
app.get("/", (req, res) => {
  res.type("text/plain").send(
    [
      "Campus Event Hub backend is running.",
      "",
      "Try these API endpoints:",
      "GET  /api/events",
      "GET  /api/notifications/:regNumber",
      "POST /api/events, /api/tickets, /api/volunteers/add, /api/volunteers/respond",
    ].join("\n")
  );
});
app.get("/healthz", (req, res) => res.json({ ok: true }));

// Use persistent storage paths that survive Render.com restarts
// For Render.com, we need to use a different approach since persistent disk isn't available on free tier
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, "uploads");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(__dirname, "backups");

// For Render.com, use environment-based storage or fallback to local
// Check if we're on Render.com and if persistent storage is available
const IS_RENDER = process.env.RENDER === 'true';
const HAS_PERSISTENT_DISK = process.env.RENDER_PERSISTENT_DISK === 'true';

// Use persistent paths only if persistent disk is explicitly enabled
const PERSISTENT_DATA_FILE = (IS_RENDER && HAS_PERSISTENT_DISK) ? "/opt/render/project/data.json" : DATA_FILE;
const PERSISTENT_UPLOAD_DIR = (IS_RENDER && HAS_PERSISTENT_DISK) ? "/opt/render/project/uploads" : UPLOAD_DIR;
const PERSISTENT_BACKUP_DIR = (IS_RENDER && HAS_PERSISTENT_DISK) ? "/opt/render/project/backups" : BACKUP_DIR;

// MongoDB Configuration for Permanent Data Storage
const MONGODB_URI = "mongodb+srv://chopramanish760_db_user:Xg8dNsvyQ0YSYIjt@campus.urvjcdt.mongodb.net/campus_event_hub?retryWrites=true&w=majority&appName=campus";
const DB_NAME = "campus_event_hub";
const COLLECTION_NAME = "app_data";

let client = null;
let db = null;
let collection = null;
let gridFSBucket = null;


// Initialize MongoDB connection
async function initMongoDB() {
  if (!MONGODB_URI) {
    console.log("📋 No MongoDB URI provided, skipping MongoDB connection");
    return false;
  }
  
  try {
    console.log("🔗 Connecting to MongoDB Atlas...");
    console.log(`📋 MongoDB URI: ${MONGODB_URI.replace(/\/\/[^:]+:[^@]+@/, '//***:***@')}`); // Hide credentials in logs
    
    // Use optimized configuration for better performance
    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 10, // Maintain up to 10 socket connections
      serverSelectionTimeoutMS: 5000, // Keep trying to send operations for 5 seconds
      socketTimeoutMS: 45000, // Close sockets after 45 seconds of inactivity
      maxIdleTimeMS: 30000, // Close connections after 30 seconds of inactivity
      connectTimeoutMS: 10000, // Give up initial connection after 10 seconds
      heartbeatFrequencyMS: 10000, // Send a ping every 10 seconds
      minPoolSize: 2 // Maintain a minimum of 2 socket connections
    });
    
    console.log("🔍 Attempting to connect...");
    await client.connect();
    console.log("✅ MongoDB client connected!");
    
    // Test database access
    db = client.db(DB_NAME);
    collection = db.collection(COLLECTION_NAME);
    
    // Initialize GridFS bucket for media storage
    gridFSBucket = new GridFSBucket(db, { bucketName: 'media' });
    
    // Test a simple operation
    console.log("🔍 Testing database operations...");
    await db.admin().ping();
    console.log("✅ Database ping successful!");
    
    // Create indexes for better performance
    await collection.createIndex({ "type": 1 });
    console.log("📊 Database indexes created");
    
    console.log("✅ Connected to MongoDB Atlas successfully!");
    console.log("📁 GridFS bucket initialized for media storage");
    return true;
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err.message);
    console.error("❌ Error details:", err);
    console.log("🔄 Falling back to local file storage...");
    return false;
  }
}

// Check if this is a manual deployment (not automatic restart)
function isManualDeployment() {
  // Check for deployment-specific environment variables
  const deployId = process.env.RENDER_DEPLOY_ID;
  const gitCommit = process.env.GIT_COMMIT_SHA;
  const renderService = process.env.RENDER;
  
  // If we have deployment info, it's likely a manual deployment
  if (deployId || gitCommit) {
    console.log(`🔍 Manual deployment detected: DeployID=${deployId}, GitCommit=${gitCommit}`);
    return true;
  }
  
  // Check if this is the first startup after a deployment
  // (Render sets these on manual deployments)
  if (renderService && (process.env.RENDER_DEPLOY_HOOK || process.env.RENDER_GIT_COMMIT)) {
    console.log(`🔍 Manual deployment detected via Render environment`);
    return true;
  }
  
  console.log(`🔍 Automatic restart detected (no deployment markers)`);
  return false;
}

// Clear both uploads and data on manual deployment
function clearDataOnDeploy() {
  if (isManualDeployment()) {
    try {
      // Clear uploads directory
      if (fs.existsSync(PERSISTENT_UPLOAD_DIR)) {
        const files = fs.readdirSync(PERSISTENT_UPLOAD_DIR);
        files.forEach(file => {
          const filePath = path.join(PERSISTENT_UPLOAD_DIR, file);
          if (fs.statSync(filePath).isFile()) {
            fs.unlinkSync(filePath);
          }
        });
        console.log(`🗑️ Cleared ${files.length} files from uploads directory (manual deployment detected)`);
      }
      
      // Clear data from MongoDB
      if (collection) {
        collection.deleteOne({ type: "app_data" }).then(() => {
          console.log(`🗑️ Cleared all data from MongoDB (manual deployment detected)`);
        }).catch(err => {
          console.error("❌ Failed to clear MongoDB data:", err);
        });
      }
      
      console.log("🔄 Fresh start: All data and uploads cleared for manual deployment");
    } catch (err) {
      console.error("❌ Failed to clear data on deployment:", err);
    }
  }
}

// Default admin can be overridden via env for cloud deployments
const DEFAULT_ADMIN = {
  username: process.env.ADMIN_USER || "Chopraa03",
  password: process.env.ADMIN_PASS || "Manish@2000",
};
// Simple data initialization
function ensureDataFile() {
  try {
    const dataFile = PERSISTENT_DATA_FILE;
    
    if (!fs.existsSync(dataFile)) {
      const base = { users: [], events: [], media: [], notifications: {}, messages: [], admin: DEFAULT_ADMIN };
      fs.writeFileSync(dataFile, JSON.stringify(base, null, 2));
      console.log(`📄 Created data file: ${dataFile}`);
    }
  } catch (err) {
    console.error("Failed to ensure data file:", err);
  }
}

// Initialize the application
async function initializeApp() {
  console.log("🚀 Initializing Campus Event Hub...");
  console.log("=" .repeat(50));
  
  // Enhanced startup logging
  console.log('🚀 Campus Event Hub Backend Starting...');
  console.log(`📁 Data file: ${PERSISTENT_DATA_FILE}`);
  console.log(`📁 Upload dir: ${PERSISTENT_UPLOAD_DIR}`);
  console.log(`📁 Backup dir: ${PERSISTENT_BACKUP_DIR}`);
  console.log(`🔧 Admin: ${DEFAULT_ADMIN.username}`);
  
  // Check deployment type first
  const isManual = isManualDeployment();
  console.log(`📋 Deployment Type: ${isManual ? 'MANUAL DEPLOYMENT' : 'AUTOMATIC RESTART'}`);
  
  // Clear both data and uploads on manual deployment
  clearDataOnDeploy();
  
  // Ensure uploads directory exists
  if (!fs.existsSync(PERSISTENT_UPLOAD_DIR)) {
    fs.mkdirSync(PERSISTENT_UPLOAD_DIR, { recursive: true });
    console.log(`📁 Created uploads directory: ${PERSISTENT_UPLOAD_DIR}`);
  }
  
  // Static file serving setup
  console.log(`📁 Setting up static file serving from: ${PERSISTENT_UPLOAD_DIR}`);
  console.log(`📁 Upload directory exists: ${fs.existsSync(PERSISTENT_UPLOAD_DIR)}`);
  if (fs.existsSync(PERSISTENT_UPLOAD_DIR)) {
    const files = fs.readdirSync(PERSISTENT_UPLOAD_DIR);
    console.log(`📁 Files in upload directory: ${files.length} files`);
    if (files.length > 0) {
      console.log(`📁 Sample files: ${files.slice(0, 3).join(', ')}`);
    }
  }
  
  // Initialize MongoDB connection
  const mongoConnected = await initMongoDB();
  
  // Verify initial data state after MongoDB connection
  try {
    const initialData = await loadData();
    console.log(`📊 Initial data loaded: ${initialData.users?.length || 0} users, ${initialData.events?.length || 0} events, ${initialData.media?.length || 0} media`);
    console.log(`💾 Data file exists: ${fs.existsSync(PERSISTENT_DATA_FILE)}`);
    console.log(`📦 Backup count: ${fs.existsSync(PERSISTENT_BACKUP_DIR) ? fs.readdirSync(PERSISTENT_BACKUP_DIR).filter(f => f.endsWith('.json')).length : 0}`);
  } catch (err) {
    console.error('❌ Failed to load initial data:', err);
  }
  
  if (mongoConnected) {
    console.log("✅ App initialized with MongoDB Atlas (permanent storage)");
    console.log("💾 Data will persist FOREVER across automatic restarts");
    if (isManual) {
      console.log("🔄 Fresh start: All data cleared for manual deployment");
    } else {
      console.log("📊 Existing data preserved (automatic restart)");
    }
  } else {
    console.log("⚠️ App initialized with local storage (temporary)");
  }
  
  console.log("=" .repeat(50));
  console.log("🎯 Ready to serve requests!");
  
  // Start the server AFTER everything is initialized
  app.listen(PORT, () => console.log(`✅ Backend running at http://localhost:${PORT}`));
}

// Start the application
initializeApp().catch(err => {
  console.error("❌ Failed to initialize app:", err);
  process.exit(1);
});

// Helper function to update user last seen
async function updateUserLastSeen(regNumber) {
  try {
    const data = await loadData();
    const user = data.users.find(u => u.regNumber === regNumber);
    if (user) {
      user.lastSeen = new Date().toISOString();
      await saveData(data);
    }
  } catch (err) {
    console.error('Failed to update last seen:', err);
  }
}

// Load data from MongoDB (permanent storage)
async function loadData() {
        const base = { users: [], events: [], media: [], notifications: {}, messages: [], admin: DEFAULT_ADMIN };
  
  if (!collection) {
    console.log("📄 MongoDB not available, using default data");
    return base;
  }
  
  try {
    const result = await collection.findOne({ type: "app_data" });
    if (result && result.data) {
      const data = {
        users: result.data.users || [],
        events: result.data.events || [],
        media: result.data.media || [],
        notifications: result.data.notifications || {},
        messages: result.data.messages || [],
        admin: result.data.admin || DEFAULT_ADMIN
      };
      
      console.log(`📊 Loaded from MongoDB: ${data.users?.length || 0} users, ${data.events?.length || 0} events, ${data.media?.length || 0} media`);
      return data;
    }
  } catch (err) {
    console.error("❌ Failed to load from MongoDB:", err);
  }
  
  return base;
}

// Save data to MongoDB (permanent storage)
async function saveData(data) {
  console.log(`🔍 saveData called - collection exists: ${!!collection}, client exists: ${!!client}`);
  
  if (!collection) {
    console.log("❌ MongoDB not available, cannot save data");
    return;
  }
  
  try {
    // Validate data before saving
    if (!data || typeof data !== 'object') {
      throw new Error('Invalid data structure');
    }
    
    // Ensure required fields exist
    const validatedData = {
      users: Array.isArray(data.users) ? data.users : [],
      events: Array.isArray(data.events) ? data.events : [],
      media: Array.isArray(data.media) ? data.media : [],
      notifications: data.notifications && typeof data.notifications === 'object' ? data.notifications : {},
      messages: Array.isArray(data.messages) ? data.messages : [],
      admin: data.admin || DEFAULT_ADMIN
    };
    
    console.log(`🔍 About to save: ${validatedData.users?.length || 0} users, ${validatedData.events?.length || 0} events, ${validatedData.media?.length || 0} media`);
    
    // Upsert (update or insert) the data
    const result = await collection.updateOne(
      { type: "app_data" },
      { 
        $set: { 
          data: validatedData,
          lastUpdated: new Date(),
          version: "1.0"
        }
      },
      { upsert: true }
    );
    
    console.log(`✅ Data saved to MongoDB: ${validatedData.users?.length || 0} users, ${validatedData.events?.length || 0} events, ${validatedData.media?.length || 0} media`);
    console.log(`🔍 MongoDB result: matched=${result.matchedCount}, modified=${result.modifiedCount}, upserted=${result.upsertedCount}`);
    
  } catch (err) {
    console.error('❌ Failed to save data to MongoDB:', err);
    throw err;
  }
}

// --------- Server-Sent Events (SSE) for live updates ---------
const sseClients = new Set();
app.get('/api/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders && res.flushHeaders();
  const reg = String((req.query.reg || '')).trim();
  const client = { res, reg };
  sseClients.add(client);
  res.write(`event: hello\n` + `data: {"ok":true}\n\n`);
  const ping = setInterval(() => { try { res.write(`event: ping\n` + `data: {"t":${Date.now()}}\n\n`); } catch {} }, 25000);
  req.on('close', () => { clearInterval(ping); sseClients.delete(client); });
});
function broadcast(eventName, data, targetReg) {
  const payload = JSON.stringify(data || {});
  sseClients.forEach(c => {
    if (targetReg && c.reg !== targetReg) return;
    try { c.res.write(`event: ${eventName}\n` + `data: ${payload}\n\n`); } catch {}
  });
}

app.post("/api/signup", async (req, res) => {
  try {
    const data = await loadData();
  const name = String(req.body.name||'');
  const surname = String(req.body.surname||'');
  const age = req.body.age;
  const gender = req.body.gender;
  const email = String(req.body.email||'').trim();
  const phone = String(req.body.phone||'').trim();
  const regNumber = String(req.body.regNumber||'').trim();
  const password = String(req.body.password||'');
  const role = req.body.role;
  if (!name || !surname || !age || !gender || !email || !phone || !regNumber || !password || !role) { return res.status(400).json({ ok: false, error: "All fields are required" }); }
  // Uniqueness validation across all users
  if (data.users.find(u => u.regNumber === regNumber)) { return res.status(400).json({ ok: false, error: "Registration number already exists" }); }
  if (data.users.find(u => (u.email||'').toLowerCase() === String(email).toLowerCase())) { return res.status(400).json({ ok: false, error: "Email already in use" }); }
  if (data.users.find(u => u.phone === phone)) { return res.status(400).json({ ok: false, error: "Phone already in use" }); }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ ok: false, error: "Invalid email format" });
  if (!/^\d{10}$/.test(phone)) return res.status(400).json({ ok: false, error: "Phone must be 10 digits" });
  if (!/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{6,}$/.test(password)) { return res.status(400).json({ ok: false, error: "Password must contain uppercase, lowercase, number and be at least 6 characters long" }); }
  let finalRole = role;
  let organizerStatus = undefined;
  if (role === 'ORGANIZER') {
    // Treat as request; user behaves as student until approved
    finalRole = 'STUDENT';
    organizerStatus = 'PENDING';
  }
  const user = { id: Date.now(), name, surname, age, gender, email, phone, regNumber, password, role: finalRole };
  if (organizerStatus) user.organizerStatus = organizerStatus;
    data.users.push(user); 
    await saveData(data);
  return res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/login", async (req, res) => {
  try {
  const regNumber = String((req.body.regNumber||'')).trim();
  const password = String((req.body.password||''));
    
    const data = await loadData();
  const user = data.users.find(u => String(u.regNumber||'').trim() === regNumber && String(u.password||'') === password);
  if (!user) return res.status(401).json({ ok: false, error: "Invalid credentials" });
    
    // Update last seen on login
    user.lastSeen = new Date().toISOString();
    await saveData(data);
    
  res.json({ ok: true, user });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/api/admin/login", async (req, res) => {
  const data = await loadData();
  const { username, password } = req.body;
  const stored = data.admin || DEFAULT_ADMIN;
  const uIn = String((username||'').trim());
  const pIn = String((password||''));
  const matchStored = String(stored.username||'').toLowerCase() === uIn.toLowerCase() && String(stored.password||'') === pIn;
  const matchDefault = String(DEFAULT_ADMIN.username||'').toLowerCase() === uIn.toLowerCase() && String(DEFAULT_ADMIN.password||'') === pIn;
  if (matchStored || matchDefault) {
    return res.json({ ok: true });
  }
  return res.status(401).json({ ok: false, error: "Invalid admin credentials" });
});

// Admin: reveal current admin username (no password) to help diagnose mismatches
app.get('/api/admin/who', async (req,res)=>{
  try{
    const d = await loadData();
    const stored = d.admin || DEFAULT_ADMIN;
    res.json({ ok:true, username: stored.username || DEFAULT_ADMIN.username });
  }catch{ res.status(500).json({ ok:false }); }
});
app.post("/api/reset-password", async (req, res) => {
  const data = await loadData(); const { regNumber, role, newPassword } = req.body;
  const user = data.users.find(u => u.regNumber === regNumber && u.role === role);
  if (!user) { return res.status(404).json({ ok: false, error: "User not found or role does not match." }); }
  user.password = newPassword; if (!data.notifications) data.notifications = {}; if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: "🔐 Your password has been successfully reset.", time: new Date().toISOString(), read: false });
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  try {
    broadcast('events_changed', { reason: 'ticket_cancelled', eventId: event.id });
    broadcast('tickets_changed', { reason: 'cancelled', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true });
});
app.get("/api/users/:regNumber", async (req, res) => { const data = await loadData(); const user = data.users.find(u => u.regNumber === req.params.regNumber); if (!user) { return res.status(404).json({ ok: false, error: "User not found" }); } const { password, ...userProfile } = user; res.json({ ok: true, user: userProfile }); });
// Admin list endpoints
app.get('/api/admin/users', async (req, res) => { const data = await loadData(); const students = data.users.filter(u => u.role === 'STUDENT'); res.json({ ok: true, users: students }); });
app.get('/api/admin/organizers', async (req, res) => { const data = await loadData(); const orgs = data.users.filter(u => u.role === 'ORGANIZER'); res.json({ ok: true, users: orgs }); });
// Admin: pending organizer requests
app.get('/api/admin/organizers/pending', async (req,res)=>{ const data=await loadData(); const list=(data.users||[]).filter(u=>u.organizerStatus==='PENDING'); res.json({ ok:true, users:list }); });
app.post('/api/admin/organizers/verify', async (req,res)=>{ 
  const data=await loadData(); 
  const { regNumber, decision, reason } = req.body; 
  const u=data.users.find(x=>x.regNumber===regNumber); 
  if(!u) return res.status(404).json({ ok:false, error:'User not found' }); 
  if(u.organizerStatus!=='PENDING') return res.status(400).json({ ok:false, error:'No pending request' }); 
  if(decision==='approve'){ 
    u.organizerStatus='APPROVED'; 
    u.role='ORGANIZER'; 
    if(!data.notifications) data.notifications={}; 
    if(!data.notifications[regNumber]) data.notifications[regNumber]=[]; 
    data.notifications[regNumber].unshift({ msg:"✅ Your organizer request has been approved. Organizer dashboard unlocked.", time:new Date().toISOString(), read:false }); 
    await saveData(data); 
    return res.json({ ok:true, status:'approved' }); 
  } else if(decision==='reject'){ 
    u.organizerStatus='REJECTED'; 
    if(!data.notifications) data.notifications={}; 
    if(!data.notifications[regNumber]) data.notifications[regNumber]=[]; 
    data.notifications[regNumber].unshift({ msg:`❌ Your organizer request was rejected.${reason? ' Reason: '+reason:''}`, time:new Date().toISOString(), read:false }); 
    await saveData(data); 
    return res.json({ ok:true, status:'rejected' }); 
  } else { 
    return res.status(400).json({ ok:false, error:'Invalid decision' }); 
  } 
});
// Admin remove organizer ownership -> set role to STUDENT
app.post('/api/admin/organizers/remove', async (req, res) => {
  const data = await loadData();
  const { regNumber } = req.body;
  const u = data.users.find(x=>x.regNumber===regNumber);
  if(!u) return res.status(404).json({ ok:false, error:'User not found' });
  u.role='STUDENT';
  if(!data.notifications) data.notifications = {};
  if(!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: "⚠️ Your organizer role has been removed by admin. You now have student access.", time: new Date().toISOString(), read: false });
  await saveData(data);
  res.json({ ok:true });
});
// Admin delete student account (hard delete)
app.post('/api/admin/users/delete', async (req, res) => {
  const data = await loadData(); const { regNumber } = req.body;
  const idx = data.users.findIndex(x=>x.regNumber===regNumber);
  if(idx===-1) return res.status(404).json({ ok:false, error:'User not found' });
  // Remove bookings, waitlist, volunteer entries
  data.events.forEach(event => {
    const before = (event.bookings||[]).length;
    event.bookings = (event.bookings||[]).filter(b=>b.regNumber!==regNumber);
    event.taken = Math.max(0, (event.taken||0) - (before - event.bookings.length));
    event.bookings.sort((a,b)=>a.seat-b.seat).forEach((b,i)=>b.seat=i+1);
    event.waitlist = Array.isArray(event.waitlist) ? event.waitlist.filter(w=>w.regNumber!==regNumber) : [];
    event.volunteers = Array.isArray(event.volunteers) ? event.volunteers.filter(v=>v.regNumber!==regNumber) : [];
    event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests.filter(r=>r.regNumber!==regNumber) : [];
  });
  // If organizer, delete their events and media
  const evIds = data.events.filter(e=>e.creatorRegNumber===regNumber).map(e=>e.id);
  if(evIds.length){
    const mediaToDelete = data.media.filter(m=>evIds.includes(m.eventId));
    mediaToDelete.forEach(m=>{ try{ const fp=path.join(__dirname, m.url); if(fs.existsSync(fp)) fs.unlinkSync(fp);}catch{} });
    data.media = data.media.filter(m=>!evIds.includes(m.eventId));
    data.events = data.events.filter(e=>!evIds.includes(e.id));
  }
  // Messages and notifications
  data.messages = (data.messages||[]).filter(m=>m.fromReg!==regNumber && m.toReg!==regNumber);
  if(data.notifications && data.notifications[regNumber]) delete data.notifications[regNumber];
  // Finally remove user
  data.users.splice(idx,1);
  await saveData(data); 
  res.json({ ok:true });
});
// Admin events list
app.get('/api/admin/events', async (req, res) => { const data = await loadData(); res.json({ ok:true, events: data.events }); });
// Admin delete event with reason
app.post('/api/admin/events/delete', async (req,res)=>{ 
  const data = await loadData(); 
  const { eventId, reason } = req.body; 
  const i = data.events.findIndex(e=>e.id===Number(eventId)); 
  if(i===-1) return res.status(404).json({ ok:false, error:'Event not found' }); 
  const ev = data.events[i]; 
  // delete media files
  const mediaToDelete = data.media.filter(m=>m.eventId===ev.id);
  mediaToDelete.forEach(m=>{ try{ const fp = path.join(__dirname, m.url); if(fs.existsSync(fp)) fs.unlinkSync(fp);}catch{} });
  data.media = data.media.filter(m=>m.eventId!==ev.id);
  // notify organizer
  if(!data.notifications) data.notifications={}; if(!data.notifications[ev.creatorRegNumber]) data.notifications[ev.creatorRegNumber]=[];
  data.notifications[ev.creatorRegNumber].unshift({ msg:`❌ Your event '${ev.title}' was deleted by admin.${reason? ' Reason: '+reason:''}`, time:new Date().toISOString(), read:false });
  data.events.splice(i,1); 
  await saveData(data); 
  res.json({ ok:true }); 
});
// Admin media list per event
app.get('/api/admin/media/:eventId', async (req,res)=>{ const data=await loadData(); const id=Number(req.params.eventId); res.json({ ok:true, media: data.media.filter(m=>m.eventId===id) }); });
// Admin delete media item
app.post('/api/admin/media/delete', async (req,res)=>{ 
  const data=await loadData(); 
  const { mediaId } = req.body; 
  const i = data.media.findIndex(m=>m.id===Number(mediaId)); 
  if(i===-1) return res.status(404).json({ ok:false, error:'Media not found' }); 
  const m = data.media[i]; 
  const ev = data.events.find(e=>e.id===m.eventId);
  try{ const fp=path.join(__dirname, m.url); if(fs.existsSync(fp)) fs.unlinkSync(fp);}catch{};
  data.media.splice(i,1);
  if(ev){ if(!data.notifications) data.notifications={}; if(!data.notifications[ev.creatorRegNumber]) data.notifications[ev.creatorRegNumber]=[]; data.notifications[ev.creatorRegNumber].unshift({ msg:`🗑️ Admin deleted a media item from '${ev.title}'.`, time:new Date().toISOString(), read:false }); }
  await saveData(data); 
  res.json({ ok:true }); 
});

// Admin change credentials
app.post('/api/admin/credentials', async (req,res)=>{ 
  const data=await loadData(); 
  const { username, password } = req.body; 
  if(!username || !password){ return res.status(400).json({ ok:false, error:'Missing fields' }); } 
  data.admin = { username, password }; 
  await saveData(data); 
  res.json({ ok:true }); 
});

// Admin stats & active users
app.get('/api/admin/stats', async (req,res)=>{ const data=await loadData(); const totalUsers=(data.users||[]).length; const totalEvents=(data.events||[]).length; const totalOrganizers=(data.users||[]).filter(u=>u.role==='ORGANIZER').length; const activeCut=Date.now()-5*60*1000; const activeUsers=(data.users||[]).filter(u=>u.lastSeen && (new Date(u.lastSeen).getTime()>activeCut)).length; res.json({ ok:true, totalUsers, totalEvents, totalOrganizers, activeUsers }); });

// Track last seen on notifications fetch
app.get("/api/notifications/:regNumber", async (req, res) => { const data = await loadData(); const reg = req.params.regNumber; const u=data.users.find(x=>x.regNumber===reg); if(u){ u.lastSeen=new Date().toISOString(); await saveData(data); } res.json({ ok: true, notifications: (data.notifications && data.notifications[reg]) || [] }); });

// Admin clear-all (dangerous): wipes users, events, media, notifications, messages, and uploads folder
app.post('/api/admin/clear-all', async (req,res)=>{
  const base = { users: [], events: [], media: [], notifications: {}, messages: [], admin: DEFAULT_ADMIN };
  // wipe uploads directory files
  try { if (fs.existsSync(UPLOAD_DIR)) { fs.readdirSync(UPLOAD_DIR).forEach(f=>{ try{ fs.unlinkSync(path.join(UPLOAD_DIR,f)); }catch{} }); } } catch{}
  await saveData(base);
  res.json({ ok:true });
});

app.post("/api/events", async (req, res) => {
  const data = await loadData();
  const { title, date, time, venue, capacity, duration, category, creatorRegNumber, volunteers, resources } = req.body;
  if (!title || !date || !time || !venue || !capacity || !duration || !category) { return res.status(400).json({ ok: false, error: "All fields are required to create an event." }); }
  const eventDateTime = new Date(`${date}T${time}`);
  if (eventDateTime < new Date()) { return res.status(400).json({ ok: false, error: "Event date and time must be in the future." }); }
  
  const newStart = eventDateTime;
  const newEnd = new Date(newStart.getTime() + Number(duration) * 60000);
  for (const existingEvent of data.events) {
    if (existingEvent.date === date && existingEvent.venue === venue) {
        const existingStart = new Date(`${existingEvent.date}T${existingEvent.time}`);
        const existingEnd = new Date(existingStart.getTime() + (existingEvent.duration || 0) * 60000);
        if (newStart < existingEnd && newEnd > existingStart) {
            return res.status(400).json({ ok: false, error: "Slot is booked! This venue is already booked for that time and date." });
        }
    }
  }
  // Resource conflict checks (if provided)
  const selectedResources = Array.isArray(resources) ? resources.filter(r => typeof r === 'string' && r.trim()).map(r => r.trim()) : [];
  if (selectedResources.length > 0) {
    for (const existingEvent of data.events) {
      const existingStart = new Date(`${existingEvent.date}T${existingEvent.time}`);
      const existingEnd = new Date(existingStart.getTime() + (existingEvent.duration || 0) * 60000);
      const overlaps = newStart < existingEnd && newEnd > existingStart;
      if (!overlaps) continue;
      const existingResources = Array.isArray(existingEvent.resources) ? existingEvent.resources : [];
      const conflict = selectedResources.find(r => existingResources.includes(r));
      if (conflict) {
        return res.status(400).json({ ok: false, error: `Resource conflict: '${conflict}' is already booked for another event in this time window.` });
      }
    }
  }
  // Ignore volunteers during creation; organiser can request later
  const newEvent = { id: Date.now(), title, date, time, venue, category, capacity: Number(capacity), duration: Number(duration), taken: 0, bookings: [], waitlist: [], volunteers: [], volunteerRequests: [], resources: selectedResources, creatorRegNumber, liveNotificationSent: false };
  data.events.push(newEvent);
  if (!data.notifications) data.notifications = {};
  const notificationMsg = `📢 New Event: ${title} on ${date}`;
  data.users.forEach(u => {
    if (!data.notifications[u.regNumber]) data.notifications[u.regNumber] = [];
    data.notifications[u.regNumber].unshift({ msg: notificationMsg, time: new Date().toISOString(), read: false });
  });
  // No volunteer notifications at creation time
  await saveData(data);
  
  // Update organizer's last seen
  await updateUserLastSeen(creatorRegNumber);
  
  try { broadcast('events_changed', { reason: 'created', eventId: newEvent.id }); } catch {}
  res.json({ ok: true, event: newEvent });
});

app.put("/api/events/:id", async (req, res) => {
  const data = await loadData(); const id = parseInt(req.params.id);
  const event = data.events.find(e => e.id === id);
  if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
  const { title, date, time, venue, capacity, duration, category, regNumber } = req.body;
  if (event.creatorRegNumber !== regNumber) { return res.status(403).json({ ok: false, error: "You can only edit your own events." }); }
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) { return res.status(403).json({ ok: false, error: "Cannot edit an event that is live or has passed." }); }
  // Prevent reducing capacity below already booked seats
  const nextCapacity = Number(capacity);
  if (!Number.isFinite(nextCapacity) || nextCapacity <= 0) {
    return res.status(400).json({ ok: false, error: "Capacity must be a positive number." });
  }
  if (nextCapacity < (event.taken || 0)) {
    return res.status(400).json({ ok: false, error: `${event.taken} seats are booked, please set capacity more than booked tickets.` });
  }
  const newEventStartTime = new Date(`${date}T${time}`);
  if (newEventStartTime < new Date()) { return res.status(400).json({ ok: false, error: "Event date and time must be in the future." }); }
  
  const newStart = newEventStartTime;
  const newEnd = new Date(newStart.getTime() + Number(duration) * 60000);
  for (const existingEvent of data.events) {
    if (existingEvent.id !== id && existingEvent.date === date && existingEvent.venue === venue) {
        const existingStart = new Date(`${existingEvent.date}T${existingEvent.time}`);
        const existingEnd = new Date(existingStart.getTime() + (existingEvent.duration || 0) * 60000);
        if (newStart < existingEnd && newEnd > existingStart) {
            return res.status(400).json({ ok: false, error: "Slot is booked! This venue is already booked for that time and date." });
        }
    }
  }
  
  const oldCapacity = event.capacity;
  event.title = title; event.date = date; event.time = time; event.venue = venue; event.capacity = Number(capacity); event.duration = Number(duration); event.category = category;
  
  // Auto-book waitlisted users if capacity increased
  if (Number(capacity) > oldCapacity && Array.isArray(event.waitlist) && event.waitlist.length > 0) {
    const additionalSeats = Number(capacity) - oldCapacity;
    const availableSeats = Number(capacity) - (event.taken || 0);
    const seatsToAutoBook = Math.min(additionalSeats, availableSeats, event.waitlist.length);
    
    console.log(`Capacity increased from ${oldCapacity} to ${Number(capacity)}. Auto-booking ${seatsToAutoBook} users from waitlist.`);
    
    const usersToAutoBook = event.waitlist.splice(0, seatsToAutoBook);
    
    usersToAutoBook.forEach(waitlistEntry => {
      const user = data.users.find(u => u.regNumber === waitlistEntry.regNumber);
      if (user) {
        event.taken += 1;
        const seatNumber = event.taken;
        const roleLetter = user.role === "ORGANIZER" ? "O" : "S";
        const booking = { regNumber: user.regNumber, name: user.name, seat: seatNumber, role: roleLetter, eventId: event.id, bookedAt: new Date().toISOString() };
        event.bookings.push(booking);
        
        console.log(`Auto-booked user ${user.regNumber} for event ${event.id} with seat ${seatNumber}`);
        
        // Send confirmation notification
        if (!data.notifications) data.notifications = {};
        if (!data.notifications[user.regNumber]) data.notifications[user.regNumber] = [];
        data.notifications[user.regNumber].unshift({ 
          msg: `🎉 Great news! You've been auto-booked for '${event.title}' due to increased capacity. Your seat: ${seatNumber}`, 
          time: new Date().toISOString(), 
          read: false 
        });
      }
    });
  }
  
  if (!data.notifications) data.notifications = {};
  const notificationMsg = `✏️ Event Updated: Details for '${event.title}' have changed.`;
  event.bookings.forEach(booking => {
    if (!data.notifications[booking.regNumber]) data.notifications[booking.regNumber] = [];
    data.notifications[booking.regNumber].unshift({ msg: notificationMsg, time: new Date().toISOString(), read: false });
  });
  await saveData(data);
  
  // Update organizer's last seen
  await updateUserLastSeen(regNumber);
  
  try { broadcast('events_changed', { reason: 'updated', eventId: event.id }); } catch {}
  res.json({ ok: true, event });
});

app.delete("/api/events/:id", async (req, res) => {
  const data = await loadData(); const id = parseInt(req.params.id);
  const eventIndex = data.events.findIndex(e => e.id === id);
  if (eventIndex === -1) return res.status(404).json({ ok: false, error: "Event not found" });
  const event = data.events[eventIndex];
  const { regNumber } = req.body;
  if (event.creatorRegNumber !== regNumber) { return res.status(403).json({ ok: false, error: "You can only delete your own events." }); }
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) { return res.status(403).json({ ok: false, error: "Cannot delete an event that is live or has passed." }); }
  const mediaToDelete = data.media.filter(m => m.eventId === id);
  mediaToDelete.forEach(media => { try { const filePath = path.join(__dirname, media.url); if (fs.existsSync(filePath)) { fs.unlinkSync(filePath); } } catch (err) { console.error("Failed to delete media file:", err); } });
  data.media = data.media.filter(m => m.eventId !== id);
  if (!data.notifications) data.notifications = {};
  const notificationMsg = `❌ Event Cancelled: '${event.title}' has been cancelled.`;
  event.bookings.forEach(booking => {
    if (!data.notifications[booking.regNumber]) data.notifications[booking.regNumber] = [];
    data.notifications[booking.regNumber].unshift({ msg: notificationMsg, time: new Date().toISOString(), read: false });
  });
  data.events.splice(eventIndex, 1);
  await saveData(data);
  
  // Update organizer's last seen
  await updateUserLastSeen(regNumber);
  
  try { broadcast('events_changed', { reason: 'deleted', eventId: id }); } catch {}
  res.json({ ok: true, message: "Event and associated media deleted successfully" });
});

app.get("/api/events", async (req, res) => {
  const data = await loadData(); let dataWasModified = false;
  const now = new Date();
  
  data.events.forEach(event => {
    const startTime = new Date(`${event.date}T${event.time}`);
    const endTime = new Date(startTime.getTime() + (event.duration || 0) * 60000);
    if (startTime <= now && now < endTime && !event.liveNotificationSent) {
      const notificationMsg = `🔥 Event Live: '${event.title}' is now live!`;
      data.users.forEach(u => {
        if (!data.notifications[u.regNumber]) data.notifications[u.regNumber] = [];
        data.notifications[u.regNumber].unshift({ msg: notificationMsg, time: new Date().toISOString(), read: false });
      });
      event.liveNotificationSent = true;
      dataWasModified = true;
    }
    const timeUntilStart = startTime - now;
    const reminders = [
        { time: 60, sentFlag: 'sent60' }, { time: 45, sentFlag: 'sent45' },
        { time: 25, sentFlag: 'sent25' }, { time: 10, sentFlag: 'sent10' }
    ];
    reminders.forEach(reminder => {
        if (timeUntilStart > 0 && timeUntilStart <= reminder.time * 60000 && !event[reminder.sentFlag]) {
             const notificationMsg = `⏳ Reminder: '${event.title}' starts in about ${reminder.time} minutes!`;
             event.bookings.forEach(booking => {
                if (!data.notifications[booking.regNumber]) data.notifications[booking.regNumber] = [];
                data.notifications[booking.regNumber].unshift({ msg: notificationMsg, time: new Date().toISOString(), read: false });
             });
             event[reminder.sentFlag] = true;
             dataWasModified = true;
        }
    });
  });
  // Normalize volunteer IDs to V01 format if needed
  data.events.forEach(event => {
    if (Array.isArray(event.volunteers) && event.volunteers.length > 0) {
      const needsNormalize = event.volunteers.some(v => !/^V\d{2}$/.test(String(v.volunteerId||'')));
      if (needsNormalize) {
        event.volunteers.forEach((v, i) => { v.volunteerId = `V${String(i+1).padStart(2,'0')}`; });
        dataWasModified = true;
      }
    }
  });
  if (dataWasModified) { await saveData(data); }
  const augmentedEvents = data.events.map(event => {
      const creator = data.users.find(u => u.regNumber === event.creatorRegNumber);
      const eventMedia = data.media.filter(m => m.eventId === event.id);
      return { ...event, creatorName: creator ? `${creator.name} ${creator.surname}` : 'Unknown Organizer', creatorGender: creator ? creator.gender : 'Other', media: eventMedia, volunteerRequests: event.volunteerRequests || [], resources: Array.isArray(event.resources) ? event.resources : [] };
  });
  res.json({ ok: true, events: augmentedEvents });
});

app.post("/api/tickets", async (req, res) => {
  const data = await loadData(); const { eventId, regNumber, via } = req.body;
  const event = data.events.find(e => e.id === eventId); const user = data.users.find(u => u.regNumber === regNumber);
  if (!event || !user) return res.status(404).json({ ok: false, error: "Event or user not found" });
  if (event.creatorRegNumber === regNumber) { return res.status(400).json({ ok: false, error: "You cannot book a ticket for your own event." }); }
  // Block booking if the user is a volunteer for this event
  if (Array.isArray(event.volunteers) && event.volunteers.find(v => v.regNumber === regNumber)) {
    return res.status(400).json({ ok: false, error: "Volunteers cannot book tickets for this event." });
  }
  if(event.bookings.find(b => b.regNumber === regNumber)){ return res.status(400).json({ ok: false, error: "Ticket already booked for this event" }); }
  if (!data.notifications) data.notifications = {};
  if (event.taken >= event.capacity) {
    if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
    data.notifications[regNumber].unshift({ msg: `⚠️ Event ${event.title} is full.`, time: new Date().toISOString(), read: false});
    await saveData(data); return res.status(400).json({ ok: false, error: "Venue is full" });
  }
  event.taken += 1; const seatNumber = event.taken; const roleLetter = user.role === "ORGANIZER" ? "O" : "S";
  const booking = { regNumber, name: user.name, seat: seatNumber, role: roleLetter, eventId: event.id, bookedAt: new Date().toISOString(), via: (via === 'qr' ? 'qr' : 'app') };
  event.bookings.push(booking);
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  const notifMsg = booking.via === 'qr' ? `🎟️ You booked a ticket via QR code for ${event.title}` : `🎟️ You booked a ticket for ${event.title}`;
  data.notifications[regNumber].unshift({ msg: notifMsg, time: new Date().toISOString(), read: false });
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  try {
    broadcast('events_changed', { reason: 'ticket_booked', eventId: event.id });
    broadcast('tickets_changed', { reason: 'booked', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true, booking });
});
app.delete("/api/tickets", async (req, res) => {
  const data = await loadData(); const { eventId, regNumber } = req.body;
  const event = data.events.find(e => e.id === eventId);
  if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) { return res.status(403).json({ ok: false, error: "Cannot cancel a ticket for a live or past event." }); }
  const bookingIndex = event.bookings.findIndex(b => b.regNumber === regNumber);
  if (bookingIndex === -1) return res.status(404).json({ ok: false, error: "Booking not found" });
  event.bookings.splice(bookingIndex, 1); event.taken -= 1;
  event.bookings.sort((a, b) => a.seat - b.seat).forEach((booking, index) => { booking.seat = index + 1; });
  if (!data.notifications) data.notifications = {}; if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `✅ Your ticket for '${event.title}' has been cancelled.`, time: new Date().toISOString(), read: false });
  // If there is a waitlist, auto-book the first user in line
  if (Array.isArray(event.waitlist) && event.waitlist.length > 0) {
    const next = event.waitlist.shift();
    const user = data.users.find(u => u.regNumber === next.regNumber);
    if (user) {
      event.taken += 1; const seatNumber = event.taken; const roleLetter = user.role === "ORGANIZER" ? "O" : "S";
      const booking = { regNumber: user.regNumber, name: user.name, seat: seatNumber, role: roleLetter, eventId: event.id, bookedAt: new Date().toISOString() };
      event.bookings.push(booking);
      if (!data.notifications[user.regNumber]) data.notifications[user.regNumber] = [];
      data.notifications[user.regNumber].unshift({ msg: `✅ A seat opened up for '${event.title}'. You have been auto-booked from the waitlist.`, time: new Date().toISOString(), read: false });
    }
  }
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  try {
    broadcast('events_changed', { reason: 'ticket_cancelled', eventId: event.id });
    broadcast('tickets_changed', { reason: 'cancelled', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true });
});

// Organizer cancels a specific user's ticket for an event
app.post("/api/tickets/admin-cancel", async (req, res) => {
  const data = await loadData();
  const { eventId, targetRegNumber, organizerRegNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
  if (event.creatorRegNumber !== organizerRegNumber) {
    return res.status(403).json({ ok: false, error: "Only the organizer can cancel bookings for this event." });
  }
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) return res.status(403).json({ ok: false, error: "Cannot cancel bookings for a live or past event." });
  const bookingIndex = event.bookings.findIndex(b => b.regNumber === targetRegNumber);
  if (bookingIndex === -1) return res.status(404).json({ ok: false, error: "Booking not found" });

  event.bookings.splice(bookingIndex, 1);
  event.taken = Math.max(0, event.taken - 1);
  event.bookings.sort((a, b) => a.seat - b.seat).forEach((booking, index) => { booking.seat = index + 1; });

  if (!data.notifications) data.notifications = {};
  if (!data.notifications[targetRegNumber]) data.notifications[targetRegNumber] = [];
  data.notifications[targetRegNumber].unshift({ msg: `❌ Your ticket for '${event.title}' was cancelled by the organizer.`, time: new Date().toISOString(), read: false });

  // Auto-book next from waitlist if available
  if (Array.isArray(event.waitlist) && event.waitlist.length > 0) {
    const next = event.waitlist.shift();
    const user = data.users.find(u => u.regNumber === next.regNumber);
    if (user) {
      event.taken += 1; const seatNumber = event.taken; const roleLetter = user.role === "ORGANIZER" ? "O" : "S";
      const booking = { regNumber: user.regNumber, name: user.name, seat: seatNumber, role: roleLetter, eventId: event.id, bookedAt: new Date().toISOString() };
      event.bookings.push(booking);
      if (!data.notifications[user.regNumber]) data.notifications[user.regNumber] = [];
      data.notifications[user.regNumber].unshift({ msg: `✅ A seat opened up for '${event.title}'. You have been auto-booked from the waitlist.`, time: new Date().toISOString(), read: false });
    }
  }

  await saveData(data);
  try {
    broadcast('events_changed', { reason: 'ticket_cancelled_by_organizer', eventId: event.id });
    broadcast('tickets_changed', { reason: 'cancelled_by_organizer', eventId: event.id }, targetRegNumber);
  } catch {}
  res.json({ ok: true });
});
app.get("/api/tickets/:regNumber", async (req, res) => {
  const data = await loadData(); const reg = req.params.regNumber; let myTickets = [];
  data.events.forEach(event => {
    // Booked tickets for this user
    event.bookings.forEach(b => {
      if (b.regNumber === reg) {
        myTickets.push({
          eventId: event.id,
          eventTitle: event.title,
          venue: event.venue,
          date: event.date,
          time: event.time,
          seat: b.seat,
          role: b.role,
          category: event.category,
          ticketId: (b.name || '').substring(0,3).toLowerCase() + reg,
          waiting: false,
          via: b.via || 'app',
          bookedAt: b.bookedAt
        });
      }
    });
    // Waiting tickets for this user
    (event.waitlist || []).forEach((w, idx) => {
      if (w.regNumber === reg) {
        myTickets.push({
          eventId: event.id,
          eventTitle: event.title,
          venue: event.venue,
          date: event.date,
          time: event.time,
          seat: null,
          role: 'S',
          category: event.category,
          ticketId: `WAIT-${reg}`,
          waiting: true,
          waitId: w.id || null,
          position: idx + 1
        });
      }
    });
  });
  res.json({ ok: true, tickets: myTickets });
});

// ---------- Waitlist Endpoints ----------
app.post("/api/waitlist", async (req, res) => {
  const data = await loadData();
  const { eventId, regNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  const user = data.users.find(u => u.regNumber === regNumber);
  if (!event || !user) return res.status(404).json({ ok: false, error: "Event or user not found" });
  if (event.creatorRegNumber === regNumber) return res.status(400).json({ ok: false, error: "Organizer cannot join waitlist for own event." });
  if (event.bookings.find(b => b.regNumber === regNumber)) return res.status(400).json({ ok: false, error: "You already have a booking for this event." });
  event.waitlist = Array.isArray(event.waitlist) ? event.waitlist : [];
  if (event.waitlist.find(w => w.regNumber === regNumber)) return res.status(400).json({ ok: false, error: "Already on waitlist." });
  event.waitlist.push({ id: Date.now(), regNumber, time: new Date().toISOString() });
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `📝 You joined the waitlist for '${event.title}'. We'll auto-book if a seat opens.`, time: new Date().toISOString(), read: false });
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  try {
    broadcast('events_changed', { reason: 'waitlist_joined', eventId: event.id });
    broadcast('tickets_changed', { reason: 'waitlist_joined', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true });
});

// Leave waitlist
app.post("/api/waitlist/leave", async (req, res) => {
  const data = await loadData();
  const { eventId, regNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  const user = data.users.find(u => u.regNumber === regNumber);
  if (!event || !user) return res.status(404).json({ ok: false, error: "Event or user not found" });
  
  event.waitlist = Array.isArray(event.waitlist) ? event.waitlist : [];
  const waitlistIndex = event.waitlist.findIndex(w => w.regNumber === regNumber);
  if (waitlistIndex === -1) return res.status(400).json({ ok: false, error: "Not on waitlist for this event." });
  
  event.waitlist.splice(waitlistIndex, 1);
  
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `📝 You left the waitlist for '${event.title}'.`, time: new Date().toISOString(), read: false });
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  try {
    broadcast('events_changed', { reason: 'waitlist_left', eventId: event.id });
    broadcast('tickets_changed', { reason: 'waitlist_left', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true });
});

// ---------- Volunteer Endpoints ----------
// List volunteers for an event (organizer only)
app.get('/api/volunteers/:eventId', async (req, res) => {
  const data = await loadData();
  const { eventId } = req.params;
  const { organizerReg } = req.query;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  if (!organizerReg || event.creatorRegNumber !== organizerReg) {
    return res.status(403).json({ ok: false, error: 'Only the organizer can view volunteers.' });
  }
  const volunteersAccepted = (event.volunteers || []).map(v => {
    const u = data.users.find(u => u.regNumber === v.regNumber);
    const firstName = u ? (u.name || '').trim() : (v.name || v.regNumber);
    return { regNumber: v.regNumber, name: firstName, volunteerId: v.volunteerId, role: v.role, status: 'accepted' };
  });
  const acceptedSet = new Set(volunteersAccepted.map(v => `${v.regNumber}|${String(v.role||'')}`));
  const requests = (event.volunteerRequests || [])
    .filter(r => String(r.status||'pending').toLowerCase() === 'pending')
    .filter(r => !acceptedSet.has(`${r.regNumber}|${String(r.role||'')}`))
    .map(r => {
      const u = data.users.find(u => u.regNumber === r.regNumber);
      const firstName = u ? (u.name || '').trim() : r.regNumber;
      return { regNumber: r.regNumber, name: firstName, role: r.role, status: r.status };
    });
  res.json({ ok: true, volunteers: [...volunteersAccepted, ...requests] });
});

// Add a volunteer (organizer only)
app.post('/api/volunteers/add', async (req, res) => {
  const data = await loadData();
  const { eventId, organizerReg, regNumber, role } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  if (event.creatorRegNumber !== organizerReg) {
    return res.status(403).json({ ok: false, error: 'Only the organizer can add volunteers.' });
  }
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) return res.status(403).json({ ok: false, error: 'Cannot add volunteers for past events.' });
  const user = data.users.find(u => u.regNumber === regNumber);
  if (!user) return res.status(404).json({ ok: false, error: 'User not found' });
  if (regNumber === event.creatorRegNumber) return res.status(400).json({ ok: false, error: 'Organizer cannot be a volunteer.' });
  if (regNumber === organizerReg) return res.status(400).json({ ok: false, error: 'Organizer cannot be a volunteer.' });
  event.volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
  event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests : [];
  if (event.volunteers.find(v => v.regNumber === regNumber)) {
    return res.status(400).json({ ok: false, error: 'User is already a volunteer for this event.' });
  }
  if (event.volunteerRequests.find(r => r.regNumber === regNumber && r.status === 'pending')) {
    return res.status(400).json({ ok: false, error: 'There is already a pending request for this user.' });
  }
  const roleName = String(role || '').trim();
  if (!roleName) return res.status(400).json({ ok: false, error: 'Role is required.' });
  if (event.volunteers.some(v => String(v.role||'') === roleName)) {
    return res.status(400).json({ ok: false, error: 'This role is already assigned to another volunteer.' });
  }
  if (event.volunteerRequests.some(r => String(r.role||'') === roleName && r.status === 'pending')) {
    return res.status(400).json({ ok: false, error: 'This role already has a pending request.' });
  }
  const request = { id: Date.now(), regNumber, role: roleName, status: 'pending', requestedAt: new Date().toISOString() };
  event.volunteerRequests.push(request);
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `🤝 Organizer invited you to volunteer for '${event.title}' as '${roleName}'.`, time: new Date().toISOString(), read: false, type: 'volunteer_request', eventId: event.id, role: roleName });
  await saveData(data);
  
  // Update organizer's last seen
  await updateUserLastSeen(organizerReg);
  
  res.json({ ok: true, request });
});

// Remove a volunteer (organizer only)
app.post('/api/volunteers/remove', async (req, res) => {
  const data = await loadData();
  const { eventId, organizerReg, regNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  if (event.creatorRegNumber !== organizerReg) {
    return res.status(403).json({ ok: false, error: 'Only the organizer can remove volunteers.' });
  }
  event.volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
  const idx = event.volunteers.findIndex(v => v.regNumber === regNumber);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'Volunteer not found on this event.' });
  const removed = event.volunteers.splice(idx, 1)[0];
  // Re-number volunteer IDs to keep them compact (optional)
  event.volunteers.forEach((v, i) => { v.volunteerId = `V${String(i+1).padStart(2,'0')}`; });
  // Also remove any pending volunteer request entries for this user for this event
  event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests.filter(r => r.regNumber !== regNumber) : [];
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `❌ Your volunteer role for '${event.title}' has been cancelled.`, time: new Date().toISOString(), read: false });
  await saveData(data);
  
  // Update organizer's last seen
  await updateUserLastSeen(organizerReg);
  
  try { broadcast('events_changed', { reason: 'volunteer_removed', eventId: event.id }); } catch {}
  res.json({ ok: true, removed });
});

// User responds to a volunteer request (accept/reject)
app.post('/api/volunteers/respond', async (req, res) => {
  const data = await loadData();
  const { eventId, regNumber, decision } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests : [];
  const reqIdx = event.volunteerRequests.findIndex(r => r.regNumber === regNumber && r.status === 'pending');
  if (reqIdx === -1) return res.status(404).json({ ok: false, error: 'No pending request found' });
  const vreq = event.volunteerRequests[reqIdx];
  const eventStartTime = new Date(`${event.date}T${event.time}`);
  if (eventStartTime < new Date()) return res.status(403).json({ ok: false, error: 'This event has already started or passed.' });
  if (decision === 'accept') {
    // Ensure role still free
    event.volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
    if (event.volunteers.some(v => String(v.role||'') === vreq.role)) {
      vreq.status = 'rejected';
      await saveData(data);
      return res.status(400).json({ ok: false, error: 'Role already assigned to someone else.' });
    }
    const user = data.users.find(u => u.regNumber === regNumber);
    const nextIdx = event.volunteers.length + 1;
    const volunteer = { regNumber, name: user ? user.name : regNumber, volunteerId: `V${String(nextIdx).padStart(2,'0')}`, role: vreq.role };
    event.volunteers.push(volunteer);
    vreq.status = 'accepted';
    // Remove existing ticket and waitlist, volunteers don't need tickets
    try{
      event.bookings = Array.isArray(event.bookings) ? event.bookings : [];
      const before = event.bookings.length;
      event.bookings = event.bookings.filter(b => b.regNumber !== regNumber);
      const removed = before - event.bookings.length;
      if(removed>0){
        event.taken = Math.max(0, (event.taken||0) - removed);
        event.bookings.sort((a,b)=>a.seat-b.seat).forEach((b,i)=> b.seat=i+1);
        if(!data.notifications) data.notifications={};
        if(!data.notifications[regNumber]) data.notifications[regNumber]=[];
        data.notifications[regNumber].unshift({ msg: `🎟️ Your ticket for '${event.title}' was removed as you are now a volunteer.`, time:new Date().toISOString(), read:false });
        
        // Auto-book someone from waiting list if seats are available
        event.waitlist = Array.isArray(event.waitlist) ? event.waitlist : [];
        if (event.waitlist.length > 0 && event.taken < event.capacity) {
          const availableSeats = event.capacity - event.taken;
          const seatsToAutoBook = Math.min(availableSeats, event.waitlist.length);
          
          console.log(`Volunteer freed ${removed} seat(s). Auto-booking ${seatsToAutoBook} users from waitlist.`);
          
          const usersToAutoBook = event.waitlist.splice(0, seatsToAutoBook);
          
          usersToAutoBook.forEach(waitlistEntry => {
            const waitlistUser = data.users.find(u => u.regNumber === waitlistEntry.regNumber);
            if (waitlistUser) {
              event.taken += 1;
              const seatNumber = event.taken;
              const roleLetter = waitlistUser.role === "ORGANIZER" ? "O" : "S";
              const booking = { regNumber: waitlistUser.regNumber, name: waitlistUser.name, seat: seatNumber, role: roleLetter, eventId: event.id, bookedAt: new Date().toISOString() };
              event.bookings.push(booking);
              
              console.log(`Auto-booked user ${waitlistUser.regNumber} for event ${event.id} with seat ${seatNumber}`);
              
              // Send confirmation notification
              if (!data.notifications[waitlistUser.regNumber]) data.notifications[waitlistUser.regNumber] = [];
              data.notifications[waitlistUser.regNumber].unshift({ 
                msg: `🎉 Great news! You've been auto-booked for '${event.title}' due to a volunteer freeing up space. Your seat: ${seatNumber}`, 
                time: new Date().toISOString(), 
                read: false 
              });
            }
          });
        }
      }
      event.waitlist = Array.isArray(event.waitlist) ? event.waitlist.filter(w => w.regNumber !== regNumber) : [];
    }catch{}
    if (!data.notifications) data.notifications = {};
    if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
    data.notifications[regNumber].unshift({ msg: `✅ You accepted volunteer role '${vreq.role}' for '${event.title}'.`, time: new Date().toISOString(), read: false });
    if (!data.notifications[event.creatorRegNumber]) data.notifications[event.creatorRegNumber] = [];
    data.notifications[event.creatorRegNumber].unshift({ msg: `✅ ${regNumber} accepted volunteer role '${vreq.role}' for '${event.title}'.`, time: new Date().toISOString(), read: false });
    await saveData(data);
    
    // Update user's last seen
    await updateUserLastSeen(regNumber);
    
    try { broadcast('events_changed', { reason: 'volunteer_accepted', eventId: event.id }); } catch {}
    return res.json({ ok: true, status: 'accepted', volunteer });
  } else if (decision === 'reject') {
    vreq.status = 'rejected';
    if (!data.notifications) data.notifications = {};
    if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
    data.notifications[regNumber].unshift({ msg: `❌ You rejected volunteer role '${vreq.role}' for '${event.title}'.`, time: new Date().toISOString(), read: false });
    if (!data.notifications[event.creatorRegNumber]) data.notifications[event.creatorRegNumber] = [];
    data.notifications[event.creatorRegNumber].unshift({ msg: `❌ ${regNumber} rejected volunteer role '${vreq.role}' for '${event.title}'.`, time: new Date().toISOString(), read: false });
    await saveData(data);
    
    // Update user's last seen
    await updateUserLastSeen(regNumber);
    
    try { broadcast('events_changed', { reason: 'volunteer_rejected', eventId: event.id }); } catch {}
    return res.json({ ok: true, status: 'rejected' });
  } else {
    return res.status(400).json({ ok: false, error: 'Invalid decision' });
  }
});

// User leaves volunteer role themselves
app.post('/api/volunteers/leave', async (req, res) => {
  const data = await loadData();
  const { eventId, regNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found' });
  event.volunteers = Array.isArray(event.volunteers) ? event.volunteers : [];
  const idx = event.volunteers.findIndex(v => v.regNumber === regNumber);
  if (idx === -1) return res.status(404).json({ ok: false, error: 'You are not a volunteer for this event.' });
  event.volunteers.splice(idx, 1);
  // Re-number IDs
  event.volunteers.forEach((v, i) => { v.volunteerId = `V${String(i+1).padStart(2,'0')}`; });
  // Remove any pending requests for this user as well
  event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests.filter(r => r.regNumber !== regNumber) : [];
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[regNumber]) data.notifications[regNumber] = [];
  data.notifications[regNumber].unshift({ msg: `🚪 You left the volunteer role for '${event.title}'.`, time: new Date().toISOString(), read: false });
  if (!data.notifications[event.creatorRegNumber]) data.notifications[event.creatorRegNumber] = [];
  data.notifications[event.creatorRegNumber].unshift({ msg: `ℹ️ ${regNumber} left the volunteer role for '${event.title}'.`, time: new Date().toISOString(), read: false });
  await saveData(data);
  res.json({ ok: true });
});

// --- Data backup endpoints (optional) ---
app.get('/api/data/export', (req, res) => {
  try{ 
    const raw = fs.readFileSync(DATA_FILE, 'utf-8'); 
    res.type('application/json').send(raw); 
  } catch(err){ 
    console.error('Export failed:', err);
    res.status(500).json({ ok:false, error: 'Export failed' }); 
  }
});

app.post('/api/data/import', async (req, res) => {
  try{
    const payload = req.body;
    if(!payload || typeof payload !== 'object') return res.status(400).json({ ok:false, error:'Invalid payload' });
    // Always preserve DEFAULT_ADMIN
    const importData = { users: [], events: [], media: [], notifications: {}, messages: [], admin: DEFAULT_ADMIN, ...payload };
    importData.admin = DEFAULT_ADMIN;
    await saveData(importData);
    console.log(`📥 Data imported: ${importData.users?.length || 0} users, ${importData.events?.length || 0} events`);
    return res.json({ ok:true, message: `Imported ${importData.users?.length || 0} users and ${importData.events?.length || 0} events` });
  }catch(err){ 
    console.error('Import failed:', err);
    res.status(500).json({ ok:false, error: 'Import failed' }); 
  }
});

// Data status endpoint
app.get('/api/data/status', async (req, res) => {
  try {
    const data = await loadData();
    const fileStats = fs.existsSync(PERSISTENT_DATA_FILE) ? fs.statSync(PERSISTENT_DATA_FILE) : null;
    const backupCount = fs.existsSync(PERSISTENT_BACKUP_DIR) ? fs.readdirSync(PERSISTENT_BACKUP_DIR).filter(f => f.endsWith('.json')).length : 0;
    
    res.json({
      ok: true,
      stats: {
        users: data.users?.length || 0,
        events: data.events?.length || 0,
        media: data.media?.length || 0,
        messages: data.messages?.length || 0,
        notifications: Object.keys(data.notifications || {}).length,
        dataFileExists: fs.existsSync(PERSISTENT_DATA_FILE),
        lastModified: fileStats ? fileStats.mtime.toISOString() : null,
        backupCount: backupCount
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Data integrity check endpoint
app.get('/api/data/integrity', async (req, res) => {
  try {
    const data = await loadData();
    const issues = [];
    
    // Check for data consistency
    if (!Array.isArray(data.users)) issues.push('Users array is invalid');
    if (!Array.isArray(data.events)) issues.push('Events array is invalid');
    if (!Array.isArray(data.media)) issues.push('Media array is invalid');
    if (!Array.isArray(data.messages)) issues.push('Messages array is invalid');
    if (typeof data.notifications !== 'object') issues.push('Notifications object is invalid');
    
    // Check for orphaned data
    const eventIds = new Set(data.events.map(e => e.id));
    const orphanedMedia = data.media.filter(m => !eventIds.has(m.eventId));
    if (orphanedMedia.length > 0) issues.push(`${orphanedMedia.length} orphaned media files`);
    
    // Check for invalid event references
    const userRegs = new Set(data.users.map(u => u.regNumber));
    const invalidEventCreators = data.events.filter(e => !userRegs.has(e.creatorRegNumber));
    if (invalidEventCreators.length > 0) issues.push(`${invalidEventCreators.length} events with invalid creators`);
    
    const result = {
      ok: true,
      integrity: {
        issues: issues,
        isHealthy: issues.length === 0,
        stats: {
          users: data.users?.length || 0,
          events: data.events?.length || 0,
          media: data.media?.length || 0,
          messages: data.messages?.length || 0,
          notifications: Object.keys(data.notifications || {}).length
        }
      }
    };
    
    res.json(result);
  } catch (err) {
    console.error('Integrity check failed:', err);
    res.status(500).json({ ok: false, error: 'Integrity check failed' });
  }
});


// Debug endpoint to check uploads directory
app.get('/api/debug/uploads', (req, res) => {
  try {
    const uploadDir = PERSISTENT_UPLOAD_DIR;
    const exists = fs.existsSync(uploadDir);
    const files = exists ? fs.readdirSync(uploadDir) : [];
    const fileDetails = files.map(file => {
      const filePath = path.join(uploadDir, file);
      const stats = fs.statSync(filePath);
      return {
        name: file,
        size: stats.size,
        modified: stats.mtime.toISOString(),
        path: filePath
      };
    });
    
    res.json({
      ok: true,
      debug: {
        uploadDir,
        exists,
        fileCount: files.length,
        files: fileDetails
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Data persistence verification endpoint
app.get('/api/data/persistence', async (req, res) => {
  try {
    const data = await loadData();
    
    // Check if MongoDB is connected
    const mongoConnected = !!collection;
    
    res.json({
      ok: true,
      persistence: {
        storageType: mongoConnected ? "MongoDB Atlas + GridFS" : "Local File System",
        mongoConnected: mongoConnected,
        dataFile: {
          exists: true,
          path: mongoConnected ? "MongoDB Atlas" : PERSISTENT_DATA_FILE,
          size: mongoConnected ? "N/A (MongoDB)" : (fs.existsSync(PERSISTENT_DATA_FILE) ? fs.statSync(PERSISTENT_DATA_FILE).size : 0),
          lastModified: mongoConnected ? "N/A (MongoDB)" : (fs.existsSync(PERSISTENT_DATA_FILE) ? fs.statSync(PERSISTENT_DATA_FILE).mtime : null),
          readable: true
        },
        uploadsFolder: {
          exists: true,
          path: mongoConnected ? "GridFS Bucket" : PERSISTENT_UPLOAD_DIR,
          fileCount: mongoConnected ? "N/A (GridFS)" : (fs.existsSync(PERSISTENT_UPLOAD_DIR) ? fs.readdirSync(PERSISTENT_UPLOAD_DIR).length : 0)
        },
        backups: {
          count: mongoConnected ? "N/A (MongoDB)" : (fs.existsSync(PERSISTENT_BACKUP_DIR) ? fs.readdirSync(PERSISTENT_BACKUP_DIR).filter(f => f.endsWith('.json')).length : 0),
          path: mongoConnected ? "MongoDB Atlas" : PERSISTENT_BACKUP_DIR,
          exists: true
        },
        dataCounts: {
          users: data.users?.length || 0,
          events: data.events?.length || 0,
          media: data.media?.length || 0,
          messages: data.messages?.length || 0,
          notifications: Object.keys(data.notifications || {}).length
        },
        timestamp: new Date().toISOString()
      }
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.delete("/api/waitlist", async (req, res) => {
  const data = await loadData();
  const { eventId, regNumber } = req.body;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
  event.waitlist = Array.isArray(event.waitlist) ? event.waitlist : [];
  const idx = event.waitlist.findIndex(w => w.regNumber === regNumber);
  if (idx === -1) return res.status(404).json({ ok: false, error: "Not on waitlist" });
  event.waitlist.splice(idx, 1);
  await saveData(data);
  try {
    broadcast('events_changed', { reason: 'waitlist_left', eventId: event.id });
    broadcast('tickets_changed', { reason: 'waitlist_left', eventId: event.id }, regNumber);
  } catch {}
  res.json({ ok: true });
});

// Organizer-only: view waitlist for an event
app.get("/api/waitlist/:eventId", async (req, res) => {
  const data = await loadData();
  const { eventId } = req.params;
  const { organizerReg } = req.query;
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found" });
  if (!organizerReg || event.creatorRegNumber !== organizerReg) return res.status(403).json({ ok: false, error: "Only the organizer can view this waitlist." });
  const list = (event.waitlist || []).map(w => {
    const u = data.users.find(u => u.regNumber === w.regNumber);
    return { regNumber: w.regNumber, name: u ? `${u.name} ${u.surname}`.trim() : w.regNumber, time: w.time };
  });
  res.json({ ok: true, waitlist: list });
});

app.post("/api/notifications/mark-read", async (req, res) => { const data = await loadData(); const { regNumber } = req.body; if (data.notifications && data.notifications[regNumber]) { data.notifications[regNumber].forEach(n => n.read = true); await saveData(data); } res.json({ ok: true }); });

// Configure multer for memory storage (GridFS will handle file storage)
const upload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB limit for videos
  fileFilter: (req, file, cb) => {
  if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) return cb(null, true);
  cb(new Error('Only image and video files are allowed'));
  }
});
const chatUpload = multer({ 
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit for chat videos
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/') || file.mimetype.startsWith('video/')) return cb(null, true);
    cb(new Error('Only image and video files are allowed'));
  }
});
// Simple video processing function with basic compression
async function processVideo(inputBuffer, filename) {
  // For now, we'll return the original buffer but log the processing
  // In a production environment, you could integrate with cloud services
  console.log(`📹 Video processing: ${filename} (${(inputBuffer.length / 1024 / 1024).toFixed(2)}MB)`);
  
  // Basic size check - if video is too large, we could implement compression here
  if (inputBuffer.length > 25 * 1024 * 1024) { // 25MB
    console.log(`⚠️ Large video detected: ${(inputBuffer.length / 1024 / 1024).toFixed(2)}MB`);
    // Here you could add compression logic or cloud processing
  }
  
  return inputBuffer;
}

// Simple image processing function (no external dependencies)
async function processImage(inputBuffer) {
  // For now, we'll just return the original buffer
  // In a production environment, you could integrate with cloud services
  // like Cloudinary, AWS Image Processing, or similar
  console.log(`🖼️ Image processing: ${inputBuffer.length} bytes - using original file`);
  return inputBuffer;
}

app.post("/api/media", upload.single("file"), async (req, res) => {
  try {
    const data = await loadData();
    const { eventId, regNumber } = req.body;
  if (!req.file) { return res.status(400).json({ ok: false, error: "No file uploaded." }); }
  const event = data.events.find(e => e.id === parseInt(eventId));
  if (!event) { return res.status(404).json({ ok: false, error: "Event not found" }); }
  if (event.creatorRegNumber !== regNumber) { return res.status(403).json({ ok: false, error: "You are not authorized to upload media for this event." }); }
    
    // Compress media before storing
    let processedBuffer = req.file.buffer;
    let originalSize = req.file.buffer.length;
    
    try {
      if (req.file.mimetype.startsWith('video/')) {
        console.log(`🎬 Processing video: ${req.file.originalname} (${originalSize} bytes)`);
        processedBuffer = await processVideo(req.file.buffer, req.file.originalname);
        console.log(`✅ Video processed: ${originalSize} → ${processedBuffer.length} bytes`);
      } else if (req.file.mimetype.startsWith('image/')) {
        console.log(`🖼️ Processing image: ${req.file.originalname} (${originalSize} bytes)`);
        processedBuffer = await processImage(req.file.buffer);
        console.log(`✅ Image processed: ${originalSize} → ${processedBuffer.length} bytes`);
      }
    } catch (compressionError) {
      console.error('⚠️ Compression failed, using original file:', compressionError.message);
      processedBuffer = req.file.buffer; // Use original if compression fails
    }
    
    // Store file in GridFS with promise-based approach
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = gridFSBucket.openUploadStream(req.file.originalname, {
        metadata: {
          eventId: parseInt(eventId),
          uploadedBy: regNumber,
          uploadedAt: new Date(),
          mimeType: req.file.mimetype
        }
      });
      
      uploadStream.on('error', (error) => {
        console.error('GridFS upload error:', error);
        reject(error);
      });
      
      uploadStream.on('finish', () => {
        resolve(uploadStream.id);
      });
      
      uploadStream.end(processedBuffer);
    });
    
    // Wait for upload to complete
    const fileId = await uploadPromise;
  const type = req.file.mimetype.startsWith("image/") ? "photo" : "video";
    
    const media = { 
      id: Date.now(),
      eventId: parseInt(eventId), 
      name: req.file.originalname, 
      url: `/api/media/file/${fileId}`, // GridFS endpoint
      type,
      size: req.file.size,
      gridFSId: fileId
    };
    
    data.media.push(media); 
    await saveData(data);
    
    // Update organizer's last seen
    await updateUserLastSeen(regNumber);
    
    console.log(`📁 File saved to GridFS: ${req.file.originalname} (${req.file.size} bytes)`);
    res.json({ ok: true, media });
  } catch (err) {
    console.error('Media upload error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.delete("/api/media/:mediaId", async (req, res) => {
  const data = await loadData(); const mediaId = parseInt(req.params.mediaId); const { regNumber } = req.body;
  const mediaIndex = data.media.findIndex(m => m.id === mediaId);
  if (mediaIndex === -1) { return res.status(404).json({ ok: false, error: "Media not found." }); }
  const media = data.media[mediaIndex];
  const event = data.events.find(e => e.id === media.eventId);
  if (event && event.creatorRegNumber !== regNumber) { return res.status(403).json({ ok: false, error: "You are not authorized to delete this media." }); }
  
  // Delete from GridFS if it exists
  if (media.gridFSId) {
    try {
      await gridFSBucket.delete(media.gridFSId);
      console.log(`📁 File deleted from GridFS: ${media.name}`);
    } catch (err) {
      console.error("Failed to delete file from GridFS:", err);
    }
  }
  
  data.media.splice(mediaIndex, 1); await saveData(data);
  res.json({ ok: true, message: "Media deleted successfully." });
});


// Update user profile endpoint
app.put("/api/profile", async (req, res) => {
  const { regNumber, department, bloodGroup, address, branch, pincode } = req.body;
  
  if (!regNumber) {
    return res.status(400).json({ ok: false, error: "Registration number is required." });
  }
  
  const data = await loadData();
  const userIndex = data.users.findIndex(u => u.regNumber === regNumber);
  
  if (userIndex === -1) {
    return res.status(404).json({ ok: false, error: "User not found." });
  }
  
  // Update user profile fields
  if (department) data.users[userIndex].department = department;
  if (bloodGroup) data.users[userIndex].bloodGroup = bloodGroup;
  if (address) data.users[userIndex].address = address;
  if (branch) data.users[userIndex].branch = branch;
  if (pincode) data.users[userIndex].pincode = pincode;
  
  await saveData(data);
  
  // Update user's last seen
  await updateUserLastSeen(regNumber);
  
  res.json({ ok: true, message: "Profile updated successfully.", user: data.users[userIndex] });
});

// GridFS file serving endpoint
app.get("/api/media/file/:fileId", async (req, res) => {
  try {
    const fileId = req.params.fileId;
    
    // Convert string to ObjectId
    let objectId;
    try {
      objectId = new ObjectId(fileId);
    } catch (err) {
      console.error('Invalid ObjectId:', fileId);
      return res.status(400).json({ ok: false, error: "Invalid file ID" });
    }
    
    const downloadStream = gridFSBucket.openDownloadStream(objectId);
    
    downloadStream.on('error', (error) => {
      console.error('GridFS download error:', error);
      res.status(404).json({ ok: false, error: "File not found" });
    });
    
    downloadStream.on('file', (file) => {
      res.set('Content-Type', file.metadata?.mimeType || 'application/octet-stream');
      res.set('Content-Disposition', `inline; filename="${file.filename}"`);
    });
    
    downloadStream.pipe(res);
  } catch (err) {
    console.error('GridFS endpoint error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Debug endpoint to list GridFS files
app.get("/api/debug/gridfs", async (req, res) => {
  try {
    if (!gridFSBucket) {
      return res.json({ ok: false, error: "GridFS not initialized" });
    }
    
    const files = await gridFSBucket.find({}).toArray();
    res.json({ 
      ok: true, 
      files: files.map(f => ({
        id: f._id,
        filename: f.filename,
        length: f.length,
        uploadDate: f.uploadDate,
        metadata: f.metadata
      }))
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Static file serving setup (logging moved to initializeApp)

app.use("/uploads", express.static(PERSISTENT_UPLOAD_DIR, {
  index: false,
  dotfiles: 'ignore',
  etag: true,
  lastModified: true
}));

// ---------- Messages (Chat) ----------
// Send a message related to an event between a student and the organizer
app.post("/api/messages", async (req, res) => {
  const data = await loadData();
  const { eventId, fromReg, toReg, text } = req.body;
  if (!eventId || !fromReg || !toReg || !text || !String(text).trim()) {
    return res.status(400).json({ ok: false, error: "Missing required fields." });
  }
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found." });

  // Authorization: either organizer OR (booked user OR volunteer) can chat
  const isOrganizer = event.creatorRegNumber === fromReg || event.creatorRegNumber === toReg;
  const isBookedUser = !!event.bookings.find(b => b.regNumber === fromReg || b.regNumber === toReg);
  const isVolunteer = Array.isArray(event.volunteers) && !!event.volunteers.find(v => v.regNumber === fromReg || v.regNumber === toReg);
  if (!isOrganizer && !isBookedUser && !isVolunteer) {
    return res.status(403).json({ ok: false, error: "Only organizer and booked users/volunteers can chat for this event." });
  }

  const msg = { id: Date.now(), eventId: Number(eventId), fromReg, toReg, text: String(text).trim(), time: new Date().toISOString(), read: false, type: 'text' };
  if (!data.messages) data.messages = [];
  data.messages.push(msg);

  // Notifications for sender and recipient (include metadata so the client can open chat directly)
  if (!data.notifications) data.notifications = {};
  if (!data.notifications[toReg]) data.notifications[toReg] = [];
  if (!data.notifications[fromReg]) data.notifications[fromReg] = [];
  const notifMeta = { type: 'chat', eventId: Number(eventId), fromReg, toReg };
  data.notifications[toReg].unshift({ msg: `💬 New message on '${event.title}'`, time: new Date().toISOString(), read: false, ...notifMeta });
  data.notifications[fromReg].unshift({ msg: `✅ Message sent for '${event.title}'`, time: new Date().toISOString(), read: false, ...notifMeta });

  await saveData(data);
  res.json({ ok: true, message: msg });
});

// Get conversation (thread) between two regs for an event
app.get("/api/messages/thread", async (req, res) => {
  const data = await loadData();
  const { eventId, regA, regB } = req.query;
  if (!eventId || !regA || !regB) return res.status(400).json({ ok: false, error: "Missing parameters." });
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found." });
  const thread = (data.messages || []).filter(m => m.eventId === Number(eventId) && ((m.fromReg === regA && m.toReg === regB) || (m.fromReg === regB && m.toReg === regA))).sort((a,b)=> new Date(a.time)-new Date(b.time));
  res.json({ ok: true, messages: thread });
});

// For organizer: list distinct user conversations for an event
app.get("/api/messages/conversations", async (req, res) => {
  const data = await loadData();
  const { eventId, organizerReg } = req.query;
  if (!eventId || !organizerReg) return res.status(400).json({ ok: false, error: "Missing parameters." });
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: "Event not found." });
  if (event.creatorRegNumber !== organizerReg) return res.status(403).json({ ok: false, error: "Only the organizer can view conversations." });
  const convMap = new Map();
  // track unread counts (simple: messages to organizer not read)
  const unreadByUser = {};
  (data.messages || []).forEach(m => {
    if (m.eventId === Number(eventId)) {
      const other = m.fromReg === organizerReg ? m.toReg : (m.toReg === organizerReg ? m.fromReg : null);
      if (!other) return;
      convMap.set(other, true);
      if (m.toReg === organizerReg && !m.read) {
        unreadByUser[other] = (unreadByUser[other] || 0) + 1;
      }
    }
  });
  const isVolunteer = (rn) => Array.isArray(event?.volunteers) && !!event.volunteers.find(v => v.regNumber === rn);
  const users = Array.from(convMap.keys()).map(rn => {
    const u = data.users.find(u => u.regNumber === rn);
    return { regNumber: rn, name: u ? `${u.name || ''} ${u.surname || ''}`.trim() : rn, volunteer: isVolunteer(rn), unread: unreadByUser[rn] || 0 };
  });
  res.json({ ok: true, users });
});

// Upload media message (image/video, <= 10MB)
app.post('/api/messages/media', chatUpload.single('file'), async (req, res) => {
  try {
    const data = await loadData();
  const { eventId, fromReg, toReg } = req.body;
  if (!req.file || !eventId || !fromReg || !toReg) {
    return res.status(400).json({ ok: false, error: 'Missing file or fields.' });
  }
  const event = data.events.find(e => e.id === Number(eventId));
  if (!event) return res.status(404).json({ ok: false, error: 'Event not found.' });
  const isOrganizer = event.creatorRegNumber === fromReg || event.creatorRegNumber === toReg;
  const isBookedUser = !!event.bookings.find(b => b.regNumber === fromReg || b.regNumber === toReg);
  const isVolunteer = Array.isArray(event.volunteers) && !!event.volunteers.find(v => v.regNumber === fromReg || v.regNumber === toReg);
  if (!isOrganizer && !isBookedUser && !isVolunteer) {
    return res.status(403).json({ ok: false, error: 'Only organizer and booked users/volunteers can chat for this event.' });
  }
    
    // Compress media before storing
    let processedBuffer = req.file.buffer;
    let originalSize = req.file.buffer.length;
    
    try {
      if (req.file.mimetype.startsWith('video/')) {
        console.log(`🎬 Processing chat video: ${req.file.originalname} (${originalSize} bytes)`);
        processedBuffer = await processVideo(req.file.buffer, req.file.originalname);
        console.log(`✅ Chat video processed: ${originalSize} → ${processedBuffer.length} bytes`);
      } else if (req.file.mimetype.startsWith('image/')) {
        console.log(`🖼️ Processing chat image: ${req.file.originalname} (${originalSize} bytes)`);
        processedBuffer = await processImage(req.file.buffer);
        console.log(`✅ Chat image processed: ${originalSize} → ${processedBuffer.length} bytes`);
      }
    } catch (compressionError) {
      console.error('⚠️ Chat compression failed, using original file:', compressionError.message);
      processedBuffer = req.file.buffer; // Use original if compression fails
    }
    
    // Store file in GridFS with promise-based approach
    const uploadPromise = new Promise((resolve, reject) => {
      const uploadStream = gridFSBucket.openUploadStream(req.file.originalname, {
        metadata: {
          eventId: Number(eventId),
          uploadedBy: fromReg,
          uploadedAt: new Date(),
          mimeType: req.file.mimetype,
          type: 'chat'
        }
      });
      
      uploadStream.on('error', (error) => {
        console.error('GridFS chat upload error:', error);
        reject(error);
      });
      
      uploadStream.on('finish', () => {
        resolve(uploadStream.id);
      });
      
      uploadStream.end(processedBuffer);
    });
    
    // Wait for upload to complete
    const fileId = await uploadPromise;
    const mediaType = req.file.mimetype.startsWith('image/') ? 'photo' : 'video';
    const msg = { 
      id: Date.now(), 
      eventId: Number(eventId), 
      fromReg, 
      toReg, 
      time: new Date().toISOString(), 
      read: false, 
      type: 'media', 
      mediaType, 
      url: `/api/media/file/${fileId}`,
      gridFSId: fileId
    };
    
    if (!data.messages) data.messages = [];
    data.messages.push(msg);
    
    if (!data.notifications) data.notifications = {};
    if (!data.notifications[toReg]) data.notifications[toReg] = [];
    if (!data.notifications[fromReg]) data.notifications[fromReg] = [];
    const notifMeta = { type: 'chat', eventId: Number(eventId), fromReg, toReg };
    data.notifications[toReg].unshift({ msg: `📎 New ${mediaType} in '${event.title}' chat`, time: new Date().toISOString(), read: false, ...notifMeta });
    data.notifications[fromReg].unshift({ msg: `✅ ${mediaType === 'photo' ? 'Image' : 'Video'} sent for '${event.title}'`, time: new Date().toISOString(), read: false, ...notifMeta });
    
    await saveData(data);
    console.log(`📁 Chat file saved to GridFS: ${req.file.originalname} (${req.file.size} bytes)`);
    res.json({ ok: true, message: msg });
  } catch (err) {
    res.status(500).json({ ok: false, error: 'Failed to save file.' });
  }
});

// Delete chat message with permanent storage cleanup
app.delete('/api/messages/:messageId', async (req, res) => {
  try {
    const data = await loadData();
    const messageId = parseInt(req.params.messageId);
    const { regNumber } = req.body;
    
    const messageIndex = data.messages.findIndex(m => m.id === messageId);
    if (messageIndex === -1) {
      return res.status(404).json({ ok: false, error: 'Message not found' });
    }
    
    const message = data.messages[messageIndex];
    
    // Check if user can delete this message (sender or organizer)
    const event = data.events.find(e => e.id === message.eventId);
    if (!event) {
      return res.status(404).json({ ok: false, error: 'Event not found' });
    }
    
    const canDelete = message.fromReg === regNumber || event.creatorRegNumber === regNumber;
    if (!canDelete) {
      return res.status(403).json({ ok: false, error: 'Not authorized to delete this message' });
    }
    
    // Delete from GridFS if it's a media message
    if (message.type === 'media' && message.gridFSId) {
      try {
        await gridFSBucket.delete(message.gridFSId);
        console.log(`📁 Chat media deleted from GridFS: ${message.gridFSId}`);
      } catch (err) {
        console.error('Failed to delete chat media from GridFS:', err);
      }
    }
    
    // Remove message from database
    data.messages.splice(messageIndex, 1);
    await saveData(data);
    
    console.log(`🗑️ Chat message deleted: ${messageId}`);
    res.json({ ok: true, message: 'Message deleted permanently' });
  } catch (err) {
    console.error('Chat deletion error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---------- Delete Account (User self-service) ----------
// Body: { regNumber, password }
app.post('/api/account/delete', async (req, res) => {
  const data = await loadData();
  const { regNumber, password } = req.body;
  if (!regNumber || !password) return res.status(400).json({ ok: false, error: 'Missing fields.' });
  const userIndex = data.users.findIndex(u => u.regNumber === regNumber && u.password === password);
  if (userIndex === -1) return res.status(401).json({ ok: false, error: 'Invalid credentials.' });

  const user = data.users[userIndex];

  // 1) Remove bookings and waitlists referencing this user across all events
  data.events.forEach(event => {
    // Remove from bookings
    const beforeCount = (event.bookings||[]).length;
    event.bookings = (event.bookings||[]).filter(b => b.regNumber !== regNumber);
    const removed = beforeCount - (event.bookings||[]).length;
    if (removed > 0) {
      event.taken = Math.max(0, (event.taken||0) - removed);
      // Re-seat numbers compactly
      event.bookings.sort((a, b) => a.seat - b.seat).forEach((b, idx) => b.seat = idx + 1);
    }
    // Remove from waitlist
    event.waitlist = Array.isArray(event.waitlist) ? event.waitlist.filter(w => w.regNumber !== regNumber) : [];
    // Remove from volunteers
    event.volunteers = Array.isArray(event.volunteers) ? event.volunteers.filter(v => v.regNumber !== regNumber) : [];
    // Remove pending volunteer requests
    event.volunteerRequests = Array.isArray(event.volunteerRequests) ? event.volunteerRequests.filter(r => r.regNumber !== regNumber) : [];
  });

  // 2) If organizer: delete events they created and associated media
  const eventsToDelete = data.events.filter(e => e.creatorRegNumber === regNumber).map(e => e.id);
  if (eventsToDelete.length > 0) {
    // Delete media files for those events
    const mediaToDelete = data.media.filter(m => eventsToDelete.includes(m.eventId));
    mediaToDelete.forEach(m => { try { const fp = path.join(__dirname, m.url); if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch {} });
    data.media = data.media.filter(m => !eventsToDelete.includes(m.eventId));
    data.events = data.events.filter(e => !eventsToDelete.includes(e.id));
  }

  // 3) Remove user media messages and text messages (retain threads but remove their messages)
  if (Array.isArray(data.messages)) {
    data.messages = data.messages.filter(m => m.fromReg !== regNumber && m.toReg !== regNumber);
  }

  // 4) Remove notifications
  if (data.notifications && data.notifications[regNumber]) {
    delete data.notifications[regNumber];
  }

  // 5) Finally remove the user record
  data.users.splice(userIndex, 1);

  await saveData(data);
  return res.json({ ok: true });
});