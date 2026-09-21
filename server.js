const express = require('express');
const cors = require('cors');
const multer = require('multer');
const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3').verbose();
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 5000);
const JWT_SECRET = process.env.JWT_SECRET || 'dropguard-dev-secret';
const DB_MODE = String(process.env.DB_MODE || 'sqlite').toLowerCase();

app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage() });
let pool = null;
let sqliteDb = null;

function isMysqlEnabled() {
  return DB_MODE === 'mysql' || Boolean(process.env.DB_HOST || process.env.DB_USER || process.env.DB_NAME || process.env.DB_PASSWORD);
}

function parseJSON(value, fallback = []) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch (err) {
    return fallback;
  }
}

function signToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '7d' });
}

function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.split(' ')[1] : null;
  if (!token) return res.status(401).json({ message: 'Missing token' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (err) {
    return res.status(401).json({ message: 'Invalid token' });
  }
}

function calcSlope(values = []) {
  const nums = values.filter(v => v !== null && v !== undefined && !Number.isNaN(Number(v))).map(Number);
  if (nums.length < 2) return 0;

  const n = nums.length;
  const mx = (n - 1) / 2;
  const my = nums.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;

  nums.forEach((y, i) => {
    num += (i - mx) * (y - my);
    den += (i - mx) ** 2;
  });

  return den === 0 ? 0 : num / den;
}

function factorWeight(val) {
  const mapping = {
    none: 0,
    'transport issue': 1,
    'family illness': 1,
    'financial issues': 2,
    migration: 2,
    'farm work': 2,
    'child labour': 2,
    'early marriage pressure': 2,
  };

  const key = String(val || 'none').trim().toLowerCase();
  return mapping[key] ?? 1;
}

function calculateRisk(student) {
  const attSeries = student.att_series && student.att_series.length ? student.att_series : [student.attendance || 0];
  const marksSeries = student.marks_series && student.marks_series.length ? student.marks_series : [student.marks || 0];
  const aSlope = calcSlope(attSeries);
  const mSlope = calcSlope(marksSeries);
  const fw = factorWeight(student.local_factor);

  let score = 0;
  score += Math.max(0, 75 - Number(student.attendance || 0)) * 0.8;
  score += Math.max(0, 50 - Number(student.marks || 0)) * 0.5;
  score += Math.min(Number(student.absence_count || 0), 25) * 0.8;
  score += Math.min(Number(student.consecutive_absences || 0), 15) * 1.2;
  score += Math.max(0, -aSlope) * 1.6;
  score += Math.max(0, -mSlope) * 1.0;
  score += fw * 7;
  score = Math.min(99, Math.max(2, score));

  const riskScore = Math.round(score * 10) / 10;
  const riskLevel = riskScore >= 70 ? 'High' : riskScore >= 40 ? 'Medium' : 'Low';
  return { score: riskScore, level: riskLevel, aSlope, mSlope, fw };
}

function buildWhy(student, result) {
  const why = [];
  const attSeries = student.att_series || [];
  const marksSeries = student.marks_series || [];

  if (result.aSlope <= -2 && attSeries.length > 1) {
    why.push(`Attendance has been continuously declining (${attSeries.map(v => `${Math.round(Number(v))}%`).join(' → ')})`);
  }
  if (Number(student.attendance || 0) < 60) {
    why.push(`Overall attendance is only ${Math.round(Number(student.attendance || 0))}%, far below the safe level`);
  } else if (Number(student.attendance || 0) < 75 && result.aSlope > -2) {
    why.push("Attendance is below 75%, the school's minimum");
  }

  if (result.mSlope <= -2 && marksSeries.length > 1) {
    why.push(`Academic performance is declining (${marksSeries.map(v => `${Math.round(Number(v))}%`).join(' → ')})`);
  }
  if (Number(student.marks || 0) < 40) {
    why.push(`Marks are below the passing level (${Math.round(Number(student.marks || 0))}%)`);
  }
  if (Number(student.consecutive_absences || 0) >= 5) {
    why.push(`Repeated consecutive absences detected (${Number(student.consecutive_absences || 0)} days in a row)`);
  } else if (Number(student.absence_count || 0) >= 10) {
    why.push(`High number of absences this term (${Number(student.absence_count || 0)} days)`);
  }
  if (result.fw >= 1 && String(student.local_factor || 'none').toLowerCase() !== 'none') {
    why.push(`Context factor reported by the school: ${student.local_factor}`);
  }
  if (!why.length) {
    why.push('No major warning signs. Attendance and marks are stable.');
  }
  return why;
}

function buildNext(student, result, level) {
  const next = [];

  if (level === 'High') {
    next.push('Contact the parent/guardian this week');
    next.push('Talk to the student personally and note the reason for absence');
  } else if (level === 'Medium') {
    next.push('Call the parent/guardian for an update');
    next.push('Talk to the student during the next class');
  }

  if (Number(student.marks || 0) < 45 || result.mSlope <= -2) {
    next.push('Provide academic support / remedial classes');
  }
  if (result.aSlope <= -2 || Number(student.attendance || 0) < 75 || Number(student.consecutive_absences || 0) >= 5) {
    next.push('Monitor daily attendance for the next 4 weeks');
  }
  if (result.fw >= 2) {
    next.push('Check eligibility for scholarship / mid-day meal / transport support');
  }
  if (level !== 'Low') {
    next.push('Schedule a follow-up review after 15 days');
  }
  if (!next.length) {
    next.push('No action needed right now — keep monitoring normally');
  }

  return next;
}

function analyseStudent(student) {
  const result = calculateRisk(student);
  return {
    risk_score: result.score,
    risk_level: result.level,
    why: buildWhy(student, result),
    next_steps: buildNext(student, result, result.level),
  };
}

async function initMysql() {
  try {
    pool = mysql.createPool({
      host: process.env.DB_HOST || 'localhost',
      port: process.env.DB_PORT ? Number(process.env.DB_PORT) : 3306,
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'dropguard',
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
    });

    const connection = await pool.getConnection();
    await connection.ping();
    connection.release();
    console.log('Using MySQL database');
    return true;
  } catch (error) {
    console.log('MySQL unavailable, switching to SQLite fallback:', error.message);
    pool = null;
    return false;
  }
}

function sqliteRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqliteDb.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function sqliteAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqliteDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}

function sqliteGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    sqliteDb.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

async function ensureMysqlSchema() {
  const connection = await pool.getConnection();
  try {
    await connection.query(`
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        email VARCHAR(255) NOT NULL UNIQUE,
        password VARCHAR(255) NOT NULL,
        role VARCHAR(50) NOT NULL,
        school VARCHAR(255),
        teacher_id VARCHAR(100),
        student_id VARCHAR(100),
        class_name VARCHAR(100),
        contact VARCHAR(100),
        position VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS students (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id VARCHAR(100) NOT NULL UNIQUE,
        name VARCHAR(255) NOT NULL,
        class_name VARCHAR(100) NOT NULL,
        attendance FLOAT DEFAULT 0,
        marks FLOAT DEFAULT 0,
        absence_count INT DEFAULT 0,
        consecutive_absences INT DEFAULT 0,
        local_factor VARCHAR(255) DEFAULT 'None',
        risk_score FLOAT DEFAULT 0,
        risk_level VARCHAR(50) DEFAULT 'Low',
        why JSON,
        next_steps JSON,
        att_series JSON,
        marks_series JSON,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);

    await connection.query(`
      CREATE TABLE IF NOT EXISTS interventions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        student_id VARCHAR(100) NOT NULL,
        title VARCHAR(255) NOT NULL,
        description TEXT,
        status VARCHAR(50) DEFAULT 'open',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    const [userCount] = await connection.query('SELECT COUNT(*) AS count FROM users');
    if (Number(userCount[0].count) === 0) {
      await connection.query(
        `INSERT INTO users (name, email, password, role, school, teacher_id, student_id, class_name, position)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)` ,
        [
          'Anita Rao','admin@demo.in','1234','teacher','ZP High School','T-001',null,null,'admin',
          'Rekha Deshmukh','teacher@demo.in','1234','teacher','ZP High School','T-014',null,'Class 9','class_teacher',
          'Rahul Sharma','student@demo.in','1234','student',null,null,'S001','Class 9',null,
          'Suresh Sharma','parent@demo.in','1234','parent',null,null,'S001',null,'contact'
        ]
      );
    }

    const [studentCount] = await connection.query('SELECT COUNT(*) AS count FROM students');
    if (Number(studentCount[0].count) === 0) {
      const demoStudents = [
        { student_id: 'S001', name: 'Rahul Sharma', class_name: 'Class 9', attendance: 52, marks: 46, absence_count: 12, consecutive_absences: 7, local_factor: 'Financial issues', att_series: [78, 65, 52], marks_series: [61, 46] },
        { student_id: 'S002', name: 'Priya Patil', class_name: 'Class 8', attendance: 81, marks: 72, absence_count: 4, consecutive_absences: 2, local_factor: 'None', att_series: [89, 84, 81], marks_series: [76, 72] },
        { student_id: 'S003', name: 'Amit Verma', class_name: 'Class 10', attendance: 64, marks: 41, absence_count: 9, consecutive_absences: 5, local_factor: 'Farm work', att_series: [75, 70, 64], marks_series: [58, 41] }
      ];

      for (const student of demoStudents) {
        const analysis = analyseStudent(student);
        await connection.query(
          `INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            student.student_id,
            student.name,
            student.class_name,
            student.attendance,
            student.marks,
            student.absence_count,
            student.consecutive_absences,
            student.local_factor,
            analysis.risk_score,
            analysis.risk_level,
            JSON.stringify(analysis.why),
            JSON.stringify(analysis.next_steps),
            JSON.stringify(student.att_series),
            JSON.stringify(student.marks_series),
          ]
        );
      }
    }
  } finally {
    connection.release();
  }
}

async function ensureSqliteSchema() {
  sqliteDb = new sqlite3.Database('./dropguard.db');

  await sqliteRun(`CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    role TEXT NOT NULL,
    school TEXT,
    teacher_id TEXT,
    student_id TEXT,
    class_name TEXT,
    contact TEXT,
    position TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await sqliteRun(`CREATE TABLE IF NOT EXISTS students (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    class_name TEXT NOT NULL,
    attendance REAL DEFAULT 0,
    marks REAL DEFAULT 0,
    absence_count INTEGER DEFAULT 0,
    consecutive_absences INTEGER DEFAULT 0,
    local_factor TEXT DEFAULT 'None',
    risk_score REAL DEFAULT 0,
    risk_level TEXT DEFAULT 'Low',
    why TEXT,
    next_steps TEXT,
    att_series TEXT,
    marks_series TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  await sqliteRun(`CREATE TABLE IF NOT EXISTS interventions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT DEFAULT 'open',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  )`);

  const userCountRow = await sqliteGet('SELECT COUNT(*) AS count FROM users');
  if (Number(userCountRow.count) === 0) {
    await sqliteRun(`INSERT INTO users (name, email, password, role, school, teacher_id, student_id, class_name, position)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?), (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
      'Anita Rao','admin@demo.in','1234','teacher','ZP High School','T-001',null,null,'admin',
      'Rekha Deshmukh','teacher@demo.in','1234','teacher','ZP High School','T-014',null,'Class 9','class_teacher',
      'Rahul Sharma','student@demo.in','1234','student',null,null,'S001','Class 9',null,
      'Suresh Sharma','parent@demo.in','1234','parent',null,null,'S001',null,'contact'
    ]);
  }

  const studentCountRow = await sqliteGet('SELECT COUNT(*) AS count FROM students');
  if (Number(studentCountRow.count) === 0) {
    const demoStudents = [
      { student_id: 'S001', name: 'Rahul Sharma', class_name: 'Class 9', attendance: 52, marks: 46, absence_count: 12, consecutive_absences: 7, local_factor: 'Financial issues', att_series: [78, 65, 52], marks_series: [61, 46] },
      { student_id: 'S002', name: 'Priya Patil', class_name: 'Class 8', attendance: 81, marks: 72, absence_count: 4, consecutive_absences: 2, local_factor: 'None', att_series: [89, 84, 81], marks_series: [76, 72] },
      { student_id: 'S003', name: 'Amit Verma', class_name: 'Class 10', attendance: 64, marks: 41, absence_count: 9, consecutive_absences: 5, local_factor: 'Farm work', att_series: [75, 70, 64], marks_series: [58, 41] }
    ];

    for (const student of demoStudents) {
      const analysis = analyseStudent(student);
      await sqliteRun(`INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
        student.student_id,
        student.name,
        student.class_name,
        student.attendance,
        student.marks,
        student.absence_count,
        student.consecutive_absences,
        student.local_factor,
        analysis.risk_score,
        analysis.risk_level,
        JSON.stringify(analysis.why),
        JSON.stringify(analysis.next_steps),
        JSON.stringify(student.att_series),
        JSON.stringify(student.marks_series),
      ]);
    }
  }
}

async function ensureSchema() {
  if (pool) {
    await ensureMysqlSchema();
    return;
  }
  await ensureSqliteSchema();
}

async function startServer() {
  const mysqlEnabled = isMysqlEnabled();
  if (mysqlEnabled) {
    await initMysql();
  }
  await ensureSchema();

  app.get('/health', (req, res) => {
    res.json({ status: 'ok', database: pool ? 'mysql' : 'sqlite' });
  });

  app.post('/auth/login', async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ message: 'Email and password are required' });
    }

    try {
      const rows = pool
        ? (await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [String(email).trim().toLowerCase()]))[0]
        : await sqliteAll('SELECT * FROM users WHERE email = ? LIMIT 1', [String(email).trim().toLowerCase()]);

      const user = Array.isArray(rows) ? rows[0] : rows;
      if (!user || user.password !== String(password)) {
        return res.status(401).json({ message: 'Invalid email or password' });
      }

      return res.json({
        token: signToken(user),
        user: { id: user.id, name: user.name, email: user.email, role: user.role, school: user.school, teacher_id: user.teacher_id, student_id: user.student_id, class_name: user.class_name, position: user.position },
      });
    } catch (error) {
      return res.status(500).json({ message: 'Login failed', error: error.message });
    }
  });

  app.get('/students', authMiddleware, async (req, res) => {
    try {
      const rows = pool
        ? (await pool.query('SELECT * FROM students ORDER BY id ASC'))[0]
        : await sqliteAll('SELECT * FROM students ORDER BY id ASC');

      const students = rows.map(row => ({
        id: row.id,
        student_id: row.student_id,
        name: row.name,
        class_name: row.class_name,
        attendance: Number(row.attendance),
        marks: Number(row.marks),
        absence_count: Number(row.absence_count),
        consecutive_absences: Number(row.consecutive_absences),
        local_factor: row.local_factor,
        risk_score: Number(row.risk_score),
        risk_level: row.risk_level,
        why: parseJSON(row.why),
        next_steps: parseJSON(row.next_steps),
        att_series: parseJSON(row.att_series),
        marks_series: parseJSON(row.marks_series),
      }));

      res.json(students);
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch students', error: error.message });
    }
  });

  app.get('/students/:studentId', authMiddleware, async (req, res) => {
    const { studentId } = req.params;

    try {
      const rows = pool
        ? (await pool.query('SELECT * FROM students WHERE student_id = ? LIMIT 1', [String(studentId).toUpperCase()]))[0]
        : await sqliteAll('SELECT * FROM students WHERE student_id = ? LIMIT 1', [String(studentId).toUpperCase()]);

      const row = Array.isArray(rows) ? rows[0] : rows;
      if (!row) return res.status(404).json({ message: 'Student not found' });

      res.json({
        id: row.id,
        student_id: row.student_id,
        name: row.name,
        class_name: row.class_name,
        attendance: Number(row.attendance),
        marks: Number(row.marks),
        absence_count: Number(row.absence_count),
        consecutive_absences: Number(row.consecutive_absences),
        local_factor: row.local_factor,
        risk_score: Number(row.risk_score),
        risk_level: row.risk_level,
        why: parseJSON(row.why),
        next_steps: parseJSON(row.next_steps),
        att_series: parseJSON(row.att_series),
        marks_series: parseJSON(row.marks_series),
      });
    } catch (error) {
      res.status(500).json({ message: 'Failed to fetch student', error: error.message });
    }
  });

  app.post('/students', authMiddleware, async (req, res) => {
    const { student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor } = req.body || {};
    if (!student_id || !name || !class_name) {
      return res.status(400).json({ message: 'student_id, name, and class_name are required' });
    }

    try {
      const studentRecord = {
        student_id: String(student_id).toUpperCase(),
        name,
        class_name,
        attendance: Number(attendance || 0),
        marks: Number(marks || 0),
        absence_count: Number(absence_count || 0),
        consecutive_absences: Number(consecutive_absences || 0),
        local_factor: local_factor || 'None',
        att_series: [Number(attendance || 0)],
        marks_series: [Number(marks || 0)],
      };
      const analysis = analyseStudent(studentRecord);

      if (pool) {
        await pool.query(
          `INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            studentRecord.student_id,
            studentRecord.name,
            studentRecord.class_name,
            studentRecord.attendance,
            studentRecord.marks,
            studentRecord.absence_count,
            studentRecord.consecutive_absences,
            studentRecord.local_factor,
            analysis.risk_score,
            analysis.risk_level,
            JSON.stringify(analysis.why),
            JSON.stringify(analysis.next_steps),
            JSON.stringify(studentRecord.att_series),
            JSON.stringify(studentRecord.marks_series),
          ]
        );
      } else {
        await sqliteRun(`INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
          studentRecord.student_id,
          studentRecord.name,
          studentRecord.class_name,
          studentRecord.attendance,
          studentRecord.marks,
          studentRecord.absence_count,
          studentRecord.consecutive_absences,
          studentRecord.local_factor,
          analysis.risk_score,
          analysis.risk_level,
          JSON.stringify(analysis.why),
          JSON.stringify(analysis.next_steps),
          JSON.stringify(studentRecord.att_series),
          JSON.stringify(studentRecord.marks_series),
        ]);
      }

      return res.status(201).json({ message: 'Student created successfully' });
    } catch (error) {
      return res.status(500).json({ message: 'Failed to create student', error: error.message });
    }
  });

  app.post('/risk/analyze', (req, res) => {
    res.json(analyseStudent(req.body || {}));
  });

  app.post('/students/import-csv', authMiddleware, upload.single('file'), async (req, res) => {
    try {
      if (!req.file) return res.status(400).json({ message: 'CSV file is required' });

      const text = req.file.buffer.toString('utf8');
      const lines = text.trim().split(/\r?\n/).filter(Boolean);
      if (lines.length < 2) return res.status(400).json({ message: 'CSV file is empty' });

      const headers = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/\s+/g, '_'));
      const required = ['student_id', 'name', 'attendance', 'marks'];
      const missing = required.filter(h => !headers.includes(h));
      if (missing.length) return res.status(400).json({ message: `Missing required columns: ${missing.join(', ')}` });

      const rows = lines.slice(1).map(line => {
        const values = line.split(',');
        const row = {};
        headers.forEach((header, index) => {
          row[header] = (values[index] || '').trim();
        });
        return row;
      });

      let created = 0;
      let updated = 0;

      for (const row of rows) {
        const studentId = String(row.student_id || '').toUpperCase();
        if (!studentId) continue;

        const studentRecord = {
          student_id: studentId,
          name: row.name || 'Unknown',
          class_name: row.class_name || 'Unknown',
          attendance: Number(row.attendance || 0),
          marks: Number(row.marks || 0),
          absence_count: Number(row.absence_count || 0),
          consecutive_absences: Number(row.consecutive_absences || 0),
          local_factor: row.local_factor || 'None',
          att_series: [Number(row.attendance || 0)],
          marks_series: [Number(row.marks || 0)],
        };

        const analysis = analyseStudent(studentRecord);

        if (pool) {
          const [existing] = await pool.query('SELECT * FROM students WHERE student_id = ? LIMIT 1', [studentId]);
          if (existing.length) {
            await pool.query(
              `UPDATE students SET name=?, class_name=?, attendance=?, marks=?, absence_count=?, consecutive_absences=?, local_factor=?, risk_score=?, risk_level=?, why=?, next_steps=?, att_series=?, marks_series=? WHERE student_id=?`,
              [
                studentRecord.name,
                studentRecord.class_name,
                studentRecord.attendance,
                studentRecord.marks,
                studentRecord.absence_count,
                studentRecord.consecutive_absences,
                studentRecord.local_factor,
                analysis.risk_score,
                analysis.risk_level,
                JSON.stringify(analysis.why),
                JSON.stringify(analysis.next_steps),
                JSON.stringify(studentRecord.att_series),
                JSON.stringify(studentRecord.marks_series),
                studentId,
              ]
            );
            updated += 1;
          } else {
            await pool.query(
              `INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [
                studentRecord.student_id,
                studentRecord.name,
                studentRecord.class_name,
                studentRecord.attendance,
                studentRecord.marks,
                studentRecord.absence_count,
                studentRecord.consecutive_absences,
                studentRecord.local_factor,
                analysis.risk_score,
                analysis.risk_level,
                JSON.stringify(analysis.why),
                JSON.stringify(analysis.next_steps),
                JSON.stringify(studentRecord.att_series),
                JSON.stringify(studentRecord.marks_series),
              ]
            );
            created += 1;
          }
        } else {
          const existing = await sqliteGet('SELECT * FROM students WHERE student_id = ? LIMIT 1', [studentId]);
          if (existing) {
            await sqliteRun(`UPDATE students SET name=?, class_name=?, attendance=?, marks=?, absence_count=?, consecutive_absences=?, local_factor=?, risk_score=?, risk_level=?, why=?, next_steps=?, att_series=?, marks_series=? WHERE student_id = ?`, [
              studentRecord.name,
              studentRecord.class_name,
              studentRecord.attendance,
              studentRecord.marks,
              studentRecord.absence_count,
              studentRecord.consecutive_absences,
              studentRecord.local_factor,
              analysis.risk_score,
              analysis.risk_level,
              JSON.stringify(analysis.why),
              JSON.stringify(analysis.next_steps),
              JSON.stringify(studentRecord.att_series),
              JSON.stringify(studentRecord.marks_series),
              studentId,
            ]);
            updated += 1;
          } else {
            await sqliteRun(`INSERT INTO students (student_id, name, class_name, attendance, marks, absence_count, consecutive_absences, local_factor, risk_score, risk_level, why, next_steps, att_series, marks_series)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
              studentRecord.student_id,
              studentRecord.name,
              studentRecord.class_name,
              studentRecord.attendance,
              studentRecord.marks,
              studentRecord.absence_count,
              studentRecord.consecutive_absences,
              studentRecord.local_factor,
              analysis.risk_score,
              analysis.risk_level,
              JSON.stringify(analysis.why),
              JSON.stringify(analysis.next_steps),
              JSON.stringify(studentRecord.att_series),
              JSON.stringify(studentRecord.marks_series),
            ]);
            created += 1;
          }
        }
      }

      res.json({ message: 'CSV imported', created, updated });
    } catch (error) {
      res.status(500).json({ message: 'CSV import failed', error: error.message });
    }
  });

  app.get('/dashboard/summary', authMiddleware, async (req, res) => {
    try {
      if (pool) {
        const [totalRows] = await pool.query('SELECT COUNT(*) AS total FROM students');
        const [highRows] = await pool.query('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['High']);
        const [mediumRows] = await pool.query('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['Medium']);
        const [lowRows] = await pool.query('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['Low']);
        const [avgAttendanceRows] = await pool.query('SELECT AVG(attendance) AS avg FROM students');
        const [avgMarksRows] = await pool.query('SELECT AVG(marks) AS avg FROM students');

        return res.json({
          total_students: Number(totalRows[0].total),
          high_risk: Number(highRows[0].count),
          medium_risk: Number(mediumRows[0].count),
          low_risk: Number(lowRows[0].count),
          average_attendance: Number(avgAttendanceRows[0].avg || 0),
          average_marks: Number(avgMarksRows[0].avg || 0),
        });
      }

      const totalRows = await sqliteGet('SELECT COUNT(*) AS total FROM students');
      const highRows = await sqliteGet('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['High']);
      const mediumRows = await sqliteGet('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['Medium']);
      const lowRows = await sqliteGet('SELECT COUNT(*) AS count FROM students WHERE risk_level = ?', ['Low']);
      const avgAttendanceRows = await sqliteGet('SELECT AVG(attendance) AS avg FROM students');
      const avgMarksRows = await sqliteGet('SELECT AVG(marks) AS avg FROM students');

      return res.json({
        total_students: Number(totalRows.total),
        high_risk: Number(highRows.count),
        medium_risk: Number(mediumRows.count),
        low_risk: Number(lowRows.count),
        average_attendance: Number(avgAttendanceRows.avg || 0),
        average_marks: Number(avgMarksRows.avg || 0),
      });
    } catch (error) {
      return res.status(500).json({ message: 'Failed to load summary', error: error.message });
    }
  });

  const server = app.listen(PORT, () => {
    console.log(`Dropguard backend running on http://localhost:${PORT} (${pool ? 'mysql' : 'sqlite'})`);
  });

  server.on('error', error => {
    if (error.code === 'EADDRINUSE') {
      console.error(`Port ${PORT} is already in use. The app may already be running at http://localhost:${PORT}/`);
      process.exit(1);
    }
    throw error;
  });
}

startServer().catch(error => {
  console.error('Failed to start Dropguard backend:', error.message);
  process.exit(1);
});
