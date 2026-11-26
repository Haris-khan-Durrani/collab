// ============================================================================
// TASKIFY CEO CENTRAL DASHBOARD — CLEAN, ONE-PANEL EXECUTIVE SPA ENGINE
// ============================================================================

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const state = {
  token: localStorage.getItem('ceo_token') || null,
  user: null,
  theme: localStorage.getItem('ceo_theme') || 'light',
  activeTab: 'overview',
  selectedWorkspace: localStorage.getItem('ceo_workspace') || 'all',
  projectViewMode: localStorage.getItem('ceo_proj_view') || 'table',
  taskViewMode: localStorage.getItem('ceo_task_view') || 'table',
  dateFilter: { start_date: '', end_date: '' },
  meta: {
    workspaces: [],
    statuses: [],
    priorities: [],
    roles: [],
    permissions: [],
    tags: [],
    users: [],
    clients: [],
    cronState: null
  },
  overview: null,
  projects: [],
  tasks: [],
  meetings: [],
  cronDetails: null,
  charts: {
    projectsStatus: null,
    tasksStatus: null,
    teamWorkload: null
  }
};

const COLOR_BADGE_MAP = {
  primary: 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/60 dark:text-blue-300 dark:border-blue-800',
  secondary: 'bg-slate-100 text-slate-700 border-slate-200 dark:bg-slate-700 dark:text-slate-300 dark:border-slate-600',
  success: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/60 dark:text-emerald-300 dark:border-emerald-800',
  danger: 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/60 dark:text-red-300 dark:border-red-800',
  warning: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-950/60 dark:text-amber-300 dark:border-amber-800',
  info: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-950/60 dark:text-sky-300 dark:border-sky-800',
  dark: 'bg-slate-200 text-slate-800 border-slate-300 dark:bg-slate-700 dark:text-slate-200 dark:border-slate-600'
};

const CHART_HEX_MAP = {
  primary: '#2563eb',
  secondary: '#64748b',
  success: '#10b981',
  danger: '#ef4444',
  warning: '#f59e0b',
  info: '#0284c7',
  dark: '#334155'
};

function badgeClass(color) {
  return COLOR_BADGE_MAP[color] || COLOR_BADGE_MAP.secondary;
}

function chartColor(color, idx = 0) {
  const fallback = ['#2563eb', '#0284c7', '#10b981', '#f59e0b', '#ef4444', '#64748b'];
  return CHART_HEX_MAP[color] || fallback[idx % fallback.length];
}

function stripHtml(html) {
  if (!html) return '';
  const tmp = document.createElement('div');
  tmp.innerHTML = html;
  const text = (tmp.textContent || tmp.innerText || '').trim();
  return text === 'null' ? '' : text;
}

function formatDate(dateStr) {
  if (!dateStr) return '—';
  return String(dateStr).substring(0, 10);
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

function formatTimeSlotBadge(startTime, endTime) {
  if (!startTime || !endTime) return '<span class="text-slate-400">Anytime</span>';
  return `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-mono text-[11px] font-semibold">🕒 ${formatTime12h(startTime)} – ${formatTime12h(endTime)}</span>`;
}

function isDateOverdue(dateStr, statusTitle = '', completion = 0) {
  if (!dateStr) return false;
  if (String(statusTitle).toLowerCase().includes('complete') || Number(completion) === 100) return false;
  const today = new Date().toISOString().substring(0, 10);
  return String(dateStr).substring(0, 10) < today;
}

function applyTheme() {
  if (state.theme === 'dark') {
    document.documentElement.classList.add('dark');
  } else {
    document.documentElement.classList.remove('dark');
  }
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  const el = document.createElement('div');
  const bg = type === 'error'
    ? 'bg-red-600 text-white border-red-700'
    : 'bg-slate-900 text-white border-slate-800';
  el.className = `px-4 py-2.5 rounded-lg border shadow-lg text-xs font-medium flex items-center gap-2 transition-all duration-300 ${bg}`;
  el.innerHTML = `
    <span class="w-2 h-2 rounded-full ${type === 'error' ? 'bg-red-200' : 'bg-emerald-400'}"></span>
    <span>${message}</span>
  `;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3200);
}

async function apiFetch(url, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  const res = await fetch(url, { ...options, headers });
  const data = await res.json().catch(() => ({ error: true, message: 'Invalid JSON response' }));
  if (res.status === 401 && !url.includes('/api/auth/login')) {
    handleLogout();
    throw new Error('Session expired');
  }
  if (!res.ok || data.error) {
    throw new Error(data.message || 'API error');
  }
  return data;
}

// ============================================================================
// INITIALIZATION
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
  applyTheme();
  lucide.createIcons();
  bindEvents();

  if (state.token) {
    try {
      const me = await apiFetch('/api/auth/me');
      state.user = me.user;
      await enterDashboard();
    } catch (e) {
      showLoginScreen();
    }
  } else {
    showLoginScreen();
  }
});

function showLoginScreen() {
  document.getElementById('login-view').classList.remove('hidden');
  document.getElementById('app-view').classList.add('hidden');
}

async function enterDashboard() {
  document.getElementById('login-view').classList.add('hidden');
  document.getElementById('app-view').classList.remove('hidden');

  const fullName = `${state.user.first_name || ''} ${state.user.last_name || ''}`.trim() || state.user.email;
  const initials = ((state.user.first_name?.[0] || '') + (state.user.last_name?.[0] || '')).toUpperCase() || 'CA';
  document.getElementById('user-name').textContent = fullName;
  document.getElementById('user-avatar').textContent = initials;
  document.getElementById('user-role-badge').textContent =
    state.user.roleNames?.length ? state.user.roleNames.join(', ') : 'Super Admin';

  setProjectViewMode(state.projectViewMode, false);
  setTaskViewMode(state.taskViewMode, false);
  applyRoleBasedVisibility();

  await loadAllData();
  await loadNotifications();

  // Poll notifications every 15 seconds so @mentions & task assignments appear live
  if (state.notifInterval) clearInterval(state.notifInterval);
  state.notifInterval = setInterval(() => {
    if (state.token) loadNotifications();
  }, 15000);
}

function userHasAnyPermission(permListStr) {
  if (!state.user) return false;
  if (state.user.isStrictAdmin) return true;
  if (!permListStr) return true;
  const userPerms = Array.isArray(state.user.permissions) ? state.user.permissions : [];
  const required = String(permListStr).split(',').map(s => s.trim()).filter(Boolean);
  return required.some(p => userPerms.includes(p));
}

function applyRoleBasedVisibility() {
  const isStrictAdmin = Boolean(state.user?.isStrictAdmin);

  // 1. Sidebar nav items with data-strict-admin or data-perm
  document.querySelectorAll('.perm-gated-nav').forEach(el => {
    const strictOnly = el.dataset.strictAdmin === 'true';
    const permAttr = el.dataset.perm || '';
    const allowed = strictOnly ? isStrictAdmin : userHasAnyPermission(permAttr);
    el.classList.toggle('hidden', !allowed);
  });

  // 2. Hide "People & Access" section label if all its items are hidden
  const peopleSection = document.getElementById('people-sidebar-section');
  if (peopleSection) {
    const anyPeopleVisible = ['team', 'clients', 'workspaces'].some(tab => {
      const btn = document.querySelector(`.nav-tab[data-tab="${tab}"]`);
      return btn && !btn.classList.contains('hidden');
    });
    peopleSection.classList.toggle('hidden', !anyPeopleVisible);
  }

  // 3. Hide "Automation & Admin" section label if all its items are hidden
  const adminSection = document.getElementById('admin-sidebar-section');
  if (adminSection) {
    const anyAdminVisible = Array.from(document.querySelectorAll('.admin-section-item')).some(
      el => !el.classList.contains('hidden')
    );
    adminSection.classList.toggle('hidden', !anyAdminVisible);
  }

  // 4. Header quick action buttons (Create Project / Task / Meeting)
  document.querySelectorAll('.perm-gated-btn').forEach(el => {
    const permAttr = el.dataset.perm || '';
    const allowed = userHasAnyPermission(permAttr);
    el.classList.toggle('hidden', !allowed);
  });

  // 5. Rename Settings label to "Statuses & Tags" for non-admins (Roles card is hidden)
  const settingsLabel = document.getElementById('nav-settings-label');
  if (settingsLabel) {
    settingsLabel.textContent = isStrictAdmin ? 'Statuses, Roles & Tags' : 'Statuses & Tags';
  }
}

window.toggleMobileSidebar = function(open) {
  const sidebar = document.getElementById('app-sidebar');
  const backdrop = document.getElementById('mobile-sidebar-backdrop');
  if (!sidebar || !backdrop) return;
  const shouldOpen = open !== undefined ? open : sidebar.classList.contains('-translate-x-full');
  if (shouldOpen) {
    sidebar.classList.remove('-translate-x-full');
    backdrop.classList.remove('hidden');
  } else {
    sidebar.classList.add('-translate-x-full');
    backdrop.classList.add('hidden');
  }
};

async function handleLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  state.token = null;
  state.user = null;
  localStorage.removeItem('ceo_token');
  showLoginScreen();
}

// ============================================================================
// DATA SYNC
// ============================================================================
async function loadAllData() {
  try {
    const qs = new URLSearchParams({ workspace_id: state.selectedWorkspace });
    if (state.dateFilter.start_date) qs.set('start_date', state.dateFilter.start_date);
    if (state.dateFilter.end_date) qs.set('end_date', state.dateFilter.end_date);

    const [metaRes, overviewRes, projectsRes, tasksRes, meetingsRes, cronRes] = await Promise.all([
      apiFetch('/api/meta'),
      apiFetch(`/api/overview?${qs.toString()}`),
      apiFetch(`/api/projects?workspace_id=${state.selectedWorkspace}`),
      apiFetch(`/api/tasks?workspace_id=${state.selectedWorkspace}`),
      apiFetch(`/api/meetings?workspace_id=${state.selectedWorkspace}`),
      apiFetch('/api/cron/status')
    ]);

    state.meta = metaRes;
    state.overview = overviewRes;
    state.projects = projectsRes.projects || [];
    state.tasks = tasksRes.tasks || [];
    state.meetings = meetingsRes.meetings || [];
    state.meetingRecurringRules = meetingsRes.recurringRules || [];
    state.cronDetails = cronRes;

    if (overviewRes.queryTimeMs !== undefined) {
      document.getElementById('query-speed-badge').textContent = `${overviewRes.queryTimeMs} ms`;
    }

    populateWorkspaceSelector();
    populateFilterDropdowns();
    updateNavBadges();

    renderOverview();
    loadExecCalendarActivity();
    renderProjectsViews();
    renderTasksViews();
    renderMeetingsTable();
    renderTeamTable();
    renderClientsTable();
    renderWorkspacesGrid();
    renderCronTab();
    renderSettingsTab();
    renderActivityAndLeavesTab();
    lucide.createIcons();
  } catch (err) {
    showToast(err.message || 'Failed to sync data', 'error');
  }
}

function populateWorkspaceSelector() {
  const select = document.getElementById('global-workspace-select');
  let current = state.selectedWorkspace;
  // If previously selected workspace was moved to deletion hold, reset cleanly to 'all'
  if (current !== 'all' && !state.meta.workspaces.some(w => String(w.id) === String(current))) {
    current = 'all';
    state.selectedWorkspace = 'all';
    localStorage.setItem('ceo_workspace', 'all');
  }
  select.innerHTML = `<option value="all">All Workspaces (Company-Wide)</option>`;
  state.meta.workspaces.forEach(w => {
    const opt = document.createElement('option');
    opt.value = String(w.id);
    opt.textContent = `${w.title} (${w.projects_count} proj / ${w.tasks_count} tasks)`;
    select.appendChild(opt);
  });
  select.value = current;

  const activeWs = state.meta.workspaces.find(w => String(w.id) === String(current));
  document.getElementById('active-workspace-pill').textContent =
    activeWs ? `Workspace: ${activeWs.title}` : 'All Workspaces';
}

function populateFilterDropdowns() {
  const curPS = document.getElementById('filter-project-status')?.value || '';
  const curTS = document.getElementById('filter-task-status')?.value || '';
  const statusOptions = `<option value="">All Statuses</option>` +
    state.meta.statuses.map(s => `<option value="${s.id}">${s.title}</option>`).join('');
  document.getElementById('filter-project-status').innerHTML = statusOptions;
  document.getElementById('filter-task-status').innerHTML = statusOptions;
  document.getElementById('filter-project-status').value = curPS;
  document.getElementById('filter-task-status').value = curTS;

  const curPP = document.getElementById('filter-project-priority')?.value || '';
  const curTP = document.getElementById('filter-task-priority')?.value || '';
  const priorityOptions = `<option value="">All Priorities</option>` +
    state.meta.priorities.map(p => `<option value="${p.id}">${p.title}</option>`).join('');
  document.getElementById('filter-project-priority').innerHTML = priorityOptions;
  document.getElementById('filter-task-priority').innerHTML = priorityOptions;
  document.getElementById('filter-project-priority').value = curPP;
  document.getElementById('filter-task-priority').value = curTP;

  const curPU = document.getElementById('filter-project-user')?.value || '';
  const curTU = document.getElementById('filter-task-user')?.value || '';
  const userOptions = `<option value="">All Team Members</option>` +
    state.meta.users.map(u => `<option value="${u.id}">${u.first_name} ${u.last_name}</option>`).join('');
  document.getElementById('filter-project-user').innerHTML = userOptions;
  document.getElementById('filter-task-user').innerHTML = userOptions;
  document.getElementById('filter-project-user').value = curPU;
  document.getElementById('filter-task-user').value = curTU;

  const curTProj = document.getElementById('filter-task-project')?.value || '';
  const projOptions = `<option value="">All Projects</option>` +
    state.projects.map(p => `<option value="${p.id}">${p.title}</option>`).join('');
  document.getElementById('filter-task-project').innerHTML = projOptions;
  document.getElementById('filter-task-project').value = curTProj;
}

function updateNavBadges() {
  document.getElementById('nav-projects-badge').textContent = state.projects.length;
  document.getElementById('nav-tasks-badge').textContent = state.tasks.length;
  document.getElementById('nav-meetings-badge').textContent = state.meetings.length;
  document.getElementById('nav-users-badge').textContent = state.meta.users.length;
  document.getElementById('nav-clients-badge').textContent = state.meta.clients.length;
  document.getElementById('nav-workspaces-badge').textContent = state.meta.workspaces.length;
}

// ============================================================================
// TAB 1: EXECUTIVE SUMMARY (TODAY'S COVERAGE + MEETINGS + AGENDAS + WORKLOAD)
// ============================================================================
function renderOverview() {
  const ov = state.overview;
  if (!ov) return;

  const ps = ov.projectStats || {};
  const ts = ov.taskStats || {};
  const tds = ov.todayTaskStats || {};

  // Today's Task Coverage Card
  const todayTotal = Number(tds.today_total || 0);
  const todayCovered = Number(tds.today_covered || 0);
  const todayRemaining = Number(tds.today_remaining || 0);
  const todayPct = todayTotal > 0 ? Math.round((todayCovered / todayTotal) * 100) : 0;

  document.getElementById('kpi-today-total').textContent = todayTotal;
  document.getElementById('kpi-today-covered').textContent = todayCovered;
  document.getElementById('kpi-today-remaining').textContent = todayRemaining;
  document.getElementById('kpi-today-pct').textContent = `${todayPct}%`;
  document.getElementById('kpi-today-bar').style.width = `${todayPct}%`;

  // Portfolio & Tasks KPIs
  const totalProjects = Number(ps.total_projects || 0);
  const activeProjects = Number(ps.active_projects || 0);
  const completedProjects = Number(ps.completed_projects || 0);
  const overdueProjects = Number(ps.overdue_projects || 0);

  const totalTasks = Number(ts.total_tasks || 0);
  const completedTasks = Number(ts.completed_tasks || 0);
  const inProgressTasks = Number(ts.in_progress_tasks || 0);
  const overdueTasks = Number(ts.overdue_tasks || 0);
  const dueTodayTasks = Number(ts.due_today_tasks || 0);
  const completionRate = totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0;

  document.getElementById('kpi-total-projects').textContent = totalProjects;
  document.getElementById('kpi-active-projects').textContent = `${activeProjects} active`;
  document.getElementById('kpi-completed-projects').textContent = completedProjects;
  document.getElementById('kpi-overdue-projects').textContent = overdueProjects;

  document.getElementById('kpi-total-tasks').textContent = totalTasks;
  document.getElementById('kpi-completion-rate').textContent = `${completionRate}% done`;
  document.getElementById('kpi-completed-tasks').textContent = completedTasks;
  document.getElementById('kpi-inprogress-tasks').textContent = inProgressTasks;

  document.getElementById('kpi-overdue-tasks').textContent = overdueTasks;
  document.getElementById('kpi-duetoday-tasks').textContent = dueTodayTasks;
  document.getElementById('kpi-avg-progress').textContent = `${ts.avg_completion || completionRate}%`;

  const todayMeetingsCount = (ov.todayMeetingsList || []).filter(m => Number(m.is_today) === 1).length;
  document.getElementById('kpi-today-meetings').textContent = todayMeetingsCount;
  document.getElementById('kpi-total-users').textContent = (ov.teamWorkload || []).length;
  document.getElementById('kpi-total-workspaces').textContent = state.meta.workspaces.length;

  // Today's Action Plan & Time-Slot Tasks Table
  const todayTbody = document.getElementById('overview-today-tasks-tbody');
  const todayTasks = ov.todayTasksList || [];
  if (todayTasks.length === 0) {
    todayTbody.innerHTML = `
      <tr>
        <td colspan="5" class="py-8 text-center text-slate-400">
          No tasks specifically scheduled for today yet. Click <strong>"+ Schedule Time-Slot Task"</strong> above to assign a time-based task (e.g. 9:00 AM – 11:00 AM).
        </td>
      </tr>
    `;
  } else {
    todayTbody.innerHTML = todayTasks.map(t => {
      const isCovered = String(t.status_title).toLowerCase().includes('complete') || Number(t.completion_percentage) === 100;
      const statusOpts = state.meta.statuses.map(s =>
        `<option value="${s.id}" ${Number(s.id) === Number(t.status_id) ? 'selected' : ''}>${s.title}</option>`
      ).join('');

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition ${isCovered ? 'bg-emerald-50/30 dark:bg-emerald-950/10' : ''}">
          <td class="py-3 px-4 whitespace-nowrap">
            ${formatTimeSlotBadge(t.start_time, t.end_time)}
            ${t.recurring_frequency ? `<div class="text-[10px] text-emerald-600 font-semibold mt-0.5">🔁 Repeats ${t.recurring_frequency}</div>` : ''}
          </td>
          <td class="py-3 px-3">
            <button onclick="openDiscussionModal('task', ${t.id})" class="font-bold text-slate-900 dark:text-white hover:text-blue-600 text-left block ${isCovered ? 'line-through text-slate-400' : ''}">
              ${t.title}
            </button>
            <span class="text-[11px] text-slate-500">${t.project_title || ''}</span>
          </td>
          <td class="py-3 px-3 text-slate-600 dark:text-slate-300 font-medium">${t.assignees || 'Unassigned'}</td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 rounded text-[10px] font-medium border ${badgeClass(t.priority_color)}">
              ${t.priority_title || 'Normal'}
            </span>
          </td>
          <td class="py-3 px-3">
            <div class="flex items-center gap-2">
              <select onchange="quickUpdateTaskStatus(${t.id}, this.value)"
                class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[11px] font-medium">
                ${statusOpts}
              </select>
              <button onclick="openDiscussionModal('task', ${t.id})" class="px-2 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 text-[11px] font-semibold">
                View Task
              </button>
              ${isCovered
                ? `<span class="text-emerald-600 font-bold text-[11px]">✓ Covered</span>`
                : `<span class="text-amber-600 font-semibold text-[11px]">Pending</span>`}
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Today's & Upcoming Meetings & Agendas Panel
  const meetingsListEl = document.getElementById('overview-meetings-list');
  const meetingsList = ov.todayMeetingsList || [];
  if (meetingsList.length === 0) {
    meetingsListEl.innerHTML = `
      <div class="text-center py-8 text-xs text-slate-400">
        <p class="mb-2">No meetings or agendas scheduled for today.</p>
        <button onclick="openMeetingModal()" class="px-3 py-1.5 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
          + Schedule First Meeting / Agenda
        </button>
      </div>
    `;
  } else {
    meetingsListEl.innerHTML = meetingsList.map(m => {
      const datePart = String(m.start_date_time).substring(0, 10);
      const startPart = formatTime12h(String(m.start_date_time).substring(11, 16));
      const endPart = formatTime12h(String(m.end_date_time).substring(11, 16));
      const isToday = Number(m.is_today) === 1;

      return `
        <div class="p-3.5 rounded-xl border ${isToday ? 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-300 dark:border-emerald-800' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700'}">
          <div class="flex items-start justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5">
                ${isToday ? `<span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-bold">TODAY</span>` : `<span class="text-[11px] font-mono text-slate-500">${datePart}</span>`}
                <span class="font-mono text-xs font-bold text-slate-700 dark:text-slate-200">${startPart} – ${endPart}</span>
              </div>
              <h4 class="font-bold text-slate-900 dark:text-white text-sm mt-1">${m.title}</h4>
              <p class="text-[11px] text-slate-500 mt-1">Participants: <strong class="text-slate-700 dark:text-slate-300">${m.participants || 'Team'}</strong></p>
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <button onclick="openMeetingMomModal(${m.id})" class="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-bold shadow-xs">
                📝 Attendance & MoM
              </button>
              <button onclick="deleteMeeting(${m.id})" class="text-slate-400 hover:text-red-600 p-1" title="Remove">
                <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
              </button>
            </div>
          </div>
        </div>
      `;
    }).join('');
  }

  renderCharts(ov);

  // Active Projects Table
  const projTbody = document.getElementById('overview-projects-tbody');
  if (!ov.atRiskProjects || ov.atRiskProjects.length === 0) {
    projTbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-400">No projects found.</td></tr>`;
  } else {
    projTbody.innerHTML = ov.atRiskProjects.slice(0, 8).map(p => {
      const totalT = Number(p.total_tasks || 0);
      const compT = Number(p.completed_tasks || 0);
      const pct = totalT > 0 ? Math.round((compT / totalT) * 100) : 0;
      const overdueT = Number(p.overdue_tasks || 0);
      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
          <td class="py-3 px-4">
            <button onclick="openProjectDetailModal(${p.id})" class="font-semibold text-slate-900 dark:text-white hover:text-blue-600 text-left">
              ${p.title}
            </button>
            <div class="text-[11px] text-slate-500 flex items-center gap-2">
              <span>${p.workspace_title || ''}</span>
              ${overdueT > 0 ? `<span class="text-red-600 font-semibold">• ${overdueT} overdue</span>` : ''}
            </div>
          </td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 rounded-md text-[11px] font-medium border ${badgeClass(p.status_color)}">
              ${p.status_title || 'Unassigned'}
            </span>
          </td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 rounded-md text-[11px] font-medium border ${badgeClass(p.priority_color)}">
              ${p.priority_title || 'Normal'}
            </span>
          </td>
          <td class="py-3 px-3 min-w-[120px]">
            <div class="flex items-center justify-between text-[11px] mb-1">
              <span class="text-slate-600 dark:text-slate-300">${compT}/${totalT} tasks</span>
              <span class="font-semibold text-slate-800 dark:text-slate-200">${pct}%</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div class="h-full bg-blue-600" style="width:${pct}%"></div>
            </div>
          </td>
          <td class="py-3 px-4 text-right">
            <button onclick="openProjectModal(${p.id})" class="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
              Edit
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Team Workload Summary Table
  const teamTbody = document.getElementById('overview-team-tbody');
  if (!ov.teamWorkload || ov.teamWorkload.length === 0) {
    teamTbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">No team members found.</td></tr>`;
  } else {
    teamTbody.innerHTML = ov.teamWorkload.map(u => {
      const initials = ((u.first_name?.[0] || '') + (u.last_name?.[0] || '')).toUpperCase();
      return `
        <tr onclick="filterTasksByMember(${u.id})" class="cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/40 transition" title="Click to view ${u.first_name}'s tasks">
          <td class="py-3 px-4">
            <div class="flex items-center gap-2.5">
              <div class="w-7 h-7 rounded-full bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 flex items-center justify-center font-bold text-[11px]">
                ${initials}
              </div>
              <div>
                <div class="font-semibold text-slate-900 dark:text-white">${u.first_name} ${u.last_name}</div>
                <div class="text-[10px] text-slate-500">${u.email}</div>
              </div>
            </div>
          </td>
          <td class="py-3 px-3">
            <span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
              ${u.role_name || 'Member'}
            </span>
          </td>
          <td class="py-3 px-3 text-center font-semibold text-slate-700 dark:text-slate-200">${u.assigned_projects || 0}</td>
          <td class="py-3 px-3 text-center">
            <span class="px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 dark:bg-blue-950/60 dark:text-blue-300 font-semibold">${u.open_tasks || 0}</span>
          </td>
          <td class="py-3 px-3 text-center">
            <span class="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-300 font-semibold">${u.completed_tasks || 0}</span>
          </td>
          <td class="py-3 px-4 text-center">
            ${Number(u.overdue_tasks) > 0
              ? `<span class="px-2 py-0.5 rounded-full bg-red-50 text-red-700 font-bold border border-red-200">${u.overdue_tasks}</span>`
              : `<span class="text-slate-400">0</span>`}
          </td>
        </tr>
      `;
    }).join('');
  }

  // All Open Tasks Table
  const urgentTbody = document.getElementById('overview-urgent-tasks-tbody');
  if (!ov.urgentTasks || ov.urgentTasks.length === 0) {
    urgentTbody.innerHTML = `<tr><td colspan="6" class="py-6 text-center text-slate-400">All tasks are completed!</td></tr>`;
  } else {
    urgentTbody.innerHTML = ov.urgentTasks.slice(0, 10).map(t => {
      const overdue = isDateOverdue(t.due_date, t.status_title, t.completion_percentage);
      const statusOpts = state.meta.statuses.map(s =>
        `<option value="${s.id}" ${Number(s.id) === Number(t.status_id) ? 'selected' : ''}>${s.title}</option>`
      ).join('');

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
          <td class="py-2.5 px-4">
            <button onclick="openDiscussionModal('task', ${t.id})" class="font-semibold text-slate-900 dark:text-white hover:text-blue-600 text-left">
              ${t.title}
            </button>
            ${t.recurring_frequency ? `<span class="ml-1 text-[10px] text-emerald-600 font-semibold">🔁 ${t.recurring_frequency}</span>` : ''}
          </td>
          <td class="py-2.5 px-3 text-slate-600 dark:text-slate-300">${t.project_title || '—'}</td>
          <td class="py-2.5 px-3">${formatTimeSlotBadge(t.start_time, t.end_time)}</td>
          <td class="py-2.5 px-3 text-slate-500">${t.assignees || 'Unassigned'}</td>
          <td class="py-2.5 px-3">
            <select onchange="quickUpdateTaskStatus(${t.id}, this.value)"
              class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[11px] font-medium">
              ${statusOpts}
            </select>
          </td>
          <td class="py-2.5 px-4 text-right font-mono text-[11px] ${overdue ? 'text-red-600 font-bold' : 'text-slate-500'}">
            ${formatDate(t.due_date)}
          </td>
        </tr>
      `;
    }).join('');
  }

  // CEO Quick Checklist
  const todosContainer = document.getElementById('overview-todos-list');
  const todos = ov.todos || [];
  if (todos.length === 0) {
    todosContainer.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">No personal checklist items yet.</p>`;
  } else {
    todosContainer.innerHTML = todos.map(td => `
      <div class="flex items-center justify-between p-2 rounded-lg bg-slate-50 dark:bg-slate-900/50 border border-slate-200 dark:border-slate-700">
        <label class="flex items-center gap-2 cursor-pointer flex-1 min-w-0">
          <input type="checkbox" ${td.is_completed ? 'checked' : ''} onchange="toggleTodo(${td.id})" class="rounded text-blue-600" />
          <span class="text-xs truncate ${td.is_completed ? 'line-through text-slate-400' : 'text-slate-800 dark:text-slate-200 font-medium'}">${td.title}</span>
        </label>
        <button onclick="deleteTodo(${td.id})" class="text-slate-400 hover:text-red-600 ml-2">
          <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
        </button>
      </div>
    `).join('');
  }
}

window.filterTasksByMember = function(userId) {
  document.getElementById('filter-task-user').value = String(userId);
  switchTab('tasks');
  renderTasksViews();
};

// ============================================================================
// CENTRAL EXECUTIVE DAILY ACTIVITY CALENDAR (Done, Started, Planned, Meetings, Activity)
// ============================================================================
const execCalState = {
  month: new Date().toISOString().substring(0, 7), // YYYY-MM
  selectedDate: new Date().toISOString().substring(0, 10), // YYYY-MM-DD
  dayFilter: 'all',
  days: {}
};

window.shiftExecCalendarMonth = function(deltaMonths) {
  if (deltaMonths === 0) {
    const now = new Date();
    execCalState.month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    execCalState.selectedDate = `${execCalState.month}-${String(now.getDate()).padStart(2, '0')}`;
  } else {
    const [y, m] = execCalState.month.split('-').map(Number);
    const d = new Date(y, m - 1 + deltaMonths, 1);
    execCalState.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    execCalState.selectedDate = `${execCalState.month}-01`;
  }
  loadExecCalendarActivity();
};

window.selectExecCalDate = function(dateStr) {
  execCalState.selectedDate = dateStr;
  renderExecCalendarGrid();
  renderExecCalendarDayBriefing();
};

window.setExecCalDayFilter = function(filterKey) {
  execCalState.dayFilter = filterKey;
  document.querySelectorAll('.exec-cal-day-tab').forEach(btn => {
    const act = btn.dataset.dayTab === filterKey;
    btn.className = `exec-cal-day-tab px-2.5 py-1 rounded-md transition ${
      act
        ? 'bg-slate-900 dark:bg-blue-600 text-white font-bold'
        : 'bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 font-semibold hover:border-blue-400'
    }`;
  });
  renderExecCalendarDayBriefing();
};

async function loadExecCalendarActivity() {
  const grid = document.getElementById('exec-cal-grid');
  if (!grid) return;
  try {
    const res = await apiFetch(`/api/calendar-activity?month=${execCalState.month}&workspace_id=${state.selectedWorkspace}`);
    execCalState.days = res.days || {};
    renderExecCalendarGrid();
    renderExecCalendarDayBriefing();
  } catch (err) {
    console.warn('Calendar load warning:', err.message);
  }
}

function renderExecCalendarGrid() {
  const grid = document.getElementById('exec-cal-grid');
  const labelEl = document.getElementById('exec-cal-month-label');
  if (!grid) return;

  const [y, m] = execCalState.month.split('-').map(Number);
  const firstOfMonth = new Date(y, m - 1, 1);
  const daysInMonth = new Date(y, m, 0).getDate();
  const startOffset = (firstOfMonth.getDay() + 6) % 7; // Monday = 0

  if (labelEl) {
    labelEl.textContent = firstOfMonth.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
  }

  const now = new Date();
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  let html = '';
  for (let i = 0; i < startOffset; i++) {
    html += `<div class="min-h-[64px] sm:min-h-[76px] rounded-lg bg-slate-50/50 dark:bg-slate-900/20"></div>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dStr = `${execCalState.month}-${String(day).padStart(2, '0')}`;
    const info = execCalState.days[dStr] || { done: [], started: [], planned: [], meetings: [], activities: [] };
    const isToday = dStr === todayStr;
    const isSelected = dStr === execCalState.selectedDate;

    const doneC = info.done.length;
    const startC = info.started.length;
    const planC = info.planned.length;
    const meetC = info.meetings.length;
    const actC = info.activities.length;
    const hasAny = doneC + startC + planC + meetC + actC > 0;

    let badges = '';
    if (doneC) badges += `<span class="px-1 py-0.2 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 text-[9px] font-bold" title="${doneC} Done">✓${doneC}</span>`;
    if (startC) badges += `<span class="px-1 py-0.2 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300 text-[9px] font-bold" title="${startC} Started">▶${startC}</span>`;
    if (planC) badges += `<span class="px-1 py-0.2 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300 text-[9px] font-bold" title="${planC} Planned">📋${planC}</span>`;
    if (meetC) badges += `<span class="px-1 py-0.2 rounded bg-teal-100 dark:bg-teal-950 text-teal-700 dark:text-teal-300 text-[9px] font-bold" title="${meetC} Meetings">📅${meetC}</span>`;
    if (actC && !doneC && !startC && !planC && !meetC) {
      badges += `<span class="px-1 py-0.2 rounded bg-purple-100 dark:bg-purple-950 text-purple-700 dark:text-purple-300 text-[9px] font-bold" title="${actC} Activity">⚡${actC}</span>`;
    }

    const cellCls = isSelected
      ? 'border-blue-600 ring-2 ring-blue-200 dark:ring-blue-900 bg-blue-50/50 dark:bg-blue-950/30'
      : (isToday
        ? 'border-emerald-400 bg-emerald-50/40 dark:bg-emerald-950/20'
        : (hasAny
          ? 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-800 hover:border-blue-400'
          : 'border-slate-100 dark:border-slate-800 bg-slate-50/30 dark:bg-slate-900/30 hover:border-slate-300'));

    html += `
      <button type="button" onclick="selectExecCalDate('${dStr}')"
        class="min-h-[64px] sm:min-h-[76px] p-1.5 rounded-lg border text-left flex flex-col justify-between transition ${cellCls}">
        <div class="flex items-center justify-between w-full">
          <span class="text-xs font-bold ${isToday ? 'px-1.5 py-0.2 rounded-full bg-emerald-600 text-white' : (isSelected ? 'text-blue-700 dark:text-blue-300' : 'text-slate-700 dark:text-slate-200')}">${day}</span>
          ${actC > 0 && (doneC || startC || planC || meetC) ? `<span class="w-1.5 h-1.5 rounded-full bg-purple-500" title="${actC} activity log event(s)"></span>` : ''}
        </div>
        <div class="flex flex-wrap gap-0.5 mt-1">${badges}</div>
      </button>
    `;
  }

  grid.innerHTML = html;
}

function renderExecCalendarDayBriefing() {
  const dateLabelEl = document.getElementById('exec-cal-selected-date-label');
  const pillsEl = document.getElementById('exec-cal-day-pills');
  const detailsEl = document.getElementById('exec-cal-day-details');
  if (!detailsEl) return;

  const dStr = execCalState.selectedDate;
  const dObj = new Date(dStr + 'T00:00:00');
  if (dateLabelEl) {
    dateLabelEl.textContent = dObj.toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  }

  const info = execCalState.days[dStr] || { done: [], started: [], planned: [], meetings: [], activities: [] };
  if (pillsEl) {
    pillsEl.innerHTML = `
      <span class="px-1.5 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300">✓ ${info.done.length} Done</span>
      <span class="px-1.5 py-0.5 rounded bg-blue-100 dark:bg-blue-950 text-blue-700 dark:text-blue-300">▶ ${info.started.length} Started</span>
      <span class="px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-700 dark:text-amber-300">📋 ${info.planned.length} Planned</span>
    `;
  }

  const f = execCalState.dayFilter || 'all';
  const sections = [];

  const renderTaskCard = (t, badgeHtml, borderCls) => `
    <div onclick="openDiscussionModal('task', ${t.id})"
      class="cursor-pointer p-2.5 rounded-lg bg-white dark:bg-slate-800 border ${borderCls} hover:shadow-xs transition">
      <div class="flex items-center justify-between gap-2">
        <span class="font-bold text-slate-900 dark:text-white truncate">${t.title}</span>
        ${badgeHtml}
      </div>
      <div class="text-[11px] text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-2">
        <span>${t.project_title || 'General'}</span>
        <span>•</span>
        <span>${t.assignees}</span>
        ${t.start_time && t.end_time ? `<span>• 🕒 ${formatTime12h(t.start_time)}–${formatTime12h(t.end_time)}</span>` : ''}
      </div>
    </div>
  `;

  if ((f === 'all' || f === 'done') && info.done.length > 0) {
    sections.push(`
      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">✓ Tasks Completed (${info.done.length})</div>
        ${info.done.map(t => renderTaskCard(t, `<span class="shrink-0 px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-bold">Done</span>`, 'border-emerald-200 dark:border-emerald-900')).join('')}
      </div>
    `);
  }

  if ((f === 'all' || f === 'started') && info.started.length > 0) {
    sections.push(`
      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-blue-700 dark:text-blue-400">▶ Started / In Progress (${info.started.length})</div>
        ${info.started.map(t => renderTaskCard(t, `<span class="shrink-0 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 border border-blue-200 text-[10px] font-bold">${t.status_title}</span>`, 'border-blue-200 dark:border-blue-900')).join('')}
      </div>
    `);
  }

  if ((f === 'all' || f === 'planned') && info.planned.length > 0) {
    sections.push(`
      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">📋 Planned / Scheduled (${info.planned.length})</div>
        ${info.planned.map(t => renderTaskCard(t, `<span class="shrink-0 px-1.5 py-0.5 rounded bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-bold">${t.status_title}</span>`, 'border-amber-200 dark:border-amber-900')).join('')}
      </div>
    `);
  }

  if ((f === 'all' || f === 'meetings') && info.meetings.length > 0) {
    sections.push(`
      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-teal-700 dark:text-teal-400">📅 Meetings Held / Scheduled (${info.meetings.length})</div>
        ${info.meetings.map(m => `
          <div onclick="openMeetingMomModal(${m.id})"
            class="cursor-pointer p-2.5 rounded-lg bg-white dark:bg-slate-800 border border-teal-200 dark:border-teal-900 hover:shadow-xs transition">
            <div class="flex items-center justify-between gap-2">
              <span class="font-bold text-slate-900 dark:text-white truncate">${m.title}</span>
              <span class="shrink-0 font-mono text-[10px] px-1.5 py-0.5 rounded bg-teal-50 text-teal-700 border border-teal-200 font-bold">${formatTime12h(m.start_time)}–${formatTime12h(m.end_time)}</span>
            </div>
            <div class="text-[11px] text-slate-500 mt-0.5">Participants: ${m.participants}</div>
          </div>
        `).join('')}
      </div>
    `);
  }

  if ((f === 'all' || f === 'activities') && info.activities.length > 0) {
    sections.push(`
      <div class="space-y-1.5">
        <div class="text-[10px] font-bold uppercase tracking-wider text-purple-700 dark:text-purple-400">⚡ Activity Log (${info.activities.length})</div>
        ${info.activities.map(a => `
          <div class="p-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-start justify-between gap-2">
            <span class="text-slate-700 dark:text-slate-200 leading-snug">${a.message}</span>
            <span class="shrink-0 font-mono text-[10px] text-slate-400">${a.time}</span>
          </div>
        `).join('')}
      </div>
    `);
  }

  if (sections.length === 0) {
    detailsEl.innerHTML = `
      <div class="text-center py-10 text-slate-400 space-y-2">
        <p>No tasks, meetings, or activity recorded for <strong>${dStr}</strong>.</p>
        <button type="button" onclick="openTaskModal()" class="px-3 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 font-semibold text-xs">
          + Plan a Task
        </button>
      </div>
    `;
  } else {
    detailsEl.innerHTML = sections.join('');
  }
}

function renderCharts(ov) {
  const textColor = state.theme === 'dark' ? '#cbd5e1' : '#475569';

  const pLabels = (ov.projectsByStatus || []).map(x => x.title);
  const pCounts = (ov.projectsByStatus || []).map(x => Number(x.count || 0));
  const pColors = (ov.projectsByStatus || []).map((x, i) => chartColor(x.color, i));

  if (state.charts.projectsStatus) state.charts.projectsStatus.destroy();
  state.charts.projectsStatus = new Chart(document.getElementById('chart-projects-status'), {
    type: 'doughnut',
    data: {
      labels: pLabels,
      datasets: [{ data: pCounts, backgroundColor: pColors, borderWidth: 1 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } }
      }
    }
  });

  const tLabels = (ov.tasksByStatus || []).map(x => x.title);
  const tCounts = (ov.tasksByStatus || []).map(x => Number(x.count || 0));
  const tColors = (ov.tasksByStatus || []).map((x, i) => chartColor(x.color, i));

  if (state.charts.tasksStatus) state.charts.tasksStatus.destroy();
  state.charts.tasksStatus = new Chart(document.getElementById('chart-tasks-status'), {
    type: 'doughnut',
    data: {
      labels: tLabels,
      datasets: [{ data: tCounts, backgroundColor: tColors, borderWidth: 1 }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      cutout: '65%',
      plugins: {
        legend: { position: 'right', labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } }
      }
    }
  });

  const members = (ov.teamWorkload || []).slice(0, 6);
  const mLabels = members.map(m => m.first_name);
  const mOpen = members.map(m => Number(m.open_tasks || 0));
  const mCompleted = members.map(m => Number(m.completed_tasks || 0));

  if (state.charts.teamWorkload) state.charts.teamWorkload.destroy();
  state.charts.teamWorkload = new Chart(document.getElementById('chart-team-workload'), {
    type: 'bar',
    data: {
      labels: mLabels,
      datasets: [
        { label: 'Pending', data: mOpen, backgroundColor: '#2563eb', borderRadius: 4 },
        { label: 'Covered', data: mCompleted, backgroundColor: '#10b981', borderRadius: 4 }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { ticks: { color: textColor, font: { size: 11 } }, grid: { display: false } },
        y: { ticks: { color: textColor, stepSize: 1, font: { size: 11 } }, grid: { color: 'rgba(148,163,184,0.15)' } }
      },
      plugins: {
        legend: { labels: { color: textColor, font: { size: 11 }, boxWidth: 12 } }
      }
    }
  });
}

// ============================================================================
// TAB 2: PROJECTS
// ============================================================================
function getFilteredProjects() {
  const search = (document.getElementById('filter-project-search')?.value || '').toLowerCase();
  const statusId = document.getElementById('filter-project-status')?.value || '';
  const priorityId = document.getElementById('filter-project-priority')?.value || '';
  const userId = document.getElementById('filter-project-user')?.value || '';

  return state.projects.filter(p => {
    if (statusId && String(p.status_id) !== String(statusId)) return false;
    if (priorityId && String(p.priority_id) !== String(priorityId)) return false;
    if (userId && !(p.user_ids || []).includes(Number(userId))) return false;
    if (search) {
      const hay = `${p.title} ${stripHtml(p.description)} ${p.workspace_title}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

window.setProjectViewMode = function(mode, rerender = true) {
  state.projectViewMode = mode;
  localStorage.setItem('ceo_proj_view', mode);

  ['table', 'cards', 'kanban'].forEach(m => {
    const viewEl = document.getElementById(`projects-view-${m}`);
    const btnEl = document.getElementById(`proj-view-btn-${m}`);
    if (m === mode) {
      viewEl?.classList.remove('hidden');
      if (btnEl) btnEl.className = 'px-2.5 py-1.5 bg-blue-600 text-white font-medium';
    } else {
      viewEl?.classList.add('hidden');
      if (btnEl) btnEl.className = 'px-2.5 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50';
    }
  });

  if (rerender) renderProjectsViews();
};

function getCardUrgencyStyle(dueDateVal, statusTitle, completionPct = 0) {
  const isDone = String(statusTitle || '').toLowerCase().includes('complete') || Number(completionPct) === 100;
  if (isDone || !dueDateVal) {
    return {
      cardCls: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700',
      badgeHtml: '',
      dueTextCls: 'text-slate-500 dark:text-slate-400'
    };
  }
  const dueStr = String(dueDateVal).substring(0, 10);
  const todayStr = localDateStr(new Date());
  if (dueStr < todayStr) {
    // OVERDUE -> Dark Red Highlight
    return {
      cardCls: 'bg-red-100/90 dark:bg-red-950/70 border-red-600 dark:border-red-600 border-l-4 border-l-red-700',
      badgeHtml: `<span class="px-1.5 py-0.5 rounded bg-red-700 text-white text-[9px] font-bold tracking-wide uppercase">Overdue</span>`,
      dueTextCls: 'text-red-800 dark:text-red-300 font-bold'
    };
  }
  if (dueStr === todayStr) {
    // DUE TODAY -> Light Red Highlight
    return {
      cardCls: 'bg-red-50/90 dark:bg-red-950/30 border-red-300 dark:border-red-800 border-l-4 border-l-red-400',
      badgeHtml: `<span class="px-1.5 py-0.5 rounded bg-red-100 dark:bg-red-900/60 text-red-700 dark:text-red-300 border border-red-300 dark:border-red-700 text-[9px] font-bold tracking-wide uppercase">Due Today</span>`,
      dueTextCls: 'text-red-600 dark:text-red-400 font-bold'
    };
  }
  return {
    cardCls: 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700',
    badgeHtml: '',
    dueTextCls: 'text-slate-500 dark:text-slate-400'
  };
}

function renderProjectsViews() {
  const filtered = getFilteredProjects();

  const tbody = document.getElementById('projects-table-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-slate-400">No matching projects found.</td></tr>`;
  } else {
    tbody.innerHTML = filtered.map(p => {
      const totalT = Number(p.tasks_count || 0);
      const compT = Number(p.completed_tasks_count || 0);
      const pct = totalT > 0 ? Math.round((compT / totalT) * 100) : 0;
      const desc = stripHtml(p.description);
      const teamPills = (p.users || []).map(u =>
        `<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">${u.first_name}</span>`
      ).join(' ');

      const statusOpts = state.meta.statuses.map(s =>
        `<option value="${s.id}" ${Number(s.id) === Number(p.status_id) ? 'selected' : ''}>${s.title}</option>`
      ).join('');

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
          <td class="py-3.5 px-4 max-w-xs">
            <div class="flex items-center gap-2">
              <button onclick="toggleProjectFavorite(${p.id})" class="${p.is_favorite ? 'text-amber-500' : 'text-slate-300 hover:text-amber-400'}" title="Pin / Favorite">
                ★
              </button>
              <button onclick="openProjectDetailModal(${p.id})" class="font-bold text-slate-900 dark:text-white hover:text-blue-600 text-left text-sm">
                ${p.title}
              </button>
            </div>
            ${desc ? `<p class="text-[11px] text-slate-500 line-clamp-1 mt-0.5 pl-5">${desc}</p>` : ''}
          </td>
          <td class="py-3.5 px-3">
            <span class="px-2 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
              ${p.workspace_title || `WS #${p.workspace_id}`}
            </span>
          </td>
          <td class="py-3.5 px-3">
            <select onchange="quickUpdateProjectStatus(${p.id}, this.value)"
              class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-xs font-medium">
              ${statusOpts}
            </select>
          </td>
          <td class="py-3.5 px-3">
            <span class="px-2 py-0.5 rounded text-[11px] font-medium border ${badgeClass(p.priority_color)}">
              ${p.priority_title || 'Normal'}
            </span>
          </td>
          <td class="py-3.5 px-3">
            <div class="flex flex-wrap gap-1">${teamPills || '<span class="text-slate-400">Unassigned</span>'}</div>
          </td>
          <td class="py-3.5 px-3 min-w-[125px]">
            <div class="flex items-center justify-between text-[11px] mb-1">
              <span class="text-slate-600 dark:text-slate-300">${compT}/${totalT} tasks</span>
              <span class="font-semibold">${pct}%</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div class="h-full bg-blue-600" style="width:${pct}%"></div>
            </div>
          </td>
          <td class="py-3.5 px-3 text-[11px] text-slate-500 font-mono">
            <div>Start: ${formatDate(p.start_date)}</div>
            <div>End: ${formatDate(p.end_date)}</div>
          </td>
          <td class="py-3.5 px-4 text-right whitespace-nowrap space-x-1">
            <button onclick="openProjectDetailModal(${p.id})" class="px-2.5 py-1 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 hover:bg-blue-100 border border-blue-200 dark:border-blue-800 text-[11px] font-semibold">
              View Project (${p.tasks_count || 0}T / ${p.comments_count || 0}💬)
            </button>
            <button onclick="openTaskModal(null, ${p.id})" class="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 hover:bg-slate-200 text-[11px] font-medium">
              + Task
            </button>
            <button onclick="openProjectModal(${p.id})" class="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
              Edit
            </button>
            <button onclick="duplicateProject(${p.id})" title="Duplicate Project" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 text-slate-600 text-[11px]">
              Copy
            </button>
            <button onclick="deleteProject(${p.id})" class="px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[11px]">
              Del
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  const cardsContainer = document.getElementById('projects-view-cards');
  cardsContainer.innerHTML = filtered.map(p => {
    const totalT = Number(p.tasks_count || 0);
    const compT = Number(p.completed_tasks_count || 0);
    const pct = totalT > 0 ? Math.round((compT / totalT) * 100) : 0;
    const desc = stripHtml(p.description);
    const urg = getCardUrgencyStyle(p.end_date, p.status_title, pct);
    const teamPills = (p.users || []).map(u =>
      `<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px]">${u.first_name}</span>`
    ).join(' ');

    return `
      <div class="p-5 rounded-xl border shadow-sm flex flex-col justify-between space-y-4 ${urg.cardCls}">
        <div>
          <div class="flex items-start justify-between gap-2 mb-2">
            <div class="flex items-center gap-1.5 flex-wrap">
              <span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-slate-100 dark:bg-slate-700 text-slate-600 dark:text-slate-300">${p.workspace_title || ''}</span>
              ${urg.badgeHtml}
            </div>
            <div class="flex items-center gap-1.5 shrink-0">
              <span class="px-2 py-0.5 rounded text-[10px] font-medium border ${badgeClass(p.status_color)}">${p.status_title || 'Status'}</span>
              <span class="px-2 py-0.5 rounded text-[10px] font-medium border ${badgeClass(p.priority_color)}">${p.priority_title || 'Normal'}</span>
            </div>
          </div>
          <button onclick="openProjectDetailModal(${p.id})" class="text-sm font-bold text-slate-900 dark:text-white hover:text-blue-600 text-left block">
            ${p.title}
          </button>
          ${desc ? `<p class="text-xs text-slate-500 line-clamp-2 mt-1">${desc}</p>` : ''}
        </div>

        <div class="space-y-3">
          <div>
            <div class="flex justify-between text-xs mb-1">
              <span class="text-slate-500">Tasks Covered: ${compT}/${totalT}</span>
              <span class="font-semibold">${pct}%</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div class="h-full bg-blue-600" style="width:${pct}%"></div>
            </div>
          </div>

          <div class="flex flex-wrap gap-1">${teamPills || '<span class="text-xs text-slate-400">No members assigned</span>'}</div>

          <div class="pt-3 border-t border-slate-200/70 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2 text-[11px]">
            <div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono">
              <span class="text-slate-500">Start: <strong class="text-slate-700 dark:text-slate-200">${formatDate(p.start_date)}</strong></span>
              <span class="${urg.dueTextCls}">End: <strong>${formatDate(p.end_date)}</strong></span>
            </div>
            <div class="space-x-1 shrink-0">
              <button onclick="openTaskModal(null, ${p.id})" class="px-2.5 py-1 rounded bg-blue-50 text-blue-700 font-medium">+ Task</button>
              <button onclick="openProjectModal(${p.id})" class="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 font-medium">Edit</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }).join('');

  const kanbanContainer = document.getElementById('projects-view-kanban');
  kanbanContainer.innerHTML = state.meta.statuses.map(st => {
    const colProjects = filtered.filter(p => Number(p.status_id) === Number(st.id));
    return `
      <div class="min-w-[275px] flex-1 max-w-[340px] shrink-0 bg-slate-100/80 dark:bg-slate-800/60 rounded-xl p-3.5 border border-slate-200 dark:border-slate-700">
        <div class="flex items-center justify-between mb-3 px-1">
          <span class="px-2.5 py-0.5 rounded text-xs font-semibold border ${badgeClass(st.color)}">${st.title}</span>
          <span class="text-xs font-bold text-slate-500">${colProjects.length}</span>
        </div>
        <div class="space-y-2.5">
          ${colProjects.map(p => {
            const totalT = Number(p.tasks_count || 0);
            const compT = Number(p.completed_tasks_count || 0);
            const pct = totalT > 0 ? Math.round((compT / totalT) * 100) : 0;
            const urg = getCardUrgencyStyle(p.end_date, p.status_title, pct);
            return `
              <div class="p-3.5 rounded-lg border shadow-xs space-y-2 ${urg.cardCls}">
                <div class="flex items-start justify-between gap-2">
                  <button onclick="openProjectDetailModal(${p.id})" class="font-semibold text-xs text-slate-900 dark:text-white hover:text-blue-600 text-left">
                    ${p.title}
                  </button>
                  <div class="flex items-center gap-1 shrink-0">
                    ${urg.badgeHtml}
                    <span class="px-1.5 py-0.5 rounded text-[10px] border ${badgeClass(p.priority_color)}">${p.priority_title || 'Normal'}</span>
                  </div>
                </div>
                <div class="flex items-center justify-between text-[10px] font-mono text-slate-500">
                  <span>Start: ${formatDate(p.start_date)}</span>
                  <span class="${urg.dueTextCls}">End: ${formatDate(p.end_date)}</span>
                </div>
                <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1 border-t border-slate-200/60 dark:border-slate-700">
                  <span>${compT}/${totalT} tasks (${pct}%)</span>
                  <button onclick="openProjectModal(${p.id})" class="text-blue-600 hover:underline">Edit</button>
                </div>
              </div>
            `;
          }).join('') || `<p class="text-xs text-slate-400 text-center py-4">No projects</p>`}
        </div>
      </div>
    `;
  }).join('');
}

window.quickUpdateProjectStatus = async function(projectId, newStatusId) {
  try {
    await apiFetch(`/api/projects/${projectId}`, {
      method: 'PUT',
      body: JSON.stringify({ status_id: Number(newStatusId) })
    });
    showToast(`Project #${projectId} status updated`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.toggleProjectFavorite = async function(projectId) {
  try {
    await apiFetch(`/api/projects/${projectId}/favorite`, { method: 'POST' });
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.duplicateProject = async function(projectId) {
  try {
    await apiFetch(`/api/projects/${projectId}/duplicate`, { method: 'POST', body: JSON.stringify({}) });
    showToast(`Project #${projectId} duplicated`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// TAB 3: TASKS & TIME SLOTS
// ============================================================================
function getFilteredTasks() {
  const search = (document.getElementById('filter-task-search')?.value || '').toLowerCase();
  const projectId = document.getElementById('filter-task-project')?.value || '';
  const statusId = document.getElementById('filter-task-status')?.value || '';
  const priorityId = document.getElementById('filter-task-priority')?.value || '';
  const userId = document.getElementById('filter-task-user')?.value || '';

  return state.tasks.filter(t => {
    if (projectId && String(t.project_id) !== String(projectId)) return false;
    if (statusId && String(t.status_id) !== String(statusId)) return false;
    if (priorityId && String(t.priority_id) !== String(priorityId)) return false;
    if (userId && !(t.user_ids || []).includes(Number(userId))) return false;
    if (search) {
      const hay = `${t.title} ${stripHtml(t.description)} ${t.project_title}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });
}

window.setTaskViewMode = function(mode, rerender = true) {
  state.taskViewMode = mode;
  localStorage.setItem('ceo_task_view', mode);

  ['table', 'kanban'].forEach(m => {
    const viewEl = document.getElementById(`tasks-view-${m}`);
    const btnEl = document.getElementById(`task-view-btn-${m}`);
    if (m === mode) {
      viewEl?.classList.remove('hidden');
      if (btnEl) btnEl.className = 'px-2.5 py-1.5 bg-blue-600 text-white font-medium';
    } else {
      viewEl?.classList.add('hidden');
      if (btnEl) btnEl.className = 'px-2.5 py-1.5 bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-200 hover:bg-slate-50';
    }
  });

  if (rerender) renderTasksViews();
};

function renderTasksViews() {
  const filtered = getFilteredTasks();

  const tbody = document.getElementById('tasks-table-tbody');
  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-8 text-center text-slate-400">No matching tasks found.</td></tr>`;
  } else {
    tbody.innerHTML = filtered.map(t => {
      const desc = stripHtml(t.description);
      const overdue = isDateOverdue(t.due_date, t.status_title, t.completion_percentage);
      const userPills = (t.users || []).map(u =>
        `<span class="px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">${u.first_name}</span>`
      ).join(' ');

      const statusOpts = state.meta.statuses.map(s =>
        `<option value="${s.id}" ${Number(s.id) === Number(t.status_id) ? 'selected' : ''}>${s.title}</option>`
      ).join('');

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
          <td class="py-3.5 px-4 max-w-xs">
            <div class="flex items-center gap-1.5">
              ${t.parent_id ? `<span class="px-1.5 py-0.2 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[10px] font-semibold">Subtask</span>` : ''}
              <button onclick="openDiscussionModal('task', ${t.id})" class="font-bold text-slate-900 dark:text-white hover:text-blue-600 text-left text-sm">
                ${t.title}
              </button>
            </div>
            ${t.parent_task_title ? `<div class="text-[10px] text-slate-400">Parent: ${t.parent_task_title}</div>` : ''}
            ${desc ? `<p class="text-[11px] text-slate-500 line-clamp-1 mt-0.5">${desc}</p>` : ''}
            <div class="flex items-center gap-2 mt-1 text-[10px] text-slate-500">
              ${Number(t.subtasks_count) > 0 ? `<span class="px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 font-semibold">📋 ${t.completed_subtasks_count || 0}/${t.subtasks_count} Subtasks</span>` : ''}
              ${Number(t.comments_count) > 0 ? `<span class="px-1.5 py-0.2 rounded bg-slate-100 dark:bg-slate-700 font-semibold">💬 ${t.comments_count}</span>` : ''}
            </div>
          </td>
          <td class="py-3.5 px-3">
            <button onclick="openProjectDetailModal(${t.project_id})" class="font-medium text-blue-600 dark:text-blue-400 hover:underline text-left">
              ${t.project_title || `Project #${t.project_id}`}
            </button>
          </td>
          <td class="py-3.5 px-3 whitespace-nowrap">
            ${formatTimeSlotBadge(t.start_time, t.end_time)}
            <div class="flex items-center gap-2 mt-1">
              ${t.is_recurring ? `<span class="text-[10px] font-semibold text-emerald-600">🔁 Repeats ${t.recurring_frequency}</span>` : ''}
              ${t.has_reminder ? `<span class="text-[10px] font-semibold text-amber-600">⏰ Reminder ${formatTime12h(t.reminder_time)}</span>` : ''}
            </div>
          </td>
          <td class="py-3.5 px-3">
            <select onchange="quickUpdateTaskStatus(${t.id}, this.value)"
              class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-xs font-medium">
              ${statusOpts}
            </select>
          </td>
          <td class="py-3.5 px-3">
            <span class="px-2 py-0.5 rounded text-[11px] font-medium border ${badgeClass(t.priority_color)}">
              ${t.priority_title || 'Normal'}
            </span>
          </td>
          <td class="py-3.5 px-3">
            <div class="flex flex-wrap gap-1">${userPills || '<span class="text-slate-400">Unassigned</span>'}</div>
          </td>
          <td class="py-3.5 px-3 font-mono text-[11px] ${overdue ? 'text-red-600 font-bold' : 'text-slate-500'}">
            ${formatDate(t.due_date)}
          </td>
          <td class="py-3.5 px-4 text-right whitespace-nowrap space-x-1">
            <button onclick="openDiscussionModal('task', ${t.id})"
              class="px-2.5 py-1 rounded bg-blue-50 dark:bg-blue-950/60 text-blue-700 dark:text-blue-300 hover:bg-blue-100 border border-blue-200 dark:border-blue-800 text-[11px] font-semibold">
              View Task (${t.subtasks_count || 0}Sub / ${t.comments_count || 0}💬)
            </button>
            <button onclick="openTaskModal(${t.id})"
              class="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
              Edit
            </button>
            <button onclick="deleteTask(${t.id})"
              class="px-2 py-1 rounded bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[11px]">
              Delete
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  const kanbanContainer = document.getElementById('tasks-view-kanban');
  kanbanContainer.innerHTML = state.meta.statuses.map(st => {
    const colTasks = filtered.filter(t => Number(t.status_id) === Number(st.id));
    return `
      <div class="min-w-[275px] flex-1 max-w-[340px] shrink-0 bg-slate-100/80 dark:bg-slate-800/60 rounded-xl p-3.5 border border-slate-200 dark:border-slate-700">
        <div class="flex items-center justify-between mb-3 px-1">
          <span class="px-2.5 py-0.5 rounded text-xs font-semibold border ${badgeClass(st.color)}">${st.title}</span>
          <span class="text-xs font-bold text-slate-500">${colTasks.length}</span>
        </div>
        <div class="space-y-2.5">
          ${colTasks.map(t => {
            const userNames = (t.users || []).map(u => u.first_name).join(', ');
            const urg = getCardUrgencyStyle(t.due_date, t.status_title, t.completion_percentage);
            return `
              <div class="p-3.5 rounded-lg border shadow-xs space-y-2 ${urg.cardCls}">
                <div class="flex items-start justify-between gap-2">
                  <button onclick="openDiscussionModal('task', ${t.id})" class="font-semibold text-xs text-slate-900 dark:text-white hover:text-blue-600 text-left">
                    ${t.title}
                  </button>
                  <div class="flex items-center gap-1 shrink-0">
                    ${urg.badgeHtml}
                    <span class="px-1.5 py-0.5 rounded text-[10px] border ${badgeClass(t.priority_color)}">${t.priority_title || 'Normal'}</span>
                  </div>
                </div>
                <div>${formatTimeSlotBadge(t.start_time, t.end_time)}</div>
                <div class="text-[11px] text-blue-600 dark:text-blue-400 font-medium">${t.project_title || ''}</div>
                <div class="flex flex-wrap items-center justify-between gap-1 text-[10px] font-mono pt-1 border-t border-slate-200/60 dark:border-slate-700">
                  <span class="text-slate-500 dark:text-slate-400">Start: <strong class="text-slate-700 dark:text-slate-200">${formatDate(t.start_date)}</strong></span>
                  <span class="${urg.dueTextCls}">End: <strong>${formatDate(t.due_date)}</strong></span>
                </div>
                <div class="flex items-center justify-between gap-2 text-[11px] text-slate-500">
                  <span class="truncate">${userNames || 'Unassigned'}</span>
                  <div class="flex items-center gap-1.5 shrink-0">
                    ${buildCompletionPercentSelect(t.id, Number(t.completion_percentage || (String(t.status_title || '').toLowerCase().includes('complete') ? 100 : 0)))}
                    <button onclick="openTaskModal(${t.id})" class="text-[10px] text-blue-600 hover:underline font-semibold">Edit</button>
                  </div>
                </div>
              </div>
            `;
          }).join('') || `<p class="text-xs text-slate-400 text-center py-4">No tasks</p>`}
        </div>
      </div>
    `;
  }).join('');
}

window.quickUpdateTaskStatus = async function(taskId, newStatusId) {
  try {
    const task = state.tasks.find(t => Number(t.id) === Number(taskId));
    const st = state.meta.statuses.find(s => Number(s.id) === Number(newStatusId));
    const isCompleted = st && st.title.toLowerCase().includes('complete');
    await apiFetch(`/api/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify({
        status_id: Number(newStatusId),
        completion_percentage: isCompleted ? 100 : (task?.completion_percentage || 0)
      })
    });
    showToast(`Task status updated to ${st ? st.title : 'new status'}`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.quickUpdateTaskCompletion = async function(taskId, newPct) {
  try {
    const pct = Math.max(0, Math.min(100, Number(newPct) || 0));
    const task = state.tasks.find(t => Number(t.id) === Number(taskId));
    const payload = { completion_percentage: pct };

    // Auto-sync status when 100% (Completed) or 10-90% from Planned (In Progress)
    if (pct === 100) {
      const compSt = state.meta.statuses.find(s => s.title.toLowerCase().includes('complete'));
      if (compSt) payload.status_id = Number(compSt.id);
    } else if (pct > 0 && task && String(task.status_title || '').toLowerCase().includes('plan')) {
      const progSt = state.meta.statuses.find(s => s.title.toLowerCase().includes('progress'));
      if (progSt) payload.status_id = Number(progSt.id);
    }

    await apiFetch(`/api/tasks/${taskId}`, {
      method: 'PUT',
      body: JSON.stringify(payload)
    });
    showToast(`Task progress updated to ${pct}%`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function buildCompletionPercentSelect(taskId, currentPct, onAfterJs = '') {
  const val = Number(currentPct || 0);
  const presets = [0, 10, 25, 50, 75, 90, 100];
  if (!presets.includes(val)) presets.push(val);
  presets.sort((a, b) => a - b);
  const opts = presets.map(v => `<option value="${v}" ${v === val ? 'selected' : ''}>${v}%</option>`).join('');
  const barColor = val === 100 ? 'bg-emerald-500' : (val >= 50 ? 'bg-blue-600' : 'bg-amber-500');
  return `
    <div class="flex items-center gap-1.5">
      <select onchange="quickUpdateTaskCompletion(${taskId}, this.value)${onAfterJs}"
        class="px-1.5 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[11px] font-bold ${val === 100 ? 'text-emerald-600' : 'text-blue-700 dark:text-blue-300'}">
        ${opts}
      </select>
      <div class="w-10 h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden hidden sm:block">
        <div class="h-full ${barColor}" style="width:${val}%"></div>
      </div>
    </div>
  `;
}

// ============================================================================
// TAB 4: MEETINGS, ATTENDANCE, MINUTES OF MEETING (MoM) & MONTHLY REPORT
// ============================================================================
let currentMomAttendanceMap = {};
let lastMonthlyReportData = null;

let currentMomGuestAttendanceMap = {};
let currentMomGuests = [];
let draftMeetingGuests = [];
let weeklyCalendarOffsetDays = 0;
state.meetingsTabMode = state.meetingsTabMode || 'calendar';

window.setMeetingsTabMode = function(mode) {
  state.meetingsTabMode = mode;
  const views = {
    calendar: ['meetings-subview-calendar', 'btn-meetings-view-calendar'],
    list: ['meetings-subview-list', 'btn-meetings-view-list'],
    report: ['meetings-subview-report', 'btn-meetings-view-report']
  };
  Object.entries(views).forEach(([key, [viewId, btnId]]) => {
    const v = document.getElementById(viewId);
    const b = document.getElementById(btnId);
    const active = key === mode;
    if (v) v.classList.toggle('hidden', !active);
    if (b) b.className = active
      ? 'px-3 py-1.5 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs whitespace-nowrap'
      : 'px-3 py-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900 whitespace-nowrap';
  });

  if (mode === 'report') {
    const monthInput = document.getElementById('mom-report-month');
    if (monthInput && !monthInput.value) monthInput.value = new Date().toISOString().substring(0, 7);
    loadMonthlyMeetingReport();
  } else if (mode === 'calendar') {
    renderWeeklyMeetingsCalendar();
  }
};

// ============================================================================
// WEEKLY MEETING CALENDAR (Whole week — upcoming meetings in grey)
// ============================================================================
function localDateStr(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

window.shiftWeeklyCalendar = function(days) {
  weeklyCalendarOffsetDays = days === 0 ? 0 : weeklyCalendarOffsetDays + days;
  renderWeeklyMeetingsCalendar();
};

function renderWeeklyMeetingsCalendar() {
  const grid = document.getElementById('weekly-meetings-calendar-grid');
  if (!grid) return;

  const today = new Date();
  const todayStr = localDateStr(today);
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const tomorrowStr = localDateStr(tomorrow);

  // Week starts Monday
  const base = new Date(today);
  base.setDate(base.getDate() + weeklyCalendarOffsetDays);
  const dow = (base.getDay() + 6) % 7;
  const monday = new Date(base); monday.setDate(base.getDate() - dow);

  const days = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday); d.setDate(monday.getDate() + i);
    days.push(d);
  }
  const fmt = d => d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const label = document.getElementById('weekly-calendar-range-label');
  if (label) label.textContent = `${fmt(days[0])} – ${fmt(days[6])} ${days[6].getFullYear()}`;

  grid.innerHTML = days.map(d => {
    const dStr = localDateStr(d);
    const isToday = dStr === todayStr;
    const isPast = dStr < todayStr;
    const dayMeetings = (state.meetings || [])
      .filter(m => String(m.start_date_time).substring(0, 10) === dStr)
      .sort((a, b) => String(a.start_date_time).localeCompare(String(b.start_date_time)));

    const cards = dayMeetings.map(m => {
      const st = formatTime12h(String(m.start_date_time).substring(11, 16));
      const en = formatTime12h(String(m.end_date_time).substring(11, 16));
      const hasMom = Boolean((m.mom_highlights || '').trim() || (m.mom_discussion || '').trim() && m.meeting_status === 'completed');
      const isCompleted = m.meeting_status === 'completed';
      const isPostponed = m.meeting_status === 'postponed' || Number(m.postponed_count) > 0;
      const isUpcoming = dStr > todayStr;

      let cls = 'bg-emerald-50 dark:bg-emerald-950/30 border-emerald-300 dark:border-emerald-800';
      let badge = '<span class="px-1.5 py-0.5 rounded bg-emerald-600 text-white text-[9px] font-bold">TODAY</span>';
      if (isCompleted) {
        cls = 'bg-blue-50 dark:bg-blue-950/30 border-blue-300 dark:border-blue-800';
        badge = '<span class="px-1.5 py-0.5 rounded bg-blue-600 text-white text-[9px] font-bold">✓ DONE</span>';
      } else if (isPostponed) {
        cls = 'bg-amber-50 dark:bg-amber-950/30 border-amber-300 dark:border-amber-800';
        badge = '<span class="px-1.5 py-0.5 rounded bg-amber-500 text-white text-[9px] font-bold">⏳ POSTPONED</span>';
      } else if (isUpcoming) {
        cls = 'bg-slate-100 dark:bg-slate-800/60 border-slate-300 dark:border-slate-600 opacity-80';
        badge = `<span class="px-1.5 py-0.5 rounded bg-slate-400 text-white text-[9px] font-bold">UPCOMING</span>`;
      } else if (isPast) {
        cls = 'bg-white dark:bg-slate-800 border-slate-200 dark:border-slate-700';
        badge = '<span class="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 text-[9px] font-bold">PENDING MoM</span>';
      }

      const reminderNote = (dStr === tomorrowStr && !isCompleted)
        ? `<div class="text-[10px] font-semibold ${m.day_before_reminder_sent ? 'text-emerald-600' : 'text-slate-500'}">${m.day_before_reminder_sent ? '✉ Reminder sent to team & guests' : '⏰ Reminder goes out today'}</div>`
        : (isUpcoming && !isCompleted ? `<div class="text-[10px] text-slate-500">⏰ Auto-reminder 1 day before</div>` : '');

      const att = m.attendance_summary || {};
      const attLine = (att.marked || att.guests_marked)
        ? `<div class="text-[10px] font-semibold text-slate-600 dark:text-slate-300">👥 ${(att.present || 0) + (att.late || 0)}/${att.total || 0} team${att.guests_total ? ` • 🎟️ ${att.guests_present || 0}/${att.guests_total} guests` : ''}</div>`
        : `<div class="text-[10px] text-slate-500">👥 ${(m.users || []).length} team${(m.guests || []).length ? ` • 🎟️ ${(m.guests || []).length} guests` : ''}</div>`;

      return `
        <div class="p-2.5 rounded-lg border ${cls} space-y-1">
          <div class="flex items-center justify-between gap-1">
            <span class="font-mono text-[11px] font-bold ${isUpcoming && !isPostponed ? 'text-slate-500' : 'text-slate-800 dark:text-slate-100'}">${st} – ${en}</span>
            ${badge}
          </div>
          <button onclick="openMeetingMomModal(${m.id})" class="block text-left text-xs font-bold leading-snug ${isUpcoming && !isPostponed ? 'text-slate-600 dark:text-slate-300' : 'text-slate-900 dark:text-white'} hover:text-emerald-600">
            ${m.title}
          </button>
          ${m.is_recurring ? `<div class="text-[10px] font-semibold text-emerald-700 dark:text-emerald-400">🔁 ${m.recurring_frequency}</div>` : ''}
          ${attLine}
          ${reminderNote}
          <div class="flex gap-1 pt-1">
            <button onclick="openMeetingMomModal(${m.id})" class="flex-1 px-2 py-1.5 rounded-md bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[10px] font-bold hover:border-emerald-500">📝 Attendance</button>
            ${!isCompleted ? `<button onclick="openPostponeMeetingModal(${m.id})" class="px-2 py-1.5 rounded-md bg-amber-50 dark:bg-amber-950/40 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 text-[10px] font-bold">⏳ Postpone</button>` : ''}
          </div>
        </div>
      `;
    }).join('');

    return `
      <div class="rounded-xl border ${isToday ? 'border-emerald-400 ring-2 ring-emerald-200 dark:ring-emerald-900' : 'border-slate-200 dark:border-slate-700'} bg-white dark:bg-slate-800 shadow-sm flex flex-col min-h-[140px]">
        <div class="px-3 py-2 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between ${isToday ? 'bg-emerald-50 dark:bg-emerald-950/30' : (isPast ? 'bg-slate-50 dark:bg-slate-900/40' : '')}">
          <div>
            <div class="text-[10px] font-bold uppercase tracking-wider ${isToday ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-500'}">${d.toLocaleDateString('en-GB', { weekday: 'long' })}</div>
            <div class="text-sm font-bold text-slate-900 dark:text-white">${fmt(d)}</div>
          </div>
          <span class="text-[10px] font-bold px-1.5 py-0.5 rounded ${dayMeetings.length ? 'bg-slate-900 dark:bg-emerald-600 text-white' : 'bg-slate-100 dark:bg-slate-700 text-slate-400'}">${dayMeetings.length}</span>
        </div>
        <div class="p-2 space-y-2 flex-1">
          ${cards || `<button onclick="openMeetingModalForDate('${dStr}')" class="w-full h-full min-h-[60px] rounded-lg border border-dashed border-slate-200 dark:border-slate-700 text-[11px] text-slate-400 hover:text-emerald-600 hover:border-emerald-400">+ Add</button>`}
        </div>
      </div>
    `;
  }).join('');
}

window.openMeetingModalForDate = function(dateStr) {
  openMeetingModal();
  document.getElementById('mt-date').value = dateStr;
  updateMeetingNextSlotPreview();
};

// ============================================================================
// POSTPONE / RESCHEDULE MEETING
// ============================================================================
window.openPostponeMeetingModal = function(meetingId) {
  const m = state.meetings.find(x => Number(x.id) === Number(meetingId));
  if (!m) return;
  document.getElementById('meeting-postpone-modal').classList.remove('hidden');
  document.getElementById('postpone-meeting-id').value = m.id;
  const d = String(m.start_date_time).substring(0, 10);
  const st = String(m.start_date_time).substring(11, 16);
  const en = String(m.end_date_time).substring(11, 16);
  document.getElementById('postpone-meeting-subtitle').textContent =
    `${m.title} • currently ${d} (${formatTime12h(st)} – ${formatTime12h(en)})`;
  document.getElementById('postpone-new-date').value = d;
  document.getElementById('postpone-new-start').value = st;
  document.getElementById('postpone-new-end').value = en;
  document.getElementById('postpone-reason').value = '';
  document.getElementById('postpone-send-email').checked = true;
  document.getElementById('postpone-new-date').dataset.origDate = d;
  document.getElementById('postpone-new-start').dataset.orig = st;
  document.getElementById('postpone-new-end').dataset.orig = en;
};

window.openPostponeModalFromMom = function() {
  const id = Number(document.getElementById('mom-meeting-id').value);
  closeMeetingMomModal();
  openPostponeMeetingModal(id);
};

window.applyPostponeOffset = function(addDays, addHours) {
  const dEl = document.getElementById('postpone-new-date');
  const sEl = document.getElementById('postpone-new-start');
  const eEl = document.getElementById('postpone-new-end');
  const origDate = dEl.dataset.origDate || dEl.value;
  const shift = (timeStr) => {
    const [h, mi] = String(timeStr || '10:00').split(':').map(Number);
    const nh = Math.min(23, h + addHours);
    return `${String(nh).padStart(2, '0')}:${String(mi || 0).padStart(2, '0')}`;
  };
  const base = new Date(origDate + 'T00:00:00');
  base.setDate(base.getDate() + addDays);
  dEl.value = localDateStr(base);
  sEl.value = shift(sEl.dataset.orig || sEl.value);
  eEl.value = shift(eEl.dataset.orig || eEl.value);
};

window.closePostponeMeetingModal = function() {
  document.getElementById('meeting-postpone-modal').classList.add('hidden');
};

// ============================================================================
// GUESTS (Schedule modal draft list + MoM guest roll-call)
// ============================================================================
function renderMeetingClientCheckboxes() {
  const box = document.getElementById('mt-clients-checkboxes');
  if (!box) return;
  const clients = state.meta.clients || [];
  box.innerHTML = clients.length
    ? clients.map(c => `
        <label class="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 cursor-pointer text-[11px]">
          <input type="checkbox" name="mt_client_ids" value="${c.id}" class="rounded text-emerald-600" />
          <span class="font-semibold">${c.first_name} ${c.last_name || ''}</span>
          ${c.company ? `<span class="text-slate-400">(${c.company})</span>` : ''}
        </label>
      `).join('')
    : '';
}

function renderDraftGuestPills() {
  const box = document.getElementById('mt-draft-guests-pills');
  if (!box) return;
  box.innerHTML = draftMeetingGuests.map((g, i) => `
    <span class="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 text-[11px] font-semibold">
      🎟️ ${g.name}${g.email ? ` <span class="font-normal opacity-75">&lt;${g.email}&gt;</span>` : ''}
      <button type="button" onclick="removeDraftMeetingGuest(${i})" class="ml-0.5 hover:text-red-600">✕</button>
    </span>
  `).join('');
}

window.addDraftMeetingGuest = function() {
  const nEl = document.getElementById('mt-guest-name-input');
  const eEl = document.getElementById('mt-guest-email-input');
  const name = nEl.value.trim();
  const email = eEl.value.trim();
  if (!name && !email) return showToast('Enter guest name or email', 'error');
  draftMeetingGuests.push({ id: `guest_${Date.now()}_${draftMeetingGuests.length}`, name: name || email, email, type: 'external' });
  nEl.value = ''; eEl.value = '';
  renderDraftGuestPills();
};

window.removeDraftMeetingGuest = function(i) {
  draftMeetingGuests.splice(i, 1);
  renderDraftGuestPills();
};

window.updateMeetingNextSlotPreview = function() {
  const box = document.getElementById('mt-next-slot-preview-box');
  const txt = document.getElementById('mt-next-slot-preview-text');
  if (!box || !txt) return;
  const freq = document.getElementById('mt-recurring-freq').value;
  const dateVal = document.getElementById('mt-date').value;
  if (freq === 'none' || !dateVal) { box.classList.add('hidden'); return; }
  const st = document.getElementById('mt-start-time').value;
  const en = document.getElementById('mt-end-time').value;
  const d = new Date(dateVal + 'T00:00:00');
  const slots = [];
  for (let i = 0; i < 3; i++) {
    if (freq === 'daily') d.setDate(d.getDate() + 1);
    else if (freq === 'weekly') d.setDate(d.getDate() + 7);
    else if (freq === 'monthly') d.setMonth(d.getMonth() + 1);
    slots.push(d.toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' }));
  }
  txt.textContent = `${slots.join(' • ')}  (${formatTime12h(st)} – ${formatTime12h(en)})`;
  box.classList.remove('hidden');
};

function renderMomGuestRollCall() {
  const container = document.getElementById('mom-guest-attendance-list');
  if (!container) return;
  if (!currentMomGuests.length) {
    container.innerHTML = `<p class="md:col-span-2 text-[11px] text-slate-400 py-2 text-center">No guests invited to this meeting. Add a walk-in guest above if needed.</p>`;
    return;
  }
  const statuses = [
    { key: 'present', label: '✓ Present', activeCls: 'bg-emerald-600 text-white border-emerald-600' },
    { key: 'late', label: '🕒 Late', activeCls: 'bg-amber-500 text-white border-amber-500' },
    { key: 'absent', label: '✕ Absent', activeCls: 'bg-red-600 text-white border-red-600' }
  ];
  container.innerHTML = currentMomGuests.map(g => {
    const cur = currentMomGuestAttendanceMap[g.id]?.status || 'pending';
    const btns = statuses.map(st => `
      <button type="button" onclick="setGuestMeetingAttendance('${g.id}', '${st.key}')"
        class="px-2 py-1.5 rounded-md text-[11px] font-bold border transition ${cur === st.key ? st.activeCls : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700'}">
        ${st.label}
      </button>`).join('');
    return `
      <div class="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-emerald-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 min-w-0">
          <span class="w-7 h-7 shrink-0 rounded-full bg-emerald-100 dark:bg-emerald-950 text-emerald-700 dark:text-emerald-300 flex items-center justify-center text-xs">🎟️</span>
          <div class="min-w-0">
            <div class="font-bold text-slate-900 dark:text-white leading-tight truncate">${g.name}</div>
            <div class="text-[10px] text-slate-400 truncate">${g.email || (g.type === 'client' ? 'Client' : 'External Guest')}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">${btns}</div>
      </div>`;
  }).join('');
}

window.setGuestMeetingAttendance = function(guestId, statusKey) {
  currentMomGuestAttendanceMap[guestId] = { status: statusKey, note: '' };
  renderMomGuestRollCall();
};

window.addGuestInsideMomModal = function() {
  const nEl = document.getElementById('mom-new-guest-name');
  const eEl = document.getElementById('mom-new-guest-email');
  const name = nEl.value.trim();
  const email = eEl.value.trim();
  if (!name && !email) return showToast('Enter guest name', 'error');
  const g = { id: `guest_${Date.now()}`, name: name || email, email, type: 'external' };
  currentMomGuests.push(g);
  currentMomGuestAttendanceMap[g.id] = { status: 'present', note: '' };
  nEl.value = ''; eEl.value = '';
  renderMomGuestRollCall();
};

function renderMeetingsTable() {
  // 1. Render Active Recurring Meeting Schedules Banner
  const rulesBox = document.getElementById('meetings-recurring-rules-box');
  const rulesList = document.getElementById('meetings-recurring-rules-list');
  const activeRules = (state.meetingRecurringRules || []).filter(r => r.is_active);
  if (rulesBox && rulesList) {
    if (activeRules.length === 0) {
      rulesBox.classList.add('hidden');
    } else {
      rulesBox.classList.remove('hidden');
      rulesList.innerHTML = activeRules.map(r => {
        const memberNames = (r.user_ids || []).map(uid => {
          const u = state.meta.users.find(x => Number(x.id) === Number(uid));
          return u ? u.first_name : '';
        }).filter(Boolean).join(', ');
        const scopeLabel = r.scope === 'individual' ? '👤 1-on-1' : '👥 Team';
        return `
          <div class="p-3 rounded-lg bg-white dark:bg-slate-900 border border-emerald-200 dark:border-slate-700 flex items-center justify-between gap-2">
            <div>
              <div class="flex items-center gap-1.5">
                <span class="px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-950 text-emerald-800 dark:text-emerald-300 font-bold text-[10px]">
                  🔁 ${String(r.frequency).toUpperCase()} • ${scopeLabel}
                </span>
                <span class="text-[11px] font-mono text-slate-500">${formatTime12h(r.start_time)} – ${formatTime12h(r.end_time)}</span>
              </div>
              <div class="font-bold text-slate-900 dark:text-white mt-1">${r.title}</div>
              <div class="text-[11px] text-slate-500">Attendees: ${memberNames || 'Team'}${(r.guests || []).length ? ` • 🎟️ ${(r.guests || []).length} guest(s)` : ''}</div>
              ${r.next_slot_date ? `
                <div class="mt-1.5 inline-flex items-center gap-1.5 px-2 py-1 rounded-md bg-slate-100 dark:bg-slate-800 border border-slate-300 dark:border-slate-600">
                  <span class="text-[10px] font-bold text-slate-500 uppercase">Next Slot</span>
                  <span class="text-[11px] font-bold text-slate-800 dark:text-slate-100">${new Date(r.next_slot_date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short' })} • ${formatTime12h(r.start_time)} – ${formatTime12h(r.end_time)}</span>
                </div>` : ''}
            </div>
            ${state.user?.isStrictAdmin ? `<button onclick="stopRecurringMeetingRule('${r.id}')" class="px-2.5 py-1 rounded bg-red-50 text-red-600 hover:bg-red-100 border border-red-200 text-[11px] font-semibold shrink-0">Stop Rule</button>` : ''}
          </div>
        `;
      }).join('');
    }
  }

  // 2. Render Weekly Calendar + Meetings Table
  renderWeeklyMeetingsCalendar();
  const tbody = document.getElementById('meetings-table-tbody');
  if (!state.meetings || state.meetings.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">No meetings scheduled yet. Click "+ Schedule Meeting / 1-on-1" to add one.</td></tr>`;
    return;
  }

  tbody.innerHTML = state.meetings.map(m => {
    const datePart = String(m.start_date_time).substring(0, 10);
    const startPart = formatTime12h(String(m.start_date_time).substring(11, 16));
    const endPart = formatTime12h(String(m.end_date_time).substring(11, 16));
    const isToday = Number(m.is_today) === 1;
    const isIndividual = m.scope === 'individual' || (m.users || []).length <= 2;

    const participantBadges = (m.users || []).map(u => {
      const attStatus = m.attendance?.[u.id]?.status || 'pending';
      let dotColor = 'bg-slate-300';
      if (attStatus === 'present') dotColor = 'bg-emerald-500';
      else if (attStatus === 'late') dotColor = 'bg-amber-500';
      else if (attStatus === 'absent') dotColor = 'bg-red-500';
      else if (attStatus === 'excused') dotColor = 'bg-blue-500';

      return `
        <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-slate-100 dark:bg-slate-700 text-slate-700 dark:text-slate-200 text-[11px] font-medium">
          <span class="w-1.5 h-1.5 rounded-full ${dotColor}"></span>
          <span>${u.first_name}</span>
        </span>
      `;
    }).join(' ');

    const attSum = m.attendance_summary || { total: (m.users || []).length, present: 0, late: 0, marked: 0 };
    const attendedCount = (attSum.present || 0) + (attSum.late || 0);
    const hasMom = Boolean((m.mom_highlights && m.mom_highlights.trim()) || (m.mom_discussion && m.mom_discussion.trim()) || (m.mom_decisions && m.mom_decisions.trim()));

    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
        <td class="py-3.5 px-4">
          <button onclick="openMeetingMomModal(${m.id})" class="font-bold text-slate-900 dark:text-white hover:text-emerald-600 text-sm text-left block">
            ${m.title}
          </button>
          <div class="text-[11px] text-slate-500 flex items-center gap-2 mt-0.5">
            <span>${m.workspace_title || 'Workspace'}</span>
            ${isToday ? `<span class="px-1.5 py-0.2 rounded bg-emerald-600 text-white text-[10px] font-bold">TODAY</span>` : ''}
          </div>
        </td>
        <td class="py-3.5 px-3">
          <div class="flex flex-col gap-1 items-start">
            <span class="px-2 py-0.5 rounded text-[10px] font-bold border ${isIndividual ? 'bg-purple-50 text-purple-700 border-purple-200 dark:bg-purple-950/50 dark:text-purple-300' : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300'}">
              ${isIndividual ? '👤 Individual 1-on-1' : '👥 Team Meeting'}
            </span>
            ${m.is_recurring ? `<span class="text-[10px] font-bold text-emerald-600">🔁 Repeats ${m.recurring_frequency}</span>` : `<span class="text-[10px] text-slate-400">One-Time</span>`}
          </div>
        </td>
        <td class="py-3.5 px-3 font-mono text-xs">
          <div class="font-semibold text-slate-800 dark:text-slate-200">${datePart}</div>
          <span class="inline-block mt-0.5 px-2 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-800 text-[11px]">${startPart} – ${endPart}</span>
        </td>
        <td class="py-3.5 px-3">
          <div class="flex flex-wrap gap-1">${participantBadges || '<span class="text-slate-400">No participants</span>'}</div>
        </td>
        <td class="py-3.5 px-3">
          ${attSum.marked > 0
            ? `<button onclick="openMeetingMomModal(${m.id})" class="px-2.5 py-1 rounded-lg bg-emerald-50 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-300 border border-emerald-200 font-bold text-[11px]">
                 ✓ ${attendedCount} / ${attSum.total} Attended
               </button>`
            : `<button onclick="openMeetingMomModal(${m.id})" class="px-2.5 py-1 rounded-lg bg-amber-50 dark:bg-amber-950/50 text-amber-700 dark:text-amber-300 border border-amber-200 font-semibold text-[11px] hover:bg-amber-100">
                 ⏳ Mark Attendance (${attSum.total})
               </button>`}
        </td>
        <td class="py-3.5 px-3 max-w-xs">
          ${hasMom
            ? `<div onclick="openMeetingMomModal(${m.id})" class="cursor-pointer p-2 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 hover:border-blue-400">
                 <div class="text-[10px] font-bold text-emerald-600 uppercase mb-0.5">✓ MoM Recorded</div>
                 <p class="text-[11px] text-slate-700 dark:text-slate-300 truncate">${m.mom_highlights || m.mom_discussion || m.mom_decisions}</p>
               </div>`
            : `<button onclick="openMeetingMomModal(${m.id})" class="text-blue-600 hover:underline font-semibold text-xs">
                 + Record Minutes (MoM)
               </button>`}
        </td>
        <td class="py-3.5 px-4 text-right space-x-1 whitespace-nowrap">
          <button onclick="openMeetingMomModal(${m.id})" class="px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold text-xs shadow-xs">
            📝 Attendance & MoM
          </button>
          ${m.meeting_status !== 'completed' ? `<button onclick="openPostponeMeetingModal(${m.id})" class="px-2.5 py-1.5 rounded-lg bg-amber-50 text-amber-700 border border-amber-200 text-xs font-semibold">⏳ Postpone</button>` : ''}
          <button onclick="deleteMeeting(${m.id})" class="px-2.5 py-1.5 rounded-lg bg-red-50 text-red-600 border border-red-200 text-xs">
            Del
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

window.openMeetingModal = function(preselectedScope = 'team') {
  document.getElementById('meeting-modal').classList.remove('hidden');
  document.getElementById('mt-title').value = '';
  document.getElementById('mt-agenda-notes').value = '';
  document.getElementById('mt-date').value = new Date().toISOString().substring(0, 10);
  document.getElementById('mt-start-time').value = '10:00';
  document.getElementById('mt-end-time').value = '11:00';
  document.getElementById('mt-send-email').checked = true;

  document.getElementById('mt-workspace').innerHTML = state.meta.workspaces.map(w =>
    `<option value="${w.id}">${w.title}</option>`
  ).join('');
  if (state.selectedWorkspace !== 'all') {
    document.getElementById('mt-workspace').value = state.selectedWorkspace;
  }

  setMeetingRecurrence('none');
  setMeetingScope(preselectedScope);
  draftMeetingGuests = [];
  renderDraftGuestPills();
  renderMeetingClientCheckboxes();
  updateMeetingNextSlotPreview();
};

window.setMeetingScope = function(scope) {
  document.getElementById('mt-scope').value = scope;
  const teamBtn = document.getElementById('pill-mt-scope-team');
  const indBtn = document.getElementById('pill-mt-scope-individual');
  const label = document.getElementById('mt-attendees-label');

  if (scope === 'individual') {
    indBtn.className = 'px-3 py-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 bg-purple-600 text-white border-purple-600 shadow-xs transition';
    teamBtn.className = 'px-3 py-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400 transition';
    if (label) label.textContent = 'Select Individual Team Member for 1-on-1 Session';
    const firstOtherUser = state.meta.users.find(u => Number(u.id) !== Number(state.user?.id)) || state.meta.users[0];
    renderAvatarChipCheckboxes('mt-users-checkboxes', 'mt_user_ids', firstOtherUser ? [Number(firstOtherUser.id)] : []);
  } else {
    teamBtn.className = 'px-3 py-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 bg-emerald-600 text-white border-emerald-600 shadow-xs transition';
    indBtn.className = 'px-3 py-2 rounded-xl border text-xs font-bold flex items-center justify-center gap-1.5 bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400 transition';
    if (label) label.textContent = 'Invite Team Members (Tap to Select / Deselect)';
    renderAvatarChipCheckboxes('mt-users-checkboxes', 'mt_user_ids', state.meta.users.map(u => Number(u.id)));
  }
};

window.setMeetingRecurrence = function(freq) {
  document.getElementById('mt-recurring-freq').value = freq;
  document.querySelectorAll('.mt-rec-pill').forEach(btn => {
    const active = btn.dataset.freq === freq;
    btn.className = `mt-rec-pill px-2.5 py-2 rounded-lg border text-[11px] transition ${
      active
        ? 'font-bold bg-slate-900 dark:bg-emerald-600 text-white border-slate-900 dark:border-emerald-600 shadow-xs'
        : 'font-semibold bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-emerald-400'
    }`;
  });
  if (typeof updateMeetingNextSlotPreview === 'function') updateMeetingNextSlotPreview();
};

window.selectAllMeetingUsers = function(selectAll = true) {
  renderAvatarChipCheckboxes('mt-users-checkboxes', 'mt_user_ids', selectAll ? state.meta.users.map(u => Number(u.id)) : []);
};

window.setMeetingTimePreset = function(startTime, endTime) {
  document.getElementById('mt-start-time').value = startTime;
  document.getElementById('mt-end-time').value = endTime;
  updateMeetingNextSlotPreview();
};

window.closeMeetingModal = function() {
  document.getElementById('meeting-modal').classList.add('hidden');
};

window.stopRecurringMeetingRule = async function(ruleId) {
  if (!confirm('Stop this auto-recurring meeting schedule? Existing scheduled meetings will remain.')) return;
  try {
    await apiFetch(`/api/meetings/recurring/${ruleId}`, { method: 'DELETE' });
    showToast('Recurring meeting rule stopped');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// MEETING ATTENDANCE ROLL-CALL & MINUTES OF MEETING (MoM) MODAL
// ============================================================================
window.openMeetingMomModal = function(meetingId) {
  const m = state.meetings.find(x => Number(x.id) === Number(meetingId));
  if (!m) {
    showToast('Loading meeting details...');
    switchTab('meetings');
    return;
  }

  document.getElementById('meeting-mom-modal').classList.remove('hidden');
  document.getElementById('mom-meeting-id').value = m.id;
  document.getElementById('mom-modal-title').textContent = `${m.title} (#${m.id})`;

  const datePart = String(m.start_date_time).substring(0, 10);
  const startPart = formatTime12h(String(m.start_date_time).substring(11, 16));
  const endPart = formatTime12h(String(m.end_date_time).substring(11, 16));
  document.getElementById('mom-modal-date-badge').textContent = `${datePart} • ${startPart} – ${endPart}`;

  const isInd = m.scope === 'individual' || (m.users || []).length <= 2;
  const scopeBadge = document.getElementById('mom-modal-scope-badge');
  scopeBadge.textContent = isInd ? '👤 INDIVIDUAL 1-ON-1' : '👥 TEAM MEETING';
  scopeBadge.className = `px-2 py-0.5 rounded text-[10px] font-bold uppercase border ${
    isInd ? 'bg-purple-50 text-purple-700 border-purple-200' : 'bg-emerald-50 text-emerald-700 border-emerald-200'
  }`;

  document.getElementById('mom-meeting-status').value = m.meeting_status === 'completed' ? 'completed' : 'completed';
  document.getElementById('mom-highlights').value = m.mom_highlights || '';
  document.getElementById('mom-discussion').value = m.mom_discussion || '';
  document.getElementById('mom-decisions').value = m.mom_decisions || '';
  document.getElementById('mom-action-task-title').value = '';

  // Populate optional action-task dropdowns
  document.getElementById('mom-action-task-project').innerHTML =
    `<option value="">Select Project...</option>` +
    state.projects.map(p => `<option value="${p.id}">${p.title}</option>`).join('');
  document.getElementById('mom-action-task-user').innerHTML =
    `<option value="">Assign To...</option>` +
    state.meta.users.map(u => `<option value="${u.id}">${u.first_name} ${u.last_name}</option>`).join('');

  // Initialize Attendance Map for invited participants
  currentMomAttendanceMap = {};
  const invitedUsers = m.users && m.users.length > 0 ? m.users : state.meta.users;
  invitedUsers.forEach(u => {
    const prev = m.attendance?.[u.id];
    currentMomAttendanceMap[u.id] = {
      status: prev?.status || 'present',
      note: prev?.note || ''
    };
  });

  renderMomAttendanceRollCall(invitedUsers);

  // Guests roll-call
  currentMomGuests = JSON.parse(JSON.stringify(m.guests || []));
  currentMomGuestAttendanceMap = {};
  currentMomGuests.forEach(g => {
    currentMomGuestAttendanceMap[g.id] = { status: m.guest_attendance?.[g.id]?.status || 'pending', note: '' };
  });
  renderMomGuestRollCall();
};

function renderMomAttendanceRollCall(usersList) {
  const container = document.getElementById('mom-attendance-list');
  if (!container) return;
  const statuses = [
    { key: 'present', label: '✓ Present', activeCls: 'bg-emerald-600 text-white border-emerald-600' },
    { key: 'late', label: '🕒 Late', activeCls: 'bg-amber-500 text-white border-amber-500' },
    { key: 'excused', label: 'ℹ Excused', activeCls: 'bg-blue-600 text-white border-blue-600' },
    { key: 'absent', label: '✕ Absent', activeCls: 'bg-red-600 text-white border-red-600' }
  ];

  container.innerHTML = usersList.map(u => {
    const cur = currentMomAttendanceMap[u.id]?.status || 'present';
    const initials = ((u.first_name?.[0] || '') + (u.last_name?.[0] || '')).toUpperCase();
    const btns = statuses.map(st => {
      const isAct = cur === st.key;
      return `
        <button type="button" onclick="setMemberMeetingAttendance(${u.id}, '${st.key}')"
          class="px-2 py-1 rounded-md text-[11px] font-bold border transition ${
            isAct
              ? st.activeCls
              : 'bg-slate-50 dark:bg-slate-900 text-slate-600 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-slate-400'
          }">
          ${st.label}
        </button>
      `;
    }).join('');

    return `
      <div class="p-2.5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2">
          <span class="w-7 h-7 rounded-full bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 font-bold text-[11px] flex items-center justify-center border border-blue-200 dark:border-blue-800">
            ${initials}
          </span>
          <div>
            <div class="font-bold text-slate-900 dark:text-white leading-tight">${u.first_name} ${u.last_name || ''}</div>
            <div class="text-[10px] text-slate-400">${u.email || ''}</div>
          </div>
        </div>
        <div class="flex items-center gap-1">${btns}</div>
      </div>
    `;
  }).join('');
}

window.setMemberMeetingAttendance = function(userId, statusKey) {
  const uid = Number(userId);
  currentMomAttendanceMap[uid] = { status: statusKey, note: '' };
  const mId = Number(document.getElementById('mom-meeting-id').value);
  const m = state.meetings.find(x => Number(x.id) === mId);
  const invitedUsers = m && m.users && m.users.length > 0 ? m.users : state.meta.users;
  renderMomAttendanceRollCall(invitedUsers);
};

window.markAllMeetingAttendance = function(statusKey = 'present') {
  Object.keys(currentMomAttendanceMap).forEach(uid => {
    currentMomAttendanceMap[uid].status = statusKey;
  });
  Object.keys(currentMomGuestAttendanceMap).forEach(gid => {
    currentMomGuestAttendanceMap[gid].status = statusKey;
  });
  const mId = Number(document.getElementById('mom-meeting-id').value);
  const m = state.meetings.find(x => Number(x.id) === mId);
  const invitedUsers = m && m.users && m.users.length > 0 ? m.users : state.meta.users;
  renderMomAttendanceRollCall(invitedUsers);
  renderMomGuestRollCall();
};

window.closeMeetingMomModal = function() {
  document.getElementById('meeting-mom-modal').classList.add('hidden');
};

// ============================================================================
// END-OF-MONTH EXECUTIVE MEETINGS, ATTENDANCE & MoM REPORT
// ============================================================================
window.loadMonthlyMeetingReport = async function() {
  try {
    const monthInput = document.getElementById('mom-report-month');
    const month = (monthInput && monthInput.value) ? monthInput.value : new Date().toISOString().substring(0, 7);
    const res = await apiFetch(`/api/meetings/monthly-report?month=${month}&workspace_id=${state.selectedWorkspace}`);
    lastMonthlyReportData = res;

    const k = res.kpis || {};
    document.getElementById('rep-kpi-total').textContent = k.totalSessions || 0;
    document.getElementById('rep-kpi-split').textContent = `${k.teamMeetingsCount || 0} Team • ${k.individualMeetingsCount || 0} Individual`;
    document.getElementById('rep-kpi-mom').textContent = k.completedWithMom || 0;
    document.getElementById('rep-kpi-attendance').textContent = `${k.overallAttendanceRate || 0}%`;
    document.getElementById('rep-kpi-recurring').textContent = k.activeRecurringRules || 0;

    const digest = res.momDigest || [];
    const highlightsItems = digest.filter(d => d.mom_highlights && d.mom_highlights.trim());
    document.getElementById('rep-kpi-highlights').textContent = highlightsItems.length;

    // 1. Render Attendance Scorecard
    const scTbody = document.getElementById('rep-attendance-scorecard-tbody');
    const scList = res.memberAttendanceScorecard || [];
    if (scList.length === 0) {
      scTbody.innerHTML = `<tr><td colspan="5" class="py-6 text-center text-slate-400">No attendance data for ${month}.</td></tr>`;
    } else {
      scTbody.innerHTML = scList.map(u => {
        const rateColor = u.attendance_rate >= 85 ? 'text-emerald-600' : (u.attendance_rate >= 60 ? 'text-amber-600' : 'text-red-600');
        return `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40">
            <td class="py-2.5 px-3 font-bold text-slate-900 dark:text-white">${u.name}</td>
            <td class="py-2.5 px-2 text-center font-semibold">${u.invited}</td>
            <td class="py-2.5 px-2 text-center font-bold text-emerald-600">${u.present + u.late}</td>
            <td class="py-2.5 px-2 text-center font-bold text-red-600">${u.absent}</td>
            <td class="py-2.5 px-3 text-right font-bold ${rateColor}">${u.attendance_rate}%</td>
          </tr>
        `;
      }).join('');
    }

    // 2. Render Monthly Team Highlights & Escalations for Higher Management
    const hlBox = document.getElementById('rep-highlights-digest');
    if (highlightsItems.length === 0) {
      hlBox.innerHTML = `
        <div class="text-center py-8 text-slate-400">
          No team highlights recorded for ${month} yet. Click <strong>"📝 Attendance & MoM"</strong> on any meeting to record key highlights raised by the team.
        </div>
      `;
    } else {
      hlBox.innerHTML = highlightsItems.map(item => `
        <div class="p-3.5 rounded-xl bg-amber-50/60 dark:bg-slate-900 border border-amber-200 dark:border-slate-700">
          <div class="flex flex-wrap items-center justify-between gap-2 mb-1.5">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 font-bold text-[10px]">
                ${item.date} • ${item.scope === 'individual' ? '👤 1-on-1' : '👥 Team'}
              </span>
              <strong class="text-slate-900 dark:text-white text-xs">${item.title}</strong>
            </div>
            <button onclick="openMeetingMomModal(${item.id})" class="text-[11px] text-blue-600 hover:underline font-semibold">Edit MoM</button>
          </div>
          <p class="text-slate-800 dark:text-slate-200 whitespace-pre-line leading-relaxed font-medium">${item.mom_highlights}</p>
          ${item.mom_decisions ? `<div class="mt-2 pt-2 border-t border-amber-200/60 dark:border-slate-700 text-[11px] text-emerald-700 dark:text-emerald-400"><strong>Decision / Action:</strong> ${item.mom_decisions}</div>` : ''}
        </div>
      `).join('');
    }

    // 3. Render Complete Chronological Minutes of Meeting (MoM) Ledger
    const ledgerEl = document.getElementById('rep-mom-timeline-list');
    if (digest.length === 0) {
      ledgerEl.innerHTML = `<p class="text-center py-8 text-slate-400">No meetings scheduled in ${month}.</p>`;
    } else {
      ledgerEl.innerHTML = digest.map(m => {
        const pBadges = (m.participants || []).map(p => {
          let cls = 'bg-slate-100 text-slate-600 border-slate-200';
          let icon = '•';
          if (p.status === 'present') { cls = 'bg-emerald-50 text-emerald-700 border-emerald-200'; icon = '✓'; }
          else if (p.status === 'late') { cls = 'bg-amber-50 text-amber-700 border-amber-200'; icon = '🕒'; }
          else if (p.status === 'absent') { cls = 'bg-red-50 text-red-700 border-red-200'; icon = '✕'; }
          else if (p.status === 'excused') { cls = 'bg-blue-50 text-blue-700 border-blue-200'; icon = 'ℹ'; }
          return `<span class="px-2 py-0.5 rounded border text-[11px] font-semibold ${cls}">${icon} ${p.name} (${p.status.toUpperCase()})</span>`;
        }).join(' ');

        return `
          <div class="p-4 rounded-xl bg-slate-50/70 dark:bg-slate-900/60 border border-slate-200 dark:border-slate-700 space-y-3">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 dark:border-slate-700 pb-2.5">
              <div>
                <div class="flex items-center gap-2">
                  <span class="font-mono font-bold text-slate-700 dark:text-slate-300">${m.date} (${formatTime12h(m.start_time)} – ${formatTime12h(m.end_time)})</span>
                  <span class="px-2 py-0.5 rounded text-[10px] font-bold uppercase ${m.scope === 'individual' ? 'bg-purple-100 text-purple-800' : 'bg-blue-100 text-blue-800'}">
                    ${m.scope === 'individual' ? '👤 Individual 1-on-1' : '👥 Team Meeting'}
                  </span>
                  ${m.is_recurring ? `<span class="text-[10px] font-bold text-emerald-600">🔁 ${m.recurring_frequency}</span>` : ''}
                </div>
                <h5 class="text-sm font-bold text-slate-900 dark:text-white mt-1">${m.title}</h5>
              </div>
              <button onclick="openMeetingMomModal(${m.id})" class="px-3 py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 hover:border-blue-500 font-semibold text-xs">
                📝 Update Attendance / MoM
              </button>
            </div>

            <div>
              <span class="block text-[10px] font-bold uppercase text-slate-400 mb-1">Attendance Roll-Call:</span>
              <div class="flex flex-wrap gap-1.5">${pBadges || '<span class="text-slate-400">No participants listed</span>'}</div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-3 pt-1">
              <div class="p-3 rounded-lg bg-amber-50/50 dark:bg-slate-800 border border-amber-200/70 dark:border-slate-700">
                <span class="block text-[10px] font-bold uppercase text-amber-800 dark:text-amber-300 mb-1">⭐ Key Team Highlights</span>
                <p class="text-slate-800 dark:text-slate-200 whitespace-pre-line">${m.mom_highlights || 'No highlights logged yet.'}</p>
              </div>
              <div class="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
                <span class="block text-[10px] font-bold uppercase text-slate-500 mb-1">💬 Discussion Minutes (MoM)</span>
                <p class="text-slate-700 dark:text-slate-300 whitespace-pre-line">${m.mom_discussion || 'No discussion minutes recorded yet.'}</p>
              </div>
              <div class="p-3 rounded-lg bg-emerald-50/50 dark:bg-slate-800 border border-emerald-200/70 dark:border-slate-700">
                <span class="block text-[10px] font-bold uppercase text-emerald-800 dark:text-emerald-300 mb-1">✅ Management Decisions & Actions</span>
                <p class="text-slate-800 dark:text-slate-200 whitespace-pre-line">${m.mom_decisions || 'No action decisions logged yet.'}</p>
              </div>
            </div>
          </div>
        `;
      }).join('');
    }
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.exportMonthlyMomCSV = function() {
  if (!lastMonthlyReportData || !lastMonthlyReportData.momDigest) {
    showToast('Open the End-of-Month Report first', 'error');
    return;
  }
  const rows = [['Meeting ID', 'Date', 'Time Slot', 'Type', 'Title', 'Workspace', 'Attendance Summary', 'Team Highlights', 'Discussion Minutes (MoM)', 'Action Decisions']];
  lastMonthlyReportData.momDigest.forEach(m => {
    const attStr = (m.participants || []).map(p => `${p.name}: ${p.status.toUpperCase()}`).join('; ');
    rows.push([
      m.id,
      m.date,
      `${m.start_time}-${m.end_time}`,
      m.scope,
      m.title,
      m.workspace_title,
      attStr,
      m.mom_highlights || '',
      m.mom_discussion || '',
      m.mom_decisions || ''
    ]);
  });
  downloadCSV(`executive-monthly-mom-report-${lastMonthlyReportData.month}.csv`, rows);
};

window.deleteMeeting = async function(id) {
  if (!confirm('Delete this meeting / agenda?')) return;
  try {
    await apiFetch(`/api/meetings/${id}`, { method: 'DELETE' });
    showToast('Meeting removed');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// TAB 5: TEAM & WORKLOAD
// ============================================================================
// ============================================================================
// WEEKLY & MONTHLY TEAM WORKLOAD & ALIGNMENT REPORT
// ============================================================================
const workloadReportState = {
  tabMode: 'workload',
  period: 'weekly', // 'weekly' | 'monthly'
  weekOffsetDays: 0,
  lastData: null,
  chart: null
};

window.openWorkloadReportView = function() {
  // Even if Team sidebar tab is hidden for a non-admin, allow opening if permitted, else show toast
  const teamNavBtn = document.querySelector('.nav-tab[data-tab="team"]');
  if (teamNavBtn && teamNavBtn.classList.contains('hidden')) {
    showToast('Workload reports require Team Management permission.', 'error');
    return;
  }
  switchTab('team');
  setTeamTabMode('workload');
};

window.setTeamTabMode = function(mode) {
  workloadReportState.tabMode = mode;
  const wlView = document.getElementById('team-subview-workload');
  const dirView = document.getElementById('team-subview-directory');
  const btnWl = document.getElementById('btn-team-mode-workload');
  const btnDir = document.getElementById('btn-team-mode-directory');

  if (mode === 'directory') {
    wlView?.classList.add('hidden');
    dirView?.classList.remove('hidden');
    if (btnDir) btnDir.className = 'px-3 py-1.5 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs';
    if (btnWl) btnWl.className = 'px-3 py-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900';
  } else {
    dirView?.classList.add('hidden');
    wlView?.classList.remove('hidden');
    if (btnWl) btnWl.className = 'px-3 py-1.5 rounded-md bg-white dark:bg-slate-800 text-slate-900 dark:text-white shadow-xs';
    if (btnDir) btnDir.className = 'px-3 py-1.5 rounded-md text-slate-600 dark:text-slate-400 hover:text-slate-900';
    loadWorkloadReport();
  }
};

window.setWorkloadReportPeriod = function(period) {
  workloadReportState.period = period;
  const btnW = document.getElementById('wl-btn-weekly');
  const btnM = document.getElementById('wl-btn-monthly');
  const ctrlW = document.getElementById('wl-weekly-controls');
  const ctrlM = document.getElementById('wl-monthly-controls');

  if (period === 'monthly') {
    if (btnM) btnM.className = 'px-3 py-1.5 rounded-md bg-blue-600 text-white shadow-xs';
    if (btnW) btnW.className = 'px-3 py-1.5 rounded-md text-slate-600 dark:text-slate-300';
    ctrlW?.classList.add('hidden');
    ctrlM?.classList.remove('hidden');
    const mp = document.getElementById('wl-month-picker');
    if (mp && !mp.value) mp.value = new Date().toISOString().substring(0, 7);
  } else {
    if (btnW) btnW.className = 'px-3 py-1.5 rounded-md bg-blue-600 text-white shadow-xs';
    if (btnM) btnM.className = 'px-3 py-1.5 rounded-md text-slate-600 dark:text-slate-300';
    ctrlM?.classList.add('hidden');
    ctrlW?.classList.remove('hidden');
  }
  loadWorkloadReport();
};

window.shiftWorkloadWeek = function(deltaDays) {
  workloadReportState.weekOffsetDays = deltaDays === 0 ? 0 : workloadReportState.weekOffsetDays + deltaDays;
  loadWorkloadReport();
};

window.loadWorkloadReport = async function() {
  const tbody = document.getElementById('wl-members-tbody');
  if (!tbody) return;

  try {
    const params = new URLSearchParams({
      period: workloadReportState.period,
      workspace_id: state.selectedWorkspace
    });

    if (workloadReportState.period === 'monthly') {
      const mp = document.getElementById('wl-month-picker');
      const mVal = (mp && mp.value) ? mp.value : new Date().toISOString().substring(0, 7);
      params.set('month', mVal);
    } else {
      const d = new Date();
      d.setDate(d.getDate() + workloadReportState.weekOffsetDays);
      params.set('date', localDateStr(d));
    }

    const res = await apiFetch(`/api/reports/workload?${params.toString()}`);
    workloadReportState.lastData = res;

    document.getElementById('wl-period-label').textContent = res.periodLabel || `${res.startDate} – ${res.endDate}`;

    const k = res.kpis || {};
    const alignEl = document.getElementById('wl-kpi-alignment');
    alignEl.textContent = `${k.avgAlignmentScore ?? 100}%`;
    alignEl.className = `text-2xl font-bold mt-1 ${(k.avgAlignmentScore || 0) >= 80 ? 'text-emerald-600' : ((k.avgAlignmentScore || 0) >= 60 ? 'text-amber-600' : 'text-red-600')}`;
    document.getElementById('wl-kpi-aligned-split').textContent = `${k.alignedMembers || 0} / ${k.totalMembers || 0} members aligned`;
    document.getElementById('wl-kpi-completion').textContent = `${k.completionRate || 0}%`;
    document.getElementById('wl-kpi-tasks-split').textContent = `${k.completedTasks || 0} / ${k.totalTasks || 0} tasks done`;
    document.getElementById('wl-kpi-overdue').textContent = k.overdueTasks || 0;
    document.getElementById('wl-kpi-overloaded').textContent = k.overloadedMembers || 0;
    document.getElementById('wl-kpi-available').textContent = k.availableMembers || 0;
    document.getElementById('wl-kpi-hours').textContent = `${k.totalScheduledHours || 0}h`;

    const members = res.members || [];

    // 1. Render Chart.js Workload Bar Chart
    const canvas = document.getElementById('chart-workload-report');
    if (canvas) {
      if (workloadReportState.chart) workloadReportState.chart.destroy();
      const isDark = state.theme === 'dark';
      const gridColor = isDark ? 'rgba(148,163,184,0.12)' : 'rgba(148,163,184,0.2)';
      const tickColor = isDark ? '#cbd5e1' : '#475569';

      workloadReportState.chart = new Chart(canvas, {
        type: 'bar',
        data: {
          labels: members.map(m => m.name.split(' ')[0]),
          datasets: [
            { label: 'Completed', data: members.map(m => m.completed_tasks), backgroundColor: '#10b981', borderRadius: 4 },
            { label: 'In Progress / Planned', data: members.map(m => Math.max(0, m.open_tasks - m.overdue_tasks)), backgroundColor: '#3b82f6', borderRadius: 4 },
            { label: 'Overdue', data: members.map(m => m.overdue_tasks), backgroundColor: '#ef4444', borderRadius: 4 }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'top', labels: { color: tickColor, boxWidth: 12, font: { size: 11 } } }
          },
          scales: {
            x: { stacked: true, ticks: { color: tickColor }, grid: { display: false } },
            y: { stacked: true, beginAtZero: true, ticks: { stepSize: 1, color: tickColor }, grid: { color: gridColor } }
          }
        }
      });
    }

    // 2. Render Member Alignment & Capacity Table
    if (members.length === 0) {
      tbody.innerHTML = `<tr><td colspan="7" class="py-8 text-center text-slate-400">No active team members found in this scope.</td></tr>`;
      return;
    }

    tbody.innerHTML = members.map(m => {
      const capCls = m.capacity_status === 'Overloaded'
        ? 'bg-red-50 text-red-700 border-red-200 dark:bg-red-950/50 dark:text-red-300'
        : (m.capacity_status === 'Available'
          ? 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/50 dark:text-emerald-300'
          : 'bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/50 dark:text-blue-300');

      const alignCls = m.alignment_status === 'Aligned'
        ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
        : (m.alignment_status === 'Needs Attention'
          ? 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300'
          : 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-300');

      const barColor = m.alignment_score >= 82 ? 'bg-emerald-500' : (m.alignment_score >= 60 ? 'bg-amber-500' : 'bg-red-500');

      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
          <td class="py-3 px-4">
            <div class="font-bold text-slate-900 dark:text-white">${m.name}</div>
            <div class="text-[11px] text-slate-500">${m.role_name} • ${m.active_projects} project(s)</div>
          </td>
          <td class="py-3 px-3 text-center">
            <div class="inline-flex items-center gap-1.5 font-mono text-[11px]">
              <span class="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 font-bold" title="Open Tasks">${m.open_tasks} Open</span>
              <span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 font-bold" title="Completed Tasks">${m.completed_tasks} Done</span>
              ${m.overdue_tasks > 0 ? `<span class="px-1.5 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 font-bold" title="Overdue">${m.overdue_tasks} Overdue</span>` : ''}
            </div>
          </td>
          <td class="py-3 px-3 text-center">
            <span class="px-2.5 py-1 rounded-full border text-[11px] font-bold ${capCls}">${m.capacity_status}</span>
          </td>
          <td class="py-3 px-3 text-center font-mono font-bold text-slate-700 dark:text-slate-200">
            ${m.scheduled_hours}h
          </td>
          <td class="py-3 px-3 min-w-[130px]">
            <div class="flex items-center justify-between text-[11px] mb-1">
              <span class="px-1.5 py-0.2 rounded font-bold text-[10px] ${alignCls}">${m.alignment_status}</span>
              <span class="font-bold text-slate-800 dark:text-slate-100">${m.alignment_score}%</span>
            </div>
            <div class="w-full h-1.5 rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
              <div class="h-full ${barColor}" style="width:${m.alignment_score}%"></div>
            </div>
          </td>
          <td class="py-3 px-3 text-[11px] text-slate-600 dark:text-slate-300 max-w-xs">
            ${m.recommendation}
            ${m.meeting_attendance_rate !== null ? `<div class="text-[10px] text-slate-400 mt-0.5">Meetings Attendance: ${m.meeting_attendance_rate}%</div>` : ''}
          </td>
          <td class="py-3 px-4 text-right">
            <button type="button" onclick="inspectWorkloadMemberTasks(${m.user_id})"
              class="px-2.5 py-1.5 rounded-lg bg-blue-50 dark:bg-blue-950 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-semibold text-[11px] hover:bg-blue-100">
              Inspect (${m.total_tasks})
            </button>
          </td>
        </tr>
      `;
    }).join('');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.inspectWorkloadMemberTasks = function(userId) {
  const data = workloadReportState.lastData;
  if (!data) return;
  const m = (data.members || []).find(x => Number(x.user_id) === Number(userId));
  if (!m) return;

  const box = document.getElementById('wl-member-drilldown-box');
  const titleEl = document.getElementById('wl-drilldown-title');
  const listEl = document.getElementById('wl-drilldown-list');
  box.classList.remove('hidden');
  titleEl.textContent = `${m.name} — ${m.total_tasks} Task(s) in ${data.periodLabel} (${m.alignment_status} • ${m.alignment_score}%)`;

  if (!m.tasks || m.tasks.length === 0) {
    listEl.innerHTML = `<p class="md:col-span-2 text-center py-6 text-slate-400">No tasks assigned in this period. This member has available capacity.</p>`;
  } else {
    listEl.innerHTML = m.tasks.map(t => `
      <div onclick="openDiscussionModal('task', ${t.id})"
        class="cursor-pointer p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border ${t.is_overdue ? 'border-red-300 dark:border-red-800' : (t.is_done ? 'border-emerald-200 dark:border-emerald-900' : 'border-slate-200 dark:border-slate-700')} hover:border-blue-400 transition flex items-center justify-between gap-2">
        <div class="min-w-0">
          <div class="font-bold text-slate-900 dark:text-white truncate ${t.is_done ? 'line-through text-slate-400' : ''}">${t.title}</div>
          <div class="text-[11px] text-slate-500">${t.project_title} • Due: ${t.due_date || '—'}</div>
        </div>
        <div class="flex items-center gap-1.5 shrink-0">
          ${t.is_overdue ? `<span class="px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold text-[10px]">OVERDUE</span>` : ''}
          <span class="px-2 py-0.5 rounded text-[10px] font-semibold border ${badgeClass(t.status_color)}">${t.status_title}</span>
        </div>
      </div>
    `).join('');
  }
  box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
};

window.exportWorkloadReportCSV = function() {
  const data = workloadReportState.lastData;
  if (!data || !data.members) {
    showToast('Load the workload report first', 'error');
    return;
  }
  const rows = [['Member', 'Role', 'Active Projects', 'Total Tasks', 'Open', 'In Progress', 'Completed', 'Overdue', 'Completion %', 'Scheduled Hours', 'Capacity Status', 'Alignment Score %', 'Alignment Status', 'Management Insight']];
  data.members.forEach(m => {
    rows.push([
      m.name, m.role_name, m.active_projects, m.total_tasks, m.open_tasks,
      m.in_progress_tasks, m.completed_tasks, m.overdue_tasks, `${m.completion_rate}%`,
      m.scheduled_hours, m.capacity_status, `${m.alignment_score}%`, m.alignment_status, m.recommendation
    ]);
  });
  downloadCSV(`team-workload-alignment-${data.period}-${data.startDate}.csv`, rows);
};

function renderTeamTable() {
  const workloadMap = {};
  (state.overview?.teamWorkload || []).forEach(w => { workloadMap[w.id] = w; });

  const tbody = document.getElementById('team-table-tbody');
  tbody.innerHTML = state.meta.users.map(u => {
    const wl = workloadMap[u.id] || {};
    const initials = ((u.first_name?.[0] || '') + (u.last_name?.[0] || '')).toUpperCase();
    return `
      <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
        <td class="py-3.5 px-4">
          <div class="flex items-center gap-3">
            <div class="w-8 h-8 rounded-full bg-blue-50 dark:bg-blue-900/50 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 flex items-center justify-center font-bold text-xs">
              ${initials}
            </div>
            <div>
              <div class="font-bold text-slate-900 dark:text-white text-sm">${u.first_name} ${u.last_name}</div>
              <div class="text-[11px] text-slate-400">User ID #${u.id}</div>
            </div>
          </div>
        </td>
        <td class="py-3.5 px-3">
          <div class="text-slate-800 dark:text-slate-200">${u.email}</div>
          <div class="text-[11px] text-slate-400">${u.phone || '—'}</div>
        </td>
        <td class="py-3.5 px-3">
          <span class="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-700 text-slate-800 dark:text-slate-200 font-semibold text-[11px]">
            ${u.role_names || 'Member'}
          </span>
        </td>
        <td class="py-3.5 px-3">
          ${Number(u.status) === 1
            ? `<span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px] font-medium">Active</span>`
            : `<span class="px-2 py-0.5 rounded bg-red-50 text-red-700 border border-red-200 text-[11px] font-medium">Inactive</span>`}
        </td>
        <td class="py-3.5 px-3 text-center font-bold">${wl.assigned_projects || 0}</td>
        <td class="py-3.5 px-3 text-center font-bold text-blue-600">${wl.open_tasks || 0}</td>
        <td class="py-3.5 px-3 text-center font-bold text-emerald-600">${wl.completed_tasks || 0}</td>
        <td class="py-3.5 px-4 text-right space-x-1">
          <button onclick="openNotifyModal([${u.id}])" class="px-2.5 py-1 rounded bg-slate-100 dark:bg-slate-700 hover:bg-slate-200 text-xs font-medium">
            ✉ Email
          </button>
          <button onclick="filterTasksByMember(${u.id})" class="px-2.5 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 text-xs font-medium">
            View Tasks
          </button>
          <button onclick="openUserModal(${u.id})" class="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 text-xs font-medium">
            Edit
          </button>
        </td>
      </tr>
    `;
  }).join('');
}

// ============================================================================
// TAB 6: CLIENTS
// ============================================================================
function renderClientsTable() {
  const tbody = document.getElementById('clients-table-tbody');
  if (!state.meta.clients || state.meta.clients.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="py-8 text-center text-slate-400">No clients added yet. Click "Add Client" to create one.</td></tr>`;
    return;
  }
  tbody.innerHTML = state.meta.clients.map(c => `
    <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40 transition">
      <td class="py-3.5 px-4 font-bold text-slate-900 dark:text-white">${c.first_name} ${c.last_name || ''}</td>
      <td class="py-3.5 px-3 text-slate-600 dark:text-slate-300">${c.company || '—'}</td>
      <td class="py-3.5 px-3">
        <div>${c.email}</div>
        <div class="text-[11px] text-slate-400">${c.phone || ''}</div>
      </td>
      <td class="py-3.5 px-3">
        <span class="px-2 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[11px]">Active</span>
      </td>
      <td class="py-3.5 px-3 text-center font-semibold">${c.projects_count || 0}</td>
      <td class="py-3.5 px-4 text-right">
        <button onclick="deleteClient(${c.id})" class="px-2.5 py-1 rounded bg-red-50 text-red-600 border border-red-200 text-xs">Delete</button>
      </td>
    </tr>
  `).join('');
}

window.openClientModal = function() {
  document.getElementById('client-modal').classList.remove('hidden');
  document.getElementById('client-form').reset();
};

window.closeClientModal = function() {
  document.getElementById('client-modal').classList.add('hidden');
};

window.deleteClient = async function(id) {
  if (!confirm('Delete this client?')) return;
  try {
    await apiFetch(`/api/clients/${id}`, { method: 'DELETE' });
    showToast('Client deleted');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// TAB 7: WORKSPACES
// ============================================================================
let deleteWsTimer = null;
let deleteWsVerifiedPassword = '';

function renderWorkspacesGrid() {
  const grid = document.getElementById('workspaces-cards-grid');
  const canEditWs = Boolean(state.user?.isStrictAdmin || (state.user?.permissions || []).includes('edit_workspaces'));
  const canDeleteWs = Boolean(state.user?.isStrictAdmin || (state.user?.permissions || []).includes('delete_workspaces'));

  grid.innerHTML = state.meta.workspaces.map(w => `
    <div class="p-5 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 shadow-sm flex flex-col justify-between">
      <div>
        <div class="flex items-center justify-between mb-2">
          <span class="text-xs text-slate-400 font-mono">ID #${w.id}</span>
          <div class="flex items-center gap-1.5">
            ${Number(w.is_primary) === 1
              ? `<span class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold border border-blue-200">Primary</span>`
              : ''}
            ${canEditWs ? `<button type="button" onclick="openWorkspaceModal(${w.id})" title="Edit Workspace" class="px-2 py-0.5 rounded bg-slate-50 hover:bg-slate-100 dark:bg-slate-700 dark:hover:bg-slate-600 text-slate-700 dark:text-slate-200 border border-slate-200 dark:border-slate-600 text-[10px] font-semibold transition">Edit</button>` : ''}
            ${canDeleteWs ? `<button type="button" onclick="openDeleteWorkspaceModal(${w.id})" title="Delete Workspace" class="px-2 py-0.5 rounded bg-red-50 hover:bg-red-100 text-red-600 border border-red-200 text-[10px] font-semibold transition">Delete</button>` : ''}
          </div>
        </div>
        <h4 class="text-base font-bold text-slate-900 dark:text-white mb-4">${w.title}</h4>
        <div class="grid grid-cols-3 gap-2 text-center p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <div>
            <div class="text-base font-bold text-slate-900 dark:text-white">${w.projects_count || 0}</div>
            <div class="text-[10px] text-slate-500">Projects</div>
          </div>
          <div>
            <div class="text-base font-bold text-slate-900 dark:text-white">${w.tasks_count || 0}</div>
            <div class="text-[10px] text-slate-500">Tasks</div>
          </div>
          <div>
            <div class="text-base font-bold text-slate-900 dark:text-white">${w.users_count || 0}</div>
            <div class="text-[10px] text-slate-500">Members</div>
          </div>
        </div>
      </div>
      <div class="mt-4 pt-3 border-t border-slate-100 dark:border-slate-700">
        <button onclick="selectWorkspaceScope('${w.id}')"
          class="w-full py-2 rounded-lg bg-slate-100 dark:bg-slate-700 hover:bg-blue-600 hover:text-white text-slate-700 dark:text-slate-200 text-xs font-semibold transition">
          Switch to This Workspace
        </button>
      </div>
    </div>
  `).join('');

  // Render 30-Day Deletion Safety Hold panel if any workspaces are scheduled for deletion
  const pendingBox = document.getElementById('workspaces-pending-deletion-box');
  const pendingList = document.getElementById('workspaces-pending-deletion-list');
  const pending = state.meta.pendingDeletionWorkspaces || [];
  if (pendingBox && pendingList) {
    if (pending.length === 0) {
      pendingBox.classList.add('hidden');
    } else {
      pendingBox.classList.remove('hidden');
      const nowMs = Date.now();
      pendingList.innerHTML = pending.map(item => {
        const purgeDt = new Date(item.purge_at);
        const daysLeft = Math.max(0, Math.ceil((purgeDt.getTime() - nowMs) / (1000 * 60 * 60 * 24)));
        const purgeStr = isNaN(purgeDt.getTime()) ? '—' : localDateStr(purgeDt);
        return `
          <div class="p-4 rounded-xl bg-white dark:bg-slate-800 border border-amber-300 dark:border-amber-700 flex flex-col justify-between gap-3 shadow-xs">
            <div>
              <div class="flex items-center justify-between gap-2 mb-1">
                <span class="font-mono text-[10px] text-slate-400">ID #${item.workspace_id}</span>
                <span class="px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-950 text-amber-800 dark:text-amber-300 font-bold text-[10px]">
                  ⏳ ${daysLeft} day(s) left
                </span>
              </div>
              <div class="text-sm font-bold text-slate-900 dark:text-white">${item.title}</div>
              <div class="text-[11px] text-slate-500 mt-1">
                ${item.projects_count || 0} Projects • ${item.tasks_count || 0} Tasks • ${item.users_count || 0} Members
              </div>
              <div class="text-[10px] text-slate-400 mt-1">
                Scheduled by ${item.requested_by_name || 'Admin'} • Permanent removal: <strong>${purgeStr}</strong>
              </div>
            </div>
            <button type="button" onclick="restoreWorkspace(${item.workspace_id})"
              class="w-full py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-xs transition shadow-xs">
              ↩ Stop Deletion & Restore Workspace
            </button>
          </div>
        `;
      }).join('');
    }
  }
}

window.openDeleteWorkspaceModal = function(wsId) {
  const ws = state.meta.workspaces.find(w => Number(w.id) === Number(wsId));
  if (!ws) return;
  if (deleteWsTimer) { clearInterval(deleteWsTimer); deleteWsTimer = null; }
  deleteWsVerifiedPassword = '';

  document.getElementById('del-ws-id').value = ws.id;
  document.getElementById('del-ws-target-name').textContent = `Workspace: "${ws.title}" (#${ws.id}) — ${ws.projects_count || 0} projects, ${ws.tasks_count || 0} tasks`;
  document.getElementById('del-ws-password').value = '';
  document.getElementById('del-ws-pass-error').classList.add('hidden');
  document.getElementById('del-ws-step-1').classList.remove('hidden');
  document.getElementById('del-ws-step-2').classList.add('hidden');
  document.getElementById('del-ws-step-3').classList.add('hidden');
  document.getElementById('delete-workspace-modal').classList.remove('hidden');
  setTimeout(() => document.getElementById('del-ws-password')?.focus(), 50);
};

window.closeDeleteWorkspaceModal = function() {
  if (deleteWsTimer) { clearInterval(deleteWsTimer); deleteWsTimer = null; }
  deleteWsVerifiedPassword = '';
  document.getElementById('delete-workspace-modal').classList.add('hidden');
};

window.verifyDeleteWorkspacePassword = async function() {
  const pwdEl = document.getElementById('del-ws-password');
  const errEl = document.getElementById('del-ws-pass-error');
  const btn = document.getElementById('del-ws-verify-btn');
  const password = pwdEl.value;
  errEl.classList.add('hidden');

  if (!password) {
    errEl.textContent = 'Please enter your account password.';
    errEl.classList.remove('hidden');
    return;
  }

  try {
    btn.disabled = true;
    btn.textContent = 'Verifying...';
    await apiFetch('/api/auth/verify-password', {
      method: 'POST',
      body: JSON.stringify({ password })
    });
    deleteWsVerifiedPassword = password;

    // Move to Step 2: 30-second cool-down timer
    document.getElementById('del-ws-step-1').classList.add('hidden');
    document.getElementById('del-ws-step-2').classList.remove('hidden');

    let secondsLeft = 30;
    const numEl = document.getElementById('del-ws-countdown-num');
    const barEl = document.getElementById('del-ws-countdown-bar');
    numEl.textContent = secondsLeft;
    barEl.style.width = '100%';

    deleteWsTimer = setInterval(() => {
      secondsLeft--;
      numEl.textContent = Math.max(0, secondsLeft);
      barEl.style.width = `${Math.max(0, (secondsLeft / 30) * 100)}%`;
      if (secondsLeft <= 0) {
        clearInterval(deleteWsTimer);
        deleteWsTimer = null;
        // Move to Step 3: "Take a sigh of relief — are you sure?"
        document.getElementById('del-ws-step-2').classList.add('hidden');
        document.getElementById('del-ws-step-3').classList.remove('hidden');
        showToast('Take a sigh of relief — please confirm if you want to hold this workspace for 30 days.');
      }
    }, 1000);
  } catch (err) {
    errEl.textContent = err.message || 'Incorrect password.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify Password →';
  }
};

window.confirmScheduleDeleteWorkspace = async function() {
  const wsId = Number(document.getElementById('del-ws-id').value);
  const btn = document.getElementById('del-ws-confirm-btn');
  try {
    btn.disabled = true;
    btn.textContent = 'Scheduling 30-Day Hold...';
    const res = await apiFetch(`/api/workspaces/${wsId}/schedule-delete`, {
      method: 'POST',
      body: JSON.stringify({ password: deleteWsVerifiedPassword })
    });
    if (String(state.selectedWorkspace) === String(wsId)) {
      state.selectedWorkspace = 'all';
      localStorage.setItem('ceo_workspace', 'all');
    }
    closeDeleteWorkspaceModal();
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Yes, Hold for 30 Days & Hide';
  }
};

window.restoreWorkspace = async function(wsId) {
  try {
    const res = await apiFetch(`/api/workspaces/${wsId}/restore`, {
      method: 'POST',
      body: JSON.stringify({})
    });
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.selectWorkspaceScope = async function(wsId) {
  state.selectedWorkspace = String(wsId);
  localStorage.setItem('ceo_workspace', state.selectedWorkspace);
  await loadAllData();
  switchTab('overview');
  showToast('Workspace switched');
};

// ============================================================================
// TAB 8: AUTO-CRON & EMAIL ENGINE
// ============================================================================
function renderCronTab() {
  const cd = state.cronDetails;
  if (!cd) return;
  const cs = cd.cronState || {};

  document.getElementById('cron-last-run').textContent = cs.lastRunAt || 'Running (60s interval)';
  document.getElementById('cron-rec-count').textContent = cs.recurringProcessed || 0;
  document.getElementById('cron-rem-count').textContent = (cs.remindersSent || 0) + (cs.meetingAlertsSent || 0);
  document.getElementById('cron-email-count').textContent = cs.emailsDispatched || 0;

  const recListEl = document.getElementById('cron-recurring-list');
  const recItems = cd.recurringTasks || [];
  const remItems = cd.reminders || [];

  if (recItems.length === 0 && remItems.length === 0) {
    recListEl.innerHTML = `<p class="text-slate-400 py-4 text-center">No recurring tasks or automated reminders configured yet. Open "+ Task" and check "Repeat Task Automatically" or "Send Automated Email Reminder".</p>`;
  } else {
    const activeRecCount = recItems.filter(r => Number(r.is_active) === 1).length;
    const recSectionHeader = `
      <div class="flex items-center justify-between pt-1 pb-1.5 border-b border-slate-200 dark:border-slate-700">
        <div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-emerald-700 dark:text-emerald-400">🔁 Auto-Recurring Task Creators (${activeRecCount} active)</span>
          <div class="text-[10px] text-slate-500">Automatically generates a fresh task copy, preserves time slot & assignees, and emails the team</div>
        </div>
      </div>
    `;

    const recHtml = recItems.length === 0
      ? `<div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-dashed border-slate-300 dark:border-slate-700 text-[11px] text-slate-500 text-center">No Auto-Recurring Task Creators enabled yet. Click <strong>+ Enable Auto-Create</strong> on a reminder below or check <em>Repeat Task Automatically</em> when editing any task.</div>`
      : recItems.map(rt => {
          const isActive = Number(rt.is_active) === 1;
          const maxOcc = rt.number_of_occurrences ? ` / ${rt.number_of_occurrences}` : ' (∞)';
          const lastCreated = rt.last_created_at ? String(rt.last_created_at).substring(0, 16).replace('T', ' ') : 'Not yet generated';
          return `
            <div class="p-3 rounded-lg ${isActive ? 'bg-emerald-50/40 dark:bg-emerald-950/20 border-emerald-200 dark:border-emerald-800/60' : 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 opacity-75'} border flex flex-wrap items-start justify-between gap-3">
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="px-2 py-0.5 rounded bg-emerald-100 dark:bg-emerald-900/50 text-emerald-800 dark:text-emerald-300 border border-emerald-200 dark:border-emerald-700 font-semibold text-[10px]">🔁 RECURRING (${(rt.frequency || 'daily').toUpperCase()})</span>
                  ${isActive
                    ? `<span class="px-2 py-0.5 rounded bg-blue-50 dark:bg-blue-900/40 text-blue-700 dark:text-blue-300 border border-blue-200 dark:border-blue-800 font-semibold text-[10px]">📅 Next Auto-Create: ${rt.next_run_date || 'Today'}</span>`
                    : `<span class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300 font-semibold text-[10px]">⏸ PAUSED</span>`
                  }
                  ${rt.time_slot ? `<span class="px-1.5 py-0.5 rounded bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300 text-[10px]">🕒 ${rt.time_slot}</span>` : ''}
                </div>
                <div class="font-bold text-slate-900 dark:text-white mt-1.5">${escapeHtml(rt.task_title)}</div>
                <div class="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-3 gap-y-0.5">
                  <span>Project: <strong>${escapeHtml(rt.project_title || '—')}</strong></span>
                  <span>Team: <strong>${escapeHtml(rt.assignees || 'Unassigned')}</strong></span>
                </div>
                <div class="text-[10px] text-slate-400 mt-1 flex flex-wrap gap-x-3">
                  <span>Generated: <strong class="text-slate-600 dark:text-slate-300">${rt.completed_occurrences || 1}${maxOcc}</strong></span>
                  <span>Last created: <strong class="text-slate-600 dark:text-slate-300">${lastCreated}</strong></span>
                </div>
              </div>
              <div class="flex items-center gap-1.5 shrink-0">
                <button onclick="spawnRecurringTaskNow(${rt.id})" title="Test & immediately generate the next scheduled occurrence" class="px-2.5 py-1 rounded bg-emerald-600 hover:bg-emerald-700 text-white text-[11px] font-semibold">⚡ Create Next Now</button>
                <button onclick="toggleRecurringRule(${rt.id})" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px] font-medium">${isActive ? 'Pause' : 'Resume'}</button>
                <button onclick="openTaskModal(${rt.task_id})" class="px-2 py-1 rounded border border-slate-300 dark:border-slate-600 hover:bg-slate-100 dark:hover:bg-slate-800 text-[11px]">Edit</button>
              </div>
            </div>
          `;
        }).join('');

    const remSectionHeader = remItems.length > 0 ? `
      <div class="flex items-center justify-between pt-3 pb-1.5 border-b border-slate-200 dark:border-slate-700">
        <div>
          <span class="text-[11px] font-bold uppercase tracking-wider text-amber-700 dark:text-amber-400">⏰ Automated Email Reminders (${remItems.length})</span>
          <div class="text-[10px] text-slate-500">Sends email reminders only — does not create a new task unless Auto-Create is enabled</div>
        </div>
      </div>
    ` : '';

    const remHtml = remItems.map(rm => {
      const hasRec = Number(rm.has_recurring || 0) > 0;
      const freqForQuick = ['daily', 'weekly', 'monthly', 'yearly'].includes((rm.frequency_type || '').toLowerCase())
        ? rm.frequency_type.toLowerCase()
        : 'daily';
      return `
        <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex flex-wrap items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="px-2 py-0.5 rounded bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 border border-amber-200 dark:border-amber-800 font-semibold text-[10px]">⏰ REMINDER (${(rm.frequency_type || 'daily').toUpperCase()} @ ${formatTime12h(rm.time_of_day)})</span>
              ${hasRec
                ? `<span class="px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-semibold">✓ Auto-Create Linked</span>`
                : `<span class="px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-slate-800 text-slate-600 dark:text-slate-400 text-[10px]">Email reminder only</span>`
              }
            </div>
            <div class="font-bold text-slate-900 dark:text-white mt-1">${escapeHtml(rm.task_title)}</div>
            <div class="text-[11px] text-slate-500">Last sent: ${rm.last_sent_at || 'Pending next trigger'}${rm.assignees ? ` • Team: ${escapeHtml(rm.assignees)}` : ''}</div>
          </div>
          <div class="flex items-center gap-1.5 shrink-0">
            ${!hasRec ? `<button onclick="quickEnableRecurring(${rm.remindable_id}, '${freqForQuick}')" class="px-2.5 py-1 rounded bg-blue-600 hover:bg-blue-700 text-white text-[11px] font-semibold">+ Enable Auto-Create (${freqForQuick})</button>` : ''}
            <button onclick="openTaskModal(${rm.remindable_id})" class="px-2.5 py-1 rounded border border-slate-300 dark:border-slate-600 text-xs">Edit</button>
          </div>
        </div>
      `;
    }).join('');

    recListEl.innerHTML = recSectionHeader + recHtml + remSectionHeader + remHtml;
  }

  const logsEl = document.getElementById('cron-logs-list');
  const logs = cs.recentLogs || [];
  if (logs.length === 0) {
    logsEl.innerHTML = `<p class="text-slate-400 py-4 text-center">No cron events logged yet.</p>`;
  } else {
    logsEl.innerHTML = logs.map(l => `
      <div class="p-2 rounded bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-start gap-2">
        <span class="text-slate-400 shrink-0">[${l.time.substring(11)}]</span>
        <span class="px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 font-semibold text-[10px] shrink-0">${l.type}</span>
        <span class="text-slate-700 dark:text-slate-300">${l.message}</span>
      </div>
    `).join('');
  }
}

window.triggerManualCron = async function() {
  try {
    const res = await apiFetch('/api/cron/run-now', { method: 'POST', body: JSON.stringify({}) });
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.spawnRecurringTaskNow = async function(recurringId) {
  try {
    const res = await apiFetch(`/api/cron/recurring-tasks/${recurringId}/spawn-now`, { method: 'POST', body: JSON.stringify({}) });
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.toggleRecurringRule = async function(recurringId) {
  try {
    const res = await apiFetch(`/api/cron/recurring-tasks/${recurringId}/toggle`, { method: 'PUT', body: JSON.stringify({}) });
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.quickEnableRecurring = async function(taskId, frequency = 'daily') {
  try {
    const res = await apiFetch('/api/cron/recurring-tasks/quick-enable', {
      method: 'POST',
      body: JSON.stringify({ task_id: taskId, frequency })
    });
    showToast(res.message);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.openNotifyModal = function(preselectedIds = null) {
  document.getElementById('notify-modal').classList.remove('hidden');
  document.getElementById('nt-subject').value = '';
  document.getElementById('nt-message').value = '';

  const sel = Array.isArray(preselectedIds) ? preselectedIds : state.meta.users.map(u => Number(u.id));
  document.getElementById('nt-users-checkboxes').innerHTML = state.meta.users.map(u => `
    <label class="flex items-center gap-2 p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
      <input type="checkbox" name="nt_user_ids" value="${u.id}" ${sel.includes(Number(u.id)) ? 'checked' : ''} class="rounded text-blue-600" />
      <span class="truncate">${u.first_name} ${u.last_name}</span>
    </label>
  `).join('');
};

window.closeNotifyModal = function() {
  document.getElementById('notify-modal').classList.add('hidden');
};

// ============================================================================
// TAB 9: SYSTEM CONFIGURATION (Statuses, Priorities, Tags, Roles)
// ============================================================================
function renderSettingsTab() {
  const canCreateStatus = userHasAnyPermission('create_statuses');
  const canDeleteStatus = userHasAnyPermission('delete_statuses');
  const canCreatePriority = userHasAnyPermission('create_priorities');
  const canDeletePriority = userHasAnyPermission('delete_priorities');
  const canCreateTag = userHasAnyPermission('create_tags');
  const canDeleteTag = userHasAnyPermission('delete_tags');

  document.getElementById('add-status-form')?.classList.toggle('hidden', !canCreateStatus);
  document.getElementById('add-priority-form')?.classList.toggle('hidden', !canCreatePriority);
  document.getElementById('add-tag-form')?.classList.toggle('hidden', !canCreateTag);

  document.getElementById('settings-statuses-list').innerHTML = state.meta.statuses.map(s => `
    <div class="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 rounded text-xs font-medium border ${badgeClass(s.color)}">${s.title}</span>
        <span class="text-[11px] text-slate-400">(${s.projects_count || 0}P / ${s.tasks_count || 0}T)</span>
      </div>
      ${canDeleteStatus ? `<button onclick="deleteStatus(${s.id})" class="text-slate-400 hover:text-red-600" title="Delete Status"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>` : ''}
    </div>
  `).join('');

  document.getElementById('settings-priorities-list').innerHTML = state.meta.priorities.map(p => `
    <div class="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
      <div class="flex items-center gap-2">
        <span class="px-2 py-0.5 rounded text-xs font-medium border ${badgeClass(p.color)}">${p.title}</span>
        <span class="text-[11px] text-slate-400">(${p.projects_count || 0}P / ${p.tasks_count || 0}T)</span>
      </div>
      ${canDeletePriority ? `<button onclick="deletePriority(${p.id})" class="text-slate-400 hover:text-red-600" title="Delete Priority"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>` : ''}
    </div>
  `).join('');

  document.getElementById('settings-tags-list').innerHTML = state.meta.tags.map(t => `
    <div class="flex items-center justify-between p-2.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
      <span class="font-medium text-slate-800 dark:text-slate-200"># ${t.title}</span>
      ${canDeleteTag ? `<button onclick="deleteTag(${t.id})" class="text-slate-400 hover:text-red-600" title="Delete Tag"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i></button>` : ''}
    </div>
  `).join('') || `<p class="text-slate-400 text-center py-2">No tags created</p>`;

  document.getElementById('settings-roles-grid').innerHTML = state.meta.roles.map(r => `
    <div class="p-4 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex flex-col justify-between">
      <div>
        <div class="flex items-center justify-between mb-1">
          <span class="font-bold text-sm text-slate-900 dark:text-white">${r.name}</span>
          <span class="text-[10px] px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-600 dark:text-slate-300">Guard: ${r.guard_name}</span>
        </div>
        <p class="text-xs text-slate-500 mb-3">${(r.permission_ids || []).length} permissions assigned</p>
      </div>
      <button onclick="openRoleModal(${r.id})" class="w-full py-1.5 rounded-lg bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 text-slate-700 dark:text-slate-200 font-medium hover:bg-slate-100">
        Configure Permissions
      </button>
    </div>
  `).join('');
}

window.deleteStatus = async function(id) {
  if (!confirm('Delete this status?')) return;
  try {
    await apiFetch(`/api/statuses/${id}`, { method: 'DELETE' });
    showToast('Status deleted');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deletePriority = async function(id) {
  if (!confirm('Delete this priority?')) return;
  try {
    await apiFetch(`/api/priorities/${id}`, { method: 'DELETE' });
    showToast('Priority deleted');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteTag = async function(id) {
  if (!confirm('Delete this tag?')) return;
  try {
    await apiFetch(`/api/tags/${id}`, { method: 'DELETE' });
    showToast('Tag deleted');
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// CATEGORIZED ROLE PERMISSIONS MATRIX (Deduplicated, Grouped & Inline Select All)
// ============================================================================
function getPermissionCategoryAndLabel(permName) {
  const name = String(permName || '').toLowerCase();
  if (name === 'access_all_data') {
    return { category: 'System & Global Access', order: 1, label: 'Access All Data (Company-Wide)' };
  }

  // Extract action prefix (manage_, create_, edit_, delete_)
  let action = '';
  let subject = name;
  const m = name.match(/^(manage|create|edit|delete|view)_(.+)$/);
  if (m) {
    action = m[1].charAt(0).toUpperCase() + m[1].slice(1);
    subject = m[2];
  }

  const prettySubject = subject
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());

  const label = action ? `${action} ${prettySubject}` : prettySubject;

  const rules = [
    { match: ['project', 'milestone', 'media'], category: 'Projects & Milestones', order: 2 },
    { match: ['task'], category: 'Tasks & Subtasks', order: 3 },
    { match: ['meeting'], category: 'Meetings & Agendas', order: 4 },
    { match: ['user', 'role'], category: 'Team, Users & Roles', order: 5 },
    { match: ['client'], category: 'Clients', order: 6 },
    { match: ['workspace'], category: 'Workspaces', order: 7 },
    { match: ['status', 'priorit', 'tag'], category: 'Statuses, Priorities & Tags', order: 8 },
    { match: ['leave', 'allowance', 'deduction', 'payslip', 'candidate', 'interview'], category: 'HR, Leaves & Payroll', order: 9 },
    { match: ['activity', 'notification', 'email', 'announcement'], category: 'Audit Log, Notifications & Emails', order: 10 },
    { match: ['contract', 'estimate', 'invoice', 'expense', 'payment', 'item', 'tax', 'unit'], category: 'Finance, Contracts & Billing', order: 11 }
  ];

  for (const r of rules) {
    if (r.match.some(k => subject.includes(k))) {
      return { category: r.category, order: r.order, label };
    }
  }
  return { category: 'Other Modules & Tools', order: 12, label };
}

function updateRolePermCounts() {
  const allBoxes = Array.from(document.querySelectorAll('input[name="role_perm_ids"]'));
  const checkedCount = allBoxes.filter(b => b.checked).length;
  const totalBadge = document.getElementById('role-perm-selected-count');
  if (totalBadge) totalBadge.textContent = `${checkedCount} / ${allBoxes.length} selected`;

  document.querySelectorAll('.perm-category-card').forEach(card => {
    const boxes = Array.from(card.querySelectorAll('input[name="role_perm_ids"]'));
    const c = boxes.filter(b => b.checked).length;
    const badge = card.querySelector('.perm-cat-count');
    if (badge) badge.textContent = `${c}/${boxes.length}`;
    const btn = card.querySelector('.perm-cat-toggle-btn');
    if (btn) btn.textContent = c === boxes.length && boxes.length > 0 ? 'Deselect All' : 'Select All';
  });
}

window.openRoleModal = function(roleId = null) {
  document.getElementById('role-modal').classList.remove('hidden');
  const r = roleId ? state.meta.roles.find(x => Number(x.id) === Number(roleId)) : null;
  document.getElementById('role-modal-title').textContent = r ? `Edit Role: ${r.name}` : 'Create New Role';
  document.getElementById('role-id').value = r ? r.id : '';
  document.getElementById('role-name').value = r ? r.name : '';
  const searchEl = document.getElementById('role-perm-search');
  if (searchEl) searchEl.value = '';

  const assigned = new Set((r ? (r.permission_ids || []) : []).map(Number));

  // Deduplicate by permission name (prefer web guard)
  const uniquePermsMap = new Map();
  (state.meta.permissions || []).forEach(p => {
    if (!uniquePermsMap.has(p.name) || p.guard_name === 'web') {
      uniquePermsMap.set(p.name, p);
    }
  });
  const uniquePerms = Array.from(uniquePermsMap.values());

  // Group into clean categories
  const groupsMap = new Map();
  uniquePerms.forEach(p => {
    const info = getPermissionCategoryAndLabel(p.name);
    if (!groupsMap.has(info.category)) {
      groupsMap.set(info.category, { category: info.category, order: info.order, items: [] });
    }
    groupsMap.get(info.category).items.push({ ...p, displayLabel: info.label });
  });

  const sortedGroups = Array.from(groupsMap.values()).sort((a, b) => a.order - b.order);

  document.getElementById('role-permissions-checkboxes').innerHTML = sortedGroups.map((grp, idx) => {
    const catKey = `perm-cat-${idx}`;
    const itemsHtml = grp.items.map(p => {
      const isChecked = assigned.has(Number(p.id));
      return `
        <label data-perm-search="${(p.name + ' ' + p.displayLabel + ' ' + grp.category).toLowerCase()}"
          class="perm-item-row flex items-center gap-2 px-2.5 py-2 rounded-lg bg-white dark:bg-slate-800 border border-slate-200/80 dark:border-slate-700 hover:border-blue-400 cursor-pointer transition">
          <input type="checkbox" name="role_perm_ids" value="${p.id}" ${isChecked ? 'checked' : ''}
            onchange="updateRolePermCounts()" class="rounded text-blue-600 shrink-0" />
          <span class="text-[11px] font-medium text-slate-700 dark:text-slate-200 leading-tight truncate" title="${p.name}">${p.displayLabel}</span>
        </label>
      `;
    }).join('');

    return `
      <div class="perm-category-card rounded-xl border border-slate-200 dark:border-slate-700 bg-slate-50/70 dark:bg-slate-900/50 overflow-hidden" data-cat-id="${catKey}">
        <div class="px-3.5 py-2.5 bg-slate-100/80 dark:bg-slate-800/80 border-b border-slate-200 dark:border-slate-700 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <span class="font-bold text-slate-800 dark:text-white text-xs">${grp.category}</span>
            <span class="perm-cat-count px-1.5 py-0.5 rounded bg-white dark:bg-slate-700 border border-slate-200 dark:border-slate-600 text-[10px] font-bold text-slate-600 dark:text-slate-300">0/${grp.items.length}</span>
          </div>
          <button type="button" onclick="toggleCategoryRolePermissions('${catKey}')"
            class="perm-cat-toggle-btn px-2.5 py-1 rounded-md bg-white dark:bg-slate-700 border border-slate-300 dark:border-slate-600 text-[11px] font-semibold text-blue-600 dark:text-blue-300 hover:bg-blue-50 transition">
            Select All
          </button>
        </div>
        <div class="p-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          ${itemsHtml}
        </div>
      </div>
    `;
  }).join('');

  updateRolePermCounts();
};

window.toggleCategoryRolePermissions = function(catKey) {
  const card = document.querySelector(`.perm-category-card[data-cat-id="${catKey}"]`);
  if (!card) return;
  const boxes = Array.from(card.querySelectorAll('input[name="role_perm_ids"]'));
  const allChecked = boxes.every(b => b.checked);
  boxes.forEach(b => { b.checked = !allChecked; });
  updateRolePermCounts();
};

window.setAllRolePermissions = function(checked) {
  document.querySelectorAll('input[name="role_perm_ids"]').forEach(b => { b.checked = Boolean(checked); });
  updateRolePermCounts();
};

window.filterRolePermissions = function(query) {
  const q = String(query || '').trim().toLowerCase();
  document.querySelectorAll('.perm-category-card').forEach(card => {
    let anyVisible = false;
    card.querySelectorAll('.perm-item-row').forEach(row => {
      const hay = row.dataset.permSearch || '';
      const match = !q || hay.includes(q);
      row.classList.toggle('hidden', !match);
      if (match) anyVisible = true;
    });
    card.classList.toggle('hidden', !anyVisible);
  });
};

window.closeRoleModal = function() {
  document.getElementById('role-modal').classList.add('hidden');
};

window.toggleAllRolePermissions = function() {
  const boxes = Array.from(document.querySelectorAll('input[name="role_perm_ids"]'));
  const allChecked = boxes.every(b => b.checked);
  boxes.forEach(b => { b.checked = !allChecked; });
  updateRolePermCounts();
};

// ============================================================================
// TAB 10: AUDIT LOG & LEAVES
// ============================================================================
function renderActivityAndLeavesTab() {
  const ov = state.overview;
  if (!ov) return;

  const actList = document.getElementById('full-activity-list');
  if (!ov.recentActivity || ov.recentActivity.length === 0) {
    actList.innerHTML = `<p class="text-xs text-slate-400 py-4 text-center">No activity logs recorded.</p>`;
  } else {
    actList.innerHTML = ov.recentActivity.map(a => `
      <div class="p-3 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-start justify-between gap-3">
        <div>
          <p class="text-xs font-medium text-slate-800 dark:text-slate-200">${a.message || `${a.actor_name || 'User'} ${a.activity} ${a.type}`}</p>
          <span class="text-[11px] text-slate-400">${a.workspace_title || 'Global'} • ${a.created_at || ''}</span>
        </div>
        <span class="px-2 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-[10px] font-semibold uppercase">${a.activity || 'log'}</span>
      </div>
    `).join('');
  }

  const leavesContainer = document.getElementById('leaves-list-container');
  const leaves = ov.leaveRequests || [];
  if (leaves.length === 0) {
    leavesContainer.innerHTML = `<p class="text-xs text-slate-400 py-6 text-center">No pending or recent leave requests.</p>`;
  } else {
    leavesContainer.innerHTML = leaves.map(lr => `
      <div class="p-3.5 rounded-lg bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700 flex items-center justify-between">
        <div>
          <div class="font-bold text-slate-900 dark:text-white">${lr.user_name || 'Employee'}</div>
          <div class="text-[11px] text-slate-500">${formatDate(lr.from_date)} to ${formatDate(lr.to_date)} • ${lr.reason || ''}</div>
        </div>
        <div class="flex items-center gap-1.5">
          <span class="px-2 py-0.5 rounded text-[11px] font-semibold bg-slate-200 dark:bg-slate-700">${lr.status}</span>
          <button onclick="updateLeaveStatus(${lr.id}, 'approved')" class="px-2 py-1 rounded bg-emerald-600 text-white text-[11px]">Approve</button>
          <button onclick="updateLeaveStatus(${lr.id}, 'rejected')" class="px-2 py-1 rounded bg-red-600 text-white text-[11px]">Reject</button>
        </div>
      </div>
    `).join('');
  }
}

window.toggleTodo = async function(id) {
  try {
    await apiFetch(`/api/todos/${id}/toggle`, { method: 'PUT' });
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.deleteTodo = async function(id) {
  try {
    await apiFetch(`/api/todos/${id}`, { method: 'DELETE' });
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.updateLeaveStatus = async function(id, status) {
  try {
    await apiFetch(`/api/leaves/${id}/status`, { method: 'PUT', body: JSON.stringify({ status }) });
    showToast(`Leave request ${status}`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// PROJECT DETAILED VIEW MODAL (Inline Task Create/Assign + Comments/@Tag + Timeline)
// ============================================================================
const selectedProjDetailMentions = new Set();

window.openProjectDetailModal = async function(projectId) {
  selectedProjDetailMentions.clear();
  const p = state.projects.find(x => Number(x.id) === Number(projectId));
  if (!p) return;

  const modal = document.getElementById('project-detail-modal');
  modal.classList.remove('hidden');

  document.getElementById('detail-proj-title').textContent = `${p.title} (#${p.id})`;
  document.getElementById('detail-proj-meta').textContent =
    `Workspace: ${p.workspace_title || '—'} • Priority: ${p.priority_title || 'Normal'} • Start: ${formatDate(p.start_date)} • End: ${formatDate(p.end_date)}`;
  document.getElementById('detail-proj-desc').textContent = stripHtml(p.description) || 'No project description provided.';

  // Project Quick Status Switcher
  const projStatusSel = document.getElementById('detail-proj-status-select');
  projStatusSel.innerHTML = state.meta.statuses.map(s =>
    `<option value="${s.id}" ${Number(s.id) === Number(p.status_id) ? 'selected' : ''}>${s.title}</option>`
  ).join('');
  projStatusSel.onchange = async () => {
    await quickUpdateProjectStatus(p.id, projStatusSel.value);
    await openProjectDetailModal(p.id);
  };

  document.getElementById('detail-add-task-btn').onclick = () => {
    closeProjectDetailModal();
    openTaskModal(null, p.id);
  };
  document.getElementById('detail-edit-proj-btn').onclick = () => {
    closeProjectDetailModal();
    openProjectModal(p.id);
  };

  // Populate Inline Task Creation Form inside Project View
  document.getElementById('pit-project-id').value = p.id;
  document.getElementById('pit-title').value = '';
  document.getElementById('pit-due-date').value = new Date().toISOString().substring(0, 10);
  document.getElementById('pit-status').innerHTML = state.meta.statuses.map(s =>
    `<option value="${s.id}">${s.title}</option>`
  ).join('');
  document.getElementById('pit-priority').innerHTML = `<option value="0">Normal Priority</option>` +
    state.meta.priorities.map(pr => `<option value="${pr.id}">${pr.title}</option>`).join('');

  const defaultProjUsers = p.user_ids || [];
  document.getElementById('pit-users-checkboxes').innerHTML = state.meta.users.map(u => `
    <label class="flex items-center gap-1.5 px-2 py-1 rounded bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 cursor-pointer text-[11px]">
      <input type="checkbox" name="pit_user_ids" value="${u.id}" ${defaultProjUsers.includes(Number(u.id)) ? 'checked' : ''} class="rounded text-blue-600" />
      <span>${u.first_name}</span>
    </label>
  `).join('');

  // Render Project Tasks Table
  const projTasks = state.tasks.filter(t => Number(t.project_id) === Number(p.id));
  const tbody = document.getElementById('detail-proj-tasks-tbody');
  if (projTasks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="py-6 text-center text-slate-400">No tasks in this project yet. Use the quick form above to create and assign a task!</td></tr>`;
  } else {
    tbody.innerHTML = projTasks.map(t => {
      const statusOpts = state.meta.statuses.map(s =>
        `<option value="${s.id}" ${Number(s.id) === Number(t.status_id) ? 'selected' : ''}>${s.title}</option>`
      ).join('');
      const pctVal = Number(t.completion_percentage || (String(t.status_title || '').toLowerCase().includes('complete') ? 100 : 0));
      return `
        <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40">
          <td class="py-2.5 px-3">
            <button onclick="closeProjectDetailModal(); openDiscussionModal('task', ${t.id})" class="font-bold text-slate-900 dark:text-white hover:text-blue-600 text-left">
              ${t.parent_id ? `<span class="text-[10px] text-slate-400 font-normal">↳ Subtask:</span> ` : ''}${t.title}
            </button>
            ${Number(t.subtasks_count) > 0 ? `<span class="ml-1.5 px-1.5 py-0.2 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold">${t.completed_subtasks_count || 0}/${t.subtasks_count} Subtasks</span>` : ''}
          </td>
          <td class="py-2.5 px-3">${formatTimeSlotBadge(t.start_time, t.end_time)}</td>
          <td class="py-2.5 px-3 text-slate-600 dark:text-slate-300">${(t.users || []).map(u => u.first_name).join(', ') || 'Unassigned'}</td>
          <td class="py-2.5 px-3">
            <select onchange="quickUpdateTaskStatus(${t.id}, this.value).then(() => openProjectDetailModal(${p.id}))"
              class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[11px] font-medium">
              ${statusOpts}
            </select>
          </td>
          <td class="py-2.5 px-3">
            ${buildCompletionPercentSelect(t.id, pctVal, `.then(() => openProjectDetailModal(${p.id}))`)}
          </td>
          <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded text-[10px] border ${badgeClass(t.priority_color)}">${t.priority_title || 'Normal'}</span></td>
          <td class="py-2.5 px-3 font-mono">${formatDate(t.due_date)}</td>
          <td class="py-2.5 px-3 text-right">
            <button onclick="closeProjectDetailModal(); openDiscussionModal('task', ${t.id})"
              class="px-2.5 py-1 rounded bg-blue-50 text-blue-700 hover:bg-blue-100 border border-blue-200 text-[11px] font-semibold">
              View Task (${t.comments_count || 0}💬)
            </button>
          </td>
        </tr>
      `;
    }).join('');
  }

  // Render Project @Tagging Pills
  renderProjectDetailTagPills();

  // Fetch Project Timeline & Comments
  try {
    const details = await apiFetch(`/api/projects/${p.id}/details`);
    const tlContainer = document.getElementById('detail-proj-timeline');
    if (!details.timelines || details.timelines.length === 0) {
      tlContainer.innerHTML = `<p class="text-slate-400 py-4 text-center">No status changes recorded yet.</p>`;
    } else {
      tlContainer.innerHTML = details.timelines.map(tl => `
        <div class="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <span class="text-slate-500">Status changed from</span>
            <strong class="mx-1 text-slate-700 dark:text-slate-300">${tl.previous_status || '-'}</strong>
            <span class="text-slate-500">to</span>
            <strong class="ml-1 px-2 py-0.5 rounded text-[11px] border ${badgeClass(tl.new_color)}">${tl.status}</strong>
          </div>
          <span class="text-slate-400 font-mono text-[10px]">${String(tl.changed_at || tl.created_at || '').substring(0, 16)}</span>
        </div>
      `).join('');
    }

    const cListEl = document.getElementById('detail-proj-comments-list');
    const comments = details.comments || [];
    if (comments.length === 0) {
      cListEl.innerHTML = `<p class="text-center py-6 text-slate-400">No project comments yet. Tag a team member below to start a discussion.</p>`;
    } else {
      cListEl.innerHTML = comments.map(c => {
        const text = stripHtml(c.content).replace(/(@\w+)/g, '<strong class="text-blue-600 dark:text-blue-400">$1</strong>');
        const canDel = state.user?.isAdminOrHasAllDataAccess || Number(c.commenter_id) === Number(state.user?.id);
        return `
          <div class="p-3 rounded-xl bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700">
            <div class="flex items-center justify-between mb-1">
              <span class="font-bold text-slate-900 dark:text-white">${c.author_name || 'Team Member'}</span>
              <div class="flex items-center gap-2">
                <span class="text-[10px] font-mono text-slate-400">${String(c.created_at || '').substring(0, 16)}</span>
                ${canDel ? `<button onclick="deleteProjDetailComment(${c.id}, ${p.id})" class="text-slate-400 hover:text-red-600 text-[10px]">Delete</button>` : ''}
              </div>
            </div>
            <p class="text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">${text}</p>
          </div>
        `;
      }).join('');
    }
  } catch (e) {}
};

function renderProjectDetailTagPills() {
  const container = document.getElementById('detail-proj-tag-pills');
  if (!container) return;
  container.innerHTML = state.meta.users.map(u => {
    const isTagged = selectedProjDetailMentions.has(Number(u.id));
    return `
      <button type="button" onclick="toggleProjDetailMention(${u.id}, '${u.first_name}')"
        class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
          isTagged
            ? 'bg-blue-600 text-white border-blue-600'
            : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-blue-400'
        }">
        @${u.first_name} ${u.last_name || ''}
      </button>
    `;
  }).join('');
}

window.toggleProjDetailMention = function(userId, firstName) {
  const uid = Number(userId);
  const textarea = document.getElementById('detail-proj-comment-input');
  if (selectedProjDetailMentions.has(uid)) {
    selectedProjDetailMentions.delete(uid);
  } else {
    selectedProjDetailMentions.add(uid);
    if (!textarea.value.includes(`@${firstName}`)) {
      textarea.value = `${textarea.value.trim()} @${firstName} `.trimStart();
    }
    textarea.focus();
  }
  renderProjectDetailTagPills();
};

window.deleteProjDetailComment = async function(commentId, projectId) {
  try {
    await apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' });
    await loadAllData();
    await openProjectDetailModal(projectId);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.closeProjectDetailModal = function() {
  document.getElementById('project-detail-modal').classList.add('hidden');
};

// ============================================================================
// CSV EXPORTS
// ============================================================================
function downloadCSV(filename, rows) {
  const csvContent = rows.map(r => r.map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  link.click();
}

window.exportProjectsCSV = function() {
  const rows = [['ID', 'Title', 'Workspace', 'Status', 'Priority', 'Tasks Count', 'Completed Tasks', 'Start Date', 'End Date', 'Budget']];
  getFilteredProjects().forEach(p => {
    rows.push([p.id, p.title, p.workspace_title, p.status_title, p.priority_title, p.tasks_count, p.completed_tasks_count, formatDate(p.start_date), formatDate(p.end_date), p.budget || '']);
  });
  downloadCSV('ceo-projects-report.csv', rows);
};

window.exportTasksCSV = function() {
  const rows = [['ID', 'Title', 'Project', 'Workspace', 'Time Slot', 'Status', 'Priority', 'Assignees', 'Completion %', 'Due Date']];
  getFilteredTasks().forEach(t => {
    const slot = t.start_time && t.end_time ? `${t.start_time}-${t.end_time}` : '';
    rows.push([t.id, t.title, t.project_title, t.workspace_title, slot, t.status_title, t.priority_title, (t.users || []).map(u => `${u.first_name} ${u.last_name}`).join('; '), t.completion_percentage || 0, formatDate(t.due_date)]);
  });
  downloadCSV('ceo-tasks-report.csv', rows);
};

// ============================================================================
// CRUD MODALS (Project, Task, User, Workspace — CEO Pill Selectors & Presets)
// ============================================================================
function renderStatusPills(containerId, hiddenInputId) {
  const currentVal = Number(document.getElementById(hiddenInputId).value);
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = state.meta.statuses.map(s => {
    const active = Number(s.id) === currentVal;
    return `
      <button type="button" onclick="selectModalPill('${containerId}', '${hiddenInputId}', ${s.id}, 'status')"
        class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition flex items-center gap-1.5 ${
          active
            ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
            : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-400'
        }">
        ${active ? '<span>✓</span>' : ''}
        <span>${s.title}</span>
      </button>
    `;
  }).join('');
}

function renderPriorityPills(containerId, hiddenInputId) {
  const currentVal = Number(document.getElementById(hiddenInputId).value || 0);
  const container = document.getElementById(containerId);
  if (!container) return;
  const allPriorities = [{ id: 0, title: 'Normal', color: 'secondary' }, ...state.meta.priorities];
  container.innerHTML = allPriorities.map(p => {
    const active = Number(p.id) === currentVal;
    return `
      <button type="button" onclick="selectModalPill('${containerId}', '${hiddenInputId}', ${p.id}, 'priority')"
        class="px-3 py-1.5 rounded-lg text-xs font-semibold border transition flex items-center gap-1.5 ${
          active
            ? 'bg-slate-900 dark:bg-blue-600 text-white border-slate-900 dark:border-blue-600 shadow-xs'
            : 'bg-slate-50 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-200 dark:border-slate-700 hover:border-blue-400'
        }">
        ${active ? '<span>✓</span>' : ''}
        <span>${p.title}</span>
      </button>
    `;
  }).join('');
}

window.selectModalPill = function(containerId, hiddenInputId, val, kind) {
  document.getElementById(hiddenInputId).value = String(val);
  if (kind === 'status') renderStatusPills(containerId, hiddenInputId);
  else renderPriorityPills(containerId, hiddenInputId);
};

function renderAvatarChipCheckboxes(containerId, inputName, selectedIds = []) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.innerHTML = state.meta.users.map(u => {
    const isChecked = selectedIds.includes(Number(u.id));
    const initials = ((u.first_name?.[0] || '') + (u.last_name?.[0] || '')).toUpperCase();
    return `
      <label onclick="setTimeout(() => refreshAvatarChipStyles('${containerId}', '${inputName}'), 10)"
        class="avatar-chip-label cursor-pointer inline-flex items-center gap-2 px-3 py-1.5 rounded-full border text-xs font-semibold transition select-none ${
          isChecked
            ? 'bg-blue-600 text-white border-blue-600 shadow-xs'
            : 'bg-white dark:bg-slate-800 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-blue-400'
        }">
        <input type="checkbox" name="${inputName}" value="${u.id}" ${isChecked ? 'checked' : ''} class="hidden" />
        <span class="w-5 h-5 rounded-full ${isChecked ? 'bg-white/20 text-white' : 'bg-blue-100 dark:bg-slate-700 text-blue-700 dark:text-blue-300'} flex items-center justify-center text-[10px] font-bold">
          ${initials}
        </span>
        <span>${u.first_name} ${u.last_name || ''}</span>
        ${isChecked ? '<span class="text-[11px]">✓</span>' : ''}
      </label>
    `;
  }).join('');
}

window.refreshAvatarChipStyles = function(containerId, inputName) {
  const checkedIds = Array.from(document.querySelectorAll(`input[name="${inputName}"]:checked`)).map(cb => Number(cb.value));
  renderAvatarChipCheckboxes(containerId, inputName, checkedIds);
};

window.selectAllProjUsers = function() {
  const allIds = state.meta.users.map(u => Number(u.id));
  renderAvatarChipCheckboxes('proj-users-checkboxes', 'proj_user_ids', allIds);
};

window.setProjDatePreset = function(days) {
  const start = new Date();
  const end = new Date();
  end.setDate(start.getDate() + Number(days));
  document.getElementById('proj-start-date').value = start.toISOString().substring(0, 10);
  document.getElementById('proj-end-date').value = end.toISOString().substring(0, 10);
};

window.setTaskTimePreset = function(startTime, endTime) {
  document.getElementById('task-start-time').value = startTime;
  document.getElementById('task-end-time').value = endTime;
};

window.openProjectModal = function(projectId = null) {
  document.getElementById('project-modal').classList.remove('hidden');

  document.getElementById('proj-workspace').innerHTML = state.meta.workspaces.map(w =>
    `<option value="${w.id}">${w.title}</option>`
  ).join('');

  const todayStr = new Date().toISOString().substring(0, 10);
  const p = projectId ? state.projects.find(x => Number(x.id) === Number(projectId)) : null;
  document.getElementById('project-modal-title').textContent = p ? `Edit Project #${p.id}` : 'Create New Project';
  document.getElementById('proj-id').value = p ? p.id : '';
  document.getElementById('proj-title').value = p ? p.title : '';
  document.getElementById('proj-workspace').value = p
    ? p.workspace_id
    : (state.selectedWorkspace !== 'all' ? state.selectedWorkspace : (state.user?.default_workspace_id || state.meta.workspaces[0]?.id || 5));

  const initialStatus = p && p.status_id ? p.status_id : (state.meta.statuses[0]?.id || 28);
  const initialPriority = p && p.priority_id ? p.priority_id : 0;
  document.getElementById('proj-status').value = String(initialStatus);
  document.getElementById('proj-priority').value = String(initialPriority);

  renderStatusPills('proj-status-pills', 'proj-status');
  renderPriorityPills('proj-priority-pills', 'proj-priority');

  document.getElementById('proj-budget').value = p && p.budget ? p.budget : '';
  document.getElementById('proj-start-date').value = p && p.start_date ? String(p.start_date).substring(0, 10) : todayStr;
  document.getElementById('proj-end-date').value = p && p.end_date ? String(p.end_date).substring(0, 10) : '';
  document.getElementById('proj-task-accessibility').value = p ? (p.task_accessibility || 'assigned_users') : 'assigned_users';
  document.getElementById('proj-time-entries').checked = p ? Boolean(p.enable_tasks_time_entries) : true;
  document.getElementById('proj-description').value = p ? stripHtml(p.description) : '';
  document.getElementById('proj-send-email').checked = true;

  const selectedUsers = p ? (p.user_ids || []) : [state.user.id];
  renderAvatarChipCheckboxes('proj-users-checkboxes', 'proj_user_ids', selectedUsers);

  const selectedTags = p ? (p.tag_ids || []) : [];
  document.getElementById('proj-tags-checkboxes').innerHTML = (state.meta.tags || []).map(t => `
    <label class="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 cursor-pointer text-[11px] font-medium">
      <input type="checkbox" name="proj_tag_ids" value="${t.id}" ${selectedTags.includes(Number(t.id)) ? 'checked' : ''} class="rounded text-blue-600" />
      <span>#${t.title}</span>
    </label>
  `).join('') || '<span class="text-slate-400">No tags available</span>';

  lucide.createIcons();
};

window.closeProjectModal = function() {
  document.getElementById('project-modal').classList.add('hidden');
};

window.deleteProject = async function(projectId) {
  if (!confirm(`Delete Project #${projectId} and its tasks?`)) return;
  try {
    await apiFetch(`/api/projects/${projectId}`, { method: 'DELETE' });
    showToast(`Project #${projectId} deleted`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.openTaskModal = function(taskId = null, preselectedProjectId = null) {
  document.getElementById('task-modal').classList.remove('hidden');

  document.getElementById('task-project').innerHTML = state.projects.map(p =>
    `<option value="${p.id}">${p.title}</option>`
  ).join('');

  const todayStr = new Date().toISOString().substring(0, 10);
  const t = taskId ? state.tasks.find(x => Number(x.id) === Number(taskId)) : null;

  document.getElementById('task-modal-title').textContent = t ? `Edit Task #${t.id}` : 'Assign New Task';
  document.getElementById('task-id').value = t ? t.id : '';
  document.getElementById('task-title').value = t ? t.title : '';
  document.getElementById('task-project').value = t
    ? t.project_id
    : (preselectedProjectId || state.projects[0]?.id || '');

  const initialStatus = t && t.status_id ? t.status_id : (state.meta.statuses[0]?.id || 28);
  const initialPriority = t && t.priority_id ? t.priority_id : 0;
  document.getElementById('task-status').value = String(initialStatus);
  document.getElementById('task-priority').value = String(initialPriority);

  renderStatusPills('task-status-pills', 'task-status');
  renderPriorityPills('task-priority-pills', 'task-priority');

  document.getElementById('task-start-date').value = t && t.start_date ? String(t.start_date).substring(0, 10) : todayStr;
  document.getElementById('task-due-date').value = t && t.due_date ? String(t.due_date).substring(0, 10) : todayStr;

  document.getElementById('task-start-time').value = t && t.start_time ? String(t.start_time).substring(0, 5) : '09:00';
  document.getElementById('task-end-time').value = t && t.end_time ? String(t.end_time).substring(0, 5) : '11:00';

  document.getElementById('task-is-recurring').checked = t ? Boolean(t.is_recurring) : false;
  document.getElementById('task-recurring-frequency').value = t && t.recurring_frequency ? t.recurring_frequency : 'daily';
  document.getElementById('task-recurring-occurrences').value = t && t.recurring_occurrences ? t.recurring_occurrences : '';

  document.getElementById('task-enable-reminder').checked = t ? Boolean(t.has_reminder) : false;
  document.getElementById('task-reminder-frequency').value = t && t.reminder_frequency ? t.reminder_frequency : 'daily';
  document.getElementById('task-reminder-time').value = t && t.reminder_time ? String(t.reminder_time).substring(0, 5) : '09:00';

  document.getElementById('task-completion').value = t ? (t.completion_percentage || 0) : 0;
  document.getElementById('task-description').value = t ? stripHtml(t.description) : '';
  document.getElementById('task-send-email').checked = true;

  const selectedUsers = t ? (t.user_ids || []) : [];
  renderAvatarChipCheckboxes('task-users-checkboxes', 'task_user_ids', selectedUsers);

  lucide.createIcons();
};

window.closeTaskModal = function() {
  document.getElementById('task-modal').classList.add('hidden');
};

window.deleteTask = async function(taskId) {
  if (!confirm(`Delete Task #${taskId}?`)) return;
  try {
    await apiFetch(`/api/tasks/${taskId}`, { method: 'DELETE' });
    showToast(`Task #${taskId} deleted`);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.openUserModal = function(userId = null) {
  document.getElementById('user-modal').classList.remove('hidden');

  document.getElementById('usr-role').innerHTML = state.meta.roles.filter(r => r.guard_name === 'web').map(r =>
    `<option value="${r.id}">${r.name}</option>`
  ).join('');

  const u = userId ? state.meta.users.find(x => Number(x.id) === Number(userId)) : null;
  document.getElementById('user-modal-title').textContent = u ? `Edit Member: ${u.first_name} ${u.last_name}` : 'Add Team Member';
  document.getElementById('usr-id').value = u ? u.id : '';
  document.getElementById('usr-first-name').value = u ? u.first_name : '';
  document.getElementById('usr-last-name').value = u ? u.last_name : '';
  document.getElementById('usr-email').value = u ? u.email : '';
  document.getElementById('usr-phone').value = u ? (u.phone || '') : '';
  document.getElementById('usr-status').value = u ? String(u.status) : '1';
  document.getElementById('usr-password').value = '';
  document.getElementById('usr-password').required = !u;
  document.getElementById('usr-pass-hint').textContent = u ? '(Leave blank to keep existing)' : '(Required for new users)';

  if (u && u.role_ids) {
    document.getElementById('usr-role').value = String(u.role_ids).split(',')[0];
  }

  const userWsIds = u && u.workspace_ids ? String(u.workspace_ids).split(',').map(Number) : state.meta.workspaces.map(w => Number(w.id));
  document.getElementById('usr-workspaces-checkboxes').innerHTML = state.meta.workspaces.map(w => `
    <label class="flex items-center gap-2 p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
      <input type="checkbox" name="usr_ws_ids" value="${w.id}" ${userWsIds.includes(Number(w.id)) ? 'checked' : ''} class="rounded text-blue-600" />
      <span class="truncate">${w.title}</span>
    </label>
  `).join('');
};

window.closeUserModal = function() {
  document.getElementById('user-modal').classList.add('hidden');
};

window.openWorkspaceModal = function(workspaceId = null) {
  const ws = workspaceId ? state.meta.workspaces.find(w => Number(w.id) === Number(workspaceId)) : null;
  document.getElementById('workspace-modal').classList.remove('hidden');
  document.getElementById('ws-id').value = ws ? ws.id : '';
  document.getElementById('workspace-modal-title').textContent = ws ? `Edit Workspace (#${ws.id})` : 'Create Workspace';
  document.getElementById('workspace-modal-submit').textContent = ws ? 'Save Changes' : 'Create Workspace';
  document.getElementById('ws-title').value = ws ? ws.title : '';
  document.getElementById('ws-is-primary').checked = ws ? Number(ws.is_primary) === 1 : false;

  const existingMembers = ws && ws.member_ids
    ? String(ws.member_ids).split(',').map(Number).filter(Boolean)
    : null;

  document.getElementById('ws-users-checkboxes').innerHTML = state.meta.users.map(u => {
    const isChecked = existingMembers ? existingMembers.includes(Number(u.id)) : true;
    return `
      <label class="flex items-center gap-2 p-1.5 rounded hover:bg-slate-100 dark:hover:bg-slate-800 cursor-pointer">
        <input type="checkbox" name="ws_user_ids" value="${u.id}" ${isChecked ? 'checked' : ''} class="rounded text-blue-600" />
        <span class="truncate">${u.first_name} ${u.last_name}</span>
      </label>
    `;
  }).join('');
};

window.closeWorkspaceModal = function() {
  document.getElementById('workspace-modal').classList.add('hidden');
};

// ============================================================================
// NAVIGATION & EVENTS
// ============================================================================
window.switchTab = function(tabName) {
  // Prevent navigating to a restricted tab if user lacks permission
  const targetNavBtn = document.querySelector(`.nav-tab[data-tab="${tabName}"]`);
  if (targetNavBtn && targetNavBtn.classList.contains('hidden')) {
    showToast('You do not have permission to access this section.', 'error');
    return;
  }

  state.activeTab = tabName;
  document.querySelectorAll('.tab-panel').forEach(el => el.classList.add('hidden'));
  document.getElementById(`tab-${tabName}`)?.classList.remove('hidden');

  // Toggle active classes WITHOUT wiping hidden or permission-gate classes
  const activeCls = ['font-semibold', 'bg-blue-50', 'text-blue-700', 'dark:bg-blue-950/60', 'dark:text-blue-300'];
  const inactiveCls = ['font-medium', 'text-slate-600', 'dark:text-slate-300', 'hover:bg-slate-100', 'dark:hover:bg-slate-700/60'];
  document.querySelectorAll('.nav-tab').forEach(btn => {
    if (btn.dataset.tab === tabName) {
      btn.classList.remove(...inactiveCls);
      btn.classList.add(...activeCls);
    } else {
      btn.classList.remove(...activeCls);
      btn.classList.add(...inactiveCls);
    }
  });

  // Update mobile bottom nav active highlight
  document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
    const isAct = btn.dataset.mobileTab === tabName;
    btn.classList.toggle('text-blue-600', isAct);
    btn.classList.toggle('font-semibold', isAct);
    btn.classList.toggle('text-slate-500', !isAct);
    btn.classList.toggle('dark:text-slate-400', !isAct);
    btn.classList.toggle('font-medium', !isAct);
  });

  // Auto-close mobile drawer when switching tabs on small screens
  toggleMobileSidebar(false);

  const titles = {
    overview: 'Executive Summary & Today\'s Schedule',
    projects: 'Projects Management',
    tasks: 'Tasks & Time-Slot Execution',
    meetings: 'Meetings & Agendas',
    team: 'Team Members & Workload',
    clients: 'Clients Directory',
    workspaces: 'Workspaces',
    cron: 'Automated Cron Scheduler & Email Engine',
    'email-settings': 'SMTP Email Settings (Admin & Super Admin Only)',
    settings: 'Statuses, Priorities, Tags & Roles',
    activity: 'System Audit Log & Leave Approvals'
  };
  document.getElementById('page-title').textContent = titles[tabName] || 'Task Manager';
  if (tabName === 'email-settings') {
    loadEmailSettings();
  } else if (tabName === 'meetings') {
    setMeetingsTabMode(state.meetingsTabMode || 'calendar');
  } else if (tabName === 'team') {
    setTeamTabMode(workloadReportState.tabMode || 'workload');
  }
};

// ============================================================================
// REAL-TIME NOTIFICATIONS, BELL DROPDOWN & CLICK REDIRECTS
// ============================================================================
window.loadNotifications = async function() {
  try {
    const res = await apiFetch('/api/notifications');
    const unread = Number(res.unreadCount || 0);
    const badge = document.getElementById('notif-unread-badge');
    if (unread > 0) {
      badge.textContent = unread > 99 ? '99+' : unread;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    const listEl = document.getElementById('notif-list-container');
    const items = res.notifications || [];
    if (items.length === 0) {
      listEl.innerHTML = `<p class="py-8 text-center text-slate-400">No notifications yet.</p>`;
      return;
    }

    listEl.innerHTML = items.map(n => {
      const isUnread = !n.read_at;
      const cleanMsg = stripHtml(n.message);
      const isMention = String(n.type).includes('mention') || n.action === 'mentioned';
      const iconBadge = isMention
        ? `<span class="px-1.5 py-0.5 rounded bg-blue-600 text-white text-[9px] font-bold">@TAG</span>`
        : `<span class="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-700 text-slate-700 dark:text-slate-300 text-[9px] font-semibold uppercase">${n.type}</span>`;

      return `
        <div onclick="handleNotificationClick(${n.id}, '${n.type}', ${n.type_id || 0})"
          class="p-3.5 cursor-pointer hover:bg-slate-50 dark:hover:bg-slate-700/50 transition flex items-start gap-3 ${isUnread ? 'bg-blue-50/40 dark:bg-blue-950/25' : ''}">
          <div class="w-2 h-2 rounded-full mt-1.5 shrink-0 ${isUnread ? 'bg-blue-600' : 'bg-transparent'}"></div>
          <div class="flex-1 min-w-0">
            <div class="flex items-center justify-between gap-2 mb-0.5">
              ${iconBadge}
              <span class="text-[10px] text-slate-400 font-mono">${String(n.created_at || '').substring(0, 16)}</span>
            </div>
            <div class="font-bold text-slate-900 dark:text-white text-xs truncate">${n.title || 'Notification'}</div>
            <p class="text-[11px] text-slate-600 dark:text-slate-300 line-clamp-2 mt-0.5">${cleanMsg}</p>
          </div>
        </div>
      `;
    }).join('');
  } catch (e) {}
};

window.handleNotificationClick = async function(notificationId, type, typeId) {
  try {
    await apiFetch(`/api/notifications/${notificationId}/read`, { method: 'PUT' });
  } catch (e) {}

  document.getElementById('notif-dropdown').classList.add('hidden');
  await loadNotifications();

  const t = String(type || '').toLowerCase();
  if (t.includes('task') && Number(typeId) > 0) {
    switchTab('tasks');
    openDiscussionModal('task', Number(typeId));
  } else if (t.includes('project') && Number(typeId) > 0) {
    switchTab('projects');
    openProjectDetailModal(Number(typeId));
  } else if (t.includes('meeting')) {
    switchTab('meetings');
  } else {
    switchTab('overview');
  }
};

window.markAllNotificationsRead = async function() {
  try {
    await apiFetch('/api/notifications/read-all', { method: 'PUT' });
    await loadNotifications();
    showToast('All notifications marked as read');
  } catch (err) {
    showToast(err.message, 'error');
  }
};

// ============================================================================
// UNIFIED TASK DETAILED VIEW MODAL (View Task + Subtasks + Timeline + Comments & @Tagging)
// ============================================================================
const selectedMentionUserIds = new Set();

window.openDiscussionModal = async function(type, entityId) {
  if (type === 'project') {
    return openProjectDetailModal(entityId);
  }

  selectedMentionUserIds.clear();
  const modal = document.getElementById('discussion-modal');
  modal.classList.remove('hidden');

  document.getElementById('disc-type').value = 'task';
  document.getElementById('disc-id').value = entityId;
  document.getElementById('disc-content').value = '';
  document.getElementById('disc-entity-badge').textContent = `VIEW TASK #${entityId}`;

  const entity = state.tasks.find(t => Number(t.id) === Number(entityId));
  document.getElementById('disc-title').textContent = entity ? entity.title : `Task #${entityId}`;
  document.getElementById('disc-time-slot-badge').innerHTML = entity ? formatTimeSlotBadge(entity.start_time, entity.end_time) : '';

  const assigneesStr = entity && entity.users?.length ? entity.users.map(u => `${u.first_name} ${u.last_name}`).join(', ') : 'Unassigned';
  document.getElementById('disc-subtitle-meta').textContent = entity
    ? `Project: ${entity.project_title || '—'} • Assigned: ${assigneesStr} • Priority: ${entity.priority_title || 'Normal'} • Due: ${formatDate(entity.due_date)}`
    : '';

  document.getElementById('disc-description-box').textContent = (entity && stripHtml(entity.description)) || 'No task description provided.';

  document.getElementById('disc-edit-entity-btn').onclick = () => {
    closeDiscussionModal();
    openTaskModal(entityId);
  };

  // Status quick switcher inside Task View modal
  const statusSelect = document.getElementById('disc-status-select');
  statusSelect.innerHTML = state.meta.statuses.map(s =>
    `<option value="${s.id}" ${entity && Number(s.id) === Number(entity.status_id) ? 'selected' : ''}>${s.title}</option>`
  ).join('');
  statusSelect.onchange = async () => {
    await quickUpdateTaskStatus(entityId, statusSelect.value);
    await loadTaskDetailSections(entityId);
    const updated = state.tasks.find(t => Number(t.id) === Number(entityId));
    if (updated) syncDiscCompletionControl(updated);
  };

  // Completion % quick switcher inside Task View modal
  const syncDiscCompletionControl = (taskObj) => {
    const pctSelect = document.getElementById('disc-completion-select');
    const pctBar = document.getElementById('disc-completion-bar');
    if (!pctSelect) return;
    const curPct = Number(taskObj?.completion_percentage || (String(taskObj?.status_title || '').toLowerCase().includes('complete') ? 100 : 0));
    const presets = [0, 10, 25, 50, 75, 90, 100];
    if (!presets.includes(curPct)) presets.push(curPct);
    presets.sort((a, b) => a - b);
    pctSelect.innerHTML = presets.map(v => `<option value="${v}" ${v === curPct ? 'selected' : ''}>${v}%</option>`).join('');
    if (pctBar) {
      pctBar.style.width = `${curPct}%`;
      pctBar.className = `h-full transition-all ${curPct === 100 ? 'bg-emerald-500' : (curPct >= 50 ? 'bg-blue-600' : 'bg-amber-500')}`;
    }
  };
  syncDiscCompletionControl(entity);
  const compSelEl = document.getElementById('disc-completion-select');
  if (compSelEl) {
    compSelEl.onchange = async () => {
      await quickUpdateTaskCompletion(entityId, compSelEl.value);
      const updated = state.tasks.find(t => Number(t.id) === Number(entityId));
      if (updated) {
        syncDiscCompletionControl(updated);
        statusSelect.value = String(updated.status_id);
      }
      await loadTaskDetailSections(entityId);
    };
  }

  // Populate Inline Subtask Form Dropdowns
  document.getElementById('subtask-title').value = '';
  document.getElementById('subtask-due-date').value = entity && entity.due_date ? String(entity.due_date).substring(0, 10) : new Date().toISOString().substring(0, 10);
  document.getElementById('subtask-status').innerHTML = state.meta.statuses.map(s =>
    `<option value="${s.id}">${s.title}</option>`
  ).join('');
  document.getElementById('subtask-priority').innerHTML = `<option value="0">Normal Priority</option>` +
    state.meta.priorities.map(p => `<option value="${p.id}">${p.title}</option>`).join('');

  const defaultAssignees = entity ? (entity.user_ids || []) : [];
  document.getElementById('subtask-users-checkboxes').innerHTML = state.meta.users.map(u => `
    <label class="flex items-center gap-1.5 px-2 py-1 rounded bg-white dark:bg-slate-800 border border-slate-300 dark:border-slate-600 cursor-pointer text-[11px]">
      <input type="checkbox" name="subtask_user_ids" value="${u.id}" ${defaultAssignees.includes(Number(u.id)) ? 'checked' : ''} class="rounded text-blue-600" />
      <span>${u.first_name}</span>
    </label>
  `).join('');

  // Render Tagging User Pills
  renderDiscussionTagPills();
  await loadTaskDetailSections(entityId);
};

async function loadTaskDetailSections(taskId) {
  await loadDiscussionComments('task', taskId);

  try {
    const res = await apiFetch(`/api/tasks/${taskId}/details`);
    const subtasks = res.subtasks || [];
    const timelines = res.timelines || [];

    const completedSubs = subtasks.filter(st => String(st.status_title).toLowerCase().includes('complete') || Number(st.completion_percentage) === 100).length;
    document.getElementById('disc-subtasks-count-badge').textContent = `${completedSubs} / ${subtasks.length} Done`;

    const subTbody = document.getElementById('disc-subtasks-tbody');
    if (subtasks.length === 0) {
      subTbody.innerHTML = `<tr><td colspan="6" class="py-4 text-center text-slate-400">No subtasks created yet. Add a subtask above!</td></tr>`;
    } else {
      subTbody.innerHTML = subtasks.map(st => {
        const statusOpts = state.meta.statuses.map(s =>
          `<option value="${s.id}" ${Number(s.id) === Number(st.status_id) ? 'selected' : ''}>${s.title}</option>`
        ).join('');
        const isDone = String(st.status_title).toLowerCase().includes('complete') || Number(st.completion_percentage) === 100;

        return `
          <tr class="hover:bg-slate-50 dark:hover:bg-slate-700/40">
            <td class="py-2 px-3 font-semibold ${isDone ? 'line-through text-slate-400' : 'text-slate-900 dark:text-white'}">
              ↳ ${st.title}
            </td>
            <td class="py-2 px-3 text-slate-600 dark:text-slate-300">${st.assignees || 'Unassigned'}</td>
            <td class="py-2 px-3"><span class="px-2 py-0.5 rounded text-[10px] border ${badgeClass(st.priority_color)}">${st.priority_title || 'Normal'}</span></td>
            <td class="py-2 px-3">
              <select onchange="quickUpdateTaskStatus(${st.id}, this.value).then(() => loadTaskDetailSections(${taskId}))"
                class="px-2 py-1 rounded bg-white dark:bg-slate-900 border border-slate-300 dark:border-slate-600 text-[11px] font-medium">
                ${statusOpts}
              </select>
            </td>
            <td class="py-2 px-3 font-mono">${formatDate(st.due_date)}</td>
            <td class="py-2 px-3 text-right space-x-1">
              <button onclick="openDiscussionModal('task', ${st.id})" class="px-2 py-0.5 rounded bg-blue-50 text-blue-700 text-[10px] font-semibold">View</button>
              <button onclick="deleteTask(${st.id}).then(() => loadTaskDetailSections(${taskId}))" class="px-2 py-0.5 rounded bg-red-50 text-red-600 text-[10px]">Del</button>
            </td>
          </tr>
        `;
      }).join('');
    }

    const tlEl = document.getElementById('disc-timeline-list');
    if (timelines.length === 0) {
      tlEl.innerHTML = `<p class="text-center py-6 text-slate-400">No status changes recorded for this task yet.</p>`;
    } else {
      tlEl.innerHTML = timelines.map(tl => `
        <div class="p-3 rounded-lg bg-white dark:bg-slate-800 border border-slate-200 dark:border-slate-700 flex items-center justify-between">
          <div>
            <span class="text-slate-500">Status moved from</span>
            <strong class="mx-1 text-slate-700 dark:text-slate-300">${tl.previous_status || '-'}</strong>
            <span class="text-slate-500">to</span>
            <strong class="ml-1 px-2 py-0.5 rounded text-[11px] border ${badgeClass(tl.new_color)}">${tl.status}</strong>
          </div>
          <span class="text-slate-400 font-mono text-[10px]">${String(tl.changed_at || tl.created_at || '').substring(0, 16)}</span>
        </div>
      `).join('');
    }
  } catch (e) {}
}

function renderDiscussionTagPills() {
  const container = document.getElementById('disc-tag-users-pills');
  container.innerHTML = state.meta.users.map(u => {
    const isTagged = selectedMentionUserIds.has(Number(u.id));
    return `
      <button type="button" onclick="toggleDiscussionMention(${u.id}, '${u.first_name}')"
        class="px-2.5 py-1 rounded-full text-[11px] font-semibold border transition ${
          isTagged
            ? 'bg-blue-600 text-white border-blue-600'
            : 'bg-slate-100 dark:bg-slate-900 text-slate-700 dark:text-slate-300 border-slate-300 dark:border-slate-600 hover:border-blue-400'
        }">
        @${u.first_name} ${u.last_name || ''}
      </button>
    `;
  }).join('');
}

window.toggleDiscussionMention = function(userId, firstName) {
  const uid = Number(userId);
  const textarea = document.getElementById('disc-content');
  if (selectedMentionUserIds.has(uid)) {
    selectedMentionUserIds.delete(uid);
  } else {
    selectedMentionUserIds.add(uid);
    if (!textarea.value.includes(`@${firstName}`)) {
      textarea.value = `${textarea.value.trim()} @${firstName} `.trimStart();
    }
    textarea.focus();
  }
  renderDiscussionTagPills();
};

async function loadDiscussionComments(type, entityId) {
  const listEl = document.getElementById('disc-comments-list');
  listEl.innerHTML = `<p class="text-center py-4 text-slate-400">Loading discussion...</p>`;
  try {
    const res = await apiFetch(`/api/comments?type=${type}&id=${entityId}`);
    const comments = res.comments || [];
    if (comments.length === 0) {
      listEl.innerHTML = `<p class="text-center py-6 text-slate-400">No comments yet. Write a comment or @tag a team member below.</p>`;
      return;
    }

    listEl.innerHTML = comments.map(c => {
      const text = stripHtml(c.content).replace(/(@\w+)/g, '<strong class="text-blue-600 dark:text-blue-400">$1</strong>');
      const canDel = state.user?.isAdminOrHasAllDataAccess || Number(c.commenter_id) === Number(state.user?.id);
      return `
        <div class="p-3.5 rounded-xl bg-slate-50 dark:bg-slate-900 border border-slate-200 dark:border-slate-700">
          <div class="flex items-center justify-between mb-1">
            <span class="font-bold text-slate-900 dark:text-white">${c.author_name || 'Team Member'}</span>
            <div class="flex items-center gap-2">
              <span class="text-[10px] font-mono text-slate-400">${String(c.created_at || '').substring(0, 16)}</span>
              ${canDel ? `<button onclick="deleteDiscussionComment(${c.id}, '${type}', ${entityId})" class="text-slate-400 hover:text-red-600 text-[10px]">Delete</button>` : ''}
            </div>
          </div>
          <p class="text-slate-700 dark:text-slate-200 leading-relaxed whitespace-pre-line">${text}</p>
        </div>
      `;
    }).join('');
    listEl.scrollTop = listEl.scrollHeight;
  } catch (err) {
    listEl.innerHTML = `<p class="text-red-500 text-center py-4">${err.message}</p>`;
  }
}

window.deleteDiscussionComment = async function(commentId, type, entityId) {
  try {
    await apiFetch(`/api/comments/${commentId}`, { method: 'DELETE' });
    await loadDiscussionComments(type, entityId);
    await loadAllData();
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.closeDiscussionModal = function() {
  document.getElementById('discussion-modal').classList.add('hidden');
};

// ============================================================================
// EMAIL SETTINGS (SMTP) — ADMIN & SUPER ADMIN ONLY
// ============================================================================
window.loadEmailSettings = async function() {
  if (!state.user?.isStrictAdmin) return;
  try {
    const res = await apiFetch('/api/email-settings');
    const es = res.emailSettings || {};
    document.getElementById('es-smtp-host').value = es.smtp_host || '';
    document.getElementById('es-smtp-port').value = es.smtp_port || '587';
    document.getElementById('es-email').value = es.email || '';
    document.getElementById('es-password').value = es.password || '';
    document.getElementById('es-encryption').value = es.smtp_encryption || 'tls';
    document.getElementById('es-content-type').value = es.email_content_type || 'html';
    document.getElementById('es-test-recipient').value = state.user?.email || es.email || '';
  } catch (err) {
    showToast(err.message, 'error');
  }
};

window.sendTestSmtpEmail = async function() {
  const to_email = document.getElementById('es-test-recipient').value || state.user?.email;
  try {
    showToast('Sending test email via SMTP...');
    const res = await apiFetch('/api/email-settings/test', {
      method: 'POST',
      body: JSON.stringify({ to_email })
    });
    showToast(res.message);
  } catch (err) {
    showToast(err.message, 'error');
  }
};

function bindEvents() {
  document.getElementById('theme-toggle-btn').addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('ceo_theme', state.theme);
    applyTheme();
    if (state.overview) renderCharts(state.overview);
  });

  document.getElementById('open-customize-btn').addEventListener('click', () => {
    document.getElementById('customize-bar').classList.toggle('hidden');
  });

  document.querySelectorAll('.widget-toggle').forEach(cb => {
    cb.addEventListener('change', (e) => {
      const target = document.getElementById(e.target.dataset.target);
      if (target) {
        if (e.target.checked) target.classList.remove('hidden');
        else target.classList.add('hidden');
      }
    });
  });

  document.getElementById('apply-date-filter-btn').addEventListener('click', async () => {
    state.dateFilter.start_date = document.getElementById('overview-start-date').value;
    state.dateFilter.end_date = document.getElementById('overview-end-date').value;
    await loadAllData();
    showToast('Date filter applied');
  });

  document.getElementById('clear-date-filter-btn').addEventListener('click', async () => {
    document.getElementById('overview-start-date').value = '';
    document.getElementById('overview-end-date').value = '';
    state.dateFilter = { start_date: '', end_date: '' };
    await loadAllData();
    showToast('Date filter cleared');
  });

  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('login-error');
    errEl.classList.add('hidden');
    const email = document.getElementById('login-email').value;
    const password = document.getElementById('login-password').value;

    try {
      const res = await apiFetch('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password })
      });
      state.token = res.token;
      state.user = res.user;
      localStorage.setItem('ceo_token', res.token);
      showToast(`Welcome back, ${res.user.first_name}!`);
      await enterDashboard();
    } catch (err) {
      errEl.textContent = err.message || 'Invalid credentials';
      errEl.classList.remove('hidden');
    }
  });

  document.getElementById('logout-btn').addEventListener('click', handleLogout);

  document.querySelectorAll('.nav-tab').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('global-workspace-select').addEventListener('change', async (e) => {
    state.selectedWorkspace = e.target.value;
    localStorage.setItem('ceo_workspace', state.selectedWorkspace);
    await loadAllData();
    showToast('Workspace updated');
  });

  document.getElementById('refresh-data-btn').addEventListener('click', async () => {
    await loadAllData();
    showToast('Refreshed live data');
  });
  document.getElementById('quick-new-project-btn').addEventListener('click', () => openProjectModal());
  document.getElementById('quick-new-task-btn').addEventListener('click', () => openTaskModal());

  ['filter-project-search', 'filter-project-status', 'filter-project-priority', 'filter-project-user'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderProjectsViews);
    document.getElementById(id)?.addEventListener('change', renderProjectsViews);
  });

  ['filter-task-search', 'filter-task-project', 'filter-task-status', 'filter-task-priority', 'filter-task-user'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', renderTasksViews);
    document.getElementById(id)?.addEventListener('change', renderTasksViews);
  });

  // Quick Todo Form
  document.getElementById('quick-todo-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = document.getElementById('quick-todo-input');
    if (!input.value.trim()) return;
    try {
      await apiFetch('/api/todos', {
        method: 'POST',
        body: JSON.stringify({ title: input.value.trim() })
      });
      input.value = '';
      await loadAllData();
      showToast('Added to checklist');
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Project Form
  document.getElementById('project-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('proj-id').value;
    const user_ids = Array.from(document.querySelectorAll('input[name="proj_user_ids"]:checked')).map(cb => Number(cb.value));
    const tag_ids = Array.from(document.querySelectorAll('input[name="proj_tag_ids"]:checked')).map(cb => Number(cb.value));

    const payload = {
      title: document.getElementById('proj-title').value,
      workspace_id: Number(document.getElementById('proj-workspace').value),
      status_id: Number(document.getElementById('proj-status').value),
      priority_id: Number(document.getElementById('proj-priority').value) || null,
      budget: document.getElementById('proj-budget').value || null,
      start_date: document.getElementById('proj-start-date').value || null,
      end_date: document.getElementById('proj-end-date').value || null,
      task_accessibility: document.getElementById('proj-task-accessibility').value,
      enable_tasks_time_entries: document.getElementById('proj-time-entries').checked ? 1 : 0,
      send_email_notification: document.getElementById('proj-send-email')?.checked ?? true,
      description: document.getElementById('proj-description').value || null,
      user_ids,
      tag_ids
    };

    try {
      if (id) {
        await apiFetch(`/api/projects/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Project updated');
      } else {
        await apiFetch('/api/projects', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Project created & team notified');
      }
      closeProjectModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Task Form (With Time-Slot, Recurring & Reminder)
  document.getElementById('task-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('task-id').value;
    const user_ids = Array.from(document.querySelectorAll('input[name="task_user_ids"]:checked')).map(cb => Number(cb.value));

    const payload = {
      title: document.getElementById('task-title').value,
      project_id: Number(document.getElementById('task-project').value),
      status_id: Number(document.getElementById('task-status').value),
      priority_id: Number(document.getElementById('task-priority').value) || null,
      start_date: document.getElementById('task-start-date').value || null,
      due_date: document.getElementById('task-due-date').value || null,
      start_time: document.getElementById('task-start-time').value || null,
      end_time: document.getElementById('task-end-time').value || null,
      is_recurring: document.getElementById('task-is-recurring').checked,
      recurring_frequency: document.getElementById('task-recurring-frequency').value,
      recurring_occurrences: document.getElementById('task-recurring-occurrences').value || null,
      enable_reminder: document.getElementById('task-enable-reminder').checked,
      reminder_frequency: document.getElementById('task-reminder-frequency').value,
      reminder_time: document.getElementById('task-reminder-time').value || '09:00',
      send_email_notification: document.getElementById('task-send-email').checked,
      completion_percentage: Number(document.getElementById('task-completion').value || 0),
      description: document.getElementById('task-description').value || null,
      user_ids
    };

    try {
      if (id) {
        await apiFetch(`/api/tasks/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Task & time slot updated');
      } else {
        await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Task scheduled & email notification sent');
      }
      closeTaskModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Meeting Form (Team or Individual 1-on-1 + Auto-Recurring Schedule)
  document.getElementById('meeting-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user_ids = Array.from(document.querySelectorAll('input[name="mt_user_ids"]:checked')).map(cb => Number(cb.value));
    const recFreq = document.getElementById('mt-recurring-freq').value;
    const payload = {
      title: document.getElementById('mt-title').value,
      workspace_id: Number(document.getElementById('mt-workspace').value),
      meeting_date: document.getElementById('mt-date').value,
      start_time: document.getElementById('mt-start-time').value,
      end_time: document.getElementById('mt-end-time').value,
      scope: document.getElementById('mt-scope').value || 'team',
      is_recurring: recFreq !== 'none',
      recurring_frequency: recFreq !== 'none' ? recFreq : null,
      agenda_notes: document.getElementById('mt-agenda-notes').value || '',
      send_email_notification: document.getElementById('mt-send-email').checked,
      client_ids: Array.from(document.querySelectorAll('input[name="mt_client_ids"]:checked')).map(cb => Number(cb.value)),
      guests: draftMeetingGuests,
      generate_future_weeks: 4,
      user_ids
    };
    try {
      const res = await apiFetch('/api/meetings', { method: 'POST', body: JSON.stringify(payload) });
      showToast(res.message || 'Meeting scheduled & email invitations sent');
      closeMeetingModal();
      await loadAllData();
      await loadNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Postpone / Reschedule Meeting Form
  document.getElementById('meeting-postpone-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = Number(document.getElementById('postpone-meeting-id').value);
    const payload = {
      new_date: document.getElementById('postpone-new-date').value,
      new_start_time: document.getElementById('postpone-new-start').value,
      new_end_time: document.getElementById('postpone-new-end').value,
      reason: document.getElementById('postpone-reason').value,
      send_email_notification: document.getElementById('postpone-send-email').checked
    };
    try {
      const res = await apiFetch(`/api/meetings/${id}/postpone`, { method: 'PUT', body: JSON.stringify(payload) });
      showToast(res.message);
      closePostponeMeetingModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Meeting Attendance & Minutes of Meeting (MoM) Form
  document.getElementById('meeting-mom-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const meetingId = Number(document.getElementById('mom-meeting-id').value);
    const actTitle = document.getElementById('mom-action-task-title').value?.trim();
    const actProj = document.getElementById('mom-action-task-project').value;
    const actUser = document.getElementById('mom-action-task-user').value;

    const create_tasks = [];
    if (actTitle && actProj) {
      create_tasks.push({
        title: actTitle,
        project_id: Number(actProj),
        assignee_id: actUser ? Number(actUser) : null,
        due_date: new Date().toISOString().substring(0, 10)
      });
    }

    const payload = {
      status: document.getElementById('mom-meeting-status').value,
      attendance: currentMomAttendanceMap,
      guests: currentMomGuests,
      guest_attendance: currentMomGuestAttendanceMap,
      mom_highlights: document.getElementById('mom-highlights').value,
      mom_discussion: document.getElementById('mom-discussion').value,
      mom_decisions: document.getElementById('mom-decisions').value,
      create_tasks,
      email_mom_to_participants: document.getElementById('mom-send-email').checked
    };

    try {
      const res = await apiFetch(`/api/meetings/${meetingId}/governance`, {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(res.message);
      closeMeetingMomModal();
      await loadAllData();
      if (!document.getElementById('meetings-subview-report')?.classList.contains('hidden')) {
        await loadMonthlyMeetingReport();
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Instant Notification / Email Broadcast Form
  document.getElementById('notify-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const user_ids = Array.from(document.querySelectorAll('input[name="nt_user_ids"]:checked')).map(cb => Number(cb.value));
    const payload = {
      subject: document.getElementById('nt-subject').value,
      message: document.getElementById('nt-message').value,
      user_ids,
      send_email: true
    };
    try {
      const res = await apiFetch('/api/notifications/send', { method: 'POST', body: JSON.stringify(payload) });
      showToast(res.message);
      closeNotifyModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // User Form
  document.getElementById('user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('usr-id').value;
    const workspace_ids = Array.from(document.querySelectorAll('input[name="usr_ws_ids"]:checked')).map(cb => Number(cb.value));

    const payload = {
      first_name: document.getElementById('usr-first-name').value,
      last_name: document.getElementById('usr-last-name').value,
      email: document.getElementById('usr-email').value,
      phone: document.getElementById('usr-phone').value,
      role_id: Number(document.getElementById('usr-role').value),
      status: Number(document.getElementById('usr-status').value),
      password: document.getElementById('usr-password').value || undefined,
      workspace_ids
    };

    try {
      if (id) {
        await apiFetch(`/api/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
        showToast('Team member updated');
      } else {
        await apiFetch('/api/users', { method: 'POST', body: JSON.stringify(payload) });
        showToast('Team member created');
      }
      closeUserModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Client Form
  document.getElementById('client-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      first_name: document.getElementById('cli-first-name').value,
      last_name: document.getElementById('cli-last-name').value,
      company: document.getElementById('cli-company').value,
      email: document.getElementById('cli-email').value,
      phone: document.getElementById('cli-phone').value
    };
    try {
      await apiFetch('/api/clients', { method: 'POST', body: JSON.stringify(payload) });
      showToast('Client added');
      closeClientModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Workspace Form (Create or Edit)
  document.getElementById('workspace-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const wsId = document.getElementById('ws-id').value;
    const user_ids = Array.from(document.querySelectorAll('input[name="ws_user_ids"]:checked')).map(cb => Number(cb.value));
    const title = document.getElementById('ws-title').value;
    const is_primary = document.getElementById('ws-is-primary').checked ? 1 : 0;
    try {
      if (wsId) {
        await apiFetch(`/api/workspaces/${wsId}`, { method: 'PUT', body: JSON.stringify({ title, is_primary, user_ids }) });
        showToast('Workspace updated');
      } else {
        await apiFetch('/api/workspaces', { method: 'POST', body: JSON.stringify({ title, is_primary, user_ids }) });
        showToast('Workspace created');
      }
      closeWorkspaceModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Add Status Form
  document.getElementById('add-status-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-status-title').value;
    const color = document.getElementById('new-status-color').value;
    try {
      await apiFetch('/api/statuses', { method: 'POST', body: JSON.stringify({ title, color }) });
      document.getElementById('new-status-title').value = '';
      showToast('Status added');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Add Priority Form
  document.getElementById('add-priority-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-priority-title').value;
    const color = document.getElementById('new-priority-color').value;
    try {
      await apiFetch('/api/priorities', { method: 'POST', body: JSON.stringify({ title, color }) });
      document.getElementById('new-priority-title').value = '';
      showToast('Priority added');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Add Tag Form
  document.getElementById('add-tag-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const title = document.getElementById('new-tag-title').value;
    try {
      await apiFetch('/api/tags', { method: 'POST', body: JSON.stringify({ title }) });
      document.getElementById('new-tag-title').value = '';
      showToast('Tag added');
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Role Form
  document.getElementById('role-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('role-id').value;
    const name = document.getElementById('role-name').value;
    const permission_ids = Array.from(document.querySelectorAll('input[name="role_perm_ids"]:checked')).map(cb => Number(cb.value));

    try {
      if (id) {
        await apiFetch(`/api/roles/${id}`, { method: 'PUT', body: JSON.stringify({ name, permission_ids }) });
        showToast('Role permissions updated');
      } else {
        await apiFetch('/api/roles', { method: 'POST', body: JSON.stringify({ name, permission_ids }) });
        showToast('New role created');
      }
      closeRoleModal();
      await loadAllData();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Notification Bell Toggle
  document.getElementById('notif-bell-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const dd = document.getElementById('notif-dropdown');
    dd.classList.toggle('hidden');
    if (!dd.classList.contains('hidden')) {
      loadNotifications();
    }
  });

  document.addEventListener('click', (e) => {
    const dd = document.getElementById('notif-dropdown');
    const btn = document.getElementById('notif-bell-btn');
    if (dd && !dd.classList.contains('hidden') && !dd.contains(e.target) && !btn.contains(e.target)) {
      dd.classList.add('hidden');
    }
  });

  // Discussion Comment & @Tag Form Submit
  document.getElementById('discussion-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const type = document.getElementById('disc-type').value;
    const id = Number(document.getElementById('disc-id').value);
    const content = document.getElementById('disc-content').value;
    const send_email = document.getElementById('disc-send-email').checked;

    try {
      const res = await apiFetch('/api/comments', {
        method: 'POST',
        body: JSON.stringify({
          type,
          id,
          content,
          mentioned_user_ids: [...selectedMentionUserIds],
          send_email
        })
      });
      document.getElementById('disc-content').value = '';
      selectedMentionUserIds.clear();
      renderDiscussionTagPills();
      showToast(res.message);
      await loadDiscussionComments(type, id);
      await loadAllData();
      await loadNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Email Settings (SMTP) Form Submit (Admin / Super Admin Only)
  document.getElementById('email-settings-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const payload = {
      smtp_host: document.getElementById('es-smtp-host').value,
      smtp_port: document.getElementById('es-smtp-port').value,
      email: document.getElementById('es-email').value,
      password: document.getElementById('es-password').value,
      smtp_encryption: document.getElementById('es-encryption').value,
      email_content_type: document.getElementById('es-content-type').value
    };
    try {
      const res = await apiFetch('/api/email-settings', {
        method: 'PUT',
        body: JSON.stringify(payload)
      });
      showToast(res.message);
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Subtask Creation Form inside Task Detailed View
  document.getElementById('subtask-create-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const parentTaskId = Number(document.getElementById('disc-id').value);
    const parentTask = state.tasks.find(t => Number(t.id) === parentTaskId);
    if (!parentTask) return;

    const user_ids = Array.from(document.querySelectorAll('input[name="subtask_user_ids"]:checked')).map(cb => Number(cb.value));
    const payload = {
      title: document.getElementById('subtask-title').value,
      project_id: Number(parentTask.project_id),
      parent_id: parentTaskId,
      status_id: Number(document.getElementById('subtask-status').value),
      priority_id: Number(document.getElementById('subtask-priority').value) || null,
      due_date: document.getElementById('subtask-due-date').value || null,
      user_ids,
      send_email_notification: true
    };

    try {
      await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('subtask-title').value = '';
      showToast('Subtask created & assignees notified');
      await loadAllData();
      await loadTaskDetailSections(parentTaskId);
      await loadNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Inline Task Creation Form inside Project Detailed View
  document.getElementById('proj-inline-task-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = Number(document.getElementById('pit-project-id').value);
    const user_ids = Array.from(document.querySelectorAll('input[name="pit_user_ids"]:checked')).map(cb => Number(cb.value));

    const payload = {
      title: document.getElementById('pit-title').value,
      project_id: projectId,
      status_id: Number(document.getElementById('pit-status').value),
      priority_id: Number(document.getElementById('pit-priority').value) || null,
      due_date: document.getElementById('pit-due-date').value || null,
      start_time: document.getElementById('pit-start-time').value || null,
      end_time: document.getElementById('pit-end-time').value || null,
      user_ids,
      send_email_notification: true
    };

    try {
      await apiFetch('/api/tasks', { method: 'POST', body: JSON.stringify(payload) });
      document.getElementById('pit-title').value = '';
      showToast('Task created inside project & team notified');
      await loadAllData();
      await openProjectDetailModal(projectId);
      await loadNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });

  // Project Detailed View Comment & @Tag Form
  document.getElementById('proj-detail-comment-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const projectId = Number(document.getElementById('pit-project-id').value);
    const content = document.getElementById('detail-proj-comment-input').value;
    const send_email = document.getElementById('detail-proj-comment-email').checked;

    try {
      const res = await apiFetch('/api/comments', {
        method: 'POST',
        body: JSON.stringify({
          type: 'project',
          id: projectId,
          content,
          mentioned_user_ids: [...selectedProjDetailMentions],
          send_email
        })
      });
      document.getElementById('detail-proj-comment-input').value = '';
      selectedProjDetailMentions.clear();
      showToast(res.message);
      await loadAllData();
      await openProjectDetailModal(projectId);
      await loadNotifications();
    } catch (err) {
      showToast(err.message, 'error');
    }
  });
}
