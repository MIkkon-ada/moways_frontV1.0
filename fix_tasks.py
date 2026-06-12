# -*- coding: utf-8 -*-
import sys, sqlite3
sys.stdout.reconfigure(encoding='utf-8')

conn = sqlite3.connect('bowei_ai_dashboard/bowei_ai_dashboard.db')
c = conn.cursor()

# 去掉 special_project 里的"专项"后缀，使其与 projects.name 完全一致
c.execute("UPDATE tasks SET special_project = REPLACE(special_project, '专项', '') WHERE special_project LIKE '%专项'")
print('updated rows:', c.rowcount)
conn.commit()

c.execute('SELECT DISTINCT special_project FROM tasks ORDER BY special_project')
print('distinct special_project values after fix:')
for r in c.fetchall():
    print(' ', r[0])

conn.close()
