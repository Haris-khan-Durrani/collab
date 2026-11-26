# Taskify CEO Central Dashboard (Node.js)

An isolated, ultra-fast Node.js Executive & SuperAdmin portal located in `c:\laragon\www\taskify\ceo-dashboard` that connects directly to the existing Laravel MySQL database (`taskify1`).

## Key Capabilities
- **100% Isolated Folder**: All code resides inside `ceo-dashboard/`. Zero Laravel application files were modified.
- **Same Users & Spatie Roles**: Log in with your existing Laravel Super Admin / Admin credentials (e.g., `haris@docman.ae` or `admin@gmail.com`). Passwords (`$2y$` bcrypt), Spatie roles (`roles`, `model_has_roles`), permissions (`permissions`, `role_has_permissions`), and workspaces (`workspaces`, `user_workspace`) are shared in real time.
- **Sub-20ms Query Performance**: Uses a pooled `mysql2` connection executing 10 parallel analytical queries in ~19ms.
- **Full Two-Way Sync**:
  - Create, edit, and delete **Projects** (automatically populates `projects`, `project_user`, `client_project`, `project_tag`, `status_timelines`, and `activity_logs`).
  - Create, edit, quick-update status, and delete **Tasks** (populates `tasks`, `task_user`, `status_timelines`, and `activity_logs`).
  - Create and edit **Team Members** & assign **Spatie Roles** and **Workspaces**.

## How to Run
1. Double-click `start-ceo-dashboard.bat` inside `c:\laragon\www\taskify\ceo-dashboard`, or run:
   ```bash
   cd c:\laragon\www\taskify\ceo-dashboard
   node server.js
   ```
2. Open **http://localhost:4000** in your browser.
