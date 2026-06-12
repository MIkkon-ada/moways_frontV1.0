# -*- coding: utf-8 -*-
import sys, os
sys.stdout.reconfigure(encoding='utf-8')
os.chdir('bowei_ai_dashboard')
sys.path.insert(0, '.')

from app.database import SessionLocal
from app import crud, models
from app.permissions import get_user_context_from_db
from sqlalchemy import or_, and_

db = SessionLocal()

# 测试所有已知账号
for username in ['mowasyadmin', '冯海林', '吴肖']:
    ctx = get_user_context_from_db(username, db)
    print(f'\n=== {username} ===')
    print(f'  can_view_all={ctx["can_view_all"]}')
    q = db.query(models.Task)
    if not ctx['can_view_all']:
        if not ctx['visible_projects']:
            print('  visible_projects=[] → 0 tasks')
            continue
        q = q.filter(models.Task.special_project.in_(ctx['visible_projects']))
        print(f'  visible_projects={ctx["visible_projects"]}')
    for pid in [2, 3, 4, 5, 6, 7]:
        proj_name = crud.get_project_name_by_id(pid, db)
        count = q.filter(or_(
            models.Task.project_id == pid,
            and_(models.Task.project_id.is_(None), models.Task.special_project == proj_name)
        )).count()
        print(f'  project {pid} ({proj_name}): {count} tasks')
    # 重置query
    q = db.query(models.Task)
    if not ctx['can_view_all']:
        q = q.filter(models.Task.special_project.in_(ctx['visible_projects']))

db.close()
