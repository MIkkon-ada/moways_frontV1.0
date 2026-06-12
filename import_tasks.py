# -*- coding: utf-8 -*-
import sys
sys.stdout.reconfigure(encoding='utf-8')

import openpyxl
import sqlite3
from datetime import datetime

EXCEL = '博维咨询2026升级工作推进计划表_V1.2.xlsx'
DB    = 'bowei_ai_dashboard/bowei_ai_dashboard.db'

STATUS_MAP = {
    '未启动': '未开始', '进行中': '进行中', '已完成': '已完成', '延期': '延期', '暂缓': '暂缓',
}

conn = sqlite3.connect(DB)
c = conn.cursor()

# 查所有项目
c.execute('SELECT id, name FROM projects')
projects = {name: pid for pid, name in c.fetchall()}
print('Projects in DB:', projects)

wb = openpyxl.load_workbook(EXCEL, data_only=True)
ws = wb['工作推进总表']
now = datetime.utcnow().isoformat()

rows_to_insert = []
unmatched = set()

for row in ws.iter_rows(min_row=2, values_only=True):
    seq, phase, special_project, key_task, key_achievement, completion_standard, \
    coordinator, owner, collaborators, plan_time, status, problem_note, remark = (list(row) + [None]*13)[:13]

    if not key_task:
        continue

    sp = str(special_project or '').strip()
    mapped_status = STATUS_MAP.get(str(status or '').strip(), '未开始')

    # 匹配 project_id：先精确匹配，再模糊匹配
    project_id = projects.get(sp)
    if project_id is None:
        for pname, pid in projects.items():
            if sp in pname or pname in sp:
                project_id = pid
                break
    if project_id is None:
        unmatched.add(sp)

    rows_to_insert.append((
        sp,
        str(key_task or '').strip(),
        str(key_achievement or '').strip(),
        str(completion_standard or '').strip(),
        str(coordinator or '').strip(),
        str(owner or '').strip(),
        str(collaborators or '').strip(),
        str(plan_time or '').strip(),
        mapped_status,
        str(problem_note or '').strip(),
        'Excel导入',
        now, now,
        project_id,
    ))

print(f'\n准备导入 {len(rows_to_insert)} 条，未匹配专项: {unmatched}')

c.execute('DELETE FROM tasks')
c.executemany('''
    INSERT INTO tasks (
        special_project, key_task, key_achievement, completion_standard,
        coordinator, owner, collaborators, plan_time, status,
        problem_note, source_type, created_at, updated_at, project_id
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
''', rows_to_insert)
conn.commit()
print(f'成功导入 {c.rowcount} 条记录')

# 验证
c.execute('SELECT special_project, project_id, key_task FROM tasks LIMIT 6')
print('\n验证：')
for r in c.fetchall():
    print(' ', r)

conn.close()
