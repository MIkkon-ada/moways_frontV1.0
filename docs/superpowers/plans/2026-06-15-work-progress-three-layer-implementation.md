# Work Progress Three Layer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing work progress table behave as Project -> key Task -> SubTask without rebuilding tables.

**Architecture:** Keep `Project`, `Task`, and `SubTask` tables. Add a small backend domain helper for task status semantics, let project members create subtasks, and synchronize parent task status from child subtasks after subtask changes. Update the frontend work progress page to present project-level responsibility separately from key-task and subtask fields.

**Tech Stack:** FastAPI, SQLAlchemy, pytest, React, TypeScript, Vite.

---

### Task 1: Backend Status Semantics

**Files:**
- Create: `D:\frontchange\moways_ai\bowei_ai_dashboard\app\domain\task_status.py`
- Test: `D:\frontchange\moways_ai\bowei_ai_dashboard\tests\test_work_progress_three_layer.py`

- [ ] **Step 1: Write failing tests for parent status derivation**

Test cases:
- no subtasks keeps the parent status unchanged
- any active subtask moves a not-started key task to in-progress
- all subtasks completed moves the key task to completed

- [ ] **Step 2: Run the test and verify it fails**

Run: `python -m pytest tests/test_work_progress_three_layer.py -q`
Expected: FAIL because `app.domain.task_status` does not exist.

- [ ] **Step 3: Implement status helper**

Add canonical normalization sets and `derive_parent_status(current_status, subtask_statuses)`.

- [ ] **Step 4: Run test and verify it passes**

Run: `python -m pytest tests/test_work_progress_three_layer.py -q`
Expected: PASS.

### Task 2: SubTask Rules and Parent Sync

**Files:**
- Modify: `D:\frontchange\moways_ai\bowei_ai_dashboard\app\routers\subtasks.py`
- Modify: `D:\frontchange\moways_ai\bowei_ai_dashboard\app\routers\tasks.py`
- Test: `D:\frontchange\moways_ai\bowei_ai_dashboard\tests\test_work_progress_three_layer.py`

- [ ] **Step 1: Write failing API tests**

Test cases:
- project member can create a subtask under a visible project task
- outsider cannot create a subtask
- creating/updating child subtasks updates parent key-task status
- parent key task cannot be manually completed while child subtasks are incomplete

- [ ] **Step 2: Run the API tests and verify they fail**

Run: `python -m pytest tests/test_work_progress_three_layer.py -q`
Expected: FAIL on current owner-only create rule and missing parent sync.

- [ ] **Step 3: Implement backend behavior**

Use project membership for subtask creation. After create/update/status/delete, recompute parent task status from all child subtasks. Block manual parent completion unless at least one child exists and all child subtasks are completed.

- [ ] **Step 4: Run focused backend tests**

Run: `python -m pytest tests/test_work_progress_three_layer.py -q`
Expected: PASS.

### Task 3: Frontend Three-Layer Presentation

**Files:**
- Modify: `D:\frontchange\moways_ai\frontend\src\types.ts`
- Modify: `D:\frontchange\moways_ai\frontend\src\pages\TaskManagementPage.tsx`

- [ ] **Step 1: Update frontend types**

Expose project `owners`, `coordinator`, and `collaborators` fields already returned by the backend.

- [ ] **Step 2: Update page presentation**

Show project-level owner/coordinator/collaborators in the project header and detail panel. Keep key-task fields focused on key task, completion standard, achievement, risk, and child progress. Label the table as key task list and show subtask progress as `done/total`.

- [ ] **Step 3: Remove frontend-only parent completion authority**

Keep client-side parent sync as a display refresh convenience, but backend remains the source of truth.

- [ ] **Step 4: Build frontend**

Run: `npm run build`
Expected: TypeScript and Vite build pass.

### Task 4: Verification

**Files:**
- No direct code changes.

- [ ] **Step 1: Run focused tests**

Run: `python -m pytest tests/test_work_progress_three_layer.py -q`
Expected: PASS.

- [ ] **Step 2: Run existing regression tests**

Run: `python -m pytest tests/test_core_business_regressions.py -q`
Expected: PASS.

- [ ] **Step 3: Compile backend**

Run: `python -m compileall app`
Expected: PASS.

- [ ] **Step 4: Build frontend**

Run: `npm run build`
Expected: PASS.

