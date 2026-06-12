# -*- coding: utf-8 -*-
import sys, sqlite3
sys.stdout.reconfigure(encoding='utf-8')
conn = sqlite3.connect('bowei_ai_dashboard/bowei_ai_dashboard.db')
c = conn.cursor()
print('=== tasks by project ===')
c.execute('SELECT t.project_id, p.name, t.special_project, COUNT(*) FROM tasks t LEFT JOIN projects p ON p.id=t.project_id GROUP BY t.project_id, t.special_project')
for r in c.fetchall():
    print(r)

print('\n=== projects list (as API returns) ===')
c.execute('SELECT id, name, is_active, sort_order FROM projects WHERE is_active=1 ORDER BY sort_order, id')
for r in c.fetchall():
    print(r)
conn.close()
