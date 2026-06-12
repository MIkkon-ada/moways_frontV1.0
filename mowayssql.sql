-- Bowei AI Dashboard
-- Migration-capable SQL script
--
-- Usage intent:
-- 1. Fresh database: creates the full schema.
-- 2. Existing legacy database: creates missing new tables and patches old tables with ADD COLUMN.
--
-- Important:
-- 1. Run on a backed-up database.
-- 2. The ALTER TABLE section is designed for the current legacy schema and should be treated as a one-time migration.
-- 3. SQLite cannot reliably do conditional ADD COLUMN in pure SQL across versions, so rerunning the ALTER section may fail once columns already exist.

PRAGMA foreign_keys = OFF;
BEGIN TRANSACTION;

-- =========================================================
-- 1. Fresh-init schema
-- Ordered for creation:
-- 1. projects
-- 2. people
-- 3. project_memberships
-- 4. tasks
-- 5. update_submissions
-- 6. achievements
-- 7. issues
-- 8. decisions
-- 9. operation_logs
-- =========================================================

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_code VARCHAR(50) UNIQUE,
    name VARCHAR(100) NOT NULL UNIQUE,
    project_type VARCHAR(30) DEFAULT 'special', -- special / governance
    status VARCHAR(30) DEFAULT 'active', -- active / paused / closed
    description TEXT,
    sort_order INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS people (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name VARCHAR(50) NOT NULL UNIQUE,
    employee_code VARCHAR(50) UNIQUE,
    system_role VARCHAR(30) NOT NULL DEFAULT '普通成员', -- 组长CEO / 超级管理员 / 过程保障 / 普通成员
    role VARCHAR(40), -- legacy display field
    title VARCHAR(100),
    department VARCHAR(100),
    special_project_duty TEXT, -- legacy display field
    permission VARCHAR(40), -- legacy display field
    permission_scope VARCHAR(30) DEFAULT 'self', -- all / project / self
    contact VARCHAR(100), -- legacy display field
    phone VARCHAR(50),
    email VARCHAR(100),
    is_active BOOLEAN DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS project_memberships (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    person_id INTEGER NOT NULL,
    project_role VARCHAR(30) NOT NULL, -- coordinator / owner / collaborator
    can_submit_update BOOLEAN DEFAULT 0,
    can_confirm_submission BOOLEAN DEFAULT 0,
    can_view_project_dashboard BOOLEAN DEFAULT 1,
    is_active BOOLEAN DEFAULT 1,
    start_date DATE,
    end_date DATE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(person_id) REFERENCES people(id),
    UNIQUE(project_id, person_id, project_role)
);

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    task_code VARCHAR(50),
    special_project VARCHAR(80), -- compatibility field
    key_task VARCHAR(255) NOT NULL,
    key_achievement VARCHAR(255) DEFAULT '',
    completion_standard TEXT DEFAULT '',
    owner_person_id INTEGER,
    coordinator_person_id INTEGER,
    owner VARCHAR(50) DEFAULT '', -- compatibility field
    coordinator VARCHAR(50) DEFAULT '', -- compatibility field
    collaborators TEXT DEFAULT '', -- compatibility field
    plan_time VARCHAR(20) DEFAULT '',
    status VARCHAR(30) DEFAULT '未开始', -- 未开始 / 进行中 / 已完成 / 延期 / 暂缓
    problem_note TEXT DEFAULT '',
    achievement_links TEXT DEFAULT '',
    source_type VARCHAR(40) DEFAULT '人工录入', -- 人工录入 / 更新提交 / 会议 / Excel导入
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(owner_person_id) REFERENCES people(id),
    FOREIGN KEY(coordinator_person_id) REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS update_submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    source_type VARCHAR(40), -- voice / meeting / text / personal_update
    submitter_person_id INTEGER,
    target_owner_person_id INTEGER,
    current_handler_person_id INTEGER,
    submitter VARCHAR(50) DEFAULT '', -- compatibility field
    title VARCHAR(255) DEFAULT '',
    transcript_text TEXT NOT NULL,
    ai_result_json TEXT DEFAULT '',
    human_result_json TEXT DEFAULT '',
    workflow_status VARCHAR(30) DEFAULT 'pending_owner', -- 保留正式流转字段
    confirm_status VARCHAR(20) DEFAULT '待确认', -- compatibility field
    confidence DECIMAL(5,2) DEFAULT 0,
    related_task_id INTEGER,
    ceo_decision_required BOOLEAN DEFAULT 0,
    confirmed_by_person_id INTEGER,
    confirmed_by VARCHAR(50) DEFAULT '', -- compatibility field
    confirmed_at DATETIME,
    reject_reason TEXT DEFAULT '',
    feedback_to_submitter TEXT DEFAULT '',
    parent_submission_id INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(submitter_person_id) REFERENCES people(id),
    FOREIGN KEY(target_owner_person_id) REFERENCES people(id),
    FOREIGN KEY(current_handler_person_id) REFERENCES people(id),
    FOREIGN KEY(related_task_id) REFERENCES tasks(id),
    FOREIGN KEY(confirmed_by_person_id) REFERENCES people(id),
    FOREIGN KEY(parent_submission_id) REFERENCES update_submissions(id)
);

CREATE TABLE IF NOT EXISTS achievements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    related_task_id INTEGER,
    source_submission_id INTEGER,
    name VARCHAR(255) NOT NULL,
    achievement_type VARCHAR(40) DEFAULT '方案', -- 方案 / 表格 / 模板 / SOP / Prompt / Agent原型 / 会议纪要 / 复盘报告 / 案例包 / 产品材料
    special_project VARCHAR(80) DEFAULT '', -- compatibility field
    owner_person_id INTEGER,
    owner VARCHAR(50) DEFAULT '', -- compatibility field
    version VARCHAR(30) DEFAULT 'V0.1',
    file_link TEXT DEFAULT '',
    scenario TEXT DEFAULT '',
    reuse_tag VARCHAR(50) DEFAULT '内部使用', -- 内部使用 / 项目复用 / 产品材料 / 客户交付
    status VARCHAR(30) DEFAULT '草稿', -- 草稿 / 已形成 / 已归档 / 可复用
    is_desensitized BOOLEAN DEFAULT 0,
    approved_by_person_id INTEGER,
    approved_at DATETIME,
    source_type VARCHAR(40) DEFAULT '人工录入',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(related_task_id) REFERENCES tasks(id),
    FOREIGN KEY(source_submission_id) REFERENCES update_submissions(id),
    FOREIGN KEY(owner_person_id) REFERENCES people(id),
    FOREIGN KEY(approved_by_person_id) REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    related_task_id INTEGER,
    source_submission_id INTEGER,
    issue_code VARCHAR(50),
    issue_type VARCHAR(30) DEFAULT '问题', -- 问题 / 风险 / 决策 / 待协调
    description TEXT NOT NULL,
    special_project VARCHAR(80) DEFAULT '', -- compatibility field
    owner_person_id INTEGER,
    owner VARCHAR(50) DEFAULT '', -- compatibility field
    helper_person_id INTEGER,
    helper VARCHAR(100) DEFAULT '', -- compatibility field
    priority VARCHAR(20) DEFAULT '中', -- 高 / 中 / 低
    status VARCHAR(30) DEFAULT '待处理', -- 待处理 / 处理中 / 待决策 / 已解决 / 已关闭 / 已决策
    expected_resolve_time VARCHAR(50) DEFAULT '',
    resolution TEXT DEFAULT '',
    need_decision_by_person_id INTEGER,
    need_decision_by VARCHAR(50) DEFAULT '', -- compatibility field
    feedback_required BOOLEAN DEFAULT 0,
    feedback_result TEXT DEFAULT '',
    source_type VARCHAR(40) DEFAULT '人工录入',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(related_task_id) REFERENCES tasks(id),
    FOREIGN KEY(source_submission_id) REFERENCES update_submissions(id),
    FOREIGN KEY(owner_person_id) REFERENCES people(id),
    FOREIGN KEY(helper_person_id) REFERENCES people(id),
    FOREIGN KEY(need_decision_by_person_id) REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS decisions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    issue_id INTEGER,
    submission_id INTEGER,
    project_id INTEGER,
    requested_by_person_id INTEGER,
    decision_maker_person_id INTEGER,
    decision_type VARCHAR(30) DEFAULT 'direction', -- approval / direction / resource_request / milestone / risk_response
    request_summary TEXT DEFAULT '',
    request_context_json TEXT DEFAULT '',
    status VARCHAR(30) DEFAULT 'pending', -- pending / replied / returned_to_submitter / resubmitted / closed
    decision_comment TEXT DEFAULT '',
    decision_result VARCHAR(30) DEFAULT '', -- approved / rejected / revise_and_resubmit / continue_processing
    reply_to_submitter TEXT DEFAULT '',
    submitter_feedback TEXT DEFAULT '',
    replied_at DATETIME,
    feedback_submitted_at DATETIME,
    closed_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(issue_id) REFERENCES issues(id),
    FOREIGN KEY(submission_id) REFERENCES update_submissions(id),
    FOREIGN KEY(project_id) REFERENCES projects(id),
    FOREIGN KEY(requested_by_person_id) REFERENCES people(id),
    FOREIGN KEY(decision_maker_person_id) REFERENCES people(id)
);

CREATE TABLE IF NOT EXISTS operation_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    operator_person_id INTEGER,
    operator VARCHAR(50) DEFAULT '', -- compatibility field
    action VARCHAR(100) DEFAULT '',
    target_type VARCHAR(40) DEFAULT '', -- project / task / submission / achievement / issue / decision
    target_id INTEGER,
    before_json TEXT DEFAULT '',
    after_json TEXT DEFAULT '',
    remark TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(operator_person_id) REFERENCES people(id)
);

-- =========================================================
-- 2. Legacy-table patch section
-- Run on the current existing SQLite schema to add new fields.
-- Designed for the project's current old schema.
-- =========================================================

-- people
ALTER TABLE people ADD COLUMN employee_code VARCHAR(50);
ALTER TABLE people ADD COLUMN system_role VARCHAR(30) NOT NULL DEFAULT 'member';
ALTER TABLE people ADD COLUMN title VARCHAR(100);
ALTER TABLE people ADD COLUMN permission_scope VARCHAR(30) DEFAULT 'self';
ALTER TABLE people ADD COLUMN phone VARCHAR(50);
ALTER TABLE people ADD COLUMN email VARCHAR(100);

-- tasks
ALTER TABLE tasks ADD COLUMN project_id INTEGER;
ALTER TABLE tasks ADD COLUMN task_code VARCHAR(50);
ALTER TABLE tasks ADD COLUMN owner_person_id INTEGER;
ALTER TABLE tasks ADD COLUMN coordinator_person_id INTEGER;

-- update_submissions
ALTER TABLE update_submissions ADD COLUMN project_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN submitter_person_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN target_owner_person_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN current_handler_person_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN workflow_status VARCHAR(30) DEFAULT 'pending_owner';
ALTER TABLE update_submissions ADD COLUMN ceo_decision_required BOOLEAN DEFAULT 0;
ALTER TABLE update_submissions ADD COLUMN confirmed_by_person_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN feedback_to_submitter TEXT DEFAULT '';
ALTER TABLE update_submissions ADD COLUMN parent_submission_id INTEGER;
ALTER TABLE update_submissions ADD COLUMN confirmed_by VARCHAR(50) DEFAULT '';

-- achievements
ALTER TABLE achievements ADD COLUMN project_id INTEGER;
ALTER TABLE achievements ADD COLUMN source_submission_id INTEGER;
ALTER TABLE achievements ADD COLUMN owner_person_id INTEGER;
ALTER TABLE achievements ADD COLUMN approved_by_person_id INTEGER;
ALTER TABLE achievements ADD COLUMN approved_at DATETIME;
ALTER TABLE achievements ADD COLUMN is_desensitized BOOLEAN DEFAULT 0;

-- issues
ALTER TABLE issues ADD COLUMN project_id INTEGER;
ALTER TABLE issues ADD COLUMN source_submission_id INTEGER;
ALTER TABLE issues ADD COLUMN issue_code VARCHAR(50);
ALTER TABLE issues ADD COLUMN owner_person_id INTEGER;
ALTER TABLE issues ADD COLUMN helper_person_id INTEGER;
ALTER TABLE issues ADD COLUMN need_decision_by_person_id INTEGER;
ALTER TABLE issues ADD COLUMN feedback_required BOOLEAN DEFAULT 0;
ALTER TABLE issues ADD COLUMN feedback_result TEXT DEFAULT '';

-- operation_logs
ALTER TABLE operation_logs ADD COLUMN operator_person_id INTEGER;
ALTER TABLE operation_logs ADD COLUMN operator VARCHAR(50) DEFAULT '';
ALTER TABLE operation_logs ADD COLUMN remark TEXT DEFAULT '';
ALTER TABLE operation_logs ADD COLUMN updated_at DATETIME DEFAULT CURRENT_TIMESTAMP;

-- =========================================================
-- 3. Recommended indexes
-- =========================================================

CREATE INDEX IF NOT EXISTS idx_people_system_role ON people(system_role);
CREATE INDEX IF NOT EXISTS idx_projects_name ON projects(name);
CREATE INDEX IF NOT EXISTS idx_project_memberships_project_person ON project_memberships(project_id, person_id);
CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_person_id ON tasks(owner_person_id);
CREATE INDEX IF NOT EXISTS idx_update_submissions_project_id ON update_submissions(project_id);
CREATE INDEX IF NOT EXISTS idx_update_submissions_submitter_person_id ON update_submissions(submitter_person_id);
CREATE INDEX IF NOT EXISTS idx_achievements_project_id ON achievements(project_id);
CREATE INDEX IF NOT EXISTS idx_issues_project_id ON issues(project_id);
CREATE INDEX IF NOT EXISTS idx_decisions_issue_id ON decisions(issue_id);

COMMIT;
PRAGMA foreign_keys = ON;
