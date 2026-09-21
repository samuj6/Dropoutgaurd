/* ============================================================
   1. TINY HELPERS
   ============================================================ */
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g,
  c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const API_BASE = window.DG_API_BASE || 'http://localhost:5000';

async function api(path, options = {}) {
  const headers = {'Content-Type': 'application/json', ...(options.headers || {})};
  const token = localStorage.getItem('dg_token');
  if (token) headers.Authorization = 'Bearer ' + token;
  const response = await fetch(API_BASE + path, {...options, headers});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.message || 'Backend request failed');
  return data;
}

function fromApiStudent(row) {
  const student = {
    id: row.student_id,
    name: row.name,
    cls: row.class_name,
    attendance: Number(row.attendance || 0),
    marks: Number(row.marks || 0),
    absenceCount: Number(row.absence_count || 0),
    consecutive: Number(row.consecutive_absences || 0),
    localFactor: row.local_factor || 'None',
    attSeries: row.att_series || [],
    marksSeries: row.marks_series || [],
    risk: Number(row.risk_score || 0),
    level: row.risk_level || 'Low',
    why: row.why || [],
    next: row.next_steps || [],
    history: [],
    interventions: []
  };
  return student;
}

async function loadBackendStudents() {
  const rows = await api('/students');
  DB.students = rows.map(fromApiStudent);
  store.save();
}

/* ---------- dark / light theme ---------- */
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  const btn = $('#themeToggle');
  if (btn) btn.textContent = mode === 'dark' ? '☀️ Light' : '🌙 Dark';
  try { localStorage.setItem('dg_theme', mode); } catch (e) { /* ignore */ }
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}
function loadTheme() {
  let saved = 'light';
  try { saved = localStorage.getItem('dg_theme') || 'light'; } catch (e) {}
  applyTheme(saved);
}

function flash(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'flash ' + type;
  el.textContent = msg;
  $('#flash').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

/* localStorage is optional — the app works without it */
const store = {
  save() {
    try { localStorage.setItem('dg_state', JSON.stringify({students: DB.students, users: DB.users, requests: DB.requests})); }
    catch (e) { /* storage blocked, keep everything in memory */ }
  },
  load() {
    try {
      const raw = localStorage.getItem('dg_state');
      if (!raw) return null;
      return JSON.parse(raw);
    } catch (e) { return null; }
  },
  clear() { try { localStorage.removeItem('dg_state'); } catch (e) {} }
};

/* ============================================================
   2. AI LAYER — risk score, WHY, WHAT NEXT
   ============================================================ */
const FACTOR_WEIGHT = {
  'none': 0, 'transport issue': 1, 'family illness': 1, 'financial issues': 2,
  'migration': 2, 'farm work': 2, 'child labour': 2, 'early marriage pressure': 2
};

/* average change per period. negative = falling */
function slope(values) {
  const v = values.filter(x => x !== null && x !== undefined && !isNaN(x)).map(Number);
  if (v.length < 2) return 0;
  const n = v.length, mx = (n - 1) / 2;
  const my = v.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  v.forEach((y, i) => { num += (i - mx) * (y - my); den += (i - mx) ** 2; });
  return den === 0 ? 0 : num / den;
}

function factorWeight(f) {
  const key = String(f || 'none').trim().toLowerCase();
  return key in FACTOR_WEIGHT ? FACTOR_WEIGHT[key] : 1;
}

/*
  The score is deliberately trend-based: two of the seven inputs are slopes,
  so a single absent day can never move a student into High risk.
  (In the Python version a Random Forest is blended with these same rules.)
*/
function riskScore(s) {
  const attS = s.attSeries && s.attSeries.length ? s.attSeries : [s.attendance];
  const mkS = s.marksSeries && s.marksSeries.length ? s.marksSeries : [s.marks];
  const aSlope = slope(attS), mSlope = slope(mkS), fw = factorWeight(s.localFactor);
  let score = 0;
  score += Math.max(0, 75 - s.attendance) * 0.8;        // low attendance
  score += Math.max(0, 50 - s.marks) * 0.5;             // low marks
  score += Math.min(s.absenceCount, 25) * 0.8;          // total absences
  score += Math.min(s.consecutive, 15) * 1.2;           // consecutive absences
  score += Math.max(0, -aSlope) * 1.6;                  // FALLING attendance trend
  score += Math.max(0, -mSlope) * 1.0;                  // FALLING marks trend
  score += fw * 7;                                      // local / context factor
  score = Math.min(99, Math.max(2, score));
  return {score: Math.round(score * 10) / 10, aSlope, mSlope, fw};
}

const levelOf = sc => sc >= 70 ? 'High' : sc >= 40 ? 'Medium' : 'Low';

function buildWhy(s, r) {
  const why = [], a = s.attSeries || [], m = s.marksSeries || [];
  if (r.aSlope <= -2 && a.length > 1)
    why.push('Attendance has been continuously declining (' + a.map(v => Math.round(v) + '%').join(' → ') + ')');
  if (s.attendance < 60) why.push('Overall attendance is only ' + Math.round(s.attendance) + '%, far below the safe level');
  else if (s.attendance < 75 && r.aSlope > -2) why.push("Attendance is below 75%, the school's minimum");
  if (r.mSlope <= -2 && m.length > 1)
    why.push('Academic performance is declining (' + m.map(v => Math.round(v) + '%').join(' → ') + ')');
  if (s.marks < 40) why.push('Marks are below the passing level (' + Math.round(s.marks) + '%)');
  if (s.consecutive >= 5) why.push('Repeated consecutive absences detected (' + s.consecutive + ' days in a row)');
  else if (s.absenceCount >= 10) why.push('High number of absences this term (' + s.absenceCount + ' days)');
  if (r.fw >= 1 && String(s.localFactor).toLowerCase() !== 'none')
    why.push('Context factor reported by the school: ' + s.localFactor);
  if (!why.length) why.push('No major warning signs. Attendance and marks are stable.');
  return why;
}

function buildNext(s, r, level) {
  const next = [];
  if (level === 'High') {
    next.push('Contact the parent/guardian this week');
    next.push('Talk to the student personally and note the reason for absence');
  } else if (level === 'Medium') {
    next.push('Call the parent/guardian for an update');
    next.push('Talk to the student during the next class');
  }
  if (s.marks < 45 || r.mSlope <= -2) next.push('Provide academic support / remedial classes');
  if (r.aSlope <= -2 || s.attendance < 75 || s.consecutive >= 5) next.push('Monitor daily attendance for the next 4 weeks');
  if (r.fw >= 2) next.push('Check eligibility for scholarship / mid-day meal / transport support');
  if (level !== 'Low') next.push('Schedule a follow-up review after 15 days');
  if (!next.length) next.push('No action needed right now — keep monitoring normally');
  return next;
}

/*
  Extra, more concrete plan shown only when attendance has fallen below 50% —
  at that point general advice ("monitor attendance") isn't enough, the school
  needs a specific week-by-week recovery plan.
*/
function buildRecoveryPlan(s) {
  if (s.attendance >= 50) return null;
  const plan = [
    'Meet the parent/guardian in person within 3 days, not just a phone call',
    'Find the real reason first — ask about transport, money, health or work at home before assuming disinterest',
    'Set a short, visible target: attend at least 4 days this coming week',
    'Assign a buddy student or mentor teacher to check in on them daily',
    'Give a personal attendance calendar to the student — a simple tick-mark chart works well',
    'If Local Factor is Financial issues or Migration, connect the family to the school\'s scholarship, free-textbook or mid-day-meal scheme',
    'Hold remedial classes to catch up missed portions, so schoolwork doesn\'t feel impossible',
    'Re-check attendance every week for one month before considering the case improved'
  ];
  if (s.consecutive >= 5) plan.unshift('Home visit within 48 hours — ' + s.consecutive + ' consecutive absences need an in-person check, not a phone call');
  return plan;
}

/* run the whole AI layer on one student object */
function analyse(s) {
  const r = riskScore(s);
  s.risk = r.score;
  s.level = levelOf(r.score);
  s.why = buildWhy(s, r);
  s.next = buildNext(s, r, s.level);
  s.history = s.history || [];
  s.history.push({date: new Date().toLocaleString('en-IN', {day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'}), score: s.risk});
  s.interventions = s.interventions || [];
  return s;
}

/* ============================================================
   3. DEMO DATA — stands in for the school MIS export
   ============================================================ */
let seed = 7;
const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
const gauss = (mu, sd) => mu + sd * (Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()));

const FIRST = ['Rahul','Priya','Amit','Sneha','Arjun','Kavya','Rohan','Meera','Vikas','Anjali','Sahil','Pooja','Nikhil','Divya','Karan','Neha','Suresh','Ritu','Manish','Aarti'];
const LAST = ['Sharma','Patil','Verma','Yadav','Joshi','Kale','Singh','Pawar','Gupta','Jadhav'];
const CLASSES = ['Class 6','Class 7','Class 8','Class 9','Class 10'];
const FACTORS = ['None','None','None','None','Financial issues','Migration','Family illness','Farm work','Transport issue','Early marriage pressure'];
const pick = arr => arr[Math.floor(rnd() * arr.length)];

function makeDemoStudents(n = 60) {
  seed = 7;
  const out = [];
  for (let i = 1; i <= n; i++) {
    /* "trouble" is a hidden 0–1 value, so risk spreads smoothly across Low/Medium/High */
    const t = Math.pow(rnd(), 1.6);
    const a1 = Math.round(Math.min(99, gauss(93 - 15 * t, 4)));
    const drop = Math.round(Math.max(-2, gauss(18 * t - 2, 3)));
    const m1 = Math.round(Math.min(98, gauss(83 - 35 * t, 7)));
    const mdrop = Math.round(Math.max(-3, gauss(16 * t - 2, 4)));
    const a2 = Math.max(20, a1 - drop), a3 = Math.max(15, a2 - drop), m2 = Math.max(10, m1 - mdrop);
    out.push({
      id: 'S' + String(i).padStart(3, '0'),
      name: pick(FIRST) + ' ' + pick(LAST),
      cls: pick(CLASSES),
      attendance: a3, marks: m2,
      absenceCount: Math.round((100 - a3) * 0.35),
      consecutive: Math.max(0, Math.round(gauss(11 * t - 1, 2))),
      localFactor: pick(FACTORS),
      attSeries: [a1, a2, a3], marksSeries: [m1, m2]
    });
  }
  /* the student from the pitch deck */
  out[0] = {id: 'S001', name: 'Rahul Sharma', cls: 'Class 9', attendance: 52, marks: 46,
    absenceCount: 12, consecutive: 7, localFactor: 'Financial issues',
    attSeries: [78, 65, 52], marksSeries: [61, 46]};
  return out.map(analyse);
}

const DB = {students: [], users: [], requests: [], user: null};

function boot() {
  const saved = store.load();
  if (saved && saved.students && saved.students.length) {
    DB.students = saved.students; DB.users = saved.users || []; DB.requests = saved.requests || [];
  } else {
    DB.students = makeDemoStudents();
    DB.users = [
      {name: 'Anita Rao', email: 'admin@demo.in', password: '1234', role: 'teacher', school: 'ZP High School', teacherId: 'T-001', subject: 'Principal', position: 'admin', myClass: null},
      {name: 'Rekha Deshmukh', email: 'teacher@demo.in', password: '1234', role: 'teacher', school: 'ZP High School', teacherId: 'T-014', subject: 'Mathematics', position: 'class_teacher', myClass: 'Class 9'},
      {name: 'Rahul Sharma', email: 'student@demo.in', password: '1234', role: 'student', studentId: 'S001', cls: 'Class 9'},
      {name: 'Suresh Sharma', email: 'parent@demo.in', password: '1234', role: 'parent', studentId: 'S001', contact: '98XXXXXX21'}
    ];
    store.save();
  }
}

const findStudent = id => DB.students.find(s => s.id === String(id || '').trim().toUpperCase());

/* ============================================================
   4. CSV UPLOAD — same columns as the school MIS export
   ============================================================ */
function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/).filter(l => l.trim());
  const head = lines[0].split(',').map(h => h.trim().toLowerCase().replace(/ /g, '_'));
  return lines.slice(1).map(line => {
    const cells = line.split(',');
    const row = {};
    head.forEach((h, i) => row[h] = (cells[i] || '').trim());
    return row;
  });
}

function importRows(rows) {
  const need = ['student_id', 'name', 'attendance', 'marks'];
  const missing = need.filter(c => !(c in rows[0]));
  if (missing.length) { flash('File is missing these columns: ' + missing.join(', '), 'error'); return; }

  let created = 0, updated = 0;
  rows.forEach(r => {
    const id = String(r.student_id || '').toUpperCase();
    if (!id) return;
    const num = (k, d = 0) => r[k] === undefined || r[k] === '' ? d : Number(r[k]);
    let s = findStudent(id);
    const prevAtt = s ? s.attendance : null, prevMarks = s ? s.marks : null;
    if (!s) { s = {id: id, history: [], interventions: []}; DB.students.push(s); created++; } else updated++;

    s.name = r.name || s.name;
    s.cls = r.class || s.cls || '';
    s.attendance = num('attendance');
    s.marks = num('marks');
    s.absenceCount = num('absence_count');
    s.consecutive = num('consecutive_absences');
    s.localFactor = r.local_factor || 'None';

    const monthly = ['attendance_m1', 'attendance_m2', 'attendance_m3']
      .filter(k => r[k] !== undefined && r[k] !== '').map(k => Number(r[k]));
    const terms = ['marks_t1', 'marks_t2']
      .filter(k => r[k] !== undefined && r[k] !== '').map(k => Number(r[k]));

    /* if the file has no history columns, compare against the previous upload
       so a trend still builds up over time */
    s.attSeries = monthly.length ? monthly : (prevAtt !== null ? [prevAtt, s.attendance] : [s.attendance]);
    s.marksSeries = terms.length ? terms : (prevMarks !== null ? [prevMarks, s.marks] : [s.marks]);
    analyse(s);
  });
  store.save();
  flash('File processed: ' + created + ' new students, ' + updated + ' updated.');
  go('teacher');
}

function downloadSampleCSV() {
  const head = 'Student_ID,Name,Class,Attendance,Marks,Absence_Count,Local_Factor,Attendance_M1,Attendance_M2,Attendance_M3,Marks_T1,Marks_T2,Consecutive_Absences';
  const body = makeDemoStudents().map(s => [s.id, s.name, s.cls, s.attendance, s.marks, s.absenceCount,
    s.localFactor, s.attSeries[0], s.attSeries[1], s.attSeries[2], s.marksSeries[0], s.marksSeries[1], s.consecutive].join(','));
  const blob = new Blob([[head].concat(body).join('\n')], {type: 'text/csv'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'sample_students.csv';
  a.click();
  URL.revokeObjectURL(a.href);
}

/* ============================================================
   5. SCREENS
   ============================================================ */
let charts = [];
const killCharts = () => { charts.forEach(c => c.destroy()); charts = []; };

function go(screen, arg) {
  killCharts();
  window.scrollTo(0, 0);
  const guard = {teacher: 'teacher', student: 'student', parent: 'parent', detail: 'teacher'}[screen];
  if (guard && (!DB.user || DB.user.role !== guard)) { flash('Please log in first.', 'error'); screen = 'login'; }
  ({landing: sLanding, signup: sSignup, login: sLogin, teacher: sTeacher,
    detail: sDetail, student: sStudent, parent: sParent}[screen] || sLanding)(arg);
  renderNav();
}

function renderNav() {
  $('#navRight').innerHTML = DB.user
    ? '<span class="small">' + esc(DB.user.name) + ' (' + esc(DB.user.role) + ')</span>' +
      '<a onclick="go(\'' + DB.user.role + '\')">Dashboard</a><a onclick="logout()">Log out</a>'
    : '<a onclick="go(\'login\')">Log in</a><a onclick="go(\'signup\')">Create account</a>';
}

function logout() { DB.user = null; flash('Logged out.'); go('landing'); }

/* ---------- landing ---------- */
function sLanding() {
  $('#app').innerHTML = `
  <section class="hero">
    <h1>Identify Early. Intervene Early. Prevent Dropout.</h1>
    <p>A school already stores attendance and marks in its MIS. DropoutGuard reads that file, finds
       the students whose trend is falling 2–3 months before they disappear, explains why, and tells
       the teacher exactly what to do next.</p>
    <div class="actions">
      <button class="btn" onclick="go('signup')">Create account</button>
      <button class="btn light" onclick="go('login')">Log in</button>
    </div>
  </section>

  <div class="card">
    <h2>How it works</h2>
    <div class="flow">
      <span>School MIS data</span><span>Data processing</span><span>Trend analysis</span>
      <span>Risk score</span><span>WHY?</span><span>WHAT NEXT?</span>
      <span>Teacher intervention</span><span>Monitor progress</span>
    </div>
  </div>

  <div class="grid g3">
    <div class="card"><h3>Trends, not one bad day</h3>
      <p class="muted small">Three months of attendance, two terms of marks, consecutive absences and
      local factors all feed the score, so one absence never triggers an alert.</p></div>
    <div class="card"><h3>Explainable WHY</h3>
      <p class="muted small">Every alert lists the exact reasons — falling attendance, declining marks,
      repeated absences, reported family or financial difficulty.</p></div>
    <div class="card"><h3>WHAT NEXT for the teacher</h3>
      <p class="muted small">Each student gets an action list, and the teacher records what was actually
      done so the risk can be tracked over time.</p></div>
  </div>`;
}

/* ---------- signup ---------- */
function sSignup() {
  $('#app').innerHTML = `
  <div class="card auth">
    <h1>Create your account</h1>
    <p class="muted small">Pick your role — the form asks only for what that role needs.</p>
    <label for="role">I am a</label>
    <select id="role" onchange="roleFields()">
      <option value="teacher">Teacher / Admin</option>
      <option value="student">Student</option>
      <option value="parent">Parent / Guardian</option>
    </select>
    <div class="row">
      <div><label for="su_name">Full name</label><input id="su_name"></div>
      <div><label for="su_email">Email</label><input id="su_email" type="email"></div>
    </div>
    <label for="su_pass">Password</label><input id="su_pass" type="password">

    <div id="f_teacher">
      <div class="row">
        <div><label for="su_school">School name</label><input id="su_school"></div>
        <div><label for="su_tid">Teacher ID</label><input id="su_tid"></div>
      </div>
      <label for="su_subject">Subject / Department</label><input id="su_subject">
      <label for="su_position">Position</label>
      <select id="su_position" onchange="positionFields()">
        <option value="class_teacher">Class Teacher (sees only my class)</option>
        <option value="admin">Admin / Principal (sees the whole school)</option>
      </select>
      <div id="f_classteacher">
        <label for="su_myclass">Which class do you teach?</label>
        <select id="su_myclass">
          <option>Class 6</option><option>Class 7</option><option>Class 8</option>
          <option>Class 9</option><option>Class 10</option>
        </select>
      </div>
    </div>
    <div id="f_student" class="hide">
      <div class="row">
        <div><label for="su_sid">Student ID (e.g. S001)</label><input id="su_sid"></div>
        <div><label for="su_cls">Class / Grade</label><input id="su_cls"></div>
      </div>
      <label for="su_parent">Parent / Guardian name</label><input id="su_parent">
    </div>
    <div id="f_parent" class="hide">
      <div class="row">
        <div><label for="su_pid">Your child's Student ID (e.g. S001)</label><input id="su_pid"></div>
        <div><label for="su_contact">Contact number</label><input id="su_contact"></div>
      </div>
    </div>
    <p></p>
    <button class="btn" onclick="doSignup()">Create account</button>
    <p class="small muted">Already registered? <a onclick="go('login')">Log in</a></p>
  </div>`;
}

function roleFields() {
  const r = $('#role').value;
  ['teacher', 'student', 'parent'].forEach(x =>
    $('#f_' + x).classList.toggle('hide', x !== r));
  if (r === 'teacher') positionFields();
}
function positionFields() {
  const p = $('#su_position').value;
  $('#f_classteacher').classList.toggle('hide', p !== 'class_teacher');
}

function doSignup() {
  const role = $('#role').value;
  const u = {
    name: $('#su_name').value.trim(),
    email: $('#su_email').value.trim().toLowerCase(),
    password: $('#su_pass').value,
    role: role
  };
  if (!u.name || !u.email || !u.password) { flash('Fill in name, email and password.', 'error'); return; }
  if (DB.users.some(x => x.email === u.email)) { flash('That email is already registered.', 'error'); return; }
  if (role === 'teacher') {
    u.school = $('#su_school').value; u.teacherId = $('#su_tid').value; u.subject = $('#su_subject').value;
    u.position = $('#su_position').value; // 'admin' or 'class_teacher'
    u.myClass = u.position === 'class_teacher' ? $('#su_myclass').value : null;
  } else if (role === 'student') {
    u.studentId = $('#su_sid').value.trim().toUpperCase(); u.cls = $('#su_cls').value;
  } else {
    u.studentId = $('#su_pid').value.trim().toUpperCase(); u.contact = $('#su_contact').value;
  }
  DB.users.push(u); store.save();
  flash('Account created. Please log in.');
  go('login');
}

/* ---------- login ---------- */
function sLogin() {
  $('#app').innerHTML = `
  <div class="card auth">
    <h1>Log in</h1>
    <label for="li_email">Email</label><input id="li_email" type="email" value="teacher@demo.in">
    <label for="li_pass">Password</label><input id="li_pass" type="password" value="1234">
    <p></p>
    <button class="btn" onclick="doLogin()">Log in</button>
    <p class="small muted">Demo accounts (password <b>1234</b>): admin@demo.in (Principal, all classes) ·
      teacher@demo.in (Class 9 teacher) · student@demo.in · parent@demo.in</p>
    <p class="small muted">New here? <a onclick="go('signup')">Create an account</a></p>
  </div>`;
}

async function doLogin() {
  const email = $('#li_email').value.trim().toLowerCase(), pass = $('#li_pass').value;
  if (!email || !pass) { flash('Enter your email and password.', 'error'); return; }

  try {
    const result = await api('/auth/login', {
      method: 'POST',
      body: JSON.stringify({email, password: pass})
    });
    const user = result.user;
    DB.user = {
      ...user,
      teacherId: user.teacher_id,
      studentId: user.student_id,
      myClass: user.class_name,
      position: user.position || (user.role === 'teacher' ? 'class_teacher' : undefined)
    };
    localStorage.setItem('dg_token', result.token);
    await loadBackendStudents();
    go(user.role);
  } catch (error) {
    const localUser = DB.users.find(x => x.email === email && x.password === pass);
    if (!localUser) { flash(error.message || 'Wrong email or password.', 'error'); return; }
    DB.user = localUser;
    flash('Backend unavailable. Using local demo data.', 'error');
    go(localUser.role);
  }
}
function logout() {
  DB.user = null;
  localStorage.removeItem('dg_token');
  flash('Logged out.');
  go('landing');
}

/* ---------- teacher dashboard ---------- */
function sTeacher() {
  const isAdmin = DB.user.position !== 'class_teacher';
  const scope = isAdmin ? DB.students : DB.students.filter(s => s.cls === DB.user.myClass);
  const list = scope.slice().sort((a, b) => b.risk - a.risk);
  const scopeLabel = isAdmin
    ? '<span class="pill">Admin — all classes</span>'
    : '<span class="pill">Class Teacher — ' + esc(DB.user.myClass) + ' only</span>';
  const counts = {High: 0, Medium: 0, Low: 0};
  const byClass = {};
  list.forEach(s => {
    counts[s.level]++;
    (byClass[s.cls || 'Unknown'] = byClass[s.cls || 'Unknown'] || {High: 0, Medium: 0, Low: 0})[s.level]++;
  });
  const avg = list.length ? Math.round(list.reduce((a, s) => a + s.attendance, 0) / list.length) : 0;
  const scopeIds = new Set(list.map(s => s.id));
  const pending = DB.requests.filter(r => r.status === 'Pending' && (isAdmin || scopeIds.has(r.studentId)));

  $('#app').innerHTML = `
  <h1>Teacher dashboard</h1>
  <p class="muted small">${scopeLabel} — Upload the attendance and marks export from your school MIS.
  Students who need you most are sorted to the top.</p>

  <div class="card">
    <h2>Upload MIS file</h2>
    <input type="file" id="csvFile" accept=".csv">
    <p></p>
    <button class="btn" onclick="handleUpload()">Upload and analyse</button>
    <button class="btn light" onclick="downloadSampleCSV()">Download sample CSV</button>
    <p class="small muted">Required: Student_ID, Name, Class, Attendance, Marks, Absence_Count, Local_Factor.
    Optional (used for trend analysis): Attendance_M1–M3, Marks_T1–T2, Consecutive_Absences.</p>
  </div>

  <div class="grid g4">
    <div class="card stat"><div class="value">${list.length}</div><div class="label">Students analysed</div></div>
    <div class="card stat"><div class="value" style="color:var(--red)">${counts.High}</div><div class="label">High risk</div></div>
    <div class="card stat"><div class="value" style="color:var(--amber)">${counts.Medium}</div><div class="label">Medium risk</div></div>
    <div class="card stat"><div class="value">${avg}%</div><div class="label">Average attendance</div></div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Risk distribution</h2><canvas id="pie" height="210"></canvas></div>
    <div class="card"><h2>Risk by class</h2><canvas id="bars" height="210"></canvas></div>
  </div>

  ${pending.length ? `<div class="card"><h2>Requests from students and parents</h2><div class="tablewrap"><table>
    <tr><th>From</th><th>Student ID</th><th>Type</th><th>Message</th><th></th></tr>
    ${pending.map((r, i) => `<tr><td>${esc(r.from)} <span class="small muted">(${esc(r.role)})</span></td>
      <td>${esc(r.studentId)}</td><td>${esc(r.type)}</td><td class="small">${esc(r.message)}</td>
      <td><button class="btn small light" onclick="closeRequest(${DB.requests.indexOf(r)})">Mark handled</button></td></tr>`).join('')}
    </table></div></div>` : ''}

  <div class="card">
    <h2>Students by risk</h2>
    <div class="tablewrap"><table>
      <tr><th>ID</th><th>Name</th><th>Class</th><th>Attendance</th><th>Marks</th><th>Absences</th>
          <th>Risk score</th><th>Level</th><th></th></tr>
      ${list.map(s => `<tr>
        <td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.cls)}</td>
        <td>${Math.round(s.attendance)}%</td><td>${Math.round(s.marks)}%</td><td>${s.absenceCount}</td>
        <td style="min-width:110px"><div class="bar"><i class="${s.level}" style="width:${s.risk}%"></i></div>
          <span class="small muted">${s.risk}%</span></td>
        <td><span class="badge ${s.level}">${s.level}</span></td>
        <td><button class="btn small light" onclick="go('detail','${s.id}')">Open</button></td></tr>`).join('')}
    </table></div>
  </div>`;

  charts.push(new Chart($('#pie'), {
    type: 'doughnut',
    data: {labels: ['High', 'Medium', 'Low'],
      datasets: [{data: [counts.High, counts.Medium, counts.Low],
        backgroundColor: ['#C0392B', '#C98A15', '#2E7D4F']}]},
    options: {plugins: {legend: {position: 'bottom'}}}
  }));

  const cls = Object.keys(byClass).sort();
  charts.push(new Chart($('#bars'), {
    type: 'bar',
    data: {labels: cls, datasets: [
      {label: 'High', data: cls.map(c => byClass[c].High), backgroundColor: '#C0392B'},
      {label: 'Medium', data: cls.map(c => byClass[c].Medium), backgroundColor: '#C98A15'},
      {label: 'Low', data: cls.map(c => byClass[c].Low), backgroundColor: '#8FA9CE'}]},
    options: {plugins: {legend: {position: 'bottom'}},
      scales: {x: {stacked: true}, y: {stacked: true, beginAtZero: true}}}
  }));
}

function handleUpload() {
  const f = $('#csvFile').files[0];
  if (!f) { flash('Choose a CSV file first.', 'error'); return; }
  const reader = new FileReader();
  reader.onload = e => {
    try { importRows(parseCSV(e.target.result)); }
    catch (err) { flash('Could not read that file. Check it is a plain CSV.', 'error'); }
  };
  reader.onerror = () => flash('Could not read that file.', 'error');
  reader.readAsText(f);
}

function closeRequest(i) { DB.requests[i].status = 'Handled'; store.save(); flash('Marked as handled.'); go('teacher'); }

/* ---------- student risk detail ---------- */
function sDetail(id) {
  const s = findStudent(id);
  if (!s) { flash('Student not found.', 'error'); return go('teacher'); }

  const recovery = buildRecoveryPlan(s);

  $('#app').innerHTML = `
  <p class="small"><a onclick="go('teacher')">← Back to dashboard</a></p>
  ${recovery ? `<div class="recovery">
    <h2>⚠ Attendance Recovery Plan (attendance is below 50%)</h2>
    <p class="small muted">General monitoring isn't enough at this stage — here's a concrete,
    week-by-week plan to bring attendance back up.</p>
    <ul class="list next">${recovery.map(r => '<li>' + esc(r) + '</li>').join('')}</ul>
  </div>` : ''}
  <div class="card">
    <h1>${esc(s.name)} <span class="badge ${s.level}">${s.level} risk</span></h1>
    <p class="muted small">${esc(s.id)} · ${esc(s.cls)} · context factor on record: <b>${esc(s.localFactor)}</b></p>
    <div class="grid g4">
      <div class="stat"><div class="value">${s.risk}%</div><div class="label">Dropout risk score</div></div>
      <div class="stat"><div class="value">${Math.round(s.attendance)}%</div><div class="label">Attendance</div></div>
      <div class="stat"><div class="value">${Math.round(s.marks)}%</div><div class="label">Marks</div></div>
      <div class="stat"><div class="value">${s.absenceCount}</div><div class="label">Absences (${s.consecutive} in a row)</div></div>
    </div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Why this student is flagged</h2>
      <ul class="list why">${s.why.map(w => '<li>' + esc(w) + '</li>').join('')}</ul></div>
    <div class="card"><h2>What to do next</h2>
      <ul class="list next">${s.next.map(n => '<li>' + esc(n) + '</li>').join('')}</ul></div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Attendance and marks trend</h2><canvas id="trend" height="210"></canvas></div>
    <div class="card"><h2>Risk score over time</h2><canvas id="hist" height="210"></canvas>
      <p class="small muted">Each point is one MIS upload. A falling line means the intervention is working.</p></div>
  </div>

  <div class="card">
    <h2>Record an intervention</h2>
    <div class="row">
      <div><label for="iv_action">Action taken</label>
        <select id="iv_action">
          <option>Contacted parent/guardian</option><option>Talked to the student</option>
          <option>Arranged academic support</option><option>Home visit</option>
          <option>Referred for scholarship / financial help</option><option>Attendance monitoring started</option>
        </select></div>
      <div><label for="iv_status">Status</label>
        <select id="iv_status"><option>In progress</option><option>Completed</option></select></div>
    </div>
    <label for="iv_date">Follow-up date</label><input id="iv_date" type="date">
    <label for="iv_notes">Notes</label>
    <textarea id="iv_notes" rows="3" placeholder="What did the parent or student say?"></textarea>
    <p></p>
    <button class="btn" onclick="saveIntervention('${s.id}')">Save intervention</button>
  </div>

  <div class="card">
    <h2>Intervention history</h2>
    ${s.interventions.length ? `<div class="tablewrap"><table>
      <tr><th>Date</th><th>Action</th><th>By</th><th>Status</th><th>Follow-up</th><th>Notes</th></tr>
      ${s.interventions.map(i => `<tr><td>${esc(i.date)}</td><td>${esc(i.action)}</td><td>${esc(i.by)}</td>
        <td>${esc(i.status)}</td><td>${esc(i.followUp || '—')}</td><td class="small">${esc(i.notes)}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">Nothing recorded yet. Save your first action above.</p>'}
  </div>`;

  charts.push(new Chart($('#trend'), {
    type: 'line',
    data: {labels: s.attSeries.map((_, i) => 'Period ' + (i + 1)), datasets: [
      {label: 'Attendance %', data: s.attSeries, borderColor: '#5579AC', backgroundColor: '#5579AC', tension: .3},
      {label: 'Marks %', data: s.marksSeries, borderColor: '#C98A15', backgroundColor: '#C98A15', tension: .3}]},
    options: {plugins: {legend: {position: 'bottom'}}, scales: {y: {min: 0, max: 100}}}
  }));

  charts.push(new Chart($('#hist'), {
    type: 'line',
    data: {labels: s.history.map(h => h.date),
      datasets: [{label: 'Risk score', data: s.history.map(h => h.score),
        borderColor: '#C0392B', backgroundColor: '#C0392B', tension: .3}]},
    options: {plugins: {legend: {display: false}}, scales: {y: {min: 0, max: 100}}}
  }));
}

function saveIntervention(id) {
  const s = findStudent(id);
  s.interventions.unshift({
    date: new Date().toLocaleDateString('en-IN', {day: '2-digit', month: 'short', year: 'numeric'}),
    action: $('#iv_action').value, status: $('#iv_status').value,
    followUp: $('#iv_date').value, notes: $('#iv_notes').value, by: DB.user ? DB.user.name : 'Teacher'
  });
  store.save();
  flash('Intervention recorded.');
  go('detail', id);
}

/* ---------- student dashboard ---------- */
function sStudent() {
  const s = findStudent(DB.user.studentId);
  if (!s) {
    $('#app').innerHTML = `<div class="card"><h2>We can't find your records yet</h2>
      <p class="muted">Your account is linked to Student ID <b>${esc(DB.user.studentId || 'not set')}</b>,
      but your school has not uploaded that ID yet. Ask your class teacher to upload the latest file.</p></div>`;
    return;
  }
  const msg = s.level === 'High'
    ? 'Your attendance and marks have dropped enough that your teacher has been alerted. This is not a punishment — it means help is on the way. Coming back regularly now makes a big difference.'
    : s.level === 'Medium'
    ? 'You have missed a few classes and your marks have slipped a little. Nothing serious yet — a steady month will put you back on track.'
    : 'You are on track. Keep attending regularly and keep it up.';
  const lowAttendance = s.attendance < 50;

  $('#app').innerHTML = `
  <h1>Hello, ${esc(s.name.split(' ')[0])}</h1>
  ${lowAttendance ? `<div class="recovery">
    <h2>Let's get your attendance back up</h2>
    <p class="small">Your attendance is at ${Math.round(s.attendance)}%. That's a big drop, but it can be
    fixed with small, steady steps:</p>
    <ul class="list next">
      <li>Try to attend at least 4 days this coming week — one small goal at a time</li>
      <li>Talk to your teacher about what's making it hard to come to school</li>
      <li>Ask a friend to walk or travel with you, it helps on the tough days</li>
      <li>Ask your teacher for a short catch-up session for what you've missed</li>
    </ul>
  </div>` : ''}
  <div class="grid g3">
    <div class="card stat"><div class="value">${Math.round(s.attendance)}%</div><div class="label">Your attendance</div></div>
    <div class="card stat"><div class="value">${Math.round(s.marks)}%</div><div class="label">Your marks</div></div>
    <div class="card stat"><div class="value">${s.absenceCount}</div><div class="label">Days missed</div></div>
  </div>

  <div class="card">
    <h2>How you are doing</h2>
    <p>${msg}</p>
    <div class="bar"><i class="${s.level}" style="width:${s.risk}%"></i></div>
    <p class="small muted">Support level: ${s.level}</p>
  </div>

  <div class="grid g2">
    <div class="card"><h2>What the school noticed</h2>
      <ul class="list why">${s.why.map(w => '<li>' + esc(w) + '</li>').join('')}</ul></div>
    <div class="card"><h2>What can help</h2>
      <ul class="list next">${s.next.map(n => '<li>' + esc(n) + '</li>').join('')}</ul></div>
  </div>

  <div class="card">
    <h2>Ask your teacher for help</h2>
    <label for="rq_type">What do you need?</label>
    <select id="rq_type"><option>Academic support</option><option>Talk to my teacher</option>
      <option>Help with fees or materials</option></select>
    <label for="rq_msg">Tell your teacher a little more</label>
    <textarea id="rq_msg" rows="3" placeholder="For example: I missed the maths chapters in October."></textarea>
    <p></p>
    <button class="btn" onclick="sendRequest('student','${s.id}')">Send request</button>
  </div>`;
}

/* ---------- parent dashboard ---------- */
function sParent() {
  const s = findStudent(DB.user.studentId);
  if (!s) {
    $('#app').innerHTML = `<div class="card"><h2>No records found</h2>
      <p class="muted">This account is linked to Student ID <b>${esc(DB.user.studentId || 'not set')}</b>.
      Please check the ID with the class teacher.</p></div>`;
    return;
  }
  const lowAttendance = s.attendance < 50;
  $('#app').innerHTML = `
  <h1>Your child's progress</h1>
  ${lowAttendance ? `<div class="recovery">
    <h2>Attendance needs urgent attention</h2>
    <p class="small">Attendance is at ${Math.round(s.attendance)}%, which is well below a safe level.
    Here's how you can help right now:</p>
    <ul class="list next">
      <li>Talk to your child about what's making it hard to attend — transport, health, money or work at home</li>
      <li>Set a simple, shared goal: attend at least 4 days this coming week</li>
      <li>Reach out to the class teacher — schools often have support for exactly this situation</li>
      <li>If cost or distance is the issue, ask the school about scholarship, mid-day meal or transport support</li>
    </ul>
  </div>` : ''}
  <div class="card">
    <h2>${esc(s.name)} <span class="badge ${s.level}">${s.level}</span></h2>
    <p class="muted small">${esc(s.cls)} · Student ID ${esc(s.id)}</p>
    <div class="grid g3">
      <div class="stat"><div class="value">${Math.round(s.attendance)}%</div><div class="label">Attendance</div></div>
      <div class="stat"><div class="value">${Math.round(s.marks)}%</div><div class="label">Marks</div></div>
      <div class="stat"><div class="value">${s.absenceCount}</div><div class="label">Days absent</div></div>
    </div>
  </div>

  <div class="grid g2">
    <div class="card"><h2>Why the school raised an alert</h2>
      <ul class="list why">${s.why.map(w => '<li>' + esc(w) + '</li>').join('')}</ul></div>
    <div class="card"><h2>What the school recommends</h2>
      <ul class="list next">${s.next.map(n => '<li>' + esc(n) + '</li>').join('')}</ul></div>
  </div>

  <div class="card">
    <h2>What the school has already done</h2>
    ${s.interventions.length ? `<div class="tablewrap"><table>
      <tr><th>Date</th><th>Action</th><th>Status</th><th>Follow-up</th></tr>
      ${s.interventions.map(i => `<tr><td>${esc(i.date)}</td><td>${esc(i.action)}</td>
        <td>${esc(i.status)}</td><td>${esc(i.followUp || '—')}</td></tr>`).join('')}
      </table></div>` : '<p class="muted">No action recorded yet.</p>'}
  </div>

  <div class="card">
    <h2>Contact the teacher</h2>
    <label for="rq_type">Reason</label>
    <select id="rq_type"><option>Meeting request</option><option>Explain an absence</option>
      <option>Request academic support</option></select>
    <label for="rq_msg">Message</label>
    <textarea id="rq_msg" rows="3" placeholder="For example: My son was unwell for two weeks in September."></textarea>
    <p></p>
    <button class="btn" onclick="sendRequest('parent','${s.id}')">Send to teacher</button>
  </div>`;
}

function sendRequest(role, studentId) {
  DB.requests.push({role: role, studentId: studentId, from: DB.user.name,
    type: $('#rq_type').value, message: $('#rq_msg').value, status: 'Pending'});
  store.save();
  flash('Your message was sent to the teacher.');
  go(role);
}

/* ============================================================
   6. START
   ============================================================ */
loadTheme();
boot();
go('landing');