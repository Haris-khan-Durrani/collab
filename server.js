require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const nodemailer = require('nodemailer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || 'taskify_ceo_executive_super_secret_key_2026';

app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

// Database Connection Pool
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USERNAME || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_DATABASE || 'taskify1',
  waitForConnections: true,
  connectionLimit: 15,
  queueLimit: 0,
  dateStrings: true
});

// In-Memory Cron & Email Telemetry State
const cronState = {
  lastRunAt: null,
  recurringProcessed: 0,
  recurringMeetingsProcessed: 0,
  remindersSent: 0,
  meetingAlertsSent: 0,
  emailsDispatched: 0,
  recentLogs: [],
  sentMeetingAlertKeys: new Set()
};

// ==========================================
// MEETING GOVERNANCE STORAGE (Settings JSON)
// Stores Recurring Meeting Rules, Attendance, and Minutes of Meeting (MoM)
// ==========================================
async function getMeetingGovernanceStore() {
  try {
    const [rows] = await pool.query("SELECT value FROM settings WHERE variable = 'ceo_meeting_governance' LIMIT 1");
    if (rows.length && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      return {
        recurringRules: Array.isArray(parsed.recurringRules) ? parsed.recurringRules : [],
        records: parsed.records && typeof parsed.records === 'object' ? parsed.records : {}
      };
    }
  } catch (e) {
    console.warn('Load meeting governance store warning:', e.message);
  }
  return { recurringRules: [], records: {} };
}

async function saveMeetingGovernanceStore(store) {
  const jsonStr = JSON.stringify(store);
  const [rows] = await pool.query("SELECT id FROM settings WHERE variable = 'ceo_meeting_governance' LIMIT 1");
  if (rows.length) {
    await pool.query("UPDATE settings SET value = ?, updated_at = NOW() WHERE variable = 'ceo_meeting_governance'", [jsonStr]);
  } else {
    await pool.query("INSERT INTO settings (variable, value, created_at, updated_at) VALUES ('ceo_meeting_governance', ?, NOW(), NOW())", [jsonStr]);
  }
}

// ==========================================
// WORKSPACE 30-DAY DELETION HOLD STORAGE (Settings JSON)
// ==========================================
async function getPendingWorkspaceDeletions() {
  try {
    const [rows] = await pool.query("SELECT value FROM settings WHERE variable = 'ceo_workspace_deletions' LIMIT 1");
    if (rows.length && rows[0].value) {
      const parsed = JSON.parse(rows[0].value);
      return Array.isArray(parsed) ? parsed : [];
    }
  } catch (e) {
    console.warn('Load workspace deletions warning:', e.message);
  }
  return [];
}

async function savePendingWorkspaceDeletions(list) {
  const jsonStr = JSON.stringify(list || []);
  const [rows] = await pool.query("SELECT id FROM settings WHERE variable = 'ceo_workspace_deletions' LIMIT 1");
  if (rows.length) {
    await pool.query("UPDATE settings SET value = ?, updated_at = NOW() WHERE variable = 'ceo_workspace_deletions'", [jsonStr]);
  } else {
    await pool.query("INSERT INTO settings (variable, value, created_at, updated_at) VALUES ('ceo_workspace_deletions', ?, NOW(), NOW())", [jsonStr]);
  }
}

async function getHeldWorkspaceIds() {
  const list = await getPendingWorkspaceDeletions();
  return list.map(x => Number(x.workspace_id)).filter(Boolean);
}

async function permanentlyPurgeWorkspace(wsId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM task_user WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM task_time_entries WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM recurring_tasks WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM tasks WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM project_user WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM client_project WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM project_tag WHERE project_id IN (SELECT id FROM projects WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM projects WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM meeting_user WHERE meeting_id IN (SELECT id FROM meetings WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM client_meeting WHERE meeting_id IN (SELECT id FROM meetings WHERE workspace_id = ?)', [wsId]);
    await conn.query('DELETE FROM meetings WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM user_workspace WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM client_workspace WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM tags WHERE workspace_id = ?', [wsId]);
    await conn.query('DELETE FROM workspaces WHERE id = ?', [wsId]);
    await conn.commit();
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

function addCronLog(type, message) {
  cronState.recentLogs.unshift({
    time: new Date().toISOString().replace('T', ' ').substring(0, 19),
    type,
    message
  });
  if (cronState.recentLogs.length > 40) cronState.recentLogs.pop();
}

function slugify(str) {
  return String(str || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/[\s_-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'item-' + Date.now();
}

function formatTime12h(timeStr) {
  if (!timeStr) return '';
  const parts = String(timeStr).split(':');
  let h = parseInt(parts[0], 10);
  const m = parts[1] || '00';
  if (isNaN(h)) return timeStr;
  const ampm = h >= 12 ? 'PM' : 'AM';
  h = h % 12 || 12;
  return `${h}:${m} ${ampm}`;
}

// ==========================================
// SMTP EMAIL & SYSTEM NOTIFICATION ENGINE
// ==========================================
async function getEmailTransporter() {
  try {
    const [rows] = await pool.query("SELECT variable, value FROM settings WHERE variable IN ('email_settings', 'general_settings')");
    const map = {};
    rows.forEach(r => {
      try { map[r.variable] = JSON.parse(r.value); } catch (e) { map[r.variable] = {}; }
    });
    const es = map.email_settings || {};
    const gs = map.general_settings || {};
    if (!es.smtp_host || !es.email || !es.password) return null;

    const port = Number(es.smtp_port || 587);
    const secure = port === 465 || String(es.smtp_encryption).toLowerCase() === 'ssl';

    const transporter = nodemailer.createTransport({
      host: es.smtp_host,
      port,
      secure,
      auth: {
        user: es.email,
        pass: es.password
      },
      tls: { rejectUnauthorized: false }
    });

    return {
      transporter,
      fromAddress: es.email,
      companyTitle: gs.company_title || 'Docman Taskify CEO Portal'
    };
  } catch (err) {
    console.warn('SMTP config load warning:', err.message);
    return null;
  }
}

// Send Email + Insert into Laravel notifications & notification_user tables
async function notifyUsersAndSendEmail({
  workspace_id,
  from_user_id,
  type, // 'task' | 'project' | 'meeting' | 'reminder'
  type_id,
  action = 'assigned',
  title,
  message,
  emailSubject,
  emailHtml,
  user_ids = [],
  send_email = true
}) {
  const uniqueIds = [...new Set((user_ids || []).map(Number).filter(Boolean))];
  if (uniqueIds.length === 0) return { notified: 0, emailed: 0 };

  let notifiedCount = 0;
  let emailedCount = 0;

  try {
    // 1. Store in Laravel notifications + notification_user tables
    const [nRes] = await pool.query(`
      INSERT INTO notifications (workspace_id, from_id, type, type_id, action, title, message, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      workspace_id || 5,
      `u_${from_user_id || 1}`,
      type,
      type_id,
      action,
      String(title || 'Notification').substring(0, 250),
      String(message || '').substring(0, 250)
    ]);

    const notificationId = nRes.insertId;
    const nuValues = uniqueIds.map(uid => [uid, notificationId, 1, 0, null]);
    await pool.query(
      'INSERT INTO notification_user (user_id, notification_id, is_system, is_push, read_at) VALUES ?',
      [nuValues]
    );
    notifiedCount = uniqueIds.length;
  } catch (e) {
    console.warn('In-app notification insert warning:', e.message);
  }

  // 2. Dispatch Automatic Emails using Laravel's SMTP settings
  if (send_email) {
    try {
      const [recipients] = await pool.query(
        'SELECT id, first_name, last_name, email FROM users WHERE id IN (?) AND status = 1',
        [uniqueIds]
      );
      if (recipients.length > 0) {
        const mailSetup = await getEmailTransporter();
        if (mailSetup) {
          for (const rec of recipients) {
            if (!rec.email) continue;
            await mailSetup.transporter.sendMail({
              from: `"${mailSetup.companyTitle}" <${mailSetup.fromAddress}>`,
              to: rec.email,
              subject: emailSubject || title,
              html: `
                <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
                  <div style="background: #2563eb; color: #ffffff; padding: 16px 24px;">
                    <h2 style="margin: 0; font-size: 18px;">${mailSetup.companyTitle}</h2>
                  </div>
                  <div style="padding: 24px; color: #1e293b; font-size: 14px; line-height: 1.6;">
                    <p>Hi <strong>${rec.first_name} ${rec.last_name || ''}</strong>,</p>
                    ${emailHtml || `<p>${message}</p>`}
                    <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
                    <p style="font-size: 12px; color: #64748b;">Sent automatically by the Task Manager Notification Engine.</p>
                  </div>
                </div>
              `
            });
            emailedCount++;
            cronState.emailsDispatched++;
          }
          addCronLog('EMAIL', `Sent "${emailSubject || title}" to ${recipients.map(r => r.email).join(', ')}`);
        } else {
          addCronLog('EMAIL_SKIP', 'SMTP settings not configured in settings table');
        }
      }
    } catch (mailErr) {
      console.warn('Email dispatch error:', mailErr.message);
      addCronLog('EMAIL_ERR', mailErr.message);
    }
  }

  return { notified: notifiedCount, emailed: emailedCount };
}

// Send Automatic Emails to Guests / External Clients
async function sendEmailToGuests(guestsList = [], { subject, html }) {
  const validGuests = (guestsList || []).filter(g => g && g.email && String(g.email).includes('@'));
  if (validGuests.length === 0) return 0;

  let count = 0;
  try {
    const mailSetup = await getEmailTransporter();
    if (!mailSetup) return 0;
    for (const g of validGuests) {
      await mailSetup.transporter.sendMail({
        from: `"${mailSetup.companyTitle}" <${mailSetup.fromAddress}>`,
        to: g.email.trim(),
        subject,
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 1px solid #e2e8f0; border-radius: 10px; overflow: hidden;">
            <div style="background: #059669; color: #ffffff; padding: 16px 24px;">
              <h2 style="margin: 0; font-size: 18px;">${mailSetup.companyTitle} — Guest Invitation</h2>
            </div>
            <div style="padding: 24px; color: #1e293b; font-size: 14px; line-height: 1.6;">
              <p>Hello <strong>${g.name || g.email}</strong>,</p>
              ${html}
              <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 20px 0;" />
              <p style="font-size: 12px; color: #64748b;">Sent automatically by the Task Manager Meeting Engine.</p>
            </div>
          </div>
        `
      });
      count++;
      cronState.emailsDispatched++;
    }
    addCronLog('GUEST_EMAIL', `Sent "${subject}" to guests: ${validGuests.map(g => g.email).join(', ')}`);
  } catch (err) {
    console.warn('Guest email dispatch warning:', err.message);
  }
  return count;
}

function getLocalDateStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function getLocalDateTimeStr(d = new Date()) {
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${getLocalDateStr(d)} ${hh}:${mm}:${ss}`;
}

function addDaysToDateStr(dateStr, days) {
  const dt = new Date(dateStr + 'T12:00:00');
  dt.setDate(dt.getDate() + days);
  return getLocalDateStr(dt);
}

// Compute the Next Upcoming Date & Time Slot for a Recurring Rule
function computeNextRecurringSlotDate(rule) {
  const nowStr = getLocalDateStr();
  const baseDateStr = rule.last_generated_date || rule.starts_from || nowStr;
  const dt = new Date(baseDateStr + 'T12:00:00');
  const freq = rule.frequency || 'weekly';

  if (freq === 'daily') dt.setDate(dt.getDate() + 1);
  else if (freq === 'weekly') dt.setDate(dt.getDate() + 7);
  else if (freq === 'biweekly') dt.setDate(dt.getDate() + 14);
  else if (freq === 'monthly') dt.setMonth(dt.getMonth() + 1);
  else if (freq === 'yearly') dt.setFullYear(dt.getFullYear() + 1);
  else dt.setDate(dt.getDate() + 7);

  while (getLocalDateStr(dt) < nowStr) {
    if (freq === 'daily') dt.setDate(dt.getDate() + 1);
    else if (freq === 'weekly') dt.setDate(dt.getDate() + 7);
    else if (freq === 'biweekly') dt.setDate(dt.getDate() + 14);
    else if (freq === 'monthly') dt.setMonth(dt.getMonth() + 1);
    else if (freq === 'yearly') dt.setFullYear(dt.getFullYear() + 1);
    else break;
  }
  return getLocalDateStr(dt);
}

// Helper: Spawn a new occurrence of a recurring task with new date, preserved duration, time slot & assignees
async function spawnRecurringTaskOccurrence(rt, targetDateStr) {
  let durationDays = 0;
  if (rt.start_date && rt.due_date) {
    const sD = new Date(String(rt.start_date).substring(0, 10) + 'T12:00:00');
    const eD = new Date(String(rt.due_date).substring(0, 10) + 'T12:00:00');
    const diff = Math.round((eD - sD) / (1000 * 60 * 60 * 24));
    if (diff > 0 && diff < 365) durationDays = diff;
  }
  const newStartDate = targetDateStr;
  const newDueDate = durationDays > 0 ? addDaysToDateStr(targetDateStr, durationDays) : targetDateStr;

  const [insTask] = await pool.query(`
    INSERT INTO tasks
      (workspace_id, project_id, title, description, billing_type, status_id, priority_id,
       start_date, due_date, note, client_can_discuss, created_by, completion_percentage, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NOW(), NOW())
  `, [
    rt.workspace_id,
    rt.project_id,
    rt.title,
    rt.description,
    rt.billing_type || 'none',
    28, // Planned status
    rt.priority_id,
    newStartDate,
    newDueDate,
    rt.note,
    rt.client_can_discuss || 0,
    rt.created_by
  ]);

  const newTaskId = insTask.insertId;

  // Copy assignees from parent task
  const [parentAssignees] = await pool.query('SELECT user_id FROM task_user WHERE task_id = ?', [rt.task_id]);
  const assigneeIds = parentAssignees.map(a => Number(a.user_id)).filter(Boolean);
  if (assigneeIds.length > 0) {
    await pool.query('INSERT INTO task_user (task_id, user_id) VALUES ?', [assigneeIds.map(uid => [newTaskId, uid])]);
  }

  // Copy time slot from parent task into task_time_entries with the new entry_date
  const [parentSlots] = await pool.query(
    'SELECT start_time, end_time, standard_hours, user_id FROM task_time_entries WHERE task_id = ? ORDER BY id DESC LIMIT 1',
    [rt.task_id]
  );
  let slotLabel = '';
  if (parentSlots.length > 0 && parentSlots[0].start_time && parentSlots[0].end_time) {
    const ps = parentSlots[0];
    await pool.query(`
      INSERT INTO task_time_entries
        (task_id, user_id, workspace_id, entry_date, is_billable, entry_type, standard_hours, start_time, end_time, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, 'flexible', ?, ?, ?, 'Scheduled Recurring Time Slot', NOW(), NOW())
    `, [newTaskId, ps.user_id || `u_${assigneeIds[0] || rt.created_by}`, rt.workspace_id, newStartDate, ps.standard_hours || '02:00:00', ps.start_time, ps.end_time]);
    slotLabel = ` (${formatTime12h(ps.start_time)} - ${formatTime12h(ps.end_time)})`;
  }

  // Log status timeline & activity so it shows on Central Activity Calendar
  await pool.query(`
    INSERT INTO status_timelines (entity_id, entity_type, status, previous_status, new_color, old_color, changed_at, created_at, updated_at)
    VALUES (?, 'App\\\\Models\\\\Task', 'Planned', '-', 'secondary', NULL, NOW(), NOW(), NOW())
  `, [newTaskId]);

  await pool.query(`
    INSERT INTO activity_logs (workspace_id, actor_id, actor_type, type_id, type, activity, message, created_at, updated_at)
    VALUES (?, ?, 'user', ?, 'task', 'created', ?, NOW(), NOW())
  `, [rt.workspace_id, rt.created_by || 1, newTaskId, `Auto-Cron created recurring (${rt.frequency}) task "${rt.title}" for ${newStartDate}${slotLabel}`]);

  // Update recurring_tasks tracker with targetDateStr
  await pool.query(`
    UPDATE recurring_tasks
    SET completed_occurrences = COALESCE(completed_occurrences, 0) + 1,
        last_created_at = ?,
        updated_at = NOW()
    WHERE id = ?
  `, [`${targetDateStr} ${getLocalDateTimeStr().substring(11)}`, rt.id]);

  // Notify & Email assigned users
  if (assigneeIds.length > 0) {
    await notifyUsersAndSendEmail({
      workspace_id: rt.workspace_id,
      from_user_id: rt.created_by || 1,
      type: 'task',
      type_id: newTaskId,
      action: 'recurring_assigned',
      title: `Recurring Task Scheduled: ${rt.title}`,
      message: `Your recurring (${rt.frequency}) task "${rt.title}"${slotLabel} has been automatically scheduled for ${newStartDate}.`,
      emailSubject: `🔁 [Auto-Scheduled Task] ${rt.title}${slotLabel} — ${newStartDate}`,
      emailHtml: `
        <p>A recurring <strong>${rt.frequency}</strong> task has been automatically generated and assigned to you:</p>
        <div style="background: #f8fafc; padding: 14px; border-left: 4px solid #2563eb; margin: 14px 0;">
          <p style="margin: 0 0 6px 0;"><strong>Task:</strong> ${rt.title}</p>
          ${slotLabel ? `<p style="margin: 0 0 6px 0; color: #2563eb;"><strong>Time Slot:</strong> ${slotLabel}</p>` : ''}
          <p style="margin: 0;"><strong>Date:</strong> ${newStartDate}${newDueDate !== newStartDate ? ` to ${newDueDate}` : ''}</p>
        </div>
      `,
      user_ids: assigneeIds,
      send_email: true
    });
  }

  return { newTaskId, newStartDate, newDueDate, slotLabel };
}

// ==========================================
// AUTOMATED CRON JOB ENGINE (Runs Every 60s)
// ==========================================
async function runAutomatedCronJobs(isManual = false) {
  cronState.lastRunAt = getLocalDateTimeStr();
  const summary = { recurringCreated: 0, recurringMeetingsCreated: 0, remindersSent: 0, meetingAlerts: 0 };

  try {
    // ----------------------------------------------------
    // JOB 1: PROCESS RECURRING TASKS (recurring_tasks table)
    // ----------------------------------------------------
    const [recTasks] = await pool.query(`
      SELECT rt.*, t.title, t.description, t.workspace_id, t.project_id, t.status_id, t.priority_id,
             t.start_date, t.due_date, t.billing_type, t.client_can_discuss, t.created_by, t.note
      FROM recurring_tasks rt
      JOIN tasks t ON t.id = rt.task_id
      WHERE rt.is_active = 1
    `);

    const now = new Date();
    const todayStr = getLocalDateStr(now);
    const todayNoon = new Date(todayStr + 'T12:00:00');

    for (const rt of recTasks) {
      if (rt.number_of_occurrences && Number(rt.completed_occurrences || 0) >= Number(rt.number_of_occurrences)) {
        await pool.query('UPDATE recurring_tasks SET is_active = 0 WHERE id = ?', [rt.id]);
        continue;
      }

      const lastDateStr = rt.last_created_at ? String(rt.last_created_at).substring(0, 10) : null;
      if (lastDateStr === todayStr) continue; // Already generated today

      let isDue = false;
      const startsFromStr = rt.starts_from ? String(rt.starts_from).substring(0, 10) : todayStr;
      if (startsFromStr > todayStr) continue;

      if (!lastDateStr) {
        isDue = true;
      } else {
        const lastNoon = new Date(lastDateStr + 'T12:00:00');
        const diffDays = Math.round((todayNoon - lastNoon) / (1000 * 60 * 60 * 24));
        if (rt.frequency === 'daily' && diffDays >= 1) isDue = true;
        else if (rt.frequency === 'weekly' && diffDays >= 7) isDue = true;
        else if (rt.frequency === 'monthly' && diffDays >= 28) isDue = true;
        else if (rt.frequency === 'yearly' && diffDays >= 365) isDue = true;
      }

      if (isDue) {
        const spawned = await spawnRecurringTaskOccurrence(rt, todayStr);
        summary.recurringCreated++;
        cronState.recurringProcessed++;
        addCronLog('RECURRING', `Auto-created ${rt.frequency} task "${rt.title}" (#${spawned.newTaskId}) for ${spawned.newStartDate}${spawned.slotLabel}`);
      }
    }

    // ----------------------------------------------------
    // JOB 2: PROCESS TASK REMINDERS (reminders table)
    // ----------------------------------------------------
    const currentTimeStr = now.toTimeString().substring(0, 8);
    const [dueReminders] = await pool.query(`
      SELECT r.*, t.title AS task_title, t.workspace_id, t.due_date, t.created_by
      FROM reminders r
      JOIN tasks t ON t.id = r.remindable_id
      WHERE r.is_active = 1
        AND r.remindable_type LIKE '%Task'
        AND (r.time_of_day IS NULL OR r.time_of_day <= ?)
        AND (r.last_sent_at IS NULL OR DATE(r.last_sent_at) < CURDATE())
    `, [currentTimeStr]);

    for (const rem of dueReminders) {
      const [assignees] = await pool.query('SELECT user_id FROM task_user WHERE task_id = ?', [rem.remindable_id]);
      const assigneeIds = assignees.map(a => a.user_id);

      await pool.query('UPDATE reminders SET last_sent_at = NOW(), updated_at = NOW() WHERE id = ?', [rem.id]);

      if (assigneeIds.length > 0) {
        await notifyUsersAndSendEmail({
          workspace_id: rem.workspace_id,
          from_user_id: rem.created_by || 1,
          type: 'task',
          type_id: rem.remindable_id,
          action: 'reminder',
          title: `Task Reminder: ${rem.task_title}`,
          message: `Friendly reminder for your task "${rem.task_title}".`,
          emailSubject: `⏰ Task Reminder: ${rem.task_title}`,
          emailHtml: `
            <p>This is an automated scheduled reminder for your assigned task:</p>
            <div style="background: #fffbeb; padding: 14px; border-left: 4px solid #f59e0b; margin: 14px 0;">
              <p style="margin: 0 0 6px 0;"><strong>Task:</strong> ${rem.task_title}</p>
              <p style="margin: 0;"><strong>Due Date:</strong> ${rem.due_date ? String(rem.due_date).substring(0, 10) : 'Today'}</p>
            </div>
          `,
          user_ids: assigneeIds,
          send_email: true
        });
        summary.remindersSent++;
        cronState.remindersSent++;
        addCronLog('REMINDER', `Sent reminder for task "${rem.task_title}" (#${rem.remindable_id})`);
      }
    }

    // ----------------------------------------------------
    // JOB 3: PROCESS RECURRING MEETINGS (Keep next upcoming occurrence seeded for Weekly Calendar + 1-Day Reminder)
    // ----------------------------------------------------
    const govStore = await getMeetingGovernanceStore();
    let govModified = false;

    for (const rule of govStore.recurringRules) {
      if (!rule.is_active) continue;
      // Ensure the next occurrence date is always scheduled in `meetings` (up to 14 days ahead for weekly/daily)
      const nextTargetDate = computeNextRecurringSlotDate(rule);
      const horizonDate = addDaysToDateStr(todayStr, rule.frequency === 'daily' ? 3 : 14);
      if (nextTargetDate > horizonDate) continue;

      // Avoid duplicating if a meeting for this rule & date already exists
      const [dupMt] = await pool.query(
        'SELECT id FROM meetings WHERE title = ? AND DATE(start_date_time) = ? LIMIT 1',
        [rule.title, nextTargetDate]
      );
      if (dupMt.length > 0) {
        if (!rule.last_generated_date || rule.last_generated_date < nextTargetDate) {
          rule.last_generated_date = nextTargetDate;
          govModified = true;
        }
        continue;
      }

      if (true) {
        const startDt = `${nextTargetDate} ${rule.start_time || '10:00'}:00`;
        const endDt = `${nextTargetDate} ${rule.end_time || '11:00'}:00`;
        const [insMt] = await pool.query(`
          INSERT INTO meetings (workspace_id, user_id, title, start_date_time, end_date_time, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, NOW(), NOW())
        `, [rule.workspace_id || 5, String(rule.creator_id || 1), rule.title, startDt, endDt]);

        const newMeetingId = insMt.insertId;
        const pUserIds = Array.isArray(rule.user_ids) ? [...new Set(rule.user_ids.map(Number).filter(Boolean))] : [];
        if (pUserIds.length > 0) {
          await pool.query('INSERT INTO meeting_user (meeting_id, user_id) VALUES ?', [pUserIds.map(uid => [newMeetingId, uid])]);
        }

        // Seed governance record for the newly spawned recurring meeting
        const attendanceMap = {};
        pUserIds.forEach(uid => { attendanceMap[uid] = { status: 'pending', note: '', updated_at: null }; });
        const guestAttendanceMap = {};
        const ruleGuests = Array.isArray(rule.guests) ? rule.guests : [];
        ruleGuests.forEach(g => {
          guestAttendanceMap[g.id] = { status: 'pending', note: '', updated_at: null };
        });

        govStore.records[newMeetingId] = {
          meeting_id: newMeetingId,
          scope: rule.scope || (pUserIds.length <= 2 ? 'individual' : 'team'),
          is_recurring: true,
          recurring_frequency: rule.frequency,
          recurring_rule_id: rule.id,
          status: 'scheduled',
          attendance: attendanceMap,
          guests: ruleGuests,
          guest_attendance: guestAttendanceMap,
          postponed_count: 0,
          postponed_history: [],
          day_before_reminder_sent: false,
          mom_discussion: '',
          mom_highlights: '',
          mom_decisions: '',
          mom_recorded_by: null,
          mom_updated_at: null
        };

        rule.last_generated_date = nextTargetDate;
        rule.completed_occurrences = Number(rule.completed_occurrences || 0) + 1;
        govModified = true;

        summary.recurringMeetingsCreated = (summary.recurringMeetingsCreated || 0) + 1;
        cronState.recurringMeetingsProcessed = (cronState.recurringMeetingsProcessed || 0) + 1;
        addCronLog('RECURRING_MEETING', `Auto-scheduled ${rule.frequency} ${rule.scope || 'team'} meeting "${rule.title}" (#${newMeetingId}) for ${nextTargetDate}`);

        // Email immediately only if it is for today (otherwise Job 4 will auto-email 1 day before)
        const scopeBadge = rule.scope === 'individual' ? 'Individual 1-on-1 Meeting' : 'Team Meeting';
        if (nextTargetDate === todayStr && pUserIds.length > 0) {
          await notifyUsersAndSendEmail({
            workspace_id: rule.workspace_id || 5,
            from_user_id: rule.creator_id || 1,
            type: 'meeting',
            type_id: newMeetingId,
            action: 'recurring_meeting',
            title: `[Recurring ${scopeBadge}] ${rule.title}`,
            message: `Automated ${rule.frequency} meeting "${rule.title}" is scheduled for today (${nextTargetDate}) from ${formatTime12h(rule.start_time)} to ${formatTime12h(rule.end_time)}. Please attend on time.`,
            emailSubject: `📅 [Auto-Scheduled ${scopeBadge}] ${rule.title} — Today (${formatTime12h(rule.start_time)})`,
            emailHtml: `
              <p>This is an automated invitation for your recurring <strong>${rule.frequency} ${scopeBadge.toLowerCase()}</strong> scheduled for today:</p>
              <div style="background: #f0fdf4; padding: 16px; border-left: 4px solid #10b981; margin: 14px 0;">
                <p style="margin: 0 0 6px 0;"><strong>Agenda / Title:</strong> ${rule.title}</p>
                <p style="margin: 0 0 6px 0;"><strong>Type:</strong> ${scopeBadge} (${rule.frequency})</p>
                <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${nextTargetDate}</p>
                <p style="margin: 0;"><strong>Time Slot:</strong> ${formatTime12h(rule.start_time)} – ${formatTime12h(rule.end_time)}</p>
              </div>
              <p style="font-size: 13px; color: #334155;"><strong>Note:</strong> Attendance and Minutes of Meeting (MoM) will be recorded during/after this session for the monthly executive review.</p>
            `,
            user_ids: pUserIds,
            send_email: true
          });
        }

        if (nextTargetDate === todayStr && ruleGuests.length > 0) {
          await sendEmailToGuests(ruleGuests, {
            subject: `📅 [Meeting Invitation] ${rule.title} — Today (${formatTime12h(rule.start_time)})`,
            html: `
              <p>You are invited as a guest to today's recurring <strong>${rule.frequency} ${scopeBadge.toLowerCase()}</strong>:</p>
              <div style="background: #f0fdf4; padding: 16px; border-left: 4px solid #10b981; margin: 14px 0;">
                <p style="margin: 0 0 6px 0;"><strong>Agenda / Title:</strong> ${rule.title}</p>
                <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${nextTargetDate}</p>
                <p style="margin: 0;"><strong>Time Slot:</strong> ${formatTime12h(rule.start_time)} – ${formatTime12h(rule.end_time)}</p>
              </div>
            `
          });
        }
      }
    }

    // ----------------------------------------------------
    // JOB 4: 1-DAY-BEFORE ADVANCE MEETING REMINDER (Team Members & Guests)
    // Automatically emails & notifies team members and external guests 1 day before a scheduled meeting
    // ----------------------------------------------------
    const [tomorrowMeetings] = await pool.query(`
      SELECT m.*
      FROM meetings m
      WHERE DATE(m.start_date_time) = DATE_ADD(CURDATE(), INTERVAL 1 DAY)
    `);

    for (const tm of tomorrowMeetings) {
      const rec = govStore.records[tm.id] || {};
      if (rec.day_before_reminder_sent) continue;
      const alert1dKey = `meeting_1day_${tm.id}_${String(tm.start_date_time).substring(0, 10)}`;
      if (cronState.sentMeetingAlertKeys.has(alert1dKey)) continue;
      cronState.sentMeetingAlertKeys.add(alert1dKey);

      const mDateStr = String(tm.start_date_time).substring(0, 10);
      const mStartStr = formatTime12h(String(tm.start_date_time).substring(11, 16));
      const mEndStr = formatTime12h(String(tm.end_date_time).substring(11, 16));

      const [mUsers] = await pool.query('SELECT user_id FROM meeting_user WHERE meeting_id = ?', [tm.id]);
      const pIds = mUsers.map(u => u.user_id);

      if (pIds.length > 0) {
        await notifyUsersAndSendEmail({
          workspace_id: tm.workspace_id,
          from_user_id: Number(tm.user_id) || 1,
          type: 'meeting',
          type_id: tm.id,
          action: 'day_before_reminder',
          title: `Reminder: Meeting Tomorrow — ${tm.title}`,
          message: `Advance reminder: "${tm.title}" is scheduled for tomorrow (${mDateStr}) from ${mStartStr} to ${mEndStr}.`,
          emailSubject: `⏰ [1-Day Advance Reminder] Meeting Tomorrow: ${tm.title} (${mDateStr})`,
          emailHtml: `
            <p>This is an automated <strong>1-Day Advance Reminder</strong> that you have a scheduled meeting tomorrow:</p>
            <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #059669; margin: 14px 0;">
              <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${tm.title}</p>
              <p style="margin: 0 0 6px 0;"><strong>Tomorrow's Date:</strong> ${mDateStr}</p>
              <p style="margin: 0;"><strong>Time Slot:</strong> ${mStartStr} – ${mEndStr}</p>
            </div>
            <p style="font-size: 13px; color: #334155;">Please prepare your updates and highlights. Attendance will be marked on the Weekly Meeting Calendar.</p>
          `,
          user_ids: pIds,
          send_email: true
        });
      }

      const guestsList = Array.isArray(rec.guests) ? rec.guests : [];
      if (guestsList.length > 0) {
        await sendEmailToGuests(guestsList, {
          subject: `⏰ [1-Day Advance Reminder] Meeting Tomorrow: ${tm.title} (${mDateStr})`,
          html: `
            <p>This is an automated <strong>1-Day Advance Reminder</strong> that you are invited as a guest to tomorrow's meeting:</p>
            <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #059669; margin: 14px 0;">
              <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${tm.title}</p>
              <p style="margin: 0 0 6px 0;"><strong>Tomorrow's Date:</strong> ${mDateStr}</p>
              <p style="margin: 0;"><strong>Time Slot:</strong> ${mStartStr} – ${mEndStr}</p>
            </div>
          `
        });
      }

      govStore.records[tm.id] = {
        ...rec,
        meeting_id: tm.id,
        day_before_reminder_sent: true,
        day_before_reminder_sent_at: new Date().toISOString()
      };
      govModified = true;
      summary.meetingAlerts++;
      cronState.meetingAlertsSent++;
      addCronLog('1DAY_REMINDER', `Sent 1-day-before advance reminder for "${tm.title}" (${mDateStr}) to ${pIds.length} member(s) & ${guestsList.length} guest(s)`);
    }

    if (govModified) {
      await saveMeetingGovernanceStore(govStore);
    }

    // ----------------------------------------------------
    // JOB 5: UPCOMING TODAY'S MEETINGS ALERT (Within 30 mins)
    // ----------------------------------------------------
    const [upcomingMeetings] = await pool.query(`
      SELECT m.*
      FROM meetings m
      WHERE DATE(m.start_date_time) = CURDATE()
        AND TIMESTAMPDIFF(MINUTE, NOW(), m.start_date_time) BETWEEN -5 AND 30
    `);

    for (const mt of upcomingMeetings) {
      const alertKey = `meeting_${mt.id}_${todayStr}`;
      if (cronState.sentMeetingAlertKeys.has(alertKey)) continue;
      cronState.sentMeetingAlertKeys.add(alertKey);

      const [mUsers] = await pool.query('SELECT user_id FROM meeting_user WHERE meeting_id = ?', [mt.id]);
      const pIds = mUsers.map(u => u.user_id);
      const rec = govStore.records[mt.id] || {};
      const guestsList = Array.isArray(rec.guests) ? rec.guests : [];

      if (pIds.length > 0) {
        await notifyUsersAndSendEmail({
          workspace_id: mt.workspace_id,
          from_user_id: Number(mt.user_id) || 1,
          type: 'meeting',
          type_id: mt.id,
          action: 'starting_soon',
          title: `Meeting Starting Soon: ${mt.title}`,
          message: `Meeting "${mt.title}" is scheduled at ${String(mt.start_date_time).substring(11, 16)}.`,
          emailSubject: `📅 Meeting Starting Soon: ${mt.title}`,
          emailHtml: `
            <p>Your scheduled meeting/agenda is starting soon:</p>
            <div style="background: #f0fdf4; padding: 14px; border-left: 4px solid #10b981; margin: 14px 0;">
              <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${mt.title}</p>
              <p style="margin: 0;"><strong>Time:</strong> ${mt.start_date_time} to ${mt.end_date_time}</p>
            </div>
          `,
          user_ids: pIds,
          send_email: true
        });
      }
      if (guestsList.length > 0) {
        await sendEmailToGuests(guestsList, {
          subject: `📅 Meeting Starting Soon: ${mt.title}`,
          html: `
            <p>Your scheduled meeting is starting within 30 minutes:</p>
            <div style="background: #f0fdf4; padding: 14px; border-left: 4px solid #10b981; margin: 14px 0;">
              <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${mt.title}</p>
              <p style="margin: 0;"><strong>Time:</strong> ${mt.start_date_time} to ${mt.end_date_time}</p>
            </div>
          `
        });
      }
      if (pIds.length > 0 || guestsList.length > 0) {
        summary.meetingAlerts++;
        cronState.meetingAlertsSent++;
        addCronLog('MEETING_ALERT', `Dispatched upcoming meeting alert for "${mt.title}"`);
      }
    }

    // ----------------------------------------------------
    // JOB 6: AUTO-PURGE WORKSPACES AFTER 30-DAY DELETION HOLD
    // ----------------------------------------------------
    const pendingWsDeletions = await getPendingWorkspaceDeletions();
    if (pendingWsDeletions.length > 0) {
      const nowMs = Date.now();
      const remaining = [];
      let purgedAny = false;
      for (const item of pendingWsDeletions) {
        const purgeMs = new Date(item.purge_at).getTime();
        if (!isNaN(purgeMs) && nowMs >= purgeMs) {
          try {
            await permanentlyPurgeWorkspace(Number(item.workspace_id));
            purgedAny = true;
            addCronLog('WS_PURGE', `Permanently removed workspace "${item.title}" (#${item.workspace_id}) after 30-day hold expired`);
          } catch (purgeErr) {
            console.warn('Workspace purge error:', purgeErr.message);
            remaining.push(item);
          }
        } else {
          remaining.push(item);
        }
      }
      if (purgedAny) {
        await savePendingWorkspaceDeletions(remaining);
      }
    }

    if (isManual) {
      addCronLog('MANUAL_RUN', `Manual cron run finished (Recurring: ${summary.recurringCreated}, Reminders: ${summary.remindersSent}, Meetings: ${summary.meetingAlerts})`);
    }
  } catch (err) {
    console.error('Cron execution error:', err.message);
    addCronLog('CRON_ERROR', err.message);
  }

  return summary;
}

// Start background cron loop every 60 seconds
setInterval(() => {
  runAutomatedCronJobs(false);
}, 60 * 1000);

// Run initial cron pass 4 seconds after boot
setTimeout(() => {
  addCronLog('SYSTEM', 'Automated Cron Scheduler initialized (60s interval)');
  runAutomatedCronJobs(false);
}, 4000);

// ==========================================
// AUTHENTICATION HELPERS & MIDDLEWARE
// ==========================================
async function verifyLaravelPassword(plain, hash) {
  if (!hash) return false;
  const normalizedHash = hash.replace(/^\$2y\$/, '$2a$');
  return bcrypt.compare(plain, normalizedHash);
}

async function hashLaravelPassword(plain) {
  const hashed = await bcrypt.hash(plain, 10);
  return hashed.replace(/^\$2[ab]\$/, '$2y$');
}

async function getUserAccessProfile(userId) {
  const [roles] = await pool.query(
    `SELECT r.id, r.name, r.guard_name
     FROM roles r
     JOIN model_has_roles mhr ON mhr.role_id = r.id
     WHERE mhr.model_id = ? AND (mhr.model_type = 'App\\\\Models\\\\User' OR mhr.model_type LIKE '%User')`,
    [userId]
  );

  const roleIds = roles.map(r => r.id);
  let permissions = [];
  if (roleIds.length > 0) {
    const [perms] = await pool.query(
      `SELECT DISTINCT p.name
       FROM permissions p
       JOIN role_has_permissions rhp ON rhp.permission_id = p.id
       WHERE rhp.role_id IN (?)`,
      [roleIds]
    );
    permissions = perms.map(p => p.name);
  }

  const [directPerms] = await pool.query(
    `SELECT DISTINCT p.name
     FROM permissions p
     JOIN model_has_permissions mhp ON mhp.permission_id = p.id
     WHERE mhp.model_id = ? AND (mhp.model_type = 'App\\\\Models\\\\User' OR mhp.model_type LIKE '%User')`,
    [userId]
  );
  for (const dp of directPerms) {
    if (!permissions.includes(dp.name)) permissions.push(dp.name);
  }

  const roleNamesLower = roles.map(r => r.name.toLowerCase());
  const isStrictAdmin =
    roleNamesLower.includes('admin') ||
    roleNamesLower.includes('super admin') ||
    roleNamesLower.includes('superadmin');
  const isSuperOrAdmin = isStrictAdmin || permissions.includes('access_all_data');

  return {
    roles,
    roleNames: roles.map(r => r.name),
    permissions,
    isStrictAdmin,
    isAdminOrHasAllDataAccess: isSuperOrAdmin
  };
}

async function logActivity(conn, { workspace_id, actor_id, type_id, type, parent_type_id = null, parent_type = null, activity, message }) {
  try {
    await conn.query(
      `INSERT INTO activity_logs (workspace_id, actor_id, actor_type, type_id, type, parent_type_id, parent_type, activity, message, created_at, updated_at)
       VALUES (?, ?, 'user', ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
      [workspace_id || null, actor_id, type_id, type, parent_type_id, parent_type, activity, message]
    );
  } catch (e) {
    console.warn('Activity log warning:', e.message);
  }
}

async function authMiddleware(req, res, next) {
  try {
    let token = req.cookies?.ceo_token;
    if (!token && req.headers.authorization?.startsWith('Bearer ')) {
      token = req.headers.authorization.split(' ')[1];
    }
    if (!token) {
      return res.status(401).json({ error: true, message: 'Authentication required' });
    }
    const decoded = jwt.verify(token, JWT_SECRET);
    const [users] = await pool.query(
      'SELECT id, first_name, last_name, email, phone, photo, status, default_workspace_id FROM users WHERE id = ? LIMIT 1',
      [decoded.id]
    );
    if (!users.length || users[0].status === 0) {
      return res.status(401).json({ error: true, message: 'User account inactive or not found' });
    }
    const access = await getUserAccessProfile(users[0].id);
    req.user = { ...users[0], ...access };
    next();
  } catch (err) {
    return res.status(401).json({ error: true, message: 'Invalid or expired session' });
  }
}

// ==========================================
// 1. AUTHENTICATION ENDPOINTS
// ==========================================
app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      return res.status(400).json({ error: true, message: 'Email and password are required' });
    }
    const [users] = await pool.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email.trim()]);
    if (!users.length) {
      return res.status(401).json({ error: true, message: 'Invalid email or password' });
    }
    const user = users[0];
    if (user.status === 0) {
      return res.status(403).json({ error: true, message: 'Your account is currently deactivated' });
    }
    const valid = await verifyLaravelPassword(password, user.password);
    if (!valid) {
      return res.status(401).json({ error: true, message: 'Invalid email or password' });
    }

    const access = await getUserAccessProfile(user.id);
    const token = jwt.sign(
      { id: user.id, email: user.email, isAdmin: access.isAdminOrHasAllDataAccess },
      JWT_SECRET,
      { expiresIn: '7d' }
    );

    res.cookie('ceo_token', token, {
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax'
    });

    return res.json({
      error: false,
      message: 'Logged in successfully',
      token,
      user: {
        id: user.id,
        first_name: user.first_name,
        last_name: user.last_name,
        email: user.email,
        photo: user.photo,
        default_workspace_id: user.default_workspace_id,
        ...access
      }
    });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ error: true, message: 'Server error during login' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearCookie('ceo_token');
  res.json({ error: false, message: 'Logged out' });
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
  res.json({ error: false, user: req.user });
});

app.post('/api/auth/verify-password', authMiddleware, async (req, res) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: true, message: 'Password is required' });
    const [rows] = await pool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: true, message: 'User not found' });
    const valid = await verifyLaravelPassword(String(password), rows[0].password);
    if (!valid) return res.status(401).json({ error: true, message: 'Incorrect password. Please try again.' });
    res.json({ error: false, message: 'Password verified' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 2. BOOTSTRAP & METADATA ENDPOINT
// ==========================================
app.get('/api/meta', authMiddleware, async (req, res) => {
  try {
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const pendingDeletions = await getPendingWorkspaceDeletions();
    const heldWsIds = pendingDeletions.map(x => Number(x.workspace_id)).filter(Boolean);
    const heldNotInSql = heldWsIds.length ? `w.id NOT IN (${heldWsIds.join(',')})` : '1=1';

    let workspacesQuery = `
      SELECT w.*,
        (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS projects_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id) AS tasks_count,
        (SELECT COUNT(*) FROM user_workspace uw WHERE uw.workspace_id = w.id) AS users_count,
        (SELECT COUNT(*) FROM client_workspace cw WHERE cw.workspace_id = w.id) AS clients_count,
        (SELECT GROUP_CONCAT(uw.user_id) FROM user_workspace uw WHERE uw.workspace_id = w.id) AS member_ids
      FROM workspaces w
      WHERE ${heldNotInSql}
    `;
    let wsParams = [];
    if (!isAdmin) {
      workspacesQuery += ` AND (w.id IN (SELECT workspace_id FROM user_workspace WHERE user_id = ?) OR w.user_id = ?)`;
      wsParams = [req.user.id, req.user.id];
    }
    workspacesQuery += ` ORDER BY w.id DESC`;

    const [
      [workspaces],
      [statuses],
      [priorities],
      [roles],
      [permissions],
      [rolePerms],
      [tags],
      [users],
      [clients]
    ] = await Promise.all([
      pool.query(workspacesQuery, wsParams),
      pool.query(`
        SELECT s.*,
          (SELECT COUNT(*) FROM projects p WHERE p.status_id = s.id) AS projects_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.status_id = s.id) AS tasks_count
        FROM statuses s ORDER BY s.id ASC
      `),
      pool.query(`
        SELECT pr.*,
          (SELECT COUNT(*) FROM projects p WHERE p.priority_id = pr.id) AS projects_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.priority_id = pr.id) AS tasks_count
        FROM priorities pr ORDER BY pr.id ASC
      `),
      pool.query("SELECT id, name, guard_name FROM roles WHERE guard_name = 'web' ORDER BY id ASC"),
      pool.query("SELECT id, name, guard_name FROM permissions WHERE guard_name = 'web' ORDER BY name ASC"),
      pool.query("SELECT role_id, permission_id FROM role_has_permissions"),
      pool.query('SELECT * FROM tags ORDER BY id DESC'),
      pool.query(`
        SELECT u.id, u.first_name, u.last_name, u.email, u.phone, u.photo, u.status, u.default_workspace_id, u.created_at,
          GROUP_CONCAT(DISTINCT r.name SEPARATOR ', ') AS role_names,
          GROUP_CONCAT(DISTINCT r.id SEPARATOR ',') AS role_ids,
          GROUP_CONCAT(DISTINCT uw.workspace_id SEPARATOR ',') AS workspace_ids
        FROM users u
        LEFT JOIN model_has_roles mhr ON mhr.model_id = u.id AND (mhr.model_type = 'App\\\\Models\\\\User' OR mhr.model_type LIKE '%User')
        LEFT JOIN roles r ON r.id = mhr.role_id
        LEFT JOIN user_workspace uw ON uw.user_id = u.id
        GROUP BY u.id
        ORDER BY u.first_name ASC
      `),
      pool.query(`
        SELECT c.id, c.first_name, c.last_name, c.company, c.email, c.phone, c.status, c.workspace_id, c.created_at,
          GROUP_CONCAT(DISTINCT cw.workspace_id SEPARATOR ',') AS workspace_ids,
          (SELECT COUNT(*) FROM client_project cp WHERE cp.client_id = c.id) AS projects_count
        FROM clients c
        LEFT JOIN client_workspace cw ON cw.client_id = c.id
        GROUP BY c.id
        ORDER BY c.first_name ASC
      `)
    ]);

    const rolePermMap = {};
    rolePerms.forEach(rp => {
      (rolePermMap[rp.role_id] = rolePermMap[rp.role_id] || []).push(rp.permission_id);
    });
    roles.forEach(r => {
      r.permission_ids = rolePermMap[r.id] || [];
    });

    res.json({
      error: false,
      workspaces,
      pendingDeletionWorkspaces: (req.user.isStrictAdmin || req.user.permissions.includes('delete_workspaces')) ? pendingDeletions : [],
      statuses,
      priorities,
      roles,
      permissions,
      tags,
      users,
      clients,
      cronState,
      laravelUrl: process.env.LARAVEL_URL || 'http://taskify.test'
    });
  } catch (err) {
    console.error('Meta error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 3. CEO CENTRAL OVERVIEW & TODAY'S COMMAND
// ==========================================
app.get('/api/overview', authMiddleware, async (req, res) => {
  const startHr = process.hrtime.bigint();
  try {
    const workspaceId = req.query.workspace_id && req.query.workspace_id !== 'all' ? Number(req.query.workspace_id) : null;
    const startDate = req.query.start_date || null;
    const endDate = req.query.end_date || null;
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const heldWsIds = await getHeldWorkspaceIds();
    const heldCsv = heldWsIds.length ? heldWsIds.join(',') : null;

    let projWhere = 'WHERE 1=1';
    let projParams = [];
    let taskWhere = 'WHERE 1=1';
    let taskParams = [];

    if (heldCsv) {
      projWhere += ` AND p.workspace_id NOT IN (${heldCsv})`;
      taskWhere += ` AND t.workspace_id NOT IN (${heldCsv})`;
    }

    if (workspaceId) {
      projWhere += ' AND p.workspace_id = ?';
      projParams.push(workspaceId);
      taskWhere += ' AND t.workspace_id = ?';
      taskParams.push(workspaceId);
    }

    if (startDate) {
      projWhere += ' AND (DATE(p.created_at) >= ? OR DATE(p.start_date) >= ?)';
      projParams.push(startDate, startDate);
      taskWhere += ' AND (DATE(t.created_at) >= ? OR DATE(t.start_date) >= ? OR DATE(t.due_date) >= ?)';
      taskParams.push(startDate, startDate, startDate);
    }

    if (endDate) {
      projWhere += ' AND (DATE(p.created_at) <= ? OR DATE(p.end_date) <= ?)';
      projParams.push(endDate, endDate);
      taskWhere += ' AND (DATE(t.created_at) <= ? OR DATE(t.due_date) <= ?)';
      taskParams.push(endDate, endDate);
    }

    if (!isAdmin) {
      projWhere += ' AND (p.id IN (SELECT project_id FROM project_user WHERE user_id = ?) OR p.created_by = ?)';
      projParams.push(req.user.id, req.user.id);
      taskWhere += ' AND (t.id IN (SELECT task_id FROM task_user WHERE user_id = ?) OR t.created_by = ? OR t.project_id IN (SELECT project_id FROM project_user WHERE user_id = ?))';
      taskParams.push(req.user.id, req.user.id, req.user.id);
    }

    // Filter for Today's Tasks & Meetings
    let todayTaskWhere = `WHERE (
      DATE(t.due_date) = CURDATE()
      OR DATE(t.start_date) = CURDATE()
      OR (t.start_date <= CURDATE() AND t.due_date >= CURDATE())
      OR t.id IN (SELECT task_id FROM task_time_entries WHERE entry_date = CURDATE())
    )`;
    const todayTaskParams = [];
    if (heldCsv) {
      todayTaskWhere += ` AND t.workspace_id NOT IN (${heldCsv})`;
    }
    if (workspaceId) {
      todayTaskWhere += ' AND t.workspace_id = ?';
      todayTaskParams.push(workspaceId);
    }
    if (!isAdmin) {
      todayTaskWhere += ' AND (t.id IN (SELECT task_id FROM task_user WHERE user_id = ?) OR t.created_by = ? OR t.project_id IN (SELECT project_id FROM project_user WHERE user_id = ?))';
      todayTaskParams.push(req.user.id, req.user.id, req.user.id);
    }

    const uidNum = Number(req.user.id);
    const heldProjSql = heldCsv ? `AND p.workspace_id NOT IN (${heldCsv})` : '';
    const heldTaskSql = heldCsv ? `AND t.workspace_id NOT IN (${heldCsv})` : '';
    const heldMeetSql = heldCsv ? `AND m.workspace_id NOT IN (${heldCsv})` : '';
    const heldP2Sql = heldCsv ? `AND p2.workspace_id NOT IN (${heldCsv})` : '';
    const heldT2Sql = heldCsv ? `AND t2.workspace_id NOT IN (${heldCsv})` : '';

    const userProjectScopeSql = `${heldProjSql} ${isAdmin ? '' : `AND (p.id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum}) OR p.created_by = ${uidNum})`}`;
    const userTaskScopeSql = `${heldTaskSql} ${isAdmin ? '' : `AND (t.id IN (SELECT task_id FROM task_user WHERE user_id = ${uidNum}) OR t.created_by = ${uidNum} OR t.project_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum}))`}`;
    const userMeetingScopeSql = `${heldMeetSql} ${isAdmin ? '' : `AND (m.id IN (SELECT meeting_id FROM meeting_user WHERE user_id = ${uidNum}) OR m.user_id = '${uidNum}')`}`;
    const sharedProjSubSql = `${heldP2Sql} ${isAdmin ? '' : `AND p2.id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum})`}`;
    const sharedTaskSubSql = `${heldT2Sql} ${isAdmin ? '' : `AND (t2.id IN (SELECT task_id FROM task_user WHERE user_id = ${uidNum}) OR t2.created_by = ${uidNum} OR t2.project_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum}))`}`;
    const teamWhereClauses = [];
    const teamParams = [];
    if (workspaceId) {
      teamWhereClauses.push('u.id IN (SELECT user_id FROM user_workspace WHERE workspace_id = ?)');
      teamParams.push(workspaceId);
    }
    if (!isAdmin) {
      teamWhereClauses.push(`(u.id = ${uidNum} OR u.id IN (SELECT pu_co.user_id FROM project_user pu_co WHERE pu_co.project_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum})))`);
    }
    const teamWhereSql = teamWhereClauses.length ? `WHERE ${teamWhereClauses.join(' AND ')}` : '';

    const [
      [projectStats],
      [taskStats],
      [todayTaskStats],
      [todayTasksList],
      [todayMeetingsList],
      [projectsByStatus],
      [tasksByStatus],
      [tasksByPriority],
      [teamWorkload],
      [atRiskProjects],
      [urgentTasks],
      [recentActivity],
      [workspaceBreakdown],
      [todos],
      [leaveRequests]
    ] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) AS total_projects,
          SUM(CASE WHEN LOWER(s.title) LIKE '%complete%' OR LOWER(s.slug) LIKE '%complete%' THEN 1 ELSE 0 END) AS completed_projects,
          SUM(CASE WHEN LOWER(s.title) LIKE '%progress%' OR LOWER(s.slug) LIKE '%progress%' THEN 1 ELSE 0 END) AS active_projects,
          SUM(CASE WHEN p.end_date IS NOT NULL AND p.end_date < CURDATE() AND (LOWER(s.title) NOT LIKE '%complete%' OR s.id IS NULL) THEN 1 ELSE 0 END) AS overdue_projects,
          COALESCE(SUM(CAST(REPLACE(p.budget, ',', '') AS DECIMAL(15,2))), 0) AS total_budget
        FROM projects p
        LEFT JOIN statuses s ON s.id = p.status_id
        ${projWhere}
      `, projParams),

      pool.query(`
        SELECT
          COUNT(*) AS total_tasks,
          SUM(CASE WHEN LOWER(s.title) LIKE '%complete%' OR t.completion_percentage = 100 THEN 1 ELSE 0 END) AS completed_tasks,
          SUM(CASE WHEN LOWER(s.title) LIKE '%progress%' THEN 1 ELSE 0 END) AS in_progress_tasks,
          SUM(CASE WHEN t.due_date IS NOT NULL AND t.due_date < CURDATE() AND (LOWER(s.title) NOT LIKE '%complete%' AND COALESCE(t.completion_percentage, 0) < 100) THEN 1 ELSE 0 END) AS overdue_tasks,
          SUM(CASE WHEN t.due_date IS NOT NULL AND DATE(t.due_date) = CURDATE() THEN 1 ELSE 0 END) AS due_today_tasks,
          ROUND(AVG(COALESCE(t.completion_percentage, CASE WHEN LOWER(s.title) LIKE '%complete%' THEN 100 ELSE 0 END)), 1) AS avg_completion
        FROM tasks t
        LEFT JOIN statuses s ON s.id = t.status_id
        ${taskWhere}
      `, taskParams),

      // Today's Task Coverage Card Stats
      pool.query(`
        SELECT
          COUNT(*) AS today_total,
          SUM(CASE WHEN LOWER(s.title) LIKE '%complete%' OR t.completion_percentage = 100 THEN 1 ELSE 0 END) AS today_covered,
          SUM(CASE WHEN (LOWER(s.title) NOT LIKE '%complete%' OR s.id IS NULL) AND COALESCE(t.completion_percentage, 0) < 100 THEN 1 ELSE 0 END) AS today_remaining
        FROM tasks t
        LEFT JOIN statuses s ON s.id = t.status_id
        ${todayTaskWhere}
      `, todayTaskParams),

      // Today's Tasks & Time-Slot Schedule List
      pool.query(`
        SELECT
          t.id, t.title, t.project_id, p.title AS project_title,
          t.workspace_id, w.title AS workspace_title,
          t.start_date, t.due_date, t.completion_percentage,
          s.id AS status_id, s.title AS status_title, s.color AS status_color,
          pr.id AS priority_id, pr.title AS priority_title, pr.color AS priority_color,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = t.id) AS assignees,
          (SELECT tte.start_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS start_time,
          (SELECT tte.end_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS end_time,
          (SELECT rt.frequency FROM recurring_tasks rt WHERE rt.task_id = t.id AND rt.is_active = 1 LIMIT 1) AS recurring_frequency
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN workspaces w ON w.id = t.workspace_id
        LEFT JOIN statuses s ON s.id = t.status_id
        LEFT JOIN priorities pr ON pr.id = t.priority_id
        ${todayTaskWhere}
        ORDER BY
          CASE WHEN start_time IS NOT NULL THEN 0 ELSE 1 END ASC,
          start_time ASC,
          t.id DESC
      `, todayTaskParams),

      // Today's & Upcoming Meetings / Agendas
      pool.query(`
        SELECT
          m.*, w.title AS workspace_title,
          DATE(m.start_date_time) = CURDATE() AS is_today,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM meeting_user mu JOIN users u ON u.id = mu.user_id WHERE mu.meeting_id = m.id) AS participants
        FROM meetings m
        LEFT JOIN workspaces w ON w.id = m.workspace_id
        WHERE DATE(m.start_date_time) >= CURDATE()
          ${workspaceId ? 'AND m.workspace_id = ?' : ''}
          ${userMeetingScopeSql}
        ORDER BY m.start_date_time ASC
        LIMIT 15
      `, workspaceId ? [workspaceId] : []),

      pool.query(`
        SELECT s.id, COALESCE(s.title, 'Unassigned') AS title, COALESCE(s.color, 'secondary') AS color, COUNT(p.id) AS count
        FROM statuses s
        LEFT JOIN projects p ON p.status_id = s.id ${workspaceId ? 'AND p.workspace_id = ?' : ''} ${userProjectScopeSql}
        GROUP BY s.id, s.title, s.color
        ORDER BY s.id ASC
      `, workspaceId ? [workspaceId] : []),

      pool.query(`
        SELECT s.id, COALESCE(s.title, 'Unassigned') AS title, COALESCE(s.color, 'secondary') AS color, COUNT(t.id) AS count
        FROM statuses s
        LEFT JOIN tasks t ON t.status_id = s.id ${workspaceId ? 'AND t.workspace_id = ?' : ''} ${userTaskScopeSql}
        GROUP BY s.id, s.title, s.color
        ORDER BY s.id ASC
      `, workspaceId ? [workspaceId] : []),

      pool.query(`
        SELECT pr.id, COALESCE(pr.title, 'No Priority') AS title, COALESCE(pr.color, 'secondary') AS color, COUNT(t.id) AS count
        FROM priorities pr
        LEFT JOIN tasks t ON t.priority_id = pr.id ${workspaceId ? 'AND t.workspace_id = ?' : ''} ${userTaskScopeSql}
        GROUP BY pr.id, pr.title, pr.color
        ORDER BY pr.id ASC
      `, workspaceId ? [workspaceId] : []),

      pool.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.email, u.photo, u.status,
          GROUP_CONCAT(DISTINCT r.name SEPARATOR ', ') AS role_name,
          (SELECT COUNT(DISTINCT pu.project_id) FROM project_user pu JOIN projects p2 ON p2.id = pu.project_id WHERE pu.user_id = u.id ${workspaceId ? 'AND p2.workspace_id = ' + Number(workspaceId) : ''} ${sharedProjSubSql}) AS assigned_projects,
          (SELECT COUNT(DISTINCT tu.task_id) FROM task_user tu JOIN tasks t2 ON t2.id = tu.task_id WHERE tu.user_id = u.id ${workspaceId ? 'AND t2.workspace_id = ' + Number(workspaceId) : ''} ${sharedTaskSubSql}) AS total_tasks,
          (SELECT COUNT(DISTINCT tu.task_id) FROM task_user tu JOIN tasks t2 ON t2.id = tu.task_id LEFT JOIN statuses s2 ON s2.id = t2.status_id WHERE tu.user_id = u.id ${workspaceId ? 'AND t2.workspace_id = ' + Number(workspaceId) : ''} ${sharedTaskSubSql} AND (LOWER(s2.title) LIKE '%complete%' OR t2.completion_percentage = 100)) AS completed_tasks,
          (SELECT COUNT(DISTINCT tu.task_id) FROM task_user tu JOIN tasks t2 ON t2.id = tu.task_id LEFT JOIN statuses s2 ON s2.id = t2.status_id WHERE tu.user_id = u.id ${workspaceId ? 'AND t2.workspace_id = ' + Number(workspaceId) : ''} ${sharedTaskSubSql} AND (LOWER(s2.title) NOT LIKE '%complete%' OR s2.id IS NULL) AND COALESCE(t2.completion_percentage, 0) < 100) AS open_tasks,
          (SELECT COUNT(DISTINCT tu.task_id) FROM task_user tu JOIN tasks t2 ON t2.id = tu.task_id LEFT JOIN statuses s2 ON s2.id = t2.status_id WHERE tu.user_id = u.id ${workspaceId ? 'AND t2.workspace_id = ' + Number(workspaceId) : ''} ${sharedTaskSubSql} AND t2.due_date IS NOT NULL AND t2.due_date < CURDATE() AND (LOWER(s2.title) NOT LIKE '%complete%' OR s2.id IS NULL) AND COALESCE(t2.completion_percentage, 0) < 100) AS overdue_tasks
        FROM users u
        LEFT JOIN model_has_roles mhr ON mhr.model_id = u.id AND (mhr.model_type = 'App\\\\Models\\\\User' OR mhr.model_type LIKE '%User')
        LEFT JOIN roles r ON r.id = mhr.role_id
        ${teamWhereSql}
        GROUP BY u.id
        ORDER BY open_tasks DESC, total_tasks DESC
      `, teamParams),

      pool.query(`
        SELECT
          p.id, p.title, p.workspace_id, w.title AS workspace_title,
          p.start_date, p.end_date, p.budget, p.is_favorite,
          s.id AS status_id, s.title AS status_title, s.color AS status_color,
          pr.id AS priority_id, pr.title AS priority_title, pr.color AS priority_color,
          (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS total_tasks,
          (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses ts ON ts.id = t.status_id WHERE t.project_id = p.id AND (LOWER(ts.title) LIKE '%complete%' OR t.completion_percentage = 100)) AS completed_tasks,
          (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses ts ON ts.id = t.status_id WHERE t.project_id = p.id AND t.due_date IS NOT NULL AND t.due_date < CURDATE() AND (LOWER(ts.title) NOT LIKE '%complete%' OR ts.id IS NULL) AND COALESCE(t.completion_percentage, 0) < 100) AS overdue_tasks,
          (SELECT COUNT(*) FROM comments c WHERE c.commentable_id = p.id AND c.commentable_type LIKE '%Project' AND c.deleted_at IS NULL) AS comments_count
        FROM projects p
        LEFT JOIN workspaces w ON w.id = p.workspace_id
        LEFT JOIN statuses s ON s.id = p.status_id
        LEFT JOIN priorities pr ON pr.id = p.priority_id
        ${projWhere}
        ORDER BY overdue_tasks DESC, p.updated_at DESC
        LIMIT 20
      `, projParams),

      pool.query(`
        SELECT
          t.id, t.title, t.project_id, p.title AS project_title,
          t.workspace_id, w.title AS workspace_title,
          t.start_date, t.due_date, t.completion_percentage,
          s.id AS status_id, s.title AS status_title, s.color AS status_color,
          pr.id AS priority_id, pr.title AS priority_title, pr.color AS priority_color,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = t.id) AS assignees,
          (SELECT tte.start_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS start_time,
          (SELECT tte.end_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS end_time,
          (SELECT rt.frequency FROM recurring_tasks rt WHERE rt.task_id = t.id AND rt.is_active = 1 LIMIT 1) AS recurring_frequency
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN workspaces w ON w.id = t.workspace_id
        LEFT JOIN statuses s ON s.id = t.status_id
        LEFT JOIN priorities pr ON pr.id = t.priority_id
        ${taskWhere} AND (LOWER(s.title) NOT LIKE '%complete%' OR s.id IS NULL)
        ORDER BY
          CASE WHEN t.due_date IS NOT NULL AND t.due_date < CURDATE() THEN 0 ELSE 1 END ASC,
          CASE WHEN LOWER(pr.title) = 'high' THEN 0 WHEN LOWER(pr.title) = 'medium' THEN 1 ELSE 2 END ASC,
          t.due_date ASC,
          t.id DESC
        LIMIT 20
      `, taskParams),

      pool.query(`
        SELECT a.id, a.workspace_id, w.title AS workspace_title, a.actor_id, a.actor_type,
          a.type, a.type_id, a.activity, a.message, a.created_at,
          CONCAT(u.first_name, ' ', u.last_name) AS actor_name
        FROM activity_logs a
        LEFT JOIN workspaces w ON w.id = a.workspace_id
        LEFT JOIN users u ON u.id = a.actor_id AND a.actor_type = 'user'
        ${workspaceId ? 'WHERE a.workspace_id = ?' : ''}
        ORDER BY a.id DESC
        LIMIT 30
      `, workspaceId ? [workspaceId] : []),

      pool.query(`
        SELECT
          w.id, w.title, w.is_primary,
          (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS projects_count,
          (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id) AS tasks_count,
          (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses s ON s.id = t.status_id WHERE t.workspace_id = w.id AND (LOWER(s.title) LIKE '%complete%' OR t.completion_percentage = 100)) AS completed_tasks_count,
          (SELECT COUNT(*) FROM user_workspace uw WHERE uw.workspace_id = w.id) AS members_count
        FROM workspaces w
        ORDER BY projects_count DESC, tasks_count DESC
      `),

      pool.query(`
        SELECT td.*
        FROM todos td
        WHERE td.creator_id = ?
        ORDER BY td.is_completed ASC, td.id DESC
        LIMIT 25
      `, [req.user.id]),

      pool.query(`
        SELECT lr.*, CONCAT(u.first_name, ' ', u.last_name) AS user_name, w.title AS workspace_title
        FROM leave_requests lr
        LEFT JOIN users u ON u.id = lr.user_id
        LEFT JOIN workspaces w ON w.id = lr.workspace_id
        ${workspaceId ? 'WHERE lr.workspace_id = ?' : ''}
        ORDER BY lr.id DESC
        LIMIT 20
      `, workspaceId ? [workspaceId] : [])
    ]);

    const queryTimeMs = Number(process.hrtime.bigint() - startHr) / 1e6;

    res.json({
      error: false,
      queryTimeMs: Number(queryTimeMs.toFixed(2)),
      projectStats: projectStats[0] || {},
      taskStats: taskStats[0] || {},
      todayTaskStats: todayTaskStats[0] || { today_total: 0, today_covered: 0, today_remaining: 0 },
      todayTasksList,
      todayMeetingsList,
      projectsByStatus,
      tasksByStatus,
      tasksByPriority,
      teamWorkload,
      atRiskProjects,
      urgentTasks,
      recentActivity,
      workspaceBreakdown,
      todos,
      leaveRequests,
      cronState
    });
  } catch (err) {
    console.error('Overview error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 3B. EXECUTIVE DAILY ACTIVITY CALENDAR (Done, Started, Planned, Meetings & Activity per Day)
// ==========================================
app.get('/api/calendar-activity', authMiddleware, async (req, res) => {
  try {
    const month = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
      ? req.query.month
      : new Date().toISOString().substring(0, 7);
    const workspaceId = req.query.workspace_id && req.query.workspace_id !== 'all' ? Number(req.query.workspace_id) : null;
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const uidNum = Number(req.user.id);
    const heldWsIds = await getHeldWorkspaceIds();
    const heldCsv = heldWsIds.length ? heldWsIds.join(',') : null;

    const monthStart = `${month}-01`;
    const [yr, mo] = month.split('-').map(Number);
    const lastDay = new Date(yr, mo, 0).getDate();
    const monthEnd = `${month}-${String(lastDay).padStart(2, '0')}`;

    const taskScopeSql = `${heldCsv ? `AND t.workspace_id NOT IN (${heldCsv})` : ''} ${isAdmin ? '' : `AND (t.id IN (SELECT task_id FROM task_user WHERE user_id = ${uidNum}) OR t.created_by = ${uidNum} OR t.project_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum}))`}`;
    const meetingScopeSql = `${heldCsv ? `AND m.workspace_id NOT IN (${heldCsv})` : ''} ${isAdmin ? '' : `AND (m.id IN (SELECT meeting_id FROM meeting_user WHERE user_id = ${uidNum}) OR m.user_id = '${uidNum}')`}`;
    const activityScopeSql = `${heldCsv ? `AND a.workspace_id NOT IN (${heldCsv})` : ''} ${isAdmin ? '' : `AND (a.actor_id = ${uidNum} OR (a.type = 'project' AND a.type_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum})) OR (a.type = 'task' AND a.type_id IN (SELECT task_id FROM task_user WHERE user_id = ${uidNum})))`}`;

    const [
      [tasks],
      [timelines],
      [meetings],
      [activities]
    ] = await Promise.all([
      pool.query(`
        SELECT
          t.id, t.title, t.project_id, p.title AS project_title,
          t.start_date, t.due_date, t.created_at, t.updated_at, t.completion_percentage,
          s.title AS status_title, s.color AS status_color,
          pr.title AS priority_title, pr.color AS priority_color,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = t.id) AS assignees,
          (SELECT tte.start_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS start_time,
          (SELECT tte.end_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS end_time
        FROM tasks t
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN statuses s ON s.id = t.status_id
        LEFT JOIN priorities pr ON pr.id = t.priority_id
        WHERE (
          (t.start_date BETWEEN ? AND ?)
          OR (t.due_date BETWEEN ? AND ?)
          OR (DATE(t.created_at) BETWEEN ? AND ?)
          OR (DATE(t.updated_at) BETWEEN ? AND ?)
        )
        ${workspaceId ? 'AND t.workspace_id = ?' : ''}
        ${taskScopeSql}
        ORDER BY t.id DESC
      `, workspaceId
        ? [monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd, workspaceId]
        : [monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd, monthStart, monthEnd]
      ),

      pool.query(`
        SELECT st.entity_id, st.status, st.previous_status, st.new_color, st.changed_at, st.created_at,
               t.title AS task_title, p.title AS project_title
        FROM status_timelines st
        JOIN tasks t ON t.id = st.entity_id
        LEFT JOIN projects p ON p.id = t.project_id
        WHERE st.entity_type LIKE '%Task'
          AND DATE(COALESCE(st.changed_at, st.created_at)) BETWEEN ? AND ?
          ${workspaceId ? 'AND t.workspace_id = ?' : ''}
          ${taskScopeSql}
        ORDER BY st.id DESC
      `, workspaceId ? [monthStart, monthEnd, workspaceId] : [monthStart, monthEnd]),

      pool.query(`
        SELECT m.id, m.title, m.start_date_time, m.end_date_time, w.title AS workspace_title,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM meeting_user mu JOIN users u ON u.id = mu.user_id WHERE mu.meeting_id = m.id) AS participants
        FROM meetings m
        LEFT JOIN workspaces w ON w.id = m.workspace_id
        WHERE DATE(m.start_date_time) BETWEEN ? AND ?
          ${workspaceId ? 'AND m.workspace_id = ?' : ''}
          ${meetingScopeSql}
        ORDER BY m.start_date_time ASC
      `, workspaceId ? [monthStart, monthEnd, workspaceId] : [monthStart, monthEnd]),

      pool.query(`
        SELECT a.id, a.type, a.type_id, a.activity, a.message, a.created_at,
               CONCAT(u.first_name, ' ', u.last_name) AS actor_name
        FROM activity_logs a
        LEFT JOIN users u ON u.id = a.actor_id AND a.actor_type = 'user'
        WHERE DATE(a.created_at) BETWEEN ? AND ?
          ${workspaceId ? 'AND a.workspace_id = ?' : ''}
          ${activityScopeSql}
        ORDER BY a.id DESC
        LIMIT 250
      `, workspaceId ? [monthStart, monthEnd, workspaceId] : [monthStart, monthEnd])
    ]);

    const days = {};
    const ensureDay = (dStr) => {
      if (!dStr || dStr < monthStart || dStr > monthEnd) return null;
      if (!days[dStr]) {
        days[dStr] = { done: [], started: [], planned: [], meetings: [], activities: [] };
      }
      return days[dStr];
    };
    const pushUnique = (arr, item, key = 'id') => {
      if (!arr.some(x => x[key] === item[key])) arr.push(item);
    };

    // Map latest completion / in-progress dates from status_timelines
    const timelineDoneDate = {};
    const timelineStartedDate = {};
    timelines.forEach(tl => {
      const dt = String(tl.changed_at || tl.created_at || '').substring(0, 10);
      const stLow = String(tl.status || '').toLowerCase();
      if (stLow.includes('complete') && !timelineDoneDate[tl.entity_id]) {
        timelineDoneDate[tl.entity_id] = dt;
      } else if (stLow.includes('progress') && !timelineStartedDate[tl.entity_id]) {
        timelineStartedDate[tl.entity_id] = dt;
      }
    });

    tasks.forEach(t => {
      const stLow = String(t.status_title || '').toLowerCase();
      const isDone = stLow.includes('complete') || Number(t.completion_percentage) === 100;
      const isStarted = stLow.includes('progress');
      const startD = t.start_date ? String(t.start_date).substring(0, 10) : null;
      const dueD = t.due_date ? String(t.due_date).substring(0, 10) : null;
      const createdD = t.created_at ? String(t.created_at).substring(0, 10) : null;
      const updatedD = t.updated_at ? String(t.updated_at).substring(0, 10) : null;

      const item = {
        id: t.id,
        title: t.title,
        project_title: t.project_title || '',
        assignees: t.assignees || 'Unassigned',
        status_title: t.status_title || 'Planned',
        status_color: t.status_color || 'secondary',
        priority_title: t.priority_title || 'Normal',
        start_time: t.start_time,
        end_time: t.end_time,
        start_date: startD,
        due_date: dueD
      };

      if (isDone) {
        const doneDate = timelineDoneDate[t.id] || updatedD || dueD || createdD;
        const b = ensureDay(doneDate);
        if (b) pushUnique(b.done, item);
      } else if (isStarted) {
        const startedDate = timelineStartedDate[t.id] || startD || updatedD || createdD;
        const b = ensureDay(startedDate);
        if (b) pushUnique(b.started, item);
      } else {
        const plannedDate = startD || dueD || createdD;
        const b = ensureDay(plannedDate);
        if (b) pushUnique(b.planned, item);
      }

      // If a task explicitly started on a date different from its done date, also show it as started on start_date
      if (isDone && startD && startD !== (timelineDoneDate[t.id] || updatedD)) {
        const sb = ensureDay(startD);
        if (sb) pushUnique(sb.started, item);
      }
    });

    meetings.forEach(m => {
      const mDate = String(m.start_date_time || '').substring(0, 10);
      const b = ensureDay(mDate);
      if (b) {
        b.meetings.push({
          id: m.id,
          title: m.title,
          start_time: String(m.start_date_time || '').substring(11, 16),
          end_time: String(m.end_date_time || '').substring(11, 16),
          workspace_title: m.workspace_title || '',
          participants: m.participants || 'Team'
        });
      }
    });

    activities.forEach(a => {
      const aDate = String(a.created_at || '').substring(0, 10);
      const b = ensureDay(aDate);
      if (b) {
        b.activities.push({
          id: a.id,
          type: a.type,
          type_id: a.type_id,
          activity: a.activity,
          actor_name: a.actor_name || 'Team Member',
          message: a.message || `${a.actor_name || 'User'} ${a.activity} ${a.type}`,
          time: String(a.created_at || '').substring(11, 16)
        });
      }
    });

    res.json({
      error: false,
      month,
      days
    });
  } catch (err) {
    console.error('Calendar activity error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 3C. WEEKLY & MONTHLY TEAM WORKLOAD & ALIGNMENT REPORT
// ==========================================
app.get('/api/reports/workload', authMiddleware, async (req, res) => {
  try {
    const period = req.query.period === 'monthly' ? 'monthly' : 'weekly';
    const workspaceId = req.query.workspace_id && req.query.workspace_id !== 'all' ? Number(req.query.workspace_id) : null;
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const uidNum = Number(req.user.id);
    const heldWsIds = await getHeldWorkspaceIds();
    const heldCsv = heldWsIds.length ? heldWsIds.join(',') : null;

    // Compute exact date range for selected Week (Mon-Sun) or Month (1st-Last)
    let startDate, endDate, periodLabel;
    if (period === 'monthly') {
      const mStr = (req.query.month && /^\d{4}-\d{2}$/.test(req.query.month))
        ? req.query.month
        : getLocalDateStr().substring(0, 7);
      const [yr, mo] = mStr.split('-').map(Number);
      const lastDay = new Date(yr, mo, 0).getDate();
      startDate = `${mStr}-01`;
      endDate = `${mStr}-${String(lastDay).padStart(2, '0')}`;
      periodLabel = new Date(yr, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
    } else {
      const refStr = (req.query.date && /^\d{4}-\d{2}-\d{2}$/.test(req.query.date))
        ? req.query.date
        : getLocalDateStr();
      const refDt = new Date(refStr + 'T12:00:00');
      const dow = (refDt.getDay() + 6) % 7; // Monday = 0
      const monday = new Date(refDt);
      monday.setDate(refDt.getDate() - dow);
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      startDate = getLocalDateStr(monday);
      endDate = getLocalDateStr(sunday);
      const fmt = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
      periodLabel = `${fmt(monday)} – ${fmt(sunday)} ${sunday.getFullYear()}`;
    }

    const todayStr = getLocalDateStr();

    // 1. Fetch active team members in scope
    const userClauses = ['u.status = 1'];
    const userParams = [];
    if (workspaceId) {
      userClauses.push('u.id IN (SELECT user_id FROM user_workspace WHERE workspace_id = ?)');
      userParams.push(workspaceId);
    }
    if (!isAdmin) {
      userClauses.push(`(u.id = ${uidNum} OR u.id IN (SELECT pu_co.user_id FROM project_user pu_co WHERE pu_co.project_id IN (SELECT project_id FROM project_user WHERE user_id = ${uidNum})))`);
    }

    const [
      [users],
      [tasks],
      [timeEntries],
      [meetings]
    ] = await Promise.all([
      pool.query(`
        SELECT u.id, u.first_name, u.last_name, u.email,
               GROUP_CONCAT(DISTINCT r.name SEPARATOR ', ') AS role_name,
               (SELECT COUNT(DISTINCT pu.project_id) FROM project_user pu JOIN projects p2 ON p2.id = pu.project_id WHERE pu.user_id = u.id ${workspaceId ? 'AND p2.workspace_id = ' + workspaceId : ''}) AS active_projects
        FROM users u
        LEFT JOIN model_has_roles mhr ON mhr.model_id = u.id AND (mhr.model_type = 'App\\\\Models\\\\User' OR mhr.model_type LIKE '%User')
        LEFT JOIN roles r ON r.id = mhr.role_id
        WHERE ${userClauses.join(' AND ')}
        GROUP BY u.id
        ORDER BY u.first_name ASC
      `, userParams),

      pool.query(`
        SELECT
          t.id, t.title, t.project_id, p.title AS project_title,
          t.start_date, t.due_date, t.created_at, t.updated_at, t.completion_percentage,
          s.title AS status_title, s.color AS status_color,
          pr.title AS priority_title, pr.color AS priority_color,
          tu.user_id AS assignee_id
        FROM tasks t
        JOIN task_user tu ON tu.task_id = t.id
        LEFT JOIN projects p ON p.id = t.project_id
        LEFT JOIN statuses s ON s.id = t.status_id
        LEFT JOIN priorities pr ON pr.id = t.priority_id
        WHERE (
          (t.start_date BETWEEN ? AND ?)
          OR (t.due_date BETWEEN ? AND ?)
          OR (DATE(t.created_at) BETWEEN ? AND ?)
          OR (DATE(t.updated_at) BETWEEN ? AND ?)
          OR (t.due_date IS NOT NULL AND t.due_date < ? AND (LOWER(s.title) NOT LIKE '%complete%' OR s.id IS NULL) AND COALESCE(t.completion_percentage, 0) < 100)
          OR (t.start_date IS NULL AND t.due_date IS NULL AND (LOWER(s.title) NOT LIKE '%complete%' OR s.id IS NULL))
        )
        ${heldCsv ? `AND t.workspace_id NOT IN (${heldCsv})` : ''}
        ${workspaceId ? 'AND t.workspace_id = ?' : ''}
        ORDER BY t.id DESC
      `, workspaceId
        ? [startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate, todayStr, workspaceId]
        : [startDate, endDate, startDate, endDate, startDate, endDate, startDate, endDate, todayStr]
      ),

      pool.query(`
        SELECT tte.user_id, tte.task_id, tte.entry_date, tte.start_time, tte.end_time
        FROM task_time_entries tte
        WHERE tte.entry_date BETWEEN ? AND ?
          ${workspaceId ? 'AND tte.workspace_id = ?' : ''}
      `, workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate]),

      pool.query(`
        SELECT m.id, m.title, m.start_date_time, mu.user_id
        FROM meetings m
        JOIN meeting_user mu ON mu.meeting_id = m.id
        WHERE DATE(m.start_date_time) BETWEEN ? AND ?
          ${workspaceId ? 'AND m.workspace_id = ?' : ''}
      `, workspaceId ? [startDate, endDate, workspaceId] : [startDate, endDate])
    ]);

    const govStore = await getMeetingGovernanceStore();

    // Index scheduled hours per user
    const hoursMap = {};
    timeEntries.forEach(te => {
      const uid = Number(String(te.user_id || '').replace(/^u_/, ''));
      if (!uid || !te.start_time || !te.end_time) return;
      const [sh, sm] = String(te.start_time).split(':').map(Number);
      const [eh, em] = String(te.end_time).split(':').map(Number);
      const mins = (eh * 60 + (em || 0)) - (sh * 60 + (sm || 0));
      if (mins > 0) hoursMap[uid] = (hoursMap[uid] || 0) + (mins / 60);
    });

    // Index meeting attendance per user
    const meetStatsMap = {};
    meetings.forEach(m => {
      const uid = Number(m.user_id);
      if (!meetStatsMap[uid]) meetStatsMap[uid] = { invited: 0, attended: 0, evaluated: 0 };
      meetStatsMap[uid].invited++;
      const st = govStore.records[m.id]?.attendance?.[uid]?.status || 'pending';
      if (st !== 'pending') {
        meetStatsMap[uid].evaluated++;
        if (st === 'present' || st === 'late') meetStatsMap[uid].attended++;
      }
    });

    // Index tasks per user
    const tasksByUser = {};
    tasks.forEach(t => {
      const uid = Number(t.assignee_id);
      if (!tasksByUser[uid]) tasksByUser[uid] = [];
      if (!tasksByUser[uid].some(x => x.id === t.id)) tasksByUser[uid].push(t);
    });

    let totalTasksAll = 0;
    let totalDoneAll = 0;
    let totalOverdueAll = 0;
    let totalHoursAll = 0;
    let overloadedCount = 0;
    let availableCount = 0;
    let alignedCount = 0;

    const members = users.map(u => {
      const uid = Number(u.id);
      const uTasks = tasksByUser[uid] || [];
      let completed = 0;
      let inProgress = 0;
      let planned = 0;
      let overdue = 0;
      let highPriorityOpen = 0;

      const taskSummaries = uTasks.map(t => {
        const stLow = String(t.status_title || '').toLowerCase();
        const isDone = stLow.includes('complete') || Number(t.completion_percentage) === 100;
        const isProg = stLow.includes('progress');
        const dueD = t.due_date ? String(t.due_date).substring(0, 10) : null;
        const isOverdue = Boolean(!isDone && dueD && dueD < todayStr);

        if (isDone) completed++;
        else if (isProg) inProgress++;
        else planned++;
        if (isOverdue) overdue++;
        if (!isDone && String(t.priority_title || '').toLowerCase() === 'high') highPriorityOpen++;

        return {
          id: t.id,
          title: t.title,
          project_title: t.project_title || 'General',
          status_title: t.status_title || 'Planned',
          status_color: t.status_color || 'secondary',
          priority_title: t.priority_title || 'Normal',
          due_date: dueD,
          is_done: isDone,
          is_overdue: isOverdue
        };
      });

      const total = uTasks.length;
      const open = total - completed;
      const completionRate = total > 0 ? Math.round((completed / total) * 100) : 100;
      const scheduledHours = Number((hoursMap[uid] || 0).toFixed(1));
      const ms = meetStatsMap[uid] || { invited: 0, attended: 0, evaluated: 0 };
      const meetingRate = ms.evaluated > 0 ? Math.round((ms.attended / ms.evaluated) * 100) : null;

      // Capacity assessment
      let capacityStatus = 'Balanced';
      if (open >= 6 || overdue >= 2 || highPriorityOpen >= 3) {
        capacityStatus = 'Overloaded';
        overloadedCount++;
      } else if (open <= 1 && total <= 2) {
        capacityStatus = 'Available';
        availableCount++;
      }

      // Alignment Score (0-100):
      // Starts at 100, deducts for overdue tasks, low active progress, and missed meetings
      let score = 100;
      if (total > 0) {
        score -= Math.min(45, overdue * 18); // Overdue penalty
        if (open > 0 && inProgress === 0 && completed === 0) score -= 20; // Stalled (nothing started or done)
        if (completionRate < 40 && total >= 3) score -= 15;
      }
      if (meetingRate !== null && meetingRate < 80) {
        score -= Math.round((80 - meetingRate) * 0.35);
      }
      score = Math.max(0, Math.min(100, score));

      let alignmentStatus = 'Aligned';
      let recommendation = 'On track and aligned with team schedule.';
      if (score < 60 || overdue >= 2) {
        alignmentStatus = 'At Risk';
        recommendation = overdue > 0
          ? `${overdue} overdue task(s) — review blockers or reassign urgent items.`
          : 'Low progress on assigned workload — check in with member.';
      } else if (score < 82 || capacityStatus === 'Overloaded') {
        alignmentStatus = 'Needs Attention';
        recommendation = capacityStatus === 'Overloaded'
          ? `High open workload (${open} tasks) — consider balancing with available teammates.`
          : `${overdue > 0 ? overdue + ' overdue task — ' : ''}Monitor progress to stay on target.`;
      } else {
        alignedCount++;
        if (capacityStatus === 'Available') {
          recommendation = 'Light workload — available to take on new or redistributed tasks.';
        }
      }

      totalTasksAll += total;
      totalDoneAll += completed;
      totalOverdueAll += overdue;
      totalHoursAll += scheduledHours;

      return {
        user_id: uid,
        name: `${u.first_name} ${u.last_name || ''}`.trim(),
        email: u.email,
        role_name: u.role_name || 'Member',
        active_projects: Number(u.active_projects || 0),
        total_tasks: total,
        open_tasks: open,
        in_progress_tasks: inProgress,
        planned_tasks: planned,
        completed_tasks: completed,
        overdue_tasks: overdue,
        high_priority_open: highPriorityOpen,
        completion_rate: completionRate,
        scheduled_hours: scheduledHours,
        meetings_invited: ms.invited,
        meeting_attendance_rate: meetingRate,
        capacity_status: capacityStatus,
        alignment_score: score,
        alignment_status: alignmentStatus,
        recommendation,
        tasks: taskSummaries
      };
    });

    const avgAlignmentScore = members.length > 0
      ? Math.round(members.reduce((acc, m) => acc + m.alignment_score, 0) / members.length)
      : 100;

    res.json({
      error: false,
      period,
      startDate,
      endDate,
      periodLabel,
      kpis: {
        avgAlignmentScore,
        alignedMembers: alignedCount,
        totalMembers: members.length,
        totalTasks: totalTasksAll,
        completedTasks: totalDoneAll,
        completionRate: totalTasksAll > 0 ? Math.round((totalDoneAll / totalTasksAll) * 100) : 0,
        overdueTasks: totalOverdueAll,
        overloadedMembers: overloadedCount,
        availableMembers: availableCount,
        totalScheduledHours: Number(totalHoursAll.toFixed(1))
      },
      members
    });
  } catch (err) {
    console.error('Workload report error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 4. PROJECTS CRUD & DRILLDOWN ENDPOINTS
// ==========================================
app.get('/api/projects', authMiddleware, async (req, res) => {
  try {
    const { workspace_id, status_id, priority_id, search, user_id } = req.query;
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const heldWsIds = await getHeldWorkspaceIds();

    let where = 'WHERE 1=1';
    const params = [];

    if (heldWsIds.length) {
      where += ` AND p.workspace_id NOT IN (${heldWsIds.join(',')})`;
    }
    if (workspace_id && workspace_id !== 'all') {
      where += ' AND p.workspace_id = ?';
      params.push(Number(workspace_id));
    }
    if (status_id) {
      where += ' AND p.status_id = ?';
      params.push(Number(status_id));
    }
    if (priority_id) {
      where += ' AND p.priority_id = ?';
      params.push(Number(priority_id));
    }
    if (search) {
      where += ' AND (p.title LIKE ? OR p.description LIKE ?)';
      params.push(`%${search}%`, `%${search}%`);
    }
    if (user_id) {
      where += ' AND p.id IN (SELECT project_id FROM project_user WHERE user_id = ?)';
      params.push(Number(user_id));
    }
    if (!isAdmin) {
      where += ' AND (p.id IN (SELECT project_id FROM project_user WHERE user_id = ?) OR p.created_by = ?)';
      params.push(req.user.id, req.user.id);
    }

    const todayStr = getLocalDateStr();
    const queryParams = [todayStr, todayStr, ...params];
    const [projects] = await pool.query(`
      SELECT
        p.*,
        w.title AS workspace_title,
        s.title AS status_title, s.color AS status_color,
        pr.title AS priority_title, pr.color AS priority_color,
        CONCAT(creator.first_name, ' ', creator.last_name) AS creator_name,
        (SELECT COUNT(*) FROM tasks t WHERE t.project_id = p.id) AS tasks_count,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses ts ON ts.id = t.status_id WHERE t.project_id = p.id AND (LOWER(ts.title) LIKE '%complete%' OR t.completion_percentage = 100)) AS completed_tasks_count,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses ts ON ts.id = t.status_id WHERE t.project_id = p.id AND t.due_date IS NOT NULL AND DATE(t.due_date) < ? AND (LOWER(COALESCE(ts.title, '')) NOT LIKE '%complete%') AND COALESCE(t.completion_percentage, 0) < 100) AS overdue_tasks_count,
        (SELECT COUNT(*) FROM tasks t LEFT JOIN statuses ts ON ts.id = t.status_id WHERE t.project_id = p.id AND t.due_date IS NOT NULL AND DATE(t.due_date) = ? AND (LOWER(COALESCE(ts.title, '')) NOT LIKE '%complete%') AND COALESCE(t.completion_percentage, 0) < 100) AS due_today_tasks_count,
        (SELECT COUNT(*) FROM comments c WHERE c.commentable_id = p.id AND c.commentable_type LIKE '%Project' AND c.deleted_at IS NULL) AS comments_count
      FROM projects p
      LEFT JOIN workspaces w ON w.id = p.workspace_id
      LEFT JOIN statuses s ON s.id = p.status_id
      LEFT JOIN priorities pr ON pr.id = p.priority_id
      LEFT JOIN users creator ON creator.id = p.created_by
      ${where}
      ORDER BY p.is_favorite DESC, p.id DESC
    `, queryParams);

    if (projects.length > 0) {
      const pIds = projects.map(p => p.id);
      const [
        [pUsers],
        [pClients],
        [pTags]
      ] = await Promise.all([
        pool.query(`
          SELECT pu.project_id, u.id, u.first_name, u.last_name, u.email, u.photo
          FROM project_user pu
          JOIN users u ON u.id = pu.user_id
          WHERE pu.project_id IN (?)
        `, [pIds]),
        pool.query(`
          SELECT cp.project_id, c.id, c.first_name, c.last_name, c.company, c.email
          FROM client_project cp
          JOIN clients c ON c.id = cp.client_id
          WHERE cp.project_id IN (?)
        `, [pIds]),
        pool.query(`
          SELECT pt.project_id, t.id, t.title, t.color
          FROM project_tag pt
          JOIN tags t ON t.id = pt.tag_id
          WHERE pt.project_id IN (?)
        `, [pIds])
      ]);

      const usersMap = {};
      const clientsMap = {};
      const tagsMap = {};
      pUsers.forEach(u => { (usersMap[u.project_id] = usersMap[u.project_id] || []).push(u); });
      pClients.forEach(c => { (clientsMap[c.project_id] = clientsMap[c.project_id] || []).push(c); });
      pTags.forEach(t => { (tagsMap[t.project_id] = tagsMap[t.project_id] || []).push(t); });

      projects.forEach(p => {
        p.users = usersMap[p.id] || [];
        p.user_ids = p.users.map(u => u.id);
        p.clients = clientsMap[p.id] || [];
        p.client_ids = p.clients.map(c => c.id);
        p.tags = tagsMap[p.id] || [];
        p.tag_ids = p.tags.map(t => t.id);
      });
    }

    res.json({ error: false, projects });
  } catch (err) {
    console.error('Get projects error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

app.get('/api/projects/:id/details', authMiddleware, async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const [
      [milestones],
      [timelines],
      [comments]
    ] = await Promise.all([
      pool.query('SELECT * FROM milestones WHERE project_id = ? ORDER BY id DESC', [projectId]),
      pool.query("SELECT * FROM status_timelines WHERE entity_id = ? AND entity_type LIKE '%Project' ORDER BY id DESC", [projectId]),
      pool.query(`
        SELECT c.*, CONCAT(u.first_name, ' ', u.last_name) AS author_name
        FROM comments c
        LEFT JOIN users u ON u.id = c.commenter_id
        WHERE c.commentable_id = ? AND c.commentable_type LIKE '%Project' AND c.deleted_at IS NULL
        ORDER BY c.id DESC
      `, [projectId])
    ]);
    res.json({ error: false, milestones, timelines, comments });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/projects/:id/favorite', authMiddleware, async (req, res) => {
  try {
    const projectId = Number(req.params.id);
    const [rows] = await pool.query('SELECT is_favorite FROM projects WHERE id = ?', [projectId]);
    if (!rows.length) return res.status(404).json({ error: true, message: 'Project not found' });
    const nextVal = rows[0].is_favorite ? 0 : 1;
    await pool.query('UPDATE projects SET is_favorite = ? WHERE id = ?', [nextVal, projectId]);
    res.json({ error: false, is_favorite: nextVal });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/projects', authMiddleware, async (req, res) => {
  const canCreate = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('create_projects');
  if (!canCreate) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create projects.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      title,
      workspace_id,
      status_id,
      priority_id,
      budget,
      start_date,
      end_date,
      description,
      note,
      task_accessibility = 'assigned_users',
      client_can_discuss = 0,
      enable_tasks_time_entries = 0,
      user_ids = [],
      client_ids = [],
      tag_ids = [],
      send_email_notification = true
    } = req.body;

    if (!title || !title.trim()) {
      return res.status(400).json({ error: true, message: 'Project title is required' });
    }
    const targetWorkspaceId = Number(workspace_id || req.user.default_workspace_id || 5);
    const cleanBudget = budget !== undefined && budget !== null && String(budget).trim() !== ''
      ? String(budget).replace(/,/g, '')
      : null;

    const [insertRes] = await conn.query(`
      INSERT INTO projects
        (workspace_id, title, description, status_id, priority_id, budget, start_date, end_date,
         created_by, is_favorite, task_accessibility, note, client_can_discuss, enable_tasks_time_entries, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW(), NOW())
    `, [
      targetWorkspaceId,
      title.trim(),
      description || null,
      status_id ? Number(status_id) : null,
      priority_id && Number(priority_id) !== 0 ? Number(priority_id) : null,
      cleanBudget,
      start_date || null,
      end_date || null,
      req.user.id,
      task_accessibility || 'assigned_users',
      note || null,
      client_can_discuss ? 1 : 0,
      enable_tasks_time_entries ? 1 : 0
    ]);

    const projectId = insertRes.insertId;

    const finalUserIds = Array.isArray(user_ids) ? [...new Set(user_ids.map(Number).filter(Boolean))] : [];
    if (!req.user.isAdminOrHasAllDataAccess && !finalUserIds.includes(req.user.id)) {
      finalUserIds.unshift(req.user.id);
    }

    if (finalUserIds.length > 0) {
      const puValues = finalUserIds.map(uid => [projectId, uid]);
      await conn.query('INSERT INTO project_user (project_id, user_id) VALUES ?', [puValues]);
    }

    const finalClientIds = Array.isArray(client_ids) ? [...new Set(client_ids.map(Number).filter(Boolean))] : [];
    if (finalClientIds.length > 0) {
      const pcValues = finalClientIds.map(cid => [projectId, cid]);
      await conn.query('INSERT INTO client_project (project_id, client_id) VALUES ?', [pcValues]);
    }

    const finalTagIds = Array.isArray(tag_ids) ? [...new Set(tag_ids.map(Number).filter(Boolean))] : [];
    if (finalTagIds.length > 0) {
      const ptValues = finalTagIds.map(tid => [projectId, tid]);
      await conn.query('INSERT INTO project_tag (project_id, tag_id) VALUES ?', [ptValues]);
    }

    if (status_id) {
      const [stRows] = await conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [status_id]);
      if (stRows.length) {
        await conn.query(`
          INSERT INTO status_timelines (entity_id, entity_type, status, previous_status, new_color, old_color, changed_at, created_at, updated_at)
          VALUES (?, 'App\\\\Models\\\\Project', ?, '-', ?, NULL, NOW(), NOW(), NOW())
        `, [projectId, stRows[0].title, stRows[0].color]);
      }
    }

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    await logActivity(conn, {
      workspace_id: targetWorkspaceId,
      actor_id: req.user.id,
      type_id: projectId,
      type: 'project',
      activity: 'created',
      message: `${actorName} created project ${title.trim()}`
    });

    await conn.commit();

    // Notify & Email assigned users asynchronously
    if (finalUserIds.length > 0) {
      notifyUsersAndSendEmail({
        workspace_id: targetWorkspaceId,
        from_user_id: req.user.id,
        type: 'project',
        type_id: projectId,
        action: 'assigned',
        title: `New Project Assigned: ${title.trim()}`,
        message: `${actorName} assigned you to project "${title.trim()}".`,
        emailSubject: `📁 New Project Assigned: ${title.trim()}`,
        emailHtml: `
          <p><strong>${actorName}</strong> has assigned you to a new project:</p>
          <div style="background: #f8fafc; padding: 14px; border-left: 4px solid #2563eb; margin: 14px 0;">
            <p style="margin: 0 0 6px 0;"><strong>Project:</strong> ${title.trim()}</p>
            ${start_date ? `<p style="margin: 0 0 6px 0;"><strong>Start Date:</strong> ${start_date}</p>` : ''}
            ${end_date ? `<p style="margin: 0;"><strong>End Date:</strong> ${end_date}</p>` : ''}
          </div>
          ${description ? `<p><strong>Details:</strong> ${description}</p>` : ''}
        `,
        user_ids: finalUserIds,
        send_email: Boolean(send_email_notification)
      });
    }

    res.json({ error: false, message: 'Project created successfully', id: projectId });
  } catch (err) {
    await conn.rollback();
    console.error('Create project error:', err);
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.put('/api/projects/:id', authMiddleware, async (req, res) => {
  const canEdit = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('edit_projects');
  if (!canEdit) {
    return res.status(403).json({ error: true, message: 'You do not have permission to edit projects.' });
  }

  const projectId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.query('SELECT * FROM projects WHERE id = ? LIMIT 1', [projectId]);
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Project not found' });
    }
    const existing = existingRows[0];

    const {
      title,
      workspace_id,
      status_id,
      priority_id,
      budget,
      start_date,
      end_date,
      description,
      note,
      task_accessibility,
      client_can_discuss,
      enable_tasks_time_entries,
      user_ids,
      client_ids,
      tag_ids
    } = req.body;

    const newStatusId = status_id !== undefined ? Number(status_id) : existing.status_id;
    const cleanBudget = budget !== undefined
      ? (budget !== null && String(budget).trim() !== '' ? String(budget).replace(/,/g, '') : null)
      : existing.budget;

    if (newStatusId && newStatusId !== existing.status_id) {
      const [[oldSt], [newSt]] = await Promise.all([
        conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [existing.status_id]),
        conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [newStatusId])
      ]);
      if (newSt.length) {
        await conn.query(`
          INSERT INTO status_timelines (entity_id, entity_type, status, previous_status, new_color, old_color, changed_at, created_at, updated_at)
          VALUES (?, 'App\\\\Models\\\\Project', ?, ?, ?, ?, NOW(), NOW(), NOW())
        `, [
          projectId,
          newSt[0].title,
          oldSt.length ? oldSt[0].title : '-',
          newSt[0].color,
          oldSt.length ? oldSt[0].color : null
        ]);
      }
    }

    await conn.query(`
      UPDATE projects
      SET workspace_id = ?, title = ?, description = ?, status_id = ?, priority_id = ?,
          budget = ?, start_date = ?, end_date = ?, task_accessibility = ?, note = ?,
          client_can_discuss = ?, enable_tasks_time_entries = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      workspace_id ? Number(workspace_id) : existing.workspace_id,
      title !== undefined ? title.trim() : existing.title,
      description !== undefined ? (description || null) : existing.description,
      newStatusId,
      priority_id !== undefined ? (priority_id && Number(priority_id) !== 0 ? Number(priority_id) : null) : existing.priority_id,
      cleanBudget,
      start_date !== undefined ? (start_date || null) : existing.start_date,
      end_date !== undefined ? (end_date || null) : existing.end_date,
      task_accessibility || existing.task_accessibility || 'assigned_users',
      note !== undefined ? (note || null) : existing.note,
      client_can_discuss !== undefined ? (client_can_discuss ? 1 : 0) : existing.client_can_discuss,
      enable_tasks_time_entries !== undefined ? (enable_tasks_time_entries ? 1 : 0) : existing.enable_tasks_time_entries,
      projectId
    ]);

    if (Array.isArray(user_ids)) {
      const [oldUsers] = await conn.query('SELECT user_id FROM project_user WHERE project_id = ?', [projectId]);
      const oldUserIds = oldUsers.map(u => Number(u.user_id));
      await conn.query('DELETE FROM project_user WHERE project_id = ?', [projectId]);
      const finalUserIds = [...new Set(user_ids.map(Number).filter(Boolean))];
      if (finalUserIds.length > 0) {
        await conn.query('INSERT INTO project_user (project_id, user_id) VALUES ?', [finalUserIds.map(uid => [projectId, uid])]);
      }
      const newlyAdded = finalUserIds.filter(uid => !oldUserIds.includes(uid));
      if (newlyAdded.length > 0) {
        const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
        const projTitle = title || existing.title;
        notifyUsersAndSendEmail({
          workspace_id: workspace_id ? Number(workspace_id) : existing.workspace_id,
          from_user_id: req.user.id,
          type: 'project',
          type_id: projectId,
          action: 'assigned',
          title: `New Project Assigned: ${projTitle}`,
          message: `${actorName} assigned you to project "${projTitle}" (#${projectId}).`,
          emailSubject: `📁 Added to Project: ${projTitle}`,
          emailHtml: `<p><strong>${actorName}</strong> added you to project <strong>${projTitle}</strong> (#${projectId}).</p>`,
          user_ids: newlyAdded,
          send_email: true
        });
      }
    }

    if (Array.isArray(client_ids)) {
      await conn.query('DELETE FROM client_project WHERE project_id = ?', [projectId]);
      const finalClientIds = [...new Set(client_ids.map(Number).filter(Boolean))];
      if (finalClientIds.length > 0) {
        await conn.query('INSERT INTO client_project (project_id, client_id) VALUES ?', [finalClientIds.map(cid => [projectId, cid])]);
      }
    }

    if (Array.isArray(tag_ids)) {
      await conn.query('DELETE FROM project_tag WHERE project_id = ?', [projectId]);
      const finalTagIds = [...new Set(tag_ids.map(Number).filter(Boolean))];
      if (finalTagIds.length > 0) {
        await conn.query('INSERT INTO project_tag (project_id, tag_id) VALUES ?', [finalTagIds.map(tid => [projectId, tid])]);
      }
    }

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    await logActivity(conn, {
      workspace_id: workspace_id ? Number(workspace_id) : existing.workspace_id,
      actor_id: req.user.id,
      type_id: projectId,
      type: 'project',
      activity: 'updated',
      message: `${actorName} updated project ${title || existing.title}`
    });

    await conn.commit();
    res.json({ error: false, message: 'Project updated successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.post('/api/projects/:id/duplicate', authMiddleware, async (req, res) => {
  const projectId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [pRows] = await conn.query('SELECT * FROM projects WHERE id = ?', [projectId]);
    if (!pRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Project not found' });
    }
    const orig = pRows[0];
    const newTitle = req.body.title || `${orig.title} (Copy)`;

    const [ins] = await conn.query(`
      INSERT INTO projects
        (workspace_id, title, description, status_id, priority_id, budget, start_date, end_date,
         created_by, is_favorite, task_accessibility, note, client_can_discuss, enable_tasks_time_entries, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, NOW(), NOW())
    `, [
      orig.workspace_id, newTitle, orig.description, orig.status_id, orig.priority_id,
      orig.budget, orig.start_date, orig.end_date, req.user.id, orig.task_accessibility,
      orig.note, orig.client_can_discuss, orig.enable_tasks_time_entries
    ]);
    const newProjId = ins.insertId;

    const [pUsers] = await conn.query('SELECT user_id FROM project_user WHERE project_id = ?', [projectId]);
    if (pUsers.length > 0) {
      await conn.query('INSERT INTO project_user (project_id, user_id) VALUES ?', [pUsers.map(u => [newProjId, u.user_id])]);
    }

    const [pTags] = await conn.query('SELECT tag_id FROM project_tag WHERE project_id = ?', [projectId]);
    if (pTags.length > 0) {
      await conn.query('INSERT INTO project_tag (project_id, tag_id) VALUES ?', [pTags.map(t => [newProjId, t.tag_id])]);
    }

    await conn.commit();
    res.json({ error: false, message: 'Project duplicated successfully', id: newProjId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/projects/:id', authMiddleware, async (req, res) => {
  const canDelete = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('delete_projects');
  if (!canDelete) {
    return res.status(403).json({ error: true, message: 'You do not have permission to delete projects.' });
  }

  const projectId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existing] = await conn.query('SELECT title, workspace_id FROM projects WHERE id = ? LIMIT 1', [projectId]);
    if (!existing.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Project not found' });
    }

    await conn.query('DELETE FROM project_user WHERE project_id = ?', [projectId]);
    await conn.query('DELETE FROM client_project WHERE project_id = ?', [projectId]);
    await conn.query('DELETE FROM project_tag WHERE project_id = ?', [projectId]);
    await conn.query('DELETE FROM task_user WHERE task_id IN (SELECT id FROM tasks WHERE project_id = ?)', [projectId]);
    await conn.query('DELETE FROM tasks WHERE project_id = ?', [projectId]);
    await conn.query('DELETE FROM projects WHERE id = ?', [projectId]);

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    await logActivity(conn, {
      workspace_id: existing[0].workspace_id,
      actor_id: req.user.id,
      type_id: projectId,
      type: 'project',
      activity: 'deleted',
      message: `${actorName} deleted project ${existing[0].title}`
    });

    await conn.commit();
    res.json({ error: false, message: 'Project deleted successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 5. TASKS CRUD (WITH TIME-SLOTS, RECURRING & REMINDERS)
// ==========================================
app.get('/api/tasks', authMiddleware, async (req, res) => {
  try {
    const { workspace_id, project_id, status_id, priority_id, user_id, search } = req.query;
    const isAdmin = req.user.isAdminOrHasAllDataAccess;
    const heldWsIds = await getHeldWorkspaceIds();

    let where = 'WHERE 1=1';
    const params = [];

    if (heldWsIds.length) {
      where += ` AND t.workspace_id NOT IN (${heldWsIds.join(',')})`;
    }
    if (workspace_id && workspace_id !== 'all') {
      where += ' AND t.workspace_id = ?';
      params.push(Number(workspace_id));
    }
    if (project_id) {
      where += ' AND t.project_id = ?';
      params.push(Number(project_id));
    }
    if (status_id) {
      where += ' AND t.status_id = ?';
      params.push(Number(status_id));
    }
    if (priority_id) {
      where += ' AND t.priority_id = ?';
      params.push(Number(priority_id));
    }
    if (user_id) {
      where += ' AND t.id IN (SELECT task_id FROM task_user WHERE user_id = ?)';
      params.push(Number(user_id));
    }
    if (search) {
      where += ' AND (t.title LIKE ? OR t.description LIKE ? OR p.title LIKE ?)';
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (!isAdmin) {
      where += ' AND (t.id IN (SELECT task_id FROM task_user WHERE user_id = ?) OR t.created_by = ? OR t.project_id IN (SELECT project_id FROM project_user WHERE user_id = ?))';
      params.push(req.user.id, req.user.id, req.user.id);
    }

    const [tasks] = await pool.query(`
      SELECT
        t.*,
        p.title AS project_title,
        w.title AS workspace_title,
        s.title AS status_title, s.color AS status_color,
        pr.title AS priority_title, pr.color AS priority_color,
        CONCAT(creator.first_name, ' ', creator.last_name) AS creator_name,
        (SELECT tte.start_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS start_time,
        (SELECT tte.end_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS end_time,
        (SELECT COUNT(*) > 0 FROM recurring_tasks rt WHERE rt.task_id = t.id) AS is_recurring,
        (SELECT rt.frequency FROM recurring_tasks rt WHERE rt.task_id = t.id ORDER BY rt.id DESC LIMIT 1) AS recurring_frequency,
        (SELECT rt.number_of_occurrences FROM recurring_tasks rt WHERE rt.task_id = t.id ORDER BY rt.id DESC LIMIT 1) AS recurring_occurrences,
        (SELECT rem.is_active FROM reminders rem WHERE rem.remindable_id = t.id AND rem.remindable_type LIKE '%Task' ORDER BY rem.id DESC LIMIT 1) AS has_reminder,
        (SELECT rem.frequency_type FROM reminders rem WHERE rem.remindable_id = t.id AND rem.remindable_type LIKE '%Task' ORDER BY rem.id DESC LIMIT 1) AS reminder_frequency,
        (SELECT rem.time_of_day FROM reminders rem WHERE rem.remindable_id = t.id AND rem.remindable_type LIKE '%Task' ORDER BY rem.id DESC LIMIT 1) AS reminder_time,
        (SELECT COUNT(*) FROM comments c WHERE c.commentable_id = t.id AND c.commentable_type LIKE '%Task' AND c.deleted_at IS NULL) AS comments_count,
        (SELECT COUNT(*) FROM tasks st WHERE st.parent_id = t.id) AS subtasks_count,
        (SELECT COUNT(*) FROM tasks st LEFT JOIN statuses sts ON sts.id = st.status_id WHERE st.parent_id = t.id AND (LOWER(sts.title) LIKE '%complete%' OR st.completion_percentage = 100)) AS completed_subtasks_count,
        (SELECT pt.title FROM tasks pt WHERE pt.id = t.parent_id LIMIT 1) AS parent_task_title
      FROM tasks t
      LEFT JOIN projects p ON p.id = t.project_id
      LEFT JOIN workspaces w ON w.id = t.workspace_id
      LEFT JOIN statuses s ON s.id = t.status_id
      LEFT JOIN priorities pr ON pr.id = t.priority_id
      LEFT JOIN users creator ON creator.id = t.created_by
      ${where}
      ORDER BY t.id DESC
    `, params);

    if (tasks.length > 0) {
      const tIds = tasks.map(t => t.id);
      const [tUsers] = await pool.query(`
        SELECT tu.task_id, u.id, u.first_name, u.last_name, u.email, u.photo
        FROM task_user tu
        JOIN users u ON u.id = tu.user_id
        WHERE tu.task_id IN (?)
      `, [tIds]);

      const usersMap = {};
      tUsers.forEach(u => { (usersMap[u.task_id] = usersMap[u.task_id] || []).push(u); });
      tasks.forEach(t => {
        t.users = usersMap[t.id] || [];
        t.user_ids = t.users.map(u => u.id);
      });
    }

    res.json({ error: false, tasks });
  } catch (err) {
    console.error('Get tasks error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

// Single Task Detailed View (Subtasks, Status History Timeline, Time Entries & Comments)
app.get('/api/tasks/:id/details', authMiddleware, async (req, res) => {
  try {
    const taskId = Number(req.params.id);
    const [
      [subtasks],
      [timelines],
      [comments],
      [timeEntries]
    ] = await Promise.all([
      pool.query(`
        SELECT
          st.*,
          s.title AS status_title, s.color AS status_color,
          pr.title AS priority_title, pr.color AS priority_color,
          (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
           FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = st.id) AS assignees,
          (SELECT GROUP_CONCAT(tu.user_id SEPARATOR ',')
           FROM task_user tu WHERE tu.task_id = st.id) AS assignee_ids
        FROM tasks st
        LEFT JOIN statuses s ON s.id = st.status_id
        LEFT JOIN priorities pr ON pr.id = st.priority_id
        WHERE st.parent_id = ?
        ORDER BY st.id ASC
      `, [taskId]),
      pool.query("SELECT * FROM status_timelines WHERE entity_id = ? AND entity_type LIKE '%Task' ORDER BY id DESC", [taskId]),
      pool.query(`
        SELECT c.*, CONCAT(u.first_name, ' ', u.last_name) AS author_name
        FROM comments c
        LEFT JOIN users u ON u.id = c.commenter_id
        WHERE c.commentable_id = ? AND c.commentable_type LIKE '%Task' AND c.deleted_at IS NULL
        ORDER BY c.id ASC
      `, [taskId]),
      pool.query('SELECT * FROM task_time_entries WHERE task_id = ? ORDER BY id DESC', [taskId])
    ]);

    res.json({ error: false, subtasks, timelines, comments, timeEntries });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/tasks', authMiddleware, async (req, res) => {
  const {
    title,
    project_id,
    parent_id = null,
    status_id,
    priority_id,
    start_date,
    due_date,
    start_time,
    end_time,
    description,
    note,
    billing_type = 'none',
    client_can_discuss = 0,
    completion_percentage = 0,
    user_ids = [],
    is_recurring = false,
    recurring_frequency = 'daily',
    recurring_occurrences = null,
    enable_reminder = false,
    reminder_frequency = 'daily',
    reminder_time = '09:00',
    send_email_notification = true
  } = req.body;

  // Allow normal users to create subtasks on tasks they are assigned to, or if they have create_tasks permission
  let canCreate = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('create_tasks');
  if (!canCreate && parent_id) {
    const [pCheck] = await pool.query('SELECT user_id FROM task_user WHERE task_id = ? AND user_id = ?', [Number(parent_id), req.user.id]);
    if (pCheck.length > 0) canCreate = true;
  }
  if (!canCreate) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create tasks.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (!title || !project_id) {
      return res.status(400).json({ error: true, message: 'Task title and project are required' });
    }

    const [projRows] = await conn.query('SELECT id, title, workspace_id FROM projects WHERE id = ? LIMIT 1', [Number(project_id)]);
    if (!projRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Parent project not found' });
    }
    const workspaceId = projRows[0].workspace_id;
    const projectTitle = projRows[0].title;
    const todayStr = getLocalDateStr();

    const [insertRes] = await conn.query(`
      INSERT INTO tasks
        (workspace_id, project_id, parent_id, title, description, billing_type, status_id, priority_id,
         start_date, due_date, note, client_can_discuss, created_by, completion_percentage, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
    `, [
      workspaceId,
      Number(project_id),
      parent_id ? Number(parent_id) : null,
      title.trim(),
      description || null,
      billing_type || 'none',
      status_id ? Number(status_id) : 28,
      priority_id && Number(priority_id) !== 0 ? Number(priority_id) : null,
      start_date || todayStr,
      due_date || start_date || todayStr,
      note || null,
      client_can_discuss ? 1 : 0,
      req.user.id,
      Number(completion_percentage || 0)
    ]);

    const taskId = insertRes.insertId;
    const finalUserIds = Array.isArray(user_ids) ? [...new Set(user_ids.map(Number).filter(Boolean))] : [];
    if (finalUserIds.length > 0) {
      await conn.query('INSERT INTO task_user (task_id, user_id) VALUES ?', [finalUserIds.map(uid => [taskId, uid])]);
    }

    // 1. Time-Based Task Slot (e.g. 09:00 AM to 11:00 AM stored in task_time_entries)
    let timeSlotFormatted = '';
    if (start_time && end_time) {
      const entryDate = due_date || start_date || todayStr;
      const firstAssignee = finalUserIds[0] || req.user.id;
      await conn.query(`
        INSERT INTO task_time_entries
          (task_id, user_id, workspace_id, entry_date, is_billable, entry_type, standard_hours, start_time, end_time, description, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'flexible', '02:00:00', ?, ?, 'Scheduled Time Slot', NOW(), NOW())
      `, [
        taskId,
        `u_${firstAssignee}`,
        workspaceId,
        entryDate,
        billing_type === 'billable' ? 1 : 0,
        start_time,
        end_time
      ]);
      timeSlotFormatted = `${formatTime12h(start_time)} – ${formatTime12h(end_time)}`;
    }

    // 2. Recurring Task Configuration (stored in recurring_tasks)
    if (is_recurring) {
      const anchorDate = start_date || todayStr;
      await conn.query(`
        INSERT INTO recurring_tasks
          (task_id, frequency, starts_from, number_of_occurrences, completed_occurrences, is_active, last_created_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, 1, ?, NOW(), NOW())
      `, [
        taskId,
        recurring_frequency || 'daily',
        anchorDate,
        recurring_occurrences ? Number(recurring_occurrences) : null,
        `${anchorDate} ${getLocalDateTimeStr().substring(11)}`
      ]);
    }

    // 3. Automated Reminder Configuration (stored in reminders)
    if (enable_reminder) {
      await conn.query(`
        INSERT INTO reminders
          (remindable_type, remindable_id, frequency_type, time_of_day, is_active, created_at, updated_at)
        VALUES ('App\\\\Models\\\\Task', ?, ?, ?, 1, NOW(), NOW())
      `, [
        taskId,
        reminder_frequency || 'daily',
        reminder_time || '09:00:00'
      ]);
    }

    if (status_id) {
      const [stRows] = await conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [status_id]);
      if (stRows.length) {
        await conn.query(`
          INSERT INTO status_timelines (entity_id, entity_type, status, previous_status, new_color, old_color, changed_at, created_at, updated_at)
          VALUES (?, 'App\\\\Models\\\\Task', ?, '-', ?, NULL, NOW(), NOW(), NOW())
        `, [taskId, stRows[0].title, stRows[0].color]);
      }
    }

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    await logActivity(conn, {
      workspace_id: workspaceId,
      actor_id: req.user.id,
      type_id: taskId,
      type: 'task',
      parent_type_id: Number(project_id),
      parent_type: 'project',
      activity: 'created',
      message: `${actorName} created task ${title.trim()}${timeSlotFormatted ? ' (' + timeSlotFormatted + ')' : ''}`
    });

    await conn.commit();

    // Notify & Email assigned users
    if (finalUserIds.length > 0) {
      notifyUsersAndSendEmail({
        workspace_id: workspaceId,
        from_user_id: req.user.id,
        type: 'task',
        type_id: taskId,
        action: 'assigned',
        title: `New Task Assigned: ${title.trim()}`,
        message: `${actorName} assigned you to task "${title.trim()}"${timeSlotFormatted ? ' scheduled for ' + timeSlotFormatted : ''}.`,
        emailSubject: `✅ New Task Assigned: ${title.trim()}${timeSlotFormatted ? ' (' + timeSlotFormatted + ')' : ''}`,
        emailHtml: `
          <p><strong>${actorName}</strong> has assigned a new task to you:</p>
          <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #2563eb; margin: 14px 0;">
            <p style="margin: 0 0 6px 0;"><strong>Task:</strong> ${title.trim()}</p>
            <p style="margin: 0 0 6px 0;"><strong>Project:</strong> ${projectTitle}</p>
            <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${due_date || start_date || todayStr}</p>
            ${timeSlotFormatted ? `<p style="margin: 0 0 6px 0; color: #2563eb;"><strong>Time Slot:</strong> ${timeSlotFormatted}</p>` : ''}
            ${is_recurring ? `<p style="margin: 0; color: #059669;"><strong>Recurring Schedule:</strong> Auto-repeats ${recurring_frequency}</p>` : ''}
          </div>
          ${description ? `<p><strong>Instructions:</strong> ${description}</p>` : ''}
        `,
        user_ids: finalUserIds,
        send_email: Boolean(send_email_notification)
      });
    }

    res.json({ error: false, message: 'Task created successfully', id: taskId });
  } catch (err) {
    await conn.rollback();
    console.error('Create task error:', err);
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.put('/api/tasks/:id', authMiddleware, async (req, res) => {
  const taskId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [existingRows] = await conn.query('SELECT * FROM tasks WHERE id = ? LIMIT 1', [taskId]);
    if (!existingRows.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Task not found' });
    }
    const existing = existingRows[0];
    const [assignedCheck] = await conn.query('SELECT user_id FROM task_user WHERE task_id = ?', [taskId]);
    const currentAssigneeIds = assignedCheck.map(u => Number(u.user_id));
    const isParticipant = currentAssigneeIds.includes(Number(req.user.id)) || Number(existing.created_by) === Number(req.user.id);
    const canEdit = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('edit_tasks') || isParticipant;
    if (!canEdit) {
      await conn.rollback();
      return res.status(403).json({ error: true, message: 'You do not have permission to edit this task.' });
    }

    const {
      title,
      project_id,
      status_id,
      priority_id,
      start_date,
      due_date,
      start_time,
      end_time,
      description,
      note,
      billing_type,
      client_can_discuss,
      completion_percentage,
      user_ids,
      is_recurring,
      recurring_frequency,
      recurring_occurrences,
      enable_reminder,
      reminder_frequency,
      reminder_time
    } = req.body;

    const newStatusId = status_id !== undefined ? Number(status_id) : existing.status_id;

    if (newStatusId && newStatusId !== existing.status_id) {
      const [[oldSt], [newSt]] = await Promise.all([
        conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [existing.status_id]),
        conn.query('SELECT title, color FROM statuses WHERE id = ? LIMIT 1', [newStatusId])
      ]);
      if (newSt.length) {
        await conn.query(`
          INSERT INTO status_timelines (entity_id, entity_type, status, previous_status, new_color, old_color, changed_at, created_at, updated_at)
          VALUES (?, 'App\\\\Models\\\\Task', ?, ?, ?, ?, NOW(), NOW(), NOW())
        `, [
          taskId,
          newSt[0].title,
          oldSt.length ? oldSt[0].title : '-',
          newSt[0].color,
          oldSt.length ? oldSt[0].color : null
        ]);
      }
    }

    await conn.query(`
      UPDATE tasks
      SET project_id = ?, title = ?, description = ?, billing_type = ?, status_id = ?, priority_id = ?,
          start_date = ?, due_date = ?, note = ?, client_can_discuss = ?, completion_percentage = ?, updated_at = NOW()
      WHERE id = ?
    `, [
      project_id ? Number(project_id) : existing.project_id,
      title !== undefined ? title.trim() : existing.title,
      description !== undefined ? (description || null) : existing.description,
      billing_type || existing.billing_type || 'none',
      newStatusId,
      priority_id !== undefined ? (priority_id && Number(priority_id) !== 0 ? Number(priority_id) : null) : existing.priority_id,
      start_date !== undefined ? (start_date || null) : existing.start_date,
      due_date !== undefined ? (due_date || null) : existing.due_date,
      note !== undefined ? (note || null) : existing.note,
      client_can_discuss !== undefined ? (client_can_discuss ? 1 : 0) : existing.client_can_discuss,
      completion_percentage !== undefined ? Number(completion_percentage) : existing.completion_percentage,
      taskId
    ]);

    if (Array.isArray(user_ids)) {
      await conn.query('DELETE FROM task_user WHERE task_id = ?', [taskId]);
      const finalUserIds = [...new Set(user_ids.map(Number).filter(Boolean))];
      if (finalUserIds.length > 0) {
        await conn.query('INSERT INTO task_user (task_id, user_id) VALUES ?', [finalUserIds.map(uid => [taskId, uid])]);
      }
      const newlyAdded = finalUserIds.filter(uid => !currentAssigneeIds.includes(uid));
      if (newlyAdded.length > 0) {
        const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
        const taskTitle = title || existing.title;
        notifyUsersAndSendEmail({
          workspace_id: existing.workspace_id,
          from_user_id: req.user.id,
          type: 'task',
          type_id: taskId,
          action: 'assigned',
          title: `New Task Assigned: ${taskTitle}`,
          message: `${actorName} assigned you to task "${taskTitle}" (#${taskId}).`,
          emailSubject: `✅ New Task Assigned: ${taskTitle}`,
          emailHtml: `<p><strong>${actorName}</strong> assigned you to task <strong>${taskTitle}</strong> (#${taskId}).</p>`,
          user_ids: newlyAdded,
          send_email: true
        });
      }
    }

    // Update Time Slot if provided
    if (start_time !== undefined && end_time !== undefined) {
      await conn.query("DELETE FROM task_time_entries WHERE task_id = ? AND description LIKE '%Time Slot%'", [taskId]);
      if (start_time && end_time) {
        const entryDate = due_date || start_date || existing.due_date || new Date().toISOString().substring(0, 10);
        await conn.query(`
          INSERT INTO task_time_entries
            (task_id, user_id, workspace_id, entry_date, is_billable, entry_type, standard_hours, start_time, end_time, description, created_at, updated_at)
          VALUES (?, ?, ?, ?, 0, 'flexible', '02:00:00', ?, ?, 'Scheduled Time Slot', NOW(), NOW())
        `, [taskId, `u_${req.user.id}`, existing.workspace_id, String(entryDate).substring(0, 10), start_time, end_time]);
      }
    }

    // Update Recurring Task if provided (preserve history if updating existing rule)
    if (is_recurring !== undefined) {
      if (is_recurring) {
        const [exRec] = await conn.query('SELECT id FROM recurring_tasks WHERE task_id = ? ORDER BY id DESC LIMIT 1', [taskId]);
        const maxOcc = (recurring_occurrences && Number(recurring_occurrences) > 0) ? Number(recurring_occurrences) : null;
        if (exRec.length) {
          await conn.query(
            'UPDATE recurring_tasks SET frequency = ?, number_of_occurrences = ?, is_active = 1, updated_at = NOW() WHERE id = ?',
            [recurring_frequency || 'daily', maxOcc, exRec[0].id]
          );
        } else {
          const anchorDate = start_date || getLocalDateStr();
          await conn.query(`
            INSERT INTO recurring_tasks
              (task_id, frequency, starts_from, number_of_occurrences, completed_occurrences, is_active, last_created_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, 1, ?, NOW(), NOW())
          `, [taskId, recurring_frequency || 'daily', anchorDate, maxOcc, `${anchorDate} ${getLocalDateTimeStr().substring(11)}`]);
        }
      } else {
        await conn.query('DELETE FROM recurring_tasks WHERE task_id = ?', [taskId]);
      }
    }

    // Update Reminder if provided
    if (enable_reminder !== undefined) {
      await conn.query("DELETE FROM reminders WHERE remindable_id = ? AND remindable_type LIKE '%Task'", [taskId]);
      if (enable_reminder) {
        await conn.query(`
          INSERT INTO reminders
            (remindable_type, remindable_id, frequency_type, time_of_day, is_active, created_at, updated_at)
          VALUES ('App\\\\Models\\\\Task', ?, ?, ?, 1, NOW(), NOW())
        `, [taskId, reminder_frequency || 'daily', reminder_time || '09:00:00']);
      }
    }

    await conn.commit();
    res.json({ error: false, message: 'Task updated successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/tasks/:id', authMiddleware, async (req, res) => {
  const canDelete = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('delete_tasks');
  if (!canDelete) {
    return res.status(403).json({ error: true, message: 'You do not have permission to delete tasks.' });
  }

  const taskId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query('DELETE FROM task_user WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM task_time_entries WHERE task_id = ?', [taskId]);
    await conn.query('DELETE FROM recurring_tasks WHERE task_id = ?', [taskId]);
    await conn.query("DELETE FROM reminders WHERE remindable_id = ? AND remindable_type LIKE '%Task'", [taskId]);
    await conn.query('DELETE FROM tasks WHERE id = ?', [taskId]);
    await conn.commit();
    res.json({ error: false, message: 'Task deleted successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 6. MEETINGS & AGENDAS CRUD (RECURRING, ATTENDANCE, MINUTES OF MEETING & MONTHLY REPORT)
// ==========================================
app.get('/api/meetings', authMiddleware, async (req, res) => {
  try {
    const { workspace_id, month } = req.query; // month optional e.g. '2026-11'
    const heldWsIds = await getHeldWorkspaceIds();
    let where = 'WHERE 1=1';
    const params = [];
    if (heldWsIds.length) {
      where += ` AND m.workspace_id NOT IN (${heldWsIds.join(',')})`;
    }
    if (workspace_id && workspace_id !== 'all') {
      where += ' AND m.workspace_id = ?';
      params.push(Number(workspace_id));
    }
    if (month && /^\d{4}-\d{2}$/.test(month)) {
      where += ' AND DATE_FORMAT(m.start_date_time, "%Y-%m") = ?';
      params.push(month);
    }
    if (!req.user.isAdminOrHasAllDataAccess) {
      where += ' AND (m.id IN (SELECT meeting_id FROM meeting_user WHERE user_id = ?) OR m.user_id = ?)';
      params.push(req.user.id, String(req.user.id));
    }

    const [meetings] = await pool.query(`
      SELECT
        m.*,
        w.title AS workspace_title,
        DATE(m.start_date_time) = CURDATE() AS is_today
      FROM meetings m
      LEFT JOIN workspaces w ON w.id = m.workspace_id
      ${where}
      ORDER BY m.start_date_time DESC
    `, params);

    const govStore = await getMeetingGovernanceStore();

    if (meetings.length > 0) {
      const mIds = meetings.map(m => m.id);
      const [mUsers] = await pool.query(`
        SELECT mu.meeting_id, u.id, u.first_name, u.last_name, u.email
        FROM meeting_user mu
        JOIN users u ON u.id = mu.user_id
        WHERE mu.meeting_id IN (?)
      `, [mIds]);

      const uMap = {};
      mUsers.forEach(u => { (uMap[u.meeting_id] = uMap[u.meeting_id] || []).push(u); });

      meetings.forEach(m => {
        m.users = uMap[m.id] || [];
        m.user_ids = m.users.map(u => u.id);
        const rec = govStore.records[m.id] || {};
        m.scope = rec.scope || (m.users.length <= 2 ? 'individual' : 'team');
        m.is_recurring = Boolean(rec.is_recurring);
        m.recurring_frequency = rec.recurring_frequency || null;
        m.recurring_rule_id = rec.recurring_rule_id || null;
        m.meeting_status = rec.status || 'scheduled';
        m.attendance = rec.attendance || {};
        m.guests = Array.isArray(rec.guests) ? rec.guests : [];
        m.guest_attendance = rec.guest_attendance || {};
        m.postponed_count = Number(rec.postponed_count || 0);
        m.postponed_history = Array.isArray(rec.postponed_history) ? rec.postponed_history : [];
        m.day_before_reminder_sent = Boolean(rec.day_before_reminder_sent);
        m.mom_discussion = rec.mom_discussion || '';
        m.mom_highlights = rec.mom_highlights || '';
        m.mom_decisions = rec.mom_decisions || '';
        m.mom_recorded_by = rec.mom_recorded_by || null;
        m.mom_updated_at = rec.mom_updated_at || null;

        // Calculate quick attendance counts (Team Members + External Guests)
        let presentCount = 0;
        let lateCount = 0;
        let absentCount = 0;
        let excusedCount = 0;
        m.users.forEach(u => {
          const st = m.attendance[u.id]?.status || 'pending';
          if (st === 'present') presentCount++;
          else if (st === 'late') lateCount++;
          else if (st === 'absent') absentCount++;
          else if (st === 'excused') excusedCount++;
        });

        let guestPresentCount = 0;
        let guestMarkedCount = 0;
        m.guests.forEach(g => {
          const gst = m.guest_attendance[g.id]?.status || 'pending';
          if (gst !== 'pending') guestMarkedCount++;
          if (gst === 'present' || gst === 'late') guestPresentCount++;
        });

        m.attendance_summary = {
          total: m.users.length,
          present: presentCount,
          late: lateCount,
          absent: absentCount,
          excused: excusedCount,
          marked: presentCount + lateCount + absentCount + excusedCount,
          guests_total: m.guests.length,
          guests_present: guestPresentCount,
          guests_marked: guestMarkedCount
        };
      });
    }

    const visibleRules = (govStore.recurringRules || []).filter(r => {
      if (workspace_id && workspace_id !== 'all' && Number(r.workspace_id) !== Number(workspace_id)) {
        return false;
      }
      if (req.user.isAdminOrHasAllDataAccess) return true;
      const uid = Number(req.user.id);
      const attendees = Array.isArray(r.user_ids) ? r.user_ids.map(Number) : [];
      return attendees.includes(uid) || Number(r.creator_id) === uid;
    });

    const enrichedRules = visibleRules.map(r => {
      const nextDate = computeNextRecurringSlotDate(r);
      return {
        ...r,
        next_slot_date: nextDate,
        next_slot_label: `${nextDate} (${formatTime12h(r.start_time)} – ${formatTime12h(r.end_time)})`
      };
    });

    res.json({
      error: false,
      meetings,
      recurringRules: enrichedRules
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/meetings', authMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      title,
      workspace_id,
      meeting_date,
      start_time,
      end_time,
      user_ids = [],
      client_ids = [],
      guests = [], // Array of { id, name, email, type: 'client'|'external' }
      scope = 'team', // 'team' | 'individual'
      is_recurring = false,
      recurring_frequency = 'weekly', // 'daily' | 'weekly' | 'biweekly' | 'monthly'
      generate_future_weeks = 4, // Auto-populate next N occurrences on the weekly calendar
      agenda_notes = '',
      send_email_notification = true
    } = req.body;

    if (!title || !meeting_date || !start_time || !end_time) {
      return res.status(400).json({ error: true, message: 'Meeting title, date, start time, and end time are required' });
    }

    const wsId = Number(workspace_id || req.user.default_workspace_id || 5);
    const startDateTime = `${meeting_date} ${start_time}:00`;
    const endDateTime = `${meeting_date} ${end_time}:00`;

    const [ins] = await conn.query(`
      INSERT INTO meetings (workspace_id, user_id, title, start_date_time, end_date_time, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NOW(), NOW())
    `, [wsId, String(req.user.id), title.trim(), startDateTime, endDateTime]);

    const meetingId = ins.insertId;
    const rawUserIds = Array.isArray(user_ids) ? user_ids.map(Number).filter(Boolean) : [];
    const finalUserIds = [...new Set(rawUserIds.length > 0 ? rawUserIds : [req.user.id])];
    if (finalUserIds.length > 0) {
      await conn.query('INSERT INTO meeting_user (meeting_id, user_id) VALUES ?', [finalUserIds.map(uid => [meetingId, uid])]);
    }

    const finalClientIds = Array.isArray(client_ids) ? [...new Set(client_ids.map(Number).filter(Boolean))] : [];
    if (finalClientIds.length > 0) {
      await conn.query('INSERT INTO client_meeting (meeting_id, client_id) VALUES ?', [finalClientIds.map(cid => [meetingId, cid])]);
    }

    // Build normalized guests list (from selected client_ids + custom external guests)
    const normalizedGuests = [];
    if (finalClientIds.length > 0) {
      const [cRows] = await conn.query('SELECT id, first_name, last_name, email, company FROM clients WHERE id IN (?)', [finalClientIds]);
      cRows.forEach(c => {
        normalizedGuests.push({
          id: `client_${c.id}`,
          client_id: c.id,
          name: `${c.first_name || ''} ${c.last_name || ''}`.trim() || c.company || 'Client Guest',
          email: c.email || '',
          company: c.company || '',
          type: 'client'
        });
      });
    }
    if (Array.isArray(guests)) {
      guests.forEach((g, idx) => {
        if (!g || (!g.name && !g.email)) return;
        const gId = g.id || `guest_${Date.now()}_${idx}`;
        if (!normalizedGuests.some(x => (x.email && g.email && x.email.toLowerCase() === g.email.toLowerCase()) || x.id === gId)) {
          normalizedGuests.push({
            id: gId,
            name: (g.name || g.email || 'Guest').trim(),
            email: (g.email || '').trim(),
            company: (g.company || 'External Guest').trim(),
            type: g.type || 'external'
          });
        }
      });
    }

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    const scopeLabel = scope === 'individual' ? 'Individual 1-on-1 Meeting' : 'Team Meeting';
    await logActivity(conn, {
      workspace_id: wsId,
      actor_id: req.user.id,
      type_id: meetingId,
      type: 'meeting',
      activity: 'created',
      message: `${actorName} scheduled ${is_recurring ? `recurring (${recurring_frequency}) ` : ''}${scopeLabel} "${title.trim()}" for ${meeting_date} (${formatTime12h(start_time)} - ${formatTime12h(end_time)})`
    });

    // Save Meeting Governance & Optional Recurring Rule + Pre-Generate Upcoming Slots for the Calendar
    const govStore = await getMeetingGovernanceStore();
    let ruleId = null;

    const initialAttendance = {};
    finalUserIds.forEach(uid => {
      initialAttendance[uid] = { status: 'pending', note: '', updated_at: null };
    });
    const initialGuestAttendance = {};
    normalizedGuests.forEach(g => {
      initialGuestAttendance[g.id] = { status: 'pending', note: '', updated_at: null };
    });

    if (is_recurring) {
      ruleId = 'mrule_' + Date.now();
    }

    govStore.records[meetingId] = {
      meeting_id: meetingId,
      scope: scope === 'individual' ? 'individual' : 'team',
      is_recurring: Boolean(is_recurring),
      recurring_frequency: is_recurring ? (recurring_frequency || 'weekly') : null,
      recurring_rule_id: ruleId,
      status: 'scheduled',
      attendance: initialAttendance,
      guests: normalizedGuests,
      guest_attendance: initialGuestAttendance,
      postponed_count: 0,
      postponed_history: [],
      day_before_reminder_sent: false,
      mom_discussion: agenda_notes ? String(agenda_notes).trim() : '',
      mom_highlights: '',
      mom_decisions: '',
      mom_recorded_by: null,
      mom_updated_at: null
    };

    // If recurring (e.g. weekly/daily), pre-seed upcoming occurrences so the Weekly Calendar shows future grey upcoming slots immediately
    let lastSeededDate = meeting_date;
    const futureCount = is_recurring ? Math.min(Math.max(Number(generate_future_weeks) || 3, 1), 6) : 0;
    const curDateObj = new Date(meeting_date + 'T00:00:00');

    for (let i = 1; i <= futureCount; i++) {
      if (recurring_frequency === 'daily') curDateObj.setDate(curDateObj.getDate() + 1);
      else if (recurring_frequency === 'weekly') curDateObj.setDate(curDateObj.getDate() + 7);
      else if (recurring_frequency === 'biweekly') curDateObj.setDate(curDateObj.getDate() + 14);
      else if (recurring_frequency === 'monthly') curDateObj.setMonth(curDateObj.getMonth() + 1);

      const nextDateStr = curDateObj.toISOString().substring(0, 10);
      lastSeededDate = nextDateStr;
      const nextStartDt = `${nextDateStr} ${start_time}:00`;
      const nextEndDt = `${nextDateStr} ${end_time}:00`;

      const [nextIns] = await conn.query(`
        INSERT INTO meetings (workspace_id, user_id, title, start_date_time, end_date_time, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, NOW(), NOW())
      `, [wsId, String(req.user.id), title.trim(), nextStartDt, nextEndDt]);
      const nextMid = nextIns.insertId;

      if (finalUserIds.length > 0) {
        await conn.query('INSERT INTO meeting_user (meeting_id, user_id) VALUES ?', [finalUserIds.map(uid => [nextMid, uid])]);
      }
      if (finalClientIds.length > 0) {
        await conn.query('INSERT INTO client_meeting (meeting_id, client_id) VALUES ?', [finalClientIds.map(cid => [nextMid, cid])]);
      }

      govStore.records[nextMid] = {
        meeting_id: nextMid,
        scope: scope === 'individual' ? 'individual' : 'team',
        is_recurring: true,
        recurring_frequency: recurring_frequency || 'weekly',
        recurring_rule_id: ruleId,
        status: 'scheduled',
        attendance: JSON.parse(JSON.stringify(initialAttendance)),
        guests: JSON.parse(JSON.stringify(normalizedGuests)),
        guest_attendance: JSON.parse(JSON.stringify(initialGuestAttendance)),
        postponed_count: 0,
        postponed_history: [],
        day_before_reminder_sent: false,
        mom_discussion: agenda_notes ? String(agenda_notes).trim() : '',
        mom_highlights: '',
        mom_decisions: '',
        mom_recorded_by: null,
        mom_updated_at: null
      };
    }

    if (is_recurring && ruleId) {
      govStore.recurringRules.push({
        id: ruleId,
        parent_meeting_id: meetingId,
        title: title.trim(),
        workspace_id: wsId,
        creator_id: req.user.id,
        scope: scope === 'individual' ? 'individual' : 'team',
        frequency: recurring_frequency || 'weekly',
        start_time,
        end_time,
        user_ids: finalUserIds,
        guests: normalizedGuests,
        starts_from: meeting_date,
        last_generated_date: lastSeededDate,
        completed_occurrences: 1 + futureCount,
        is_active: true,
        created_at: new Date().toISOString()
      });
    }

    await conn.commit();
    await saveMeetingGovernanceStore(govStore);

    // Send In-App & Email Invitations to Team Members & External Guests
    const recBadge = is_recurring ? ` (Auto-Recurring ${String(recurring_frequency).toUpperCase()})` : '';
    if (finalUserIds.length > 0) {
      notifyUsersAndSendEmail({
        workspace_id: wsId,
        from_user_id: req.user.id,
        type: 'meeting',
        type_id: meetingId,
        action: 'assigned',
        title: `${scopeLabel} Scheduled: ${title.trim()}${recBadge}`,
        message: `${actorName} scheduled ${scopeLabel.toLowerCase()} "${title.trim()}" on ${meeting_date} (${formatTime12h(start_time)} - ${formatTime12h(end_time)}). Please attend on time.`,
        emailSubject: `📅 [${scopeLabel}] ${title.trim()} — ${meeting_date} (${formatTime12h(start_time)})${recBadge}`,
        emailHtml: `
          <p><strong>${actorName}</strong> has scheduled a <strong>${scopeLabel}</strong>${is_recurring ? ` set to auto-recur <strong>${recurring_frequency}</strong>` : ''} and requested your attendance:</p>
          <div style="background: #f0fdf4; padding: 16px; border-left: 4px solid #10b981; margin: 14px 0;">
            <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${title.trim()}</p>
            <p style="margin: 0 0 6px 0;"><strong>Meeting Scope:</strong> ${scopeLabel} ${is_recurring ? `• 🔁 Auto-Recurring (${recurring_frequency})` : ''}</p>
            <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${meeting_date}</p>
            <p style="margin: 0;"><strong>Time Slot:</strong> ${formatTime12h(start_time)} – ${formatTime12h(end_time)}</p>
            ${normalizedGuests.length ? `<p style="margin: 6px 0 0 0;"><strong>Invited Guests:</strong> ${normalizedGuests.map(g => g.name).join(', ')}</p>` : ''}
            ${agenda_notes ? `<p style="margin: 8px 0 0 0;"><strong>Agenda Notes:</strong> ${agenda_notes}</p>` : ''}
          </div>
          <p style="font-size: 13px; color: #334155;">An automated reminder will also be sent 1 day before each upcoming session. Attendance and Minutes of Meeting (MoM) are tracked on the Weekly Calendar.</p>
        `,
        user_ids: finalUserIds,
        send_email: Boolean(send_email_notification)
      });
    }

    if (Boolean(send_email_notification) && normalizedGuests.length > 0) {
      sendEmailToGuests(normalizedGuests, {
        subject: `📅 [Meeting Invitation] ${title.trim()} — ${meeting_date} (${formatTime12h(start_time)})`,
        html: `
          <p><strong>${actorName}</strong> has invited you as a guest to the following meeting:</p>
          <div style="background: #f0fdf4; padding: 16px; border-left: 4px solid #10b981; margin: 14px 0;">
            <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${title.trim()}</p>
            <p style="margin: 0 0 6px 0;"><strong>Date:</strong> ${meeting_date}</p>
            <p style="margin: 0;"><strong>Time Slot:</strong> ${formatTime12h(start_time)} – ${formatTime12h(end_time)}</p>
            ${agenda_notes ? `<p style="margin: 8px 0 0 0;"><strong>Agenda Notes:</strong> ${agenda_notes}</p>` : ''}
          </div>
          <p style="font-size: 13px; color: #334155;">You will also receive an automated email reminder 1 day prior to the meeting.</p>
        `
      });
    }

    res.json({
      error: false,
      message: is_recurring
        ? `Recurring (${recurring_frequency}) ${scopeLabel} scheduled (+${futureCount} upcoming slots added to calendar) & invitations sent`
        : `${scopeLabel} scheduled & invitations sent`,
      id: meetingId
    });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// Postpone / Reschedule a Meeting to a New Date & Time Slot (Auto-Emails Team Members & Guests)
app.put('/api/meetings/:id/postpone', authMiddleware, async (req, res) => {
  try {
    const meetingId = Number(req.params.id);
    const {
      new_date,
      new_start_time,
      new_end_time,
      reason = '',
      send_email_notification = true
    } = req.body;

    if (!new_date || !new_start_time || !new_end_time) {
      return res.status(400).json({ error: true, message: 'New date, start time, and end time are required to postpone a meeting' });
    }

    const [mRows] = await pool.query('SELECT * FROM meetings WHERE id = ? LIMIT 1', [meetingId]);
    if (!mRows.length) {
      return res.status(404).json({ error: true, message: 'Meeting not found' });
    }
    const mt = mRows[0];
    const oldStart = String(mt.start_date_time);
    const oldEnd = String(mt.end_date_time);

    const newStartDt = `${new_date} ${new_start_time}:00`;
    const newEndDt = `${new_date} ${new_end_time}:00`;

    await pool.query(
      'UPDATE meetings SET start_date_time = ?, end_date_time = ?, updated_at = NOW() WHERE id = ?',
      [newStartDt, newEndDt, meetingId]
    );

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    const govStore = await getMeetingGovernanceStore();
    const rec = govStore.records[meetingId] || {
      meeting_id: meetingId,
      scope: 'team',
      status: 'scheduled',
      attendance: {},
      guests: [],
      guest_attendance: {},
      postponed_count: 0,
      postponed_history: []
    };

    const historyEntry = {
      from_date_time: `${oldStart.substring(0, 10)} (${formatTime12h(oldStart.substring(11, 16))} - ${formatTime12h(oldEnd.substring(11, 16))})`,
      to_date_time: `${new_date} (${formatTime12h(new_start_time)} - ${formatTime12h(new_end_time)})`,
      reason: reason ? String(reason).trim() : 'Schedule adjustment',
      postponed_by: actorName,
      postponed_at: new Date().toISOString().replace('T', ' ').substring(0, 16)
    };

    rec.status = 'postponed';
    rec.postponed_count = Number(rec.postponed_count || 0) + 1;
    rec.postponed_history = [...(Array.isArray(rec.postponed_history) ? rec.postponed_history : []), historyEntry];
    rec.day_before_reminder_sent = false; // Reset 1-day-before reminder for the new date
    govStore.records[meetingId] = rec;
    await saveMeetingGovernanceStore(govStore);

    const [mUsers] = await pool.query('SELECT user_id FROM meeting_user WHERE meeting_id = ?', [meetingId]);
    const pIds = mUsers.map(u => u.user_id);

    if (pIds.length > 0) {
      await notifyUsersAndSendEmail({
        workspace_id: mt.workspace_id,
        from_user_id: req.user.id,
        type: 'meeting',
        type_id: meetingId,
        action: 'postponed',
        title: `Meeting Postponed: ${mt.title}`,
        message: `${actorName} postponed "${mt.title}" to ${new_date} (${formatTime12h(new_start_time)} – ${formatTime12h(new_end_time)}).${reason ? ` Reason: ${reason}` : ''}`,
        emailSubject: `⏳ [Meeting Postponed / Rescheduled] ${mt.title} → ${new_date} (${formatTime12h(new_start_time)})`,
        emailHtml: `
          <p><strong>${actorName}</strong> has postponed and rescheduled the meeting <strong>${mt.title}</strong>:</p>
          <div style="background: #fffbeb; padding: 16px; border-left: 4px solid #f59e0b; margin: 14px 0;">
            <p style="margin: 0 0 6px 0;"><strong>Meeting / Agenda:</strong> ${mt.title}</p>
            <p style="margin: 0 0 6px 0; color: #64748b; text-decoration: line-through;"><strong>Previous Slot:</strong> ${historyEntry.from_date_time}</p>
            <p style="margin: 0 0 6px 0; color: #b45309;"><strong>New Date & Time Slot:</strong> ${historyEntry.to_date_time}</p>
            ${reason ? `<p style="margin: 6px 0 0 0;"><strong>Reason for Postponement:</strong> ${reason}</p>` : ''}
          </div>
          <p style="font-size: 13px; color: #334155;">Your Weekly Meeting Calendar has been updated automatically.</p>
        `,
        user_ids: pIds,
        send_email: Boolean(send_email_notification)
      });
    }

    const guestsList = Array.isArray(rec.guests) ? rec.guests : [];
    if (Boolean(send_email_notification) && guestsList.length > 0) {
      await sendEmailToGuests(guestsList, {
        subject: `⏳ [Meeting Postponed / Rescheduled] ${mt.title} → ${new_date} (${formatTime12h(new_start_time)})`,
        html: `
          <p>The meeting <strong>${mt.title}</strong> has been postponed to a new date and time slot by <strong>${actorName}</strong>:</p>
          <div style="background: #fffbeb; padding: 16px; border-left: 4px solid #f59e0b; margin: 14px 0;">
            <p style="margin: 0 0 6px 0; color: #64748b; text-decoration: line-through;"><strong>Previous Slot:</strong> ${historyEntry.from_date_time}</p>
            <p style="margin: 0 0 6px 0; color: #b45309;"><strong>New Date & Time Slot:</strong> ${historyEntry.to_date_time}</p>
            ${reason ? `<p style="margin: 6px 0 0 0;"><strong>Reason:</strong> ${reason}</p>` : ''}
          </div>
        `
      });
    }

    res.json({
      error: false,
      message: `Meeting postponed to ${new_date} (${formatTime12h(new_start_time)} – ${formatTime12h(new_end_time)}) & participants/guests notified`
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// Save Meeting Attendance & Minutes of Meeting (MoM) + Optional Email Summary to Team/Management
app.put('/api/meetings/:id/governance', authMiddleware, async (req, res) => {
  try {
    const meetingId = Number(req.params.id);
    const [mRows] = await pool.query('SELECT * FROM meetings WHERE id = ? LIMIT 1', [meetingId]);
    if (!mRows.length) {
      return res.status(404).json({ error: true, message: 'Meeting not found' });
    }
    const mt = mRows[0];

    const {
      status, // 'scheduled' | 'completed' | 'postponed'
      attendance, // { [userId]: { status: 'present' | 'late' | 'absent' | 'excused', note: '' } }
      guests, // optional updated array of { id, name, email, company, type }
      guest_attendance, // { [guestId]: { status: 'present' | 'late' | 'absent' | 'excused', note: '' } }
      mom_discussion,
      mom_highlights,
      mom_decisions,
      create_tasks = [], // optional array of follow-up action tasks [{ title, project_id, assignee_id, due_date }]
      email_mom_to_participants = false
    } = req.body;

    const govStore = await getMeetingGovernanceStore();
    const existing = govStore.records[meetingId] || {
      meeting_id: meetingId,
      scope: 'team',
      is_recurring: false,
      recurring_frequency: null,
      status: 'scheduled',
      attendance: {},
      guests: [],
      guest_attendance: {},
      mom_discussion: '',
      mom_highlights: '',
      mom_decisions: ''
    };

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 16);

    const updatedRecord = {
      ...existing,
      status: status || existing.status || 'completed',
      attendance: attendance !== undefined ? attendance : existing.attendance,
      guests: Array.isArray(guests) ? guests : (existing.guests || []),
      guest_attendance: guest_attendance !== undefined ? guest_attendance : (existing.guest_attendance || {}),
      mom_discussion: mom_discussion !== undefined ? String(mom_discussion).trim() : existing.mom_discussion,
      mom_highlights: mom_highlights !== undefined ? String(mom_highlights).trim() : existing.mom_highlights,
      mom_decisions: mom_decisions !== undefined ? String(mom_decisions).trim() : existing.mom_decisions,
      mom_recorded_by: actorName,
      mom_updated_at: nowStr
    };

    govStore.records[meetingId] = updatedRecord;
    await saveMeetingGovernanceStore(govStore);

    // Optional: Create instant follow-up tasks from MoM Action Items
    let createdTasksCount = 0;
    if (Array.isArray(create_tasks) && create_tasks.length > 0) {
      for (const ct of create_tasks) {
        if (!ct.title || !ct.project_id) continue;
        const [insT] = await pool.query(`
          INSERT INTO tasks
            (workspace_id, project_id, title, description, billing_type, status_id, priority_id, start_date, due_date, created_by, completion_percentage, created_at, updated_at)
          VALUES (?, ?, ?, ?, 'none', 28, 3, CURDATE(), ?, ?, 0, NOW(), NOW())
        `, [
          mt.workspace_id || 5,
          Number(ct.project_id),
          ct.title.trim(),
          `<p>Action item from Meeting MoM: <strong>${mt.title}</strong> (${String(mt.start_date_time).substring(0, 10)})</p>`,
          ct.due_date || new Date().toISOString().substring(0, 10),
          req.user.id
        ]);
        const newTid = insT.insertId;
        if (ct.assignee_id) {
          await pool.query('INSERT INTO task_user (task_id, user_id) VALUES (?, ?)', [newTid, Number(ct.assignee_id)]);
        }
        createdTasksCount++;
      }
    }

    // Optional: Email the recorded Attendance & Minutes of Meeting (MoM) to participants
    if (email_mom_to_participants) {
      const [mUsers] = await pool.query(`
        SELECT u.id, u.first_name, u.last_name
        FROM meeting_user mu
        JOIN users u ON u.id = mu.user_id
        WHERE mu.meeting_id = ?
      `, [meetingId]);
      const pIds = mUsers.map(u => u.id);

      const attLines = mUsers.map(u => {
        const st = (updatedRecord.attendance?.[u.id]?.status || 'pending').toUpperCase();
        return `<li><strong>${u.first_name} ${u.last_name || ''} (Team):</strong> ${st}</li>`;
      }).join('');

      const guestAttLines = (updatedRecord.guests || []).map(g => {
        const gst = (updatedRecord.guest_attendance?.[g.id]?.status || 'pending').toUpperCase();
        return `<li><strong>${g.name} (Guest):</strong> ${gst}</li>`;
      }).join('');

      const emailBodyHtml = `
        <p><strong>${actorName}</strong> has published the official <strong>Attendance & Minutes of Meeting (MoM)</strong> for <strong>${mt.title}</strong>:</p>
        <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #2563eb; margin: 14px 0;">
          <p style="margin: 0 0 8px 0;"><strong>Date & Time:</strong> ${mt.start_date_time} – ${String(mt.end_date_time).substring(11, 16)}</p>
          <p style="margin: 0 0 6px 0;"><strong>Attendance Roll-Call (Team & Guests):</strong></p>
          <ul style="margin: 0 0 12px 0; padding-left: 20px;">${attLines}${guestAttLines}</ul>
          ${updatedRecord.mom_highlights ? `<p style="margin: 0 0 4px 0; color: #b45309;"><strong>⭐ Key Team Highlights & Escalations:</strong></p><p style="margin: 0 0 12px 0; white-space: pre-line;">${updatedRecord.mom_highlights}</p>` : ''}
          ${updatedRecord.mom_discussion ? `<p style="margin: 0 0 4px 0;"><strong>💬 Discussion Summary (Minutes of Meeting):</strong></p><p style="margin: 0 0 12px 0; white-space: pre-line;">${updatedRecord.mom_discussion}</p>` : ''}
          ${updatedRecord.mom_decisions ? `<p style="margin: 0 0 4px 0; color: #047857;"><strong>✅ Action Decisions & Next Steps:</strong></p><p style="margin: 0; white-space: pre-line;">${updatedRecord.mom_decisions}</p>` : ''}
        </div>
      `;

      if (pIds.length > 0) {
        await notifyUsersAndSendEmail({
          workspace_id: mt.workspace_id,
          from_user_id: req.user.id,
          type: 'meeting',
          type_id: meetingId,
          action: 'mom_published',
          title: `Minutes of Meeting (MoM) Recorded: ${mt.title}`,
          message: `${actorName} recorded Attendance & Minutes of Meeting for "${mt.title}".`,
          emailSubject: `📝 Minutes of Meeting (MoM) & Attendance: ${mt.title} (${String(mt.start_date_time).substring(0, 10)})`,
          emailHtml: emailBodyHtml,
          user_ids: pIds,
          send_email: true
        });
      }

      if ((updatedRecord.guests || []).length > 0) {
        await sendEmailToGuests(updatedRecord.guests, {
          subject: `📝 Minutes of Meeting (MoM) & Attendance: ${mt.title} (${String(mt.start_date_time).substring(0, 10)})`,
          html: emailBodyHtml
        });
      }
    }

    res.json({
      error: false,
      message: `Attendance & Minutes of Meeting saved${createdTasksCount ? ` (+${createdTasksCount} follow-up task created)` : ''}${email_mom_to_participants ? ' & emailed to team' : ''}`,
      record: updatedRecord
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// Toggle or Delete Recurring Meeting Rule (Admin / Super Admin Only)
app.delete('/api/meetings/recurring/:ruleId', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin or Admin can stop a recurring meeting rule.' });
  }
  try {
    const { ruleId } = req.params;
    const govStore = await getMeetingGovernanceStore();
    govStore.recurringRules = (govStore.recurringRules || []).filter(r => r.id !== ruleId);
    await saveMeetingGovernanceStore(govStore);
    res.json({ error: false, message: 'Recurring meeting schedule stopped' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// Monthly Executive Meetings, Attendance & MoM Report for Higher Management
app.get('/api/meetings/monthly-report', authMiddleware, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().substring(0, 7); // YYYY-MM
    const workspace_id = req.query.workspace_id;
    const heldWsIds = await getHeldWorkspaceIds();

    let where = 'WHERE DATE_FORMAT(m.start_date_time, "%Y-%m") = ?';
    const params = [month];
    if (heldWsIds.length) {
      where += ` AND m.workspace_id NOT IN (${heldWsIds.join(',')})`;
    }
    if (workspace_id && workspace_id !== 'all') {
      where += ' AND m.workspace_id = ?';
      params.push(Number(workspace_id));
    }
    if (!req.user.isAdminOrHasAllDataAccess) {
      where += ' AND (m.id IN (SELECT meeting_id FROM meeting_user WHERE user_id = ?) OR m.user_id = ?)';
      params.push(req.user.id, String(req.user.id));
    }

    const [meetings] = await pool.query(`
      SELECT m.*, w.title AS workspace_title
      FROM meetings m
      LEFT JOIN workspaces w ON w.id = m.workspace_id
      ${where}
      ORDER BY m.start_date_time ASC
    `, params);

    const govStore = await getMeetingGovernanceStore();
    const [allUsers] = await pool.query('SELECT id, first_name, last_name, email FROM users WHERE status = 1');
    const userStatsMap = {};
    allUsers.forEach(u => {
      userStatsMap[u.id] = {
        user_id: u.id,
        name: `${u.first_name} ${u.last_name || ''}`.trim(),
        email: u.email,
        invited: 0,
        present: 0,
        late: 0,
        excused: 0,
        absent: 0,
        pending: 0,
        attendance_rate: 0
      };
    });

    let mUsers = [];
    if (meetings.length > 0) {
      const mIds = meetings.map(m => m.id);
      const [muRows] = await pool.query(`
        SELECT mu.meeting_id, u.id, u.first_name, u.last_name, u.email
        FROM meeting_user mu
        JOIN users u ON u.id = mu.user_id
        WHERE mu.meeting_id IN (?)
      `, [mIds]);
      mUsers = muRows;
    }

    const uByMeeting = {};
    mUsers.forEach(row => {
      (uByMeeting[row.meeting_id] = uByMeeting[row.meeting_id] || []).push(row);
    });

    let totalSessions = meetings.length;
    let completedWithMom = 0;
    let teamMeetingsCount = 0;
    let individualMeetingsCount = 0;
    let totalAttendanceSeats = 0;
    let totalAttendedSeats = 0;

    const momDigest = [];

    meetings.forEach(m => {
      const participants = uByMeeting[m.id] || [];
      const rec = govStore.records[m.id] || {};
      const scope = rec.scope || (participants.length <= 2 ? 'individual' : 'team');
      if (scope === 'individual') individualMeetingsCount++;
      else teamMeetingsCount++;

      const hasMom = Boolean((rec.mom_discussion && rec.mom_discussion.trim()) || (rec.mom_highlights && rec.mom_highlights.trim()) || (rec.mom_decisions && rec.mom_decisions.trim()));
      if (hasMom || rec.status === 'completed') completedWithMom++;

      const attDetails = [];
      participants.forEach(p => {
        const st = rec.attendance?.[p.id]?.status || 'pending';
        if (userStatsMap[p.id]) {
          userStatsMap[p.id].invited++;
          if (st === 'present') userStatsMap[p.id].present++;
          else if (st === 'late') userStatsMap[p.id].late++;
          else if (st === 'excused') userStatsMap[p.id].excused++;
          else if (st === 'absent') userStatsMap[p.id].absent++;
          else userStatsMap[p.id].pending++;
        }
        if (st !== 'pending') {
          totalAttendanceSeats++;
          if (st === 'present' || st === 'late') totalAttendedSeats++;
        }
        attDetails.push({
          user_id: p.id,
          name: `${p.first_name} ${p.last_name || ''}`.trim(),
          status: st,
          role_type: 'team'
        });
      });

      const guestList = Array.isArray(rec.guests) ? rec.guests : [];
      guestList.forEach(g => {
        const gst = rec.guest_attendance?.[g.id]?.status || 'pending';
        attDetails.push({
          guest_id: g.id,
          name: `${g.name} (Guest)`,
          status: gst,
          role_type: 'guest'
        });
      });

      momDigest.push({
        id: m.id,
        title: m.title,
        workspace_title: m.workspace_title || 'General',
        date: String(m.start_date_time).substring(0, 10),
        start_time: String(m.start_date_time).substring(11, 16),
        end_time: String(m.end_date_time).substring(11, 16),
        scope,
        is_recurring: Boolean(rec.is_recurring),
        recurring_frequency: rec.recurring_frequency || null,
        status: rec.status || (hasMom ? 'completed' : 'scheduled'),
        postponed_count: Number(rec.postponed_count || 0),
        postponed_history: Array.isArray(rec.postponed_history) ? rec.postponed_history : [],
        mom_discussion: rec.mom_discussion || '',
        mom_highlights: rec.mom_highlights || '',
        mom_decisions: rec.mom_decisions || '',
        mom_recorded_by: rec.mom_recorded_by || null,
        mom_updated_at: rec.mom_updated_at || null,
        participants: attDetails
      });
    });

    const memberAttendanceScorecard = Object.values(userStatsMap)
      .filter(u => u.invited > 0)
      .map(u => {
        const evaluated = u.present + u.late + u.absent + u.excused;
        u.attendance_rate = evaluated > 0 ? Math.round(((u.present + u.late) / evaluated) * 100) : 0;
        return u;
      })
      .sort((a, b) => b.invited - a.invited);

    const overallAttendanceRate = totalAttendanceSeats > 0
      ? Math.round((totalAttendedSeats / totalAttendanceSeats) * 100)
      : 0;

    res.json({
      error: false,
      month,
      kpis: {
        totalSessions,
        completedWithMom,
        teamMeetingsCount,
        individualMeetingsCount,
        overallAttendanceRate,
        activeRecurringRules: (govStore.recurringRules || []).filter(r => r.is_active).length
      },
      memberAttendanceScorecard,
      momDigest
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/meetings/:id', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM meeting_user WHERE meeting_id = ?', [id]);
    await pool.query('DELETE FROM client_meeting WHERE meeting_id = ?', [id]);
    await pool.query('DELETE FROM meetings WHERE id = ?', [id]);
    const govStore = await getMeetingGovernanceStore();
    if (govStore.records[id]) {
      delete govStore.records[id];
      await saveMeetingGovernanceStore(govStore);
    }
    res.json({ error: false, message: 'Meeting deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 7. CRON & INSTANT NOTIFICATION ENDPOINTS
// ==========================================
app.get('/api/cron/status', authMiddleware, async (req, res) => {
  const todayStr = getLocalDateStr();
  const [recListRaw] = await pool.query(`
    SELECT rt.*, t.title AS task_title, t.due_date, p.title AS project_title,
           (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
            FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = t.id) AS assignees,
           (SELECT tte.start_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS start_time,
           (SELECT tte.end_time FROM task_time_entries tte WHERE tte.task_id = t.id ORDER BY tte.id DESC LIMIT 1) AS end_time
    FROM recurring_tasks rt
    JOIN tasks t ON t.id = rt.task_id
    LEFT JOIN projects p ON p.id = t.project_id
    ORDER BY rt.is_active DESC, rt.id DESC
  `);

  const recList = recListRaw.map(rt => {
    const lastDate = rt.last_created_at ? String(rt.last_created_at).substring(0, 10) : null;
    const startsFrom = rt.starts_from ? String(rt.starts_from).substring(0, 10) : todayStr;
    let nextRunDate = null;
    if (Number(rt.is_active) === 1) {
      if (!lastDate && startsFrom >= todayStr) {
        nextRunDate = startsFrom;
      } else if (!lastDate && startsFrom < todayStr) {
        nextRunDate = todayStr;
      } else {
        nextRunDate = computeNextRecurringSlotDate({
          frequency: rt.frequency,
          last_generated_date: lastDate,
          starts_from: startsFrom
        });
      }
    }
    return {
      ...rt,
      next_run_date: nextRunDate,
      time_slot: (rt.start_time && rt.end_time) ? `${formatTime12h(rt.start_time)} – ${formatTime12h(rt.end_time)}` : null
    };
  });

  const [remList] = await pool.query(`
    SELECT r.*, t.title AS task_title, p.title AS project_title,
           (SELECT GROUP_CONCAT(CONCAT(u.first_name, ' ', u.last_name) SEPARATOR ', ')
            FROM task_user tu JOIN users u ON u.id = tu.user_id WHERE tu.task_id = t.id) AS assignees,
           (SELECT COUNT(*) FROM recurring_tasks rt WHERE rt.task_id = t.id AND rt.is_active = 1) AS has_recurring
    FROM reminders r
    JOIN tasks t ON t.id = r.remindable_id
    LEFT JOIN projects p ON p.id = t.project_id
    WHERE r.remindable_type LIKE '%Task'
    ORDER BY r.id DESC
  `);

  res.json({
    error: false,
    cronState,
    serverToday: todayStr,
    recurringTasks: recList,
    reminders: remList
  });
});

// Toggle Pause / Resume on a Recurring Task Creator
app.put('/api/cron/recurring-tasks/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const rtId = Number(req.params.id);
    const [rows] = await pool.query('SELECT id, is_active, number_of_occurrences, completed_occurrences FROM recurring_tasks WHERE id = ?', [rtId]);
    if (!rows.length) return res.status(404).json({ error: true, message: 'Recurring rule not found' });
    const row = rows[0];
    const nextState = Number(row.is_active) === 1 ? 0 : 1;
    // If resuming a rule that had reached its max occurrence cap (e.g. 1/1), lift the cap to unlimited so it stays active
    const shouldClearCap = nextState === 1 && row.number_of_occurrences && Number(row.completed_occurrences || 0) >= Number(row.number_of_occurrences);
    if (shouldClearCap) {
      await pool.query('UPDATE recurring_tasks SET is_active = 1, number_of_occurrences = NULL, updated_at = NOW() WHERE id = ?', [rtId]);
    } else {
      await pool.query('UPDATE recurring_tasks SET is_active = ?, updated_at = NOW() WHERE id = ?', [nextState, rtId]);
    }
    addCronLog('RECURRING', `${nextState ? 'Resumed' : 'Paused'} recurring rule #${rtId}${shouldClearCap ? ' (switched to Unlimited)' : ''}`);
    res.json({
      error: false,
      is_active: nextState,
      message: nextState
        ? (shouldClearCap ? 'Auto-recurring creator resumed (set to Unlimited occurrences)' : 'Auto-recurring creator resumed')
        : 'Auto-recurring creator paused'
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// 1-Click Enable Auto-Recurring Task Creator on an existing task (e.g. from a Reminder-only task)
app.post('/api/cron/recurring-tasks/quick-enable', authMiddleware, async (req, res) => {
  try {
    const { task_id, frequency = 'daily' } = req.body;
    const tid = Number(task_id);
    if (!tid) return res.status(400).json({ error: true, message: 'task_id is required' });
    const allowedFreq = ['daily', 'weekly', 'monthly', 'yearly'].includes(String(frequency).toLowerCase())
      ? String(frequency).toLowerCase()
      : 'daily';
    const [existing] = await pool.query('SELECT id FROM recurring_tasks WHERE task_id = ? LIMIT 1', [tid]);
    const todayStr = getLocalDateStr();
    if (existing.length) {
      await pool.query(
        'UPDATE recurring_tasks SET frequency = ?, is_active = 1, number_of_occurrences = NULL, updated_at = NOW() WHERE id = ?',
        [allowedFreq, existing[0].id]
      );
    } else {
      await pool.query(
        `INSERT INTO recurring_tasks (task_id, frequency, starts_from, number_of_occurrences, completed_occurrences, last_created_at, is_active, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 1, NOW(), 1, NOW(), NOW())`,
        [tid, allowedFreq, todayStr]
      );
    }
    addCronLog('RECURRING', `Enabled ${allowedFreq.toUpperCase()} auto-recurring task creator for Task #${tid}`);
    res.json({ error: false, message: `Auto-Create (${allowedFreq.toUpperCase()}) enabled! Next occurrence will auto-generate automatically.` });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/cron/run-now', authMiddleware, async (req, res) => {
  const summary = await runAutomatedCronJobs(true);
  res.json({
    error: false,
    message: `Cron executed: ${summary.recurringCreated} recurring task(s), ${summary.recurringMeetingsCreated || 0} recurring meeting(s), ${summary.remindersSent} reminder(s), ${summary.meetingAlerts} meeting alert(s)`,
    summary,
    cronState
  });
});

// Manually trigger the NEXT occurrence of a specific recurring task rule immediately (for verification / early scheduling)
app.post('/api/cron/recurring-tasks/:id/spawn-now', authMiddleware, async (req, res) => {
  try {
    const rtId = Number(req.params.id);
    const [rows] = await pool.query(`
      SELECT rt.*, t.title, t.description, t.workspace_id, t.project_id, t.status_id, t.priority_id,
             t.start_date, t.due_date, t.billing_type, t.client_can_discuss, t.created_by, t.note
      FROM recurring_tasks rt
      JOIN tasks t ON t.id = rt.task_id
      WHERE rt.id = ? LIMIT 1
    `, [rtId]);
    if (!rows.length) {
      return res.status(404).json({ error: true, message: 'Recurring task rule not found' });
    }
    const rt = rows[0];
    const nextDate = computeNextRecurringSlotDate({
      frequency: rt.frequency,
      last_generated_date: rt.last_created_at ? String(rt.last_created_at).substring(0, 10) : getLocalDateStr(),
      starts_from: rt.starts_from ? String(rt.starts_from).substring(0, 10) : getLocalDateStr()
    });
    const spawned = await spawnRecurringTaskOccurrence(rt, nextDate);
    cronState.recurringProcessed++;
    addCronLog('MANUAL_SPAWN', `Generated next ${rt.frequency} occurrence of "${rt.title}" (#${spawned.newTaskId}) for ${spawned.newStartDate}${spawned.slotLabel}`);
    res.json({
      error: false,
      message: `Created next occurrence (#${spawned.newTaskId}) for ${spawned.newStartDate}${spawned.slotLabel} & notified assigned team`,
      spawned
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// Manual Instant Broadcast / Ping Team Members by Email & In-App Notification
app.post('/api/notifications/send', authMiddleware, async (req, res) => {
  try {
    const { subject, message, user_ids = [], send_email = true } = req.body;
    if (!subject || !message || !user_ids.length) {
      return res.status(400).json({ error: true, message: 'Subject, message, and at least one recipient are required' });
    }
    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    const result = await notifyUsersAndSendEmail({
      workspace_id: req.user.default_workspace_id || 5,
      from_user_id: req.user.id,
      type: 'task',
      type_id: 0,
      action: 'executive_notice',
      title: subject,
      message,
      emailSubject: `📢 [Executive Notice] ${subject}`,
      emailHtml: `
        <p>Message from <strong>${actorName}</strong> (Task Manager):</p>
        <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #2563eb; margin: 14px 0;">
          <p style="margin: 0; white-space: pre-line;">${message}</p>
        </div>
      `,
      user_ids,
      send_email: Boolean(send_email)
    });
    res.json({
      error: false,
      message: `Notified ${result.notified} user(s) and sent ${result.emailed} email(s)`
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 8. USERS, CLIENTS, ROLES & WORKSPACES
// ==========================================
app.post('/api/users', authMiddleware, async (req, res) => {
  const canCreate = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('create_users');
  if (!canCreate) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create users.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const {
      first_name,
      last_name,
      email,
      password,
      phone,
      role_id,
      status = 1,
      workspace_ids = []
    } = req.body;

    if (!first_name || !last_name || !email || !password || !role_id) {
      return res.status(400).json({ error: true, message: 'First name, last name, email, password, and role are required' });
    }

    const [dup] = await conn.query('SELECT id FROM users WHERE email = ? LIMIT 1', [email.trim()]);
    if (dup.length) {
      await conn.rollback();
      return res.status(400).json({ error: true, message: 'A user with this email already exists' });
    }

    const hashed = await hashLaravelPassword(password);
    const defaultWs = Array.isArray(workspace_ids) && workspace_ids.length ? Number(workspace_ids[0]) : (req.user.default_workspace_id || 5);

    const [insertRes] = await conn.query(`
      INSERT INTO users
        (first_name, last_name, email, password, phone, photo, status, email_verified_at, default_workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'photos/no-image.jpg', ?, NOW(), ?, NOW(), NOW())
    `, [
      first_name.trim(),
      last_name.trim(),
      email.trim(),
      hashed,
      phone || null,
      status ? 1 : 0,
      defaultWs
    ]);

    const newUserId = insertRes.insertId;

    await conn.query(`
      INSERT INTO model_has_roles (role_id, model_type, model_id)
      VALUES (?, 'App\\\\Models\\\\User', ?)
    `, [Number(role_id), newUserId]);

    const wsIds = Array.isArray(workspace_ids) && workspace_ids.length
      ? [...new Set(workspace_ids.map(Number).filter(Boolean))]
      : [defaultWs];
    if (wsIds.length > 0) {
      await conn.query('INSERT INTO user_workspace (workspace_id, user_id) VALUES ?', [wsIds.map(wid => [wid, newUserId])]);
    }

    await conn.commit();
    res.json({ error: false, message: 'User created and synced with Laravel database', id: newUserId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.put('/api/users/:id', authMiddleware, async (req, res) => {
  const canEdit = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('edit_users');
  if (!canEdit) {
    return res.status(403).json({ error: true, message: 'You do not have permission to edit users.' });
  }

  const targetUserId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { first_name, last_name, email, password, phone, role_id, status, workspace_ids } = req.body;

    if (password && password.trim().length >= 6) {
      const hashed = await hashLaravelPassword(password.trim());
      await conn.query('UPDATE users SET password = ? WHERE id = ?', [hashed, targetUserId]);
    }

    await conn.query(`
      UPDATE users
      SET first_name = COALESCE(?, first_name),
          last_name = COALESCE(?, last_name),
          email = COALESCE(?, email),
          phone = ?,
          status = COALESCE(?, status),
          updated_at = NOW()
      WHERE id = ?
    `, [
      first_name ? first_name.trim() : null,
      last_name ? last_name.trim() : null,
      email ? email.trim() : null,
      phone !== undefined ? (phone || null) : null,
      status !== undefined ? (status ? 1 : 0) : null,
      targetUserId
    ]);

    if (role_id) {
      await conn.query("DELETE FROM model_has_roles WHERE model_id = ? AND (model_type = 'App\\\\Models\\\\User' OR model_type LIKE '%User')", [targetUserId]);
      await conn.query("INSERT INTO model_has_roles (role_id, model_type, model_id) VALUES (?, 'App\\\\Models\\\\User', ?)", [Number(role_id), targetUserId]);
    }

    if (Array.isArray(workspace_ids)) {
      await conn.query('DELETE FROM user_workspace WHERE user_id = ?', [targetUserId]);
      const wsIds = [...new Set(workspace_ids.map(Number).filter(Boolean))];
      if (wsIds.length > 0) {
        await conn.query('INSERT INTO user_workspace (workspace_id, user_id) VALUES ?', [wsIds.map(wid => [wid, targetUserId])]);
      }
    }

    await conn.commit();
    res.json({ error: false, message: 'User updated successfully' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.post('/api/clients', authMiddleware, async (req, res) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { first_name, last_name, company, email, phone, password, status = 1, workspace_ids = [] } = req.body;
    if (!first_name || !email) {
      return res.status(400).json({ error: true, message: 'First name and email are required' });
    }
    const hashed = await hashLaravelPassword(password || 'client123456');
    const defaultWs = Array.isArray(workspace_ids) && workspace_ids.length ? Number(workspace_ids[0]) : (req.user.default_workspace_id || 5);

    const [ins] = await conn.query(`
      INSERT INTO clients
        (workspace_id, first_name, last_name, company, email, phone, password, photo, status, internal_purpose, default_workspace_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'photos/no-image.jpg', ?, 0, ?, NOW(), NOW())
    `, [defaultWs, first_name.trim(), (last_name || '').trim(), company || null, email.trim(), phone || null, hashed, status ? 1 : 0, defaultWs]);

    const clientId = ins.insertId;
    const wsIds = Array.isArray(workspace_ids) && workspace_ids.length
      ? [...new Set(workspace_ids.map(Number).filter(Boolean))]
      : [defaultWs];
    if (wsIds.length > 0) {
      await conn.query('INSERT INTO client_workspace (workspace_id, client_id) VALUES ?', [wsIds.map(wid => [wid, clientId])]);
    }

    await conn.commit();
    res.json({ error: false, message: 'Client created successfully', id: clientId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.delete('/api/clients/:id', authMiddleware, async (req, res) => {
  try {
    const cid = Number(req.params.id);
    await pool.query('DELETE FROM client_workspace WHERE client_id = ?', [cid]);
    await pool.query('DELETE FROM client_project WHERE client_id = ?', [cid]);
    await pool.query('DELETE FROM clients WHERE id = ?', [cid]);
    res.json({ error: false, message: 'Client deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/workspaces', authMiddleware, async (req, res) => {
  const canCreate = req.user.isAdminOrHasAllDataAccess || req.user.permissions.includes('create_workspaces');
  if (!canCreate) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create workspaces.' });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { title, is_primary = 0, user_ids = [] } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: true, message: 'Workspace title is required' });
    }

    if (is_primary) {
      await conn.query('UPDATE workspaces SET is_primary = 0');
    }

    const [insertRes] = await conn.query(`
      INSERT INTO workspaces (user_id, title, is_primary, created_at, updated_at)
      VALUES (?, ?, ?, NOW(), NOW())
    `, [req.user.id, title.trim(), is_primary ? 1 : 0]);

    const wsId = insertRes.insertId;
    const finalUsers = [...new Set([req.user.id, ...(Array.isArray(user_ids) ? user_ids.map(Number).filter(Boolean) : [])])];
    if (finalUsers.length > 0) {
      await conn.query('INSERT INTO user_workspace (workspace_id, user_id) VALUES ?', [finalUsers.map(uid => [wsId, uid])]);
    }

    await conn.commit();
    res.json({ error: false, message: 'Workspace created successfully', id: wsId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// Edit Workspace (title, primary status, team members)
app.put('/api/workspaces/:id', authMiddleware, async (req, res) => {
  const canEdit = req.user.isStrictAdmin || req.user.permissions.includes('edit_workspaces');
  if (!canEdit) {
    return res.status(403).json({ error: true, message: 'You do not have permission to edit workspaces.' });
  }

  const wsId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { title, is_primary = 0, user_ids = [] } = req.body;
    if (!title || !title.trim()) {
      await conn.rollback();
      return res.status(400).json({ error: true, message: 'Workspace title is required' });
    }

    const [existing] = await conn.query('SELECT id FROM workspaces WHERE id = ? LIMIT 1', [wsId]);
    if (!existing.length) {
      await conn.rollback();
      return res.status(404).json({ error: true, message: 'Workspace not found' });
    }

    if (is_primary) {
      await conn.query('UPDATE workspaces SET is_primary = 0 WHERE id != ?', [wsId]);
    }

    await conn.query(
      'UPDATE workspaces SET title = ?, is_primary = ?, updated_at = NOW() WHERE id = ?',
      [title.trim(), is_primary ? 1 : 0, wsId]
    );

    if (Array.isArray(user_ids)) {
      await conn.query('DELETE FROM user_workspace WHERE workspace_id = ?', [wsId]);
      const finalUsers = [...new Set(user_ids.map(Number).filter(Boolean))];
      if (finalUsers.length > 0) {
        await conn.query('INSERT INTO user_workspace (workspace_id, user_id) VALUES ?', [finalUsers.map(uid => [wsId, uid])]);
      }
    }

    await conn.commit();
    res.json({ error: false, message: 'Workspace updated successfully', id: wsId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// Schedule Workspace Deletion with 30-Day Safety Hold (Requires Password Verification)
app.post('/api/workspaces/:id/schedule-delete', authMiddleware, async (req, res) => {
  const canDelete = req.user.isStrictAdmin || req.user.permissions.includes('delete_workspaces');
  if (!canDelete) {
    return res.status(403).json({ error: true, message: 'Only Super Admin / Admin can delete workspaces.' });
  }
  try {
    const wsId = Number(req.params.id);
    const { password } = req.body;
    if (!password) {
      return res.status(400).json({ error: true, message: 'Your account password is required to delete a workspace.' });
    }

    const [uRows] = await pool.query('SELECT password FROM users WHERE id = ? LIMIT 1', [req.user.id]);
    if (!uRows.length || !(await verifyLaravelPassword(String(password), uRows[0].password))) {
      return res.status(401).json({ error: true, message: 'Incorrect password. Workspace deletion cancelled.' });
    }

    const [wsRows] = await pool.query(`
      SELECT w.id, w.title,
        (SELECT COUNT(*) FROM projects p WHERE p.workspace_id = w.id) AS projects_count,
        (SELECT COUNT(*) FROM tasks t WHERE t.workspace_id = w.id) AS tasks_count,
        (SELECT COUNT(*) FROM user_workspace uw WHERE uw.workspace_id = w.id) AS users_count
      FROM workspaces w WHERE w.id = ? LIMIT 1
    `, [wsId]);
    if (!wsRows.length) {
      return res.status(404).json({ error: true, message: 'Workspace not found' });
    }

    const pending = await getPendingWorkspaceDeletions();
    if (pending.some(x => Number(x.workspace_id) === wsId)) {
      return res.status(400).json({ error: true, message: 'This workspace is already in the 30-day deletion hold.' });
    }

    const now = new Date();
    const purgeDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();

    pending.push({
      workspace_id: wsId,
      title: wsRows[0].title,
      projects_count: Number(wsRows[0].projects_count || 0),
      tasks_count: Number(wsRows[0].tasks_count || 0),
      users_count: Number(wsRows[0].users_count || 0),
      requested_by_id: req.user.id,
      requested_by_name: actorName,
      requested_at: now.toISOString(),
      purge_at: purgeDate.toISOString()
    });
    await savePendingWorkspaceDeletions(pending);

    addCronLog('WS_HOLD', `${actorName} scheduled workspace "${wsRows[0].title}" (#${wsId}) for 30-day deletion hold (purges ${getLocalDateStr(purgeDate)})`);
    res.json({
      error: false,
      message: `Workspace "${wsRows[0].title}" moved to 30-day deletion hold. You can restore it anytime before ${getLocalDateStr(purgeDate)}.`
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// Cancel Deletion & Restore Workspace from 30-Day Hold
app.post('/api/workspaces/:id/restore', authMiddleware, async (req, res) => {
  const canRestore = req.user.isStrictAdmin || req.user.permissions.includes('delete_workspaces');
  if (!canRestore) {
    return res.status(403).json({ error: true, message: 'Only Super Admin / Admin can restore workspaces.' });
  }
  try {
    const wsId = Number(req.params.id);
    const pending = await getPendingWorkspaceDeletions();
    const target = pending.find(x => Number(x.workspace_id) === wsId);
    if (!target) {
      return res.status(404).json({ error: true, message: 'Workspace is not in the deletion hold queue.' });
    }
    const updated = pending.filter(x => Number(x.workspace_id) !== wsId);
    await savePendingWorkspaceDeletions(updated);

    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();
    addCronLog('WS_RESTORE', `${actorName} stopped deletion and restored workspace "${target.title}" (#${wsId})`);
    res.json({
      error: false,
      message: `Deletion stopped! Workspace "${target.title}" has been restored with all its projects and tasks.`
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 9. SYSTEM CONFIGURATION: STATUSES, PRIORITIES, TAGS, ROLES
// ==========================================
app.post('/api/statuses', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('create_statuses')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create statuses.' });
  }
  try {
    const { title, color = 'secondary' } = req.body;
    if (!title) return res.status(400).json({ error: true, message: 'Status title is required' });
    const slug = slugify(title);
    const [ins] = await pool.query(
      'INSERT INTO statuses (title, slug, color, is_default, created_at, updated_at) VALUES (?, ?, ?, 0, NOW(), NOW())',
      [title.trim(), slug, color]
    );
    res.json({ error: false, message: 'Status created', id: ins.insertId });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/statuses/:id', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('delete_statuses')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to delete statuses.' });
  }
  try {
    const id = Number(req.params.id);
    const [[pCount], [tCount]] = await Promise.all([
      pool.query('SELECT COUNT(*) AS c FROM projects WHERE status_id = ?', [id]),
      pool.query('SELECT COUNT(*) AS c FROM tasks WHERE status_id = ?', [id])
    ]);
    if (pCount[0].c > 0 || tCount[0].c > 0) {
      return res.status(400).json({ error: true, message: 'Cannot delete status while projects or tasks are using it.' });
    }
    await pool.query('DELETE FROM statuses WHERE id = ?', [id]);
    res.json({ error: false, message: 'Status deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/priorities', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('create_priorities')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create priorities.' });
  }
  try {
    const { title, color = 'secondary' } = req.body;
    if (!title) return res.status(400).json({ error: true, message: 'Priority title is required' });
    const slug = slugify(title);
    const [ins] = await pool.query(
      'INSERT INTO priorities (title, slug, color, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
      [title.trim(), slug, color]
    );
    res.json({ error: false, message: 'Priority created', id: ins.insertId });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/priorities/:id', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('delete_priorities')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to delete priorities.' });
  }
  try {
    const id = Number(req.params.id);
    await pool.query('UPDATE projects SET priority_id = NULL WHERE priority_id = ?', [id]);
    await pool.query('UPDATE tasks SET priority_id = NULL WHERE priority_id = ?', [id]);
    await pool.query('DELETE FROM priorities WHERE id = ?', [id]);
    res.json({ error: false, message: 'Priority deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/tags', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('create_tags')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to create tags.' });
  }
  try {
    const { title, color = 'primary', workspace_id } = req.body;
    if (!title) return res.status(400).json({ error: true, message: 'Tag title is required' });
    const slug = slugify(title);
    const wsId = Number(workspace_id || req.user.default_workspace_id || 5);
    const [ins] = await pool.query(
      'INSERT INTO tags (workspace_id, title, slug, color, created_at, updated_at) VALUES (?, ?, ?, ?, NOW(), NOW())',
      [wsId, title.trim(), slug, color]
    );
    res.json({ error: false, message: 'Tag created', id: ins.insertId });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/tags/:id', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin && !req.user.permissions.includes('delete_tags')) {
    return res.status(403).json({ error: true, message: 'You do not have permission to delete tags.' });
  }
  try {
    const id = Number(req.params.id);
    await pool.query('DELETE FROM project_tag WHERE tag_id = ?', [id]);
    await pool.query('DELETE FROM tags WHERE id = ?', [id]);
    res.json({ error: false, message: 'Tag deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/roles', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin / Admin can manage roles' });
  }
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { name, permission_ids = [] } = req.body;
    if (!name) return res.status(400).json({ error: true, message: 'Role name is required' });
    const [ins] = await conn.query(
      "INSERT INTO roles (name, guard_name, created_at, updated_at) VALUES (?, 'web', NOW(), NOW())",
      [name.trim()]
    );
    const roleId = ins.insertId;
    const pIds = [...new Set((permission_ids || []).map(Number).filter(Boolean))];
    if (pIds.length > 0) {
      await conn.query('INSERT INTO role_has_permissions (permission_id, role_id) VALUES ?', [pIds.map(pid => [pid, roleId])]);
    }
    await conn.commit();
    res.json({ error: false, message: 'Role created successfully', id: roleId });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

app.put('/api/roles/:id', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin / Admin can manage roles' });
  }
  const roleId = Number(req.params.id);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const { name, permission_ids } = req.body;
    if (name) {
      await conn.query('UPDATE roles SET name = ?, updated_at = NOW() WHERE id = ?', [name.trim(), roleId]);
    }
    if (Array.isArray(permission_ids)) {
      await conn.query('DELETE FROM role_has_permissions WHERE role_id = ?', [roleId]);
      const pIds = [...new Set(permission_ids.map(Number).filter(Boolean))];
      if (pIds.length > 0) {
        await conn.query('INSERT INTO role_has_permissions (permission_id, role_id) VALUES ?', [pIds.map(pid => [pid, roleId])]);
      }
    }
    await conn.commit();
    res.json({ error: false, message: 'Role permissions updated' });
  } catch (err) {
    await conn.rollback();
    res.status(500).json({ error: true, message: err.message });
  } finally {
    conn.release();
  }
});

// ==========================================
// 10. CEO PERSONAL TODOS & LEAVE APPROVALS
// ==========================================
app.post('/api/todos', authMiddleware, async (req, res) => {
  try {
    const { title, priority = 'medium', workspace_id } = req.body;
    if (!title) return res.status(400).json({ error: true, message: 'Todo title is required' });
    const wsId = Number(workspace_id || req.user.default_workspace_id || 5);
    const [ins] = await pool.query(
      `INSERT INTO todos (workspace_id, title, priority, is_completed, creator_id, creator_type, created_at, updated_at)
       VALUES (?, ?, ?, 0, ?, 'App\\\\Models\\\\User', NOW(), NOW())`,
      [wsId, title.trim(), priority, req.user.id]
    );
    res.json({ error: false, message: 'Checklist item added', id: ins.insertId });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.put('/api/todos/:id/toggle', authMiddleware, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const [rows] = await pool.query('SELECT is_completed FROM todos WHERE id = ?', [id]);
    if (!rows.length) return res.status(404).json({ error: true, message: 'Todo not found' });
    const next = rows[0].is_completed ? 0 : 1;
    await pool.query('UPDATE todos SET is_completed = ?, updated_at = NOW() WHERE id = ?', [next, id]);
    res.json({ error: false, is_completed: next });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/todos/:id', authMiddleware, async (req, res) => {
  try {
    await pool.query('DELETE FROM todos WHERE id = ?', [Number(req.params.id)]);
    res.json({ error: false, message: 'Todo deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.put('/api/leaves/:id/status', authMiddleware, async (req, res) => {
  try {
    const { status } = req.body;
    await pool.query(
      'UPDATE leave_requests SET status = ?, action_by = ?, updated_at = NOW() WHERE id = ?',
      [status, req.user.id, Number(req.params.id)]
    );
    res.json({ error: false, message: `Leave request ${status}` });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 11. REAL-TIME IN-APP NOTIFICATIONS & CLICK REDIRECTS
// ==========================================
app.get('/api/notifications', authMiddleware, async (req, res) => {
  try {
    const [notifications] = await pool.query(`
      SELECT
        n.id, n.workspace_id, n.from_id, n.type, n.type_id, n.action, n.title, n.message, n.created_at,
        nu.read_at,
        CONCAT(u.first_name, ' ', u.last_name) AS sender_name
      FROM notification_user nu
      JOIN notifications n ON n.id = nu.notification_id
      LEFT JOIN users u ON CONCAT('u_', u.id) = n.from_id
      WHERE nu.user_id = ?
      ORDER BY n.id DESC
      LIMIT 40
    `, [req.user.id]);

    const [[unreadRow]] = await pool.query(
      'SELECT COUNT(*) AS unread_count FROM notification_user WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    );

    res.json({
      error: false,
      unreadCount: Number(unreadRow?.unread_count || 0),
      notifications
    });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.put('/api/notifications/:id/read', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notification_user SET read_at = NOW() WHERE notification_id = ? AND user_id = ?',
      [Number(req.params.id), req.user.id]
    );
    res.json({ error: false });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.put('/api/notifications/read-all', authMiddleware, async (req, res) => {
  try {
    await pool.query(
      'UPDATE notification_user SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL',
      [req.user.id]
    );
    res.json({ error: false, message: 'All notifications marked as read' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 12. TASK & PROJECT COMMENTS WITH @TAGGING & AUTO-NOTIFICATION
// ==========================================
app.get('/api/comments', authMiddleware, async (req, res) => {
  try {
    const { type, id } = req.query; // type = 'task' | 'project'
    const modelLike = type === 'project' ? '%Project' : '%Task';
    const [comments] = await pool.query(`
      SELECT
        c.*,
        u.first_name, u.last_name, u.email, u.photo,
        CONCAT(u.first_name, ' ', u.last_name) AS author_name
      FROM comments c
      LEFT JOIN users u ON u.id = c.commenter_id
      WHERE c.commentable_id = ? AND c.commentable_type LIKE ? AND c.deleted_at IS NULL
      ORDER BY c.id ASC
    `, [Number(id), modelLike]);

    res.json({ error: false, comments });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/comments', authMiddleware, async (req, res) => {
  try {
    const { type, id, content, mentioned_user_ids = [], send_email = true } = req.body;
    if (!type || !id || !content || !String(content).trim()) {
      return res.status(400).json({ error: true, message: 'Comment content is required' });
    }

    const entityId = Number(id);
    const isProject = type === 'project';
    const commentableType = isProject ? 'App\\Models\\Project' : 'App\\Models\\Task';

    let entityTitle = `${type} #${entityId}`;
    let workspaceId = req.user.default_workspace_id || 5;
    if (isProject) {
      const [pRows] = await pool.query('SELECT title, workspace_id FROM projects WHERE id = ?', [entityId]);
      if (pRows.length) {
        entityTitle = pRows[0].title;
        workspaceId = pRows[0].workspace_id;
      }
    } else {
      const [tRows] = await pool.query('SELECT title, workspace_id FROM tasks WHERE id = ?', [entityId]);
      if (tRows.length) {
        entityTitle = tRows[0].title;
        workspaceId = tRows[0].workspace_id;
      }
    }

    const cleanContent = `<p>${String(content).trim()}</p>`;
    const [ins] = await pool.query(`
      INSERT INTO comments (parent_id, commenter_id, commenter_type, commentable_type, commentable_id, content, created_at, updated_at)
      VALUES (NULL, ?, 'App\\\\Models\\\\User', ?, ?, ?, NOW(), NOW())
    `, [req.user.id, commentableType, entityId, cleanContent]);

    const commentId = ins.insertId;

    // Also parse @FirstName or @FullName mentions from the comment text automatically
    const [allUsers] = await pool.query('SELECT id, first_name, last_name FROM users WHERE status = 1');
    const detectedIds = new Set((mentioned_user_ids || []).map(Number).filter(Boolean));
    const lowerText = String(content).toLowerCase();
    for (const u of allUsers) {
      const fn = (u.first_name || '').toLowerCase();
      const full = `${u.first_name || ''} ${u.last_name || ''}`.trim().toLowerCase();
      if ((fn && lowerText.includes(`@${fn}`)) || (full && lowerText.includes(`@${full}`))) {
        detectedIds.add(Number(u.id));
      }
    }

    const taggedIds = [...detectedIds];
    const actorName = `${req.user.first_name} ${req.user.last_name}`.trim();

    if (taggedIds.length > 0) {
      const notifType = isProject ? 'project_comment_mention' : 'task_comment_mention';
      await notifyUsersAndSendEmail({
        workspace_id: workspaceId,
        from_user_id: req.user.id,
        type: notifType,
        type_id: entityId,
        action: 'mentioned',
        title: `You were tagged in ${isProject ? 'Project' : 'Task'}: ${entityTitle}`,
        message: `${actorName} tagged you in ${isProject ? 'Project' : 'Task'} "${entityTitle}": "${String(content).trim().substring(0, 140)}"`,
        emailSubject: `💬 ${actorName} tagged you in ${isProject ? 'Project' : 'Task'}: ${entityTitle}`,
        emailHtml: `
          <p><strong>${actorName}</strong> tagged you in a comment on ${isProject ? 'Project' : 'Task'} <strong>${entityTitle} (#${entityId})</strong>:</p>
          <div style="background: #f8fafc; padding: 16px; border-left: 4px solid #2563eb; margin: 14px 0;">
            <p style="margin: 0; white-space: pre-line;">${String(content).trim()}</p>
          </div>
          <p style="font-size: 13px;">Open the dashboard and click your notification bell to jump directly to this discussion.</p>
        `,
        user_ids: taggedIds,
        send_email: Boolean(send_email)
      });
    }

    res.json({
      error: false,
      message: taggedIds.length > 0 ? `Comment posted and ${taggedIds.length} tagged member(s) notified` : 'Comment posted',
      id: commentId,
      taggedCount: taggedIds.length
    });
  } catch (err) {
    console.error('Comment post error:', err);
    res.status(500).json({ error: true, message: err.message });
  }
});

app.delete('/api/comments/:id', authMiddleware, async (req, res) => {
  try {
    const cid = Number(req.params.id);
    const [rows] = await pool.query('SELECT commenter_id FROM comments WHERE id = ?', [cid]);
    if (!rows.length) return res.status(404).json({ error: true, message: 'Comment not found' });
    if (!req.user.isAdminOrHasAllDataAccess && Number(rows[0].commenter_id) !== Number(req.user.id)) {
      return res.status(403).json({ error: true, message: 'You can only delete your own comments' });
    }
    await pool.query('DELETE FROM comments WHERE id = ?', [cid]);
    res.json({ error: false, message: 'Comment deleted' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

// ==========================================
// 13. EMAIL SETTINGS (ADMIN & SUPERADMIN ONLY)
// ==========================================
app.get('/api/email-settings', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin and Admin can view or modify Email Settings.' });
  }
  try {
    const [rows] = await pool.query("SELECT value FROM settings WHERE variable = 'email_settings' LIMIT 1");
    let config = {
      email: '',
      password: '',
      smtp_host: 'smtp.gmail.com',
      smtp_port: '587',
      email_content_type: 'html',
      smtp_encryption: 'tls'
    };
    if (rows.length && rows[0].value) {
      try { config = { ...config, ...JSON.parse(rows[0].value) }; } catch (e) {}
    }
    res.json({ error: false, emailSettings: config });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.put('/api/email-settings', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin and Admin can modify Email Settings.' });
  }
  try {
    const { email, password, smtp_host, smtp_port, smtp_encryption, email_content_type } = req.body;
    if (!email || !smtp_host || !smtp_port) {
      return res.status(400).json({ error: true, message: 'SMTP Host, Port, and Email are required' });
    }

    const [existingRows] = await pool.query("SELECT value FROM settings WHERE variable = 'email_settings' LIMIT 1");
    let existing = {};
    if (existingRows.length && existingRows[0].value) {
      try { existing = JSON.parse(existingRows[0].value); } catch (e) {}
    }

    const newSettings = {
      email: email.trim(),
      password: password && password.trim() !== '' ? password.trim() : (existing.password || ''),
      smtp_host: smtp_host.trim(),
      smtp_port: String(smtp_port).trim(),
      email_content_type: email_content_type || 'html',
      smtp_encryption: smtp_encryption || 'tls'
    };

    const jsonStr = JSON.stringify(newSettings);
    if (existingRows.length) {
      await pool.query("UPDATE settings SET value = ?, updated_at = NOW() WHERE variable = 'email_settings'", [jsonStr]);
    } else {
      await pool.query("INSERT INTO settings (variable, value, created_at, updated_at) VALUES ('email_settings', ?, NOW(), NOW())", [jsonStr]);
    }

    addCronLog('SMTP_CONFIG', `Admin ${req.user.email} updated SMTP Email Settings (${newSettings.email} @ ${newSettings.smtp_host}:${newSettings.smtp_port})`);
    res.json({ error: false, message: 'Email settings saved and synced with Laravel database' });
  } catch (err) {
    res.status(500).json({ error: true, message: err.message });
  }
});

app.post('/api/email-settings/test', authMiddleware, async (req, res) => {
  if (!req.user.isStrictAdmin) {
    return res.status(403).json({ error: true, message: 'Only Super Admin and Admin can test Email Settings.' });
  }
  try {
    const testTo = req.body.to_email || req.user.email;
    const mailSetup = await getEmailTransporter();
    if (!mailSetup) {
      return res.status(400).json({ error: true, message: 'SMTP settings are incomplete. Please save valid SMTP settings first.' });
    }
    await mailSetup.transporter.sendMail({
      from: `"${mailSetup.companyTitle}" <${mailSetup.fromAddress}>`,
      to: testTo,
      subject: `✅ SMTP Test Email — ${mailSetup.companyTitle}`,
      html: `
        <div style="font-family: Arial, sans-serif; padding: 20px; border: 1px solid #e2e8f0; border-radius: 8px;">
          <h3 style="color: #2563eb; margin-top: 0;">SMTP Connection Successful!</h3>
          <p>Your Node.js Task Manager SMTP configuration is working properly.</p>
          <p style="font-size: 12px; color: #64748b;">Sent to: ${testTo}</p>
        </div>
      `
    });
    res.json({ error: false, message: `Test email successfully sent to ${testTo}` });
  } catch (err) {
    res.status(500).json({ error: true, message: `SMTP Error: ${err.message}` });
  }
});

// SPA Fallback
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`====================================================`);
  console.log(`🚀 Task Manager running on port ${PORT}`);
  console.log(`🔗 URL: http://localhost:${PORT}`);
  console.log(`🗄️  Connected to MySQL database: ${process.env.DB_DATABASE || 'taskify1'}`);
  console.log(`⏰ Automated Cron & Email Engine: ACTIVE (60s cycle)`);
  console.log(`====================================================`);
});
