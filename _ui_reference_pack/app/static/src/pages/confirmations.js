// AI确认中心页面模块
// 依赖：
//   components.js                 : esc, badge, emptyState, openModal, closeModal
//   src/appState.js               : state, members, PROJECTS
//   src/api/client.js             : api
//   src/api/cache.js              : invalidate
//   src/permissions/userContext.js : getCurrentUserContext, getCurrentUserName
//   src/permissions/permissions.js : canViewConfirmationCenter, canConfirmProject, canAssignSubmission
//   src/utils/format.js           : formatWaitText
//   src/utils/project.js          : normalizeProject

function sourceTypeMeta(sourceType) {
  if (sourceType === "meeting") return { label: "会议纪要", chipClass: "meeting" };
  if (sourceType === "text_update") return { label: "文字粘贴", chipClass: "text" };
  return { label: "语音更新", chipClass: "voice" };
}

const RETURNED_CONFIRM_STATUSES = new Set(["已打回", "已打回提交人", "returned_to_submitter", "已撤回", "withdrawn", "withdrawn_editable"]);
const STORED_CONFIRM_STATUSES = new Set(["已确认入库", "stored", "approved_for_storage", "已入库"]);
const PENDING_OWNER_REVIEW_STATUSES = new Set(["待确认", "待负责人审核", "pending_owner_review", "已重新提交", "resubmitted", "需修改", "提交人已确认"]);
const COORDINATOR_PENDING_STATUSES = new Set(["已转交统筹人", "transferred_to_coordinator"]);
const COORDINATOR_FEEDBACK_STATUSES = new Set(["统筹人已反馈", "coordinator_feedback_given"]);
const CEO_PENDING_STATUSES = new Set(["待CEO决策", "pending_ceo_decision"]);
const CEO_DECIDED_STATUSES = new Set(["CEO已批示", "ceo_decided"]);

function getConfirmationStatus(row) {
  const status = String(row?.confirm_status || "").trim();
  const aliases = {
    pending_owner_review: "待负责人审核",
    resubmitted: "已重新提交",
    returned_to_submitter: "已打回提交人",
    withdrawn: "已撤回",
    withdrawn_editable: "已撤回",
    transferred_to_coordinator: "已转交统筹人",
    coordinator_feedback_given: "统筹人已反馈",
    pending_ceo_decision: "待CEO决策",
    ceo_decided: "CEO已批示",
    stored: "已入库",
    approved_for_storage: "已入库",
  };
  return aliases[status] || status;
}

function isReturnedStatus(row) {
  return RETURNED_CONFIRM_STATUSES.has(getConfirmationStatus(row));
}

function isStoredStatus(row) {
  return STORED_CONFIRM_STATUSES.has(getConfirmationStatus(row));
}

function isPendingOwnerReview(row) {
  return PENDING_OWNER_REVIEW_STATUSES.has(getConfirmationStatus(row));
}

function canShowConfirmationAction(row, ctx, action) {
  const status = getConfirmationStatus(row);
  const project = normalizeProject(row?.special_project || row?.human_result?.special_project || row?.ai_result?.special_project || "");
  const context = ctx || getCurrentUserContext();
  const isSubmitter = String(row?.submitter || "") === String(context?.name || "");
  const isOwner = !!project && canConfirmProject(project);
  const isCoordinator = !!project && Array.isArray(context?.coordinatedProjects) && context.coordinatedProjects.includes(project);
  const isCEO = !!context?.isCEO || !!context?.canMaintainAll;

  if (isStoredStatus(row)) return false;

  if (isReturnedStatus(row)) {
    return action === "resubmit" && isSubmitter;
  }

  if (COORDINATOR_PENDING_STATUSES.has(status)) {
    if (action === "coordinator_feedback") return isCoordinator;
    return false;
  }

  if (COORDINATOR_FEEDBACK_STATUSES.has(status)) {
    return isOwner && ["confirm", "reject", "transfer", "escalate"].includes(action);
  }

  if (CEO_PENDING_STATUSES.has(status)) {
    if (action === "ceo_decide") return isCEO;
    return false;
  }

  if (CEO_DECIDED_STATUSES.has(status)) {
    return isOwner && ["confirm", "reject"].includes(action);
  }

  if (isPendingOwnerReview(row)) {
    return isOwner && ["confirm", "reject", "transfer", "escalate"].includes(action);
  }

  return false;
}

async function renderConfirmations() {
  if (!canViewConfirmationCenter()) {
    document.getElementById("confirmations").innerHTML = emptyState("无权限访问", "当前身份无法查看 AI 确认中心。");
    return;
  }
  document.getElementById("confirmations").innerHTML = `<div class="page-loading">加载中…</div>`;
  const tab = state.confirmationTab || "待审核";
  let counts, rows;
  try {
    [counts, rows] = await Promise.all([
      api("/api/confirmations/counts"),
      api(`/api/confirmations/pending?tab=${encodeURIComponent(tab)}`),
    ]);
  } catch (err) {
    document.getElementById("confirmations").innerHTML = `<div class="page-error"><strong>确认中心加载失败</strong><p>${esc(err.message || "网络错误")}</p><button onclick="loadPage('confirmations')">重试</button></div>`;
    return;
  }
  document.getElementById("confirmations").innerHTML = `
    <div class="confirm-layout">
      <div class="confirm-queue">
        <div class="confirm-queue-head">
          <h3>AI 确认中心</h3>
          <p>负责人对 AI 建议校对后写入业务数据</p>
        </div>
        <div class="confirm-tabs">
          ${confirmTabBtn("待审核", counts["待审核"] || 0)}
          ${confirmTabBtn("流转中", counts["流转中"] || 0)}
          ${confirmTabBtn("已完成", counts["已完成"] || 0)}
        </div>
        <div class="confirm-list">
          ${rows.map(confirmationCard).join("") || emptyState(
            tab === "待审核" ? "暂无待审核记录" : tab === "流转中" ? "暂无流转中记录" : "暂无已完成记录",
            tab === "待审核" ? "成员提交进度更新后会出现在这里，等待负责人审核。" :
            tab === "流转中" ? "已打回提交人、已转交统筹人或待CEO决策的记录会出现在这里。" : "已确认写入或不入库的记录归档在这里。"
          )}
        </div>
      </div>
      <div id="confirmDetail" class="confirm-detail">
        ${emptyState("请选择一条记录", "点击左侧条目查看原文和 AI 提取字段")}
      </div>
    </div>`;
  if (state.selectedConfirmationId) openConfirmation(state.selectedConfirmationId);
}

function confirmTabBtn(label, count) {
  const active = (state.confirmationTab || "待审核") === label;
  return `<button class="confirm-tab ${active ? "active" : ""}" onclick="setConfirmationTab('${label}')">
    ${esc(label)}${count > 0 ? `<span class="confirm-tab-badge">${count}</span>` : ""}
  </button>`;
}

function setConfirmationTab(tab) {
  state.confirmationTab = tab;
  state.selectedConfirmationId = null;
  renderConfirmations();
}

function confirmationCard(r) {
  const selected = state.selectedConfirmationId === r.id;
  const sourceMeta = sourceTypeMeta(r.source_type);
  const project = r.special_project ? normalizeProject(r.special_project) : "";
  const timeStr = r.updated_at ? formatWaitText(r.updated_at) : "-";
  const ctx = getCurrentUserContext();
  const status = getConfirmationStatus(r);
  const needsMyFeedback = COORDINATOR_PENDING_STATUSES.has(getConfirmationStatus(r)) && ctx.coordinatedProjects.includes(project);
  return `<article class="confirm-card ${selected ? "selected" : ""} ${needsMyFeedback ? "needs-my-action" : ""}" data-id="${r.id}" onclick="openConfirmation(${r.id})">
    <div class="confirm-card-top">
      <h4>${esc(r.title || "未命名")}${needsMyFeedback ? ' <span class="action-dot">待我反馈</span>' : ""}</h4>
      ${badge(status)}
    </div>
    <div class="confirm-card-meta">
      <span class="ctype-chip ${sourceMeta.chipClass}">${esc(sourceMeta.label)}</span>
      <span class="muted-text">${esc(r.submitter || "-")}</span>
      <span class="muted-dot">·</span>
      <span class="muted-text">${esc(timeStr)}</span>
    </div>
    ${project ? `<div class="confirm-card-tags"><span class="project-chip">${esc(project)}</span></div>` : ""}
  </article>`;
}

function confirmationDrawerCurrentHandler(status, context, project, row) {
  if (isStoredStatus(row)) return "已入库，归档查看";
  if (RETURNED_CONFIRM_STATUSES.has(status)) {
    return String(row?.submitter || "") === String(context?.name || "") ? "提交人待补充" : "等待提交人重新提交";
  }
  if (COORDINATOR_PENDING_STATUSES.has(status)) return "统筹人反馈中";
  if (COORDINATOR_FEEDBACK_STATUSES.has(status)) return canConfirmProject(project) ? "负责人处理中" : "等待负责人处理";
  if (CEO_PENDING_STATUSES.has(status)) return "CEO决策中";
  if (CEO_DECIDED_STATUSES.has(status)) return canConfirmProject(project) ? "负责人根据 CEO 批示处理" : "等待负责人处理";
  if (isPendingOwnerReview(row)) return "负责人审核中";
  return "等待处理";
}

function confirmationDrawerNextStep(status, context, project, row) {
  if (isStoredStatus(row)) return "已入库后仅可查看记录";
  if (RETURNED_CONFIRM_STATUSES.has(status)) {
    return String(row?.submitter || "") === String(context?.name || "")
      ? "补充字段并重新提交"
      : "等待提交人补充后重新提交";
  }
  if (COORDINATOR_PENDING_STATUSES.has(status)) return "等待统筹人反馈意见";
  if (COORDINATOR_FEEDBACK_STATUSES.has(status)) return canConfirmProject(project) ? "负责人根据反馈继续处理" : "等待负责人继续处理";
  if (CEO_PENDING_STATUSES.has(status)) return "等待 CEO 批示";
  if (CEO_DECIDED_STATUSES.has(status)) return canConfirmProject(project) ? "负责人依据批示确认入库或打回" : "等待负责人处理";
  if (isPendingOwnerReview(row)) return "负责人确认写入、打回或转交统筹人";
  return "等待下一步流转";
}

function confirmationDrawerOriginalSummary(row, sourceMeta) {
  const parts = [];
  const human = row?.human_result || row?.ai_result || {};
  if (human?.summary) parts.push(human.summary);
  if (human?.notes) parts.push(human.notes);
  else if (row?.transcript_text) parts.push(row.transcript_text);
  if (human?.completed_items?.length) parts.push(`完成事项：${human.completed_items.join("；")}`);
  if (human?.next_steps?.length) parts.push(`下周计划：${human.next_steps.join("；")}`);
  if (human?.issues?.length) parts.push(`问题：${human.issues.map(i => i.description || i).join("；")}`);
  const raw = parts.filter(Boolean).join(" · ").replace(/\s+/g, " ").trim();
  if (!raw) return `来源方式：${sourceMeta.label}`;
  return raw.length > 160 ? `${raw.slice(0, 160).trim()}…` : raw;
}

function confirmationDrawerOriginalFullText(row) {
  const parts = [];
  const human = row?.human_result || row?.ai_result || {};
  const seen = new Set();
  const pushUnique = (value) => {
    const normalized = String(value || "").replace(/\s+/g, " ").trim();
    if (!normalized || seen.has(normalized)) return;
    seen.add(normalized);
    parts.push(normalized);
  };
  pushUnique(row?.transcript_text);
  pushUnique(human?.summary);
  pushUnique(human?.notes);
  return parts.join("\n\n");
}

function formatFlowLogTime(value) {
  const raw = String(value || "").trim();
  if (!raw) return { date: "-", time: "-" };

  const normalized = raw
    .replace("T", " ")
    .replace(/\.\d+$/, "")
    .trim();

  const pick = (datePart, timePart) => ({
    date: datePart || "-",
    time: timePart || "-",
  });

  let match = normalized.match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (match) return pick(match[1], match[2] && match[3] ? `${match[2]}:${match[3]}` : "-");

  match = normalized.match(/^(\d{2}-\d{2})(?:\s+(\d{2}):(\d{2})(?::\d{2})?)?$/);
  if (match) return pick(match[1], match[2] && match[3] ? `${match[2]}:${match[3]}` : "-");

  match = normalized.match(/^(\d{4}-\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?$/);
  if (match) return pick(`${match[1]}-${match[2]}`, `${match[3]}:${match[4]}`);

  const parsed = new Date(normalized);
  if (!Number.isNaN(parsed.getTime())) {
    const date = parsed.toISOString().slice(0, 10);
    const hh = String(parsed.getHours()).padStart(2, "0");
    const mm = String(parsed.getMinutes()).padStart(2, "0");
    return pick(date, `${hh}:${mm}`);
  }

  return pick(normalized, "-");
}

function confirmationDrawerLogItem(item, idx) {
  if (!item) return "";
  const at = item.created_at || item.updated_at || item.time || item.at || "";
  const timeParts = formatFlowLogTime(at);
  const actor = item.operator || item.user || item.actor || item.by || "-";
  const action = item.action || item.event || item.status || "流转记录";
  const note = item.note || item.reason || item.content || item.message || item.result || item.detail || "";
  return `<div class="cc-flow-row" style="display:grid;grid-template-columns:120px 110px 110px minmax(0,1fr);gap:12px;padding:12px 0;border-bottom:1px solid #eef2f7;align-items:start">
    <div class="cc-flow-time" style="font-size:12px;line-height:1.45;color:#64748b;white-space:nowrap;word-break:normal;overflow-wrap:normal">
      <div class="cc-flow-date" style="font-weight:600;color:#334155">${esc(timeParts.date)}</div>
      <div class="cc-flow-clock" style="margin-top:2px;color:#64748b">${esc(timeParts.time)}</div>
    </div>
    <div class="cc-flow-action" style="font-size:13px;font-weight:700;line-height:1.6;color:#0f172a">${esc(action)}</div>
    <div class="cc-flow-actor" style="font-size:13px;line-height:1.6;color:#334155">${esc(actor)}</div>
    <div class="cc-flow-note" style="min-width:0;font-size:13px;line-height:1.7;color:#475569;white-space:pre-wrap;word-break:break-word">${esc(note || "-")}${item.after_json ? `<pre class="cc-flow-json" style="margin:8px 0 0;padding:10px;border-radius:10px;background:#f8fafc;color:#334155;font-size:12px;line-height:1.6;overflow:auto">${esc(JSON.stringify(item.after_json, null, 2))}</pre>` : ""}</div>
  </div>`;
}

function confirmationDrawerFallbackLogs(row) {
  const status = getConfirmationStatus(row);
  const items = [
    { action: "提交", actor: row?.submitter || "-", at: row?.created_at || row?.updated_at || "", note: `${sourceTypeMeta(row?.source_type).label}提交` },
    { action: "AI提取", actor: "系统", at: row?.created_at || row?.updated_at || "", note: "AI提取字段完成，等待负责人审核" },
  ];
  if (row?.reject_reason) items.push({ action: "打回", actor: row?.confirmed_by || row?.operator || "-", at: row?.updated_at || "", note: row.reject_reason });
  if (row?.coordinator_note) items.push({ action: "统筹人反馈", actor: row?.coordinator || row?.operator || "-", at: row?.updated_at || "", note: row.coordinator_note });
  if (row?.ceo_note) items.push({ action: "CEO批示", actor: "CEO", at: row?.updated_at || "", note: row.ceo_note });
  if (status === "已撤回") items.push({ action: "撤回", actor: row?.submitter || "-", at: row?.updated_at || "", note: "提交人撤回到可编辑状态" });
  if (status === "已重新提交") items.push({ action: "重新提交", actor: row?.submitter || "-", at: row?.updated_at || "", note: "补充后重新提交给负责人审核" });
  if (isStoredStatus(row)) items.push({ action: "确认写入", actor: row?.confirmed_by || row?.operator || "-", at: row?.confirmed_at || row?.updated_at || "", note: "负责人已确认写入业务数据" });
  return items;
}

function confirmationDrawerLogs(row) {
  const logs = Array.isArray(row?.flow_records) ? row.flow_records
    : Array.isArray(row?.flow_logs) ? row.flow_logs
    : Array.isArray(row?.logs) ? row.logs
    : Array.isArray(row?.timeline) ? row.timeline
    : Array.isArray(row?.history) ? row.history
    : confirmationDrawerFallbackLogs(row);
  return `<div class="cc-timeline">${logs.map((item, idx) => confirmationDrawerLogItem(item, idx)).join("")}</div>`;
}

function closeConfirmationDrawer() {
  state.selectedConfirmationId = null;
  state.currentConfirmationData = null;
  const detail = document.getElementById("confirmDetail");
  if (detail) {
    detail.innerHTML = emptyState("请选择一条记录", "点击左侧条目查看原文和 AI 提取字段");
  }
  document.querySelectorAll(".confirm-card.selected").forEach(el => el.classList.remove("selected"));
}

function toggleOriginalText(id) {
  const panel = document.getElementById(`cc-origin-full-${id}`);
  const btn = document.getElementById(`cc-origin-toggle-${id}`);
  if (!panel || !btn) return;
  const nextHidden = !panel.hidden;
  panel.hidden = nextHidden;
  btn.textContent = nextHidden ? "展开原文" : "收起原文";
  btn.setAttribute("aria-expanded", String(!nextHidden));
}

function confirmationActionBar(actionsHtml) {
  return `<div class="cc-action-bar" style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;flex-wrap:wrap;padding:14px 16px;border:1px solid #dbe3ef;border-radius:16px;background:linear-gradient(180deg,#f8fbff 0%,#ffffff 100%)">
    <div class="cc-action-copy" style="flex:1 1 320px;min-width:260px">
      <div class="cc-section-title" style="font-weight:700;color:#0f172a;margin-bottom:6px">负责人审核提示</div>
      <div class="cc-section-body" style="font-size:14px;line-height:1.75;color:#475569">请重点核对下方结构化字段是否可入库；原始输入仅作为辅助核对。</div>
    </div>
    <div class="cc-action-slot" style="flex:1 1 360px;min-width:280px">${actionsHtml}</div>
  </div>`;
}

async function openConfirmation(id) {
  state.selectedConfirmationId = id;
  document.querySelectorAll(".confirm-card").forEach(el => {
    el.classList.toggle("selected", Number(el.dataset.id) === id);
  });
  const d = await api(`/api/confirmations/${id}`);
  state.currentConfirmationData = d;
  const s = d.human_result || d.ai_result || {};
  const isMeeting = d.source_type === "meeting";
  const sourceMeta = sourceTypeMeta(d.source_type);
  const tab = state.confirmationTab || "待审核";
  const issues = s.issues || [];
  const timeStr = d.updated_at ? formatWaitText(d.updated_at) : "-";
  const project = normalizeProject(s.special_project || (s.task || {}).special_project || d.special_project || "");
  const context = getCurrentUserContext();
  const status = getConfirmationStatus(d);
  const isTerminal = isStoredStatus(d) || ["已确认", "已退回", "不入库", "已归档"].includes(status);
  const isCoordinatorPending = COORDINATOR_PENDING_STATUSES.has(status);
  const isCeoPending = CEO_PENDING_STATUSES.has(status);
  const isReturnFlow = isReturnedStatus(d) || ["需修改"].includes(status);
  const isWithdrawable = PENDING_OWNER_REVIEW_STATUSES.has(status) || isReturnedStatus(d);
  const isSubmitter = d.submitter === context.name;
  const readOnlyBox = `<div class="cc-action-box"><strong>只读查看</strong><p class="muted-text" style="margin:4px 0 0">当前身份可查看该记录，但没有操作权限。</p></div>`;
  const confirmLabel = isMeeting ? "校对完成，发布纪要并写入任务表" : "确认写入";
  const canConfirm = canShowConfirmationAction(d, context, "confirm");
  const canReject = canShowConfirmationAction(d, context, "reject");
  const canTransfer = canShowConfirmationAction(d, context, "transfer");
  const canEscalate = canShowConfirmationAction(d, context, "escalate");
  const canCoordinatorFeedback = canShowConfirmationAction(d, context, "coordinator_feedback");
  const canCeoDecide = canShowConfirmationAction(d, context, "ceo_decide");
  const canResubmit = canShowConfirmationAction(d, context, "resubmit");

  let actionsHtml;
  if (isTerminal) {
    actionsHtml = `<div class="cc-actions"><button disabled style="flex:1;opacity:.5">已处理归档</button></div>`;
  } else if (canResubmit && isSubmitter) {
    const isWithdrawn = status === "已撤回";
    const boxTitle = isWithdrawn ? "已撤回，可修改后重新提交" : "已打回，请修改字段后补充说明再提交";
    const boxReason = `<p class="muted-text" style="margin:4px 0 12px">` +
      `${esc(isWithdrawn ? "撤回/打回原因" : "打回原因")}：${esc(d.reject_reason || (isWithdrawn ? "提交人主动撤回，待修改后重新提交。" : "负责人要求补充信息后重新提交。"))}</p>`;
    actionsHtml = `<div class="cc-action-box" style="border-left-color:#f59e0b;background:#fffbeb">
      <strong style="color:#92400e">${boxTitle}</strong>
      ${boxReason}
      <label style="display:block;margin-bottom:4px;font-size:13px;color:#374151;font-weight:500;margin-top:${isWithdrawn ? "8px" : "0"}">补充说明（告知负责人修改了哪些内容）</label>
      <textarea id="inlineResubmitNote" rows="3" style="width:100%;border:1px solid #d1d5db;border-radius:5px;padding:6px 10px;font-size:13px;resize:vertical;box-sizing:border-box" placeholder="例如：已更新完成事项，修正了成果描述…"></textarea>
      <div class="cc-actions" style="margin-top:10px">
        <button class="success" onclick="doInlineResubmit(${id})">补充后重新提交</button>
      </div>
    </div>`;
  } else if (isCoordinatorPending) {
    if (canCoordinatorFeedback) {
      actionsHtml = `<div class="cc-actions">
        <button class="warn-outline" onclick="coordinatorFeedback(${id})">反馈意见给负责人</button>
      </div>`;
    } else {
      actionsHtml = readOnlyBox;
    }
  } else if (isCeoPending) {
    if (canCeoDecide) {
      actionsHtml = `<div class="cc-actions">
        <button class="success" onclick="ceoDecide(${id})">CEO批示</button>
        ${canConfirm ? `<button class="warn-outline" onclick="confirmWrite(${id})">直接确认写入</button>` : ""}
      </div>`;
    } else {
      actionsHtml = readOnlyBox;
    }
  } else if (isReturnedStatus(d)) {
    actionsHtml = readOnlyBox;
  } else if (isReturnFlow) {
    if (canAssignSubmission()) {
      actionsHtml = `<div class="cc-action-box">
        <strong>请指定责任人（过程保障操作）</strong>
        <p class="muted-text" style="margin:4px 0 10px">AI未能识别责任人，指定后移入待审核队列，由负责人完成确认写入。</p>
        <div class="cc-assign-row">
          <select id="assigneeSelect">
            <option value="">选择责任人...</option>
            ${members.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("")}
          </select>
          <button class="success" onclick="confirmAssign(${id})">确认分配</button>
        </div>
      </div>`;
    } else {
      actionsHtml = readOnlyBox;
    }
  } else {
    if (canConfirm) {
      actionsHtml = `<div class="cc-actions">
        ${canReject ? `<button class="danger-outline" onclick="rejectConfirmation(${id})">打回给提交人</button>` : ""}
        ${canTransfer ? `<button class="warn-outline" onclick="transferToCoordinator(${id})">转交统筹人</button>` : ""}
        ${canEscalate ? `<button class="warn-outline" onclick="escalateToCeo(${id})">上报CEO</button>` : ""}
        <button class="success" onclick="confirmWrite(${id})">${esc(confirmLabel)}</button>
      </div>`;
    } else if (canAssignSubmission()) {
      actionsHtml = `<div class="cc-action-box">
        <strong>过程保障指派责任人</strong>
        <p class="muted-text" style="margin:4px 0 10px">指定后移入待审核队列，由负责人完成确认写入。</p>
        <div class="cc-assign-row">
          <select id="assigneeSelect">
            <option value="">选择责任人...</option>
            ${members.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join("")}
          </select>
          <button class="success" onclick="confirmAssign(${id})">确认分配</button>
        </div>
      </div>`;
    } else {
      actionsHtml = isSubmitter && isWithdrawable
        ? `<div class="cc-action-box">
            <strong>等待负责人审核</strong>
            <p class="muted-text" style="margin:4px 0 10px">如需修改，可撤回后重新编辑提交。</p>
            <div class="cc-actions" style="margin-top:8px">
              <button class="danger-outline" onclick="withdrawSubmission(${id})">撤回此提交</button>
            </div>
          </div>`
        : readOnlyBox;
    }
  }

  const currentHandler = confirmationDrawerCurrentHandler(status, context, project, d);
  const nextStep = confirmationDrawerNextStep(status, context, project, d);
  const originalSummary = confirmationDrawerOriginalSummary(d, sourceMeta);
  const originalFullText = confirmationDrawerOriginalFullText(d);
  const showExpand = !!originalFullText && originalFullText !== originalSummary;
  const actionBarHtml = confirmationActionBar(actionsHtml);
  document.getElementById("confirmDetail").innerHTML = `
    <div class="cc-detail-workspace" style="width:100%;max-width:980px;margin:0 auto;display:flex;flex-direction:column;gap:14px;box-sizing:border-box;padding:8px 8px 18px">
      <div class="cc-review-header" style="display:flex;justify-content:space-between;gap:16px;align-items:flex-start;padding:16px 18px;border:1px solid #e5e7eb;border-radius:18px;background:linear-gradient(180deg,#ffffff 0%,#f8fafc 100%);box-shadow:0 12px 28px rgba(15,23,42,.06)">
        <div class="cc-review-title" style="min-width:0;flex:1">
          <div class="cc-drawer-kicker" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:8px">
            <span class="ctype-chip ${sourceMeta.chipClass}">${esc(sourceMeta.label)}</span>
            <span class="cc-status-pill${isReturnedStatus(d) ? " cc-status-warning" : ""}">${esc(status)}</span>
          </div>
          <h3 style="margin:0;font-size:20px;line-height:1.3;color:#0f172a">${esc(d.title || "未命名")}</h3>
          <div class="cc-review-meta" style="margin-top:8px;font-size:13px;line-height:1.8;color:#64748b;word-break:break-word">
            提交人：${esc(d.submitter || "-")} ｜ ${esc(timeStr)} ｜ 当前处理人：${esc(currentHandler)} ｜ 下一步：${esc(nextStep)}
          </div>
        </div>
        <button class="cc-drawer-close" type="button" onclick="closeConfirmationDrawer()" title="关闭详情" style="border:0;background:#f3f4f6;color:#334155;border-radius:999px;width:34px;height:34px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;font-size:18px;line-height:1">×</button>
      </div>

      ${actionBarHtml}

      <div class="cc-ai-table" style="border:1px solid #dbe3ef;border-radius:18px;background:#fff;overflow:hidden;box-shadow:0 10px 26px rgba(15,23,42,.05)">
        <div class="cc-ai-table-head" style="display:flex;justify-content:space-between;gap:12px;align-items:flex-end;padding:18px 18px 14px;border-bottom:1px solid #e5e7eb;background:linear-gradient(180deg,#f8fbff 0%,#ffffff 100%)">
          <div>
            <div class="cc-section-title" style="font-weight:700;color:#0f172a;margin-bottom:4px">AI 提取字段（负责人核心审核表）</div>
            <div class="cc-section-body" style="font-size:13px;line-height:1.65;color:#64748b">请逐项核对字段是否可以直接入库，低置信字段建议优先检查。</div>
          </div>
        </div>
        <div class="cc-ai-grid-head" style="display:grid;grid-template-columns:minmax(96px,120px) minmax(0,1fr) 88px 76px;gap:12px;padding:12px 18px;background:#f8fafc;border-bottom:1px solid #e5e7eb;color:#475569;font-size:12px;font-weight:700">
          <div>字段</div>
          <div>AI提取内容</div>
          <div>置信度</div>
          <div>操作</div>
        </div>
        <div class="cc-ai-grid-body" style="display:grid">
          ${confirmField("专项", normalizeProject(s.special_project), s.confidence >= 0.8 ? "高" : "中", "special_project")}
          ${confirmField("关联任务", s.related_task, "高", "related_task")}
          ${confirmField("完成事项", (s.completed_items || []).join("；"), "高", "completed_items")}
          ${confirmField("成果", (s.achievements || []).map(a => a.name).join("；"), "中", "achievement_names")}
          ${confirmField("状态建议", s.status_suggestion || "进行中（无变更）", "高", "status_suggestion")}
          ${confirmField("下周计划", (s.next_steps || []).join("；"), "高", "next_steps")}
          ${confirmField("需协调人", (s.need_coordination || []).join("；"), issues.length ? "高" : "低", "need_coordination")}
          ${confirmField("额外补充", s.extra_note || "", "低", "extra_note")}
          ${issues.length ? confirmField("问题 / 风险", issues.map(i => i.description).join("；"), "低", "") : ""}
        </div>
      </div>

      ${d.coordinator_note ? `<div class="cc-drawer-section" style="border:1px solid #fde68a;border-left:4px solid #f59e0b;border-radius:14px;padding:14px;background:#fffdf4"><div class="cc-section-title" style="font-weight:600;color:#92400e;margin-bottom:8px">统筹人意见</div><div class="cc-section-body" style="font-size:14px;line-height:1.75;color:#7c2d12">${esc(d.coordinator_note)}</div></div>` : ""}
      ${d.ceo_note ? `<div class="cc-drawer-section" style="border:1px solid #bfdbfe;border-left:4px solid #3b82f6;border-radius:14px;padding:14px;background:#f8fbff"><div class="cc-section-title" style="font-weight:600;color:#1d4ed8;margin-bottom:8px">CEO 批示</div><div class="cc-section-body" style="font-size:14px;line-height:1.75;color:#1e3a8a">${esc(d.ceo_note)}</div></div>` : ""}

      <div class="cc-origin-summary" style="border:1px dashed #d7deea;border-radius:16px;padding:14px 16px;background:#fafafa">
        <div class="cc-section-title" style="font-weight:600;color:#334155;margin-bottom:10px">原始输入摘要（辅助核对）</div>
        <div class="cc-origin-summary-text" style="font-size:14px;line-height:1.75;color:#475569;white-space:pre-wrap">${esc(originalSummary || "暂无摘要")}</div>
        ${showExpand ? `<button id="cc-origin-toggle-${id}" type="button" class="cc-origin-toggle" onclick="toggleOriginalText(${id})" aria-expanded="false" style="margin-top:10px;border:0;background:transparent;color:#2563eb;font-size:13px;padding:0;cursor:pointer">展开原文</button>
        <div id="cc-origin-full-${id}" class="cc-origin-full" hidden style="margin-top:10px;font-size:13px;line-height:1.75;color:#64748b;white-space:pre-wrap">${esc(originalFullText)}</div>` : ""}
      </div>

      <div class="cc-origin-meta" style="border:1px solid #eef2f7;border-radius:14px;padding:12px 14px;background:#fff">
        <div class="cc-section-title" style="font-weight:600;color:#334155;margin-bottom:8px">原始提交信息 / 技术信息</div>
        <div class="cc-origin-meta-grid" style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;font-size:13px;color:#64748b">
          <div><strong style="color:#334155">记录编号：</strong>${esc(String(d.id ?? id ?? "-"))}</div>
          <div><strong style="color:#334155">提交方式：</strong>${esc(sourceMeta.label)}</div>
        </div>
      </div>

      <div class="cc-flow-log" style="border:1px solid #e5e7eb;border-radius:16px;padding:14px 16px;background:#fff">
        <div class="cc-section-title" style="font-weight:700;color:#0f172a;margin-bottom:10px">流转记录</div>
        <div class="cc-flow-head" style="display:grid;grid-template-columns:120px 110px 110px minmax(0,1fr);gap:12px;padding:0 0 10px;border-bottom:1px solid #e5e7eb;color:#64748b;font-size:12px;font-weight:700">
          <div>时间</div>
          <div>动作</div>
          <div>操作人</div>
          <div>说明</div>
        </div>
        ${confirmationDrawerLogs(d)}
      </div>
    </div>`;
}

function confirmField(label, value, confidence = "中", fieldName = "") {
  const cls = confidence === "高" ? "high" : confidence === "低" ? "low" : "mid";
  const labelText = { "高": "高置信", "中": "中置信", "低": "低置信" }[confidence];
  const pencil = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  const isEmpty = !value;
  const lowTone = confidence === "低" ? "background:#fff7ed;color:#b45309;border-color:#fdba74" : confidence === "中" ? "background:#eff6ff;color:#1d4ed8;border-color:#bfdbfe" : "background:#ecfdf5;color:#047857;border-color:#86efac";
  return `<div class="cc-ai-row" style="display:grid;grid-template-columns:minmax(96px,120px) minmax(0,1fr) 88px 76px;gap:12px;padding:14px 18px;border-bottom:1px solid #edf2f7;align-items:start">
    <div class="cc-ai-field" style="font-size:13px;font-weight:700;color:#334155;line-height:1.6">${esc(label)}</div>
    <div class="cc-ai-value-wrap" style="min-width:0">
      <p class="field-value${isEmpty ? " confirm-field-empty" : ""}" contenteditable="true" data-field="${esc(fieldName)}" style="margin:0;font-size:14px;line-height:1.75;color:#0f172a;white-space:pre-wrap;word-break:break-word">${esc(isEmpty ? "未识别，可手动补充" : value)}</p>
    </div>
    <span class="cc-ai-confidence ${cls}" style="justify-self:start;display:inline-flex;align-items:center;padding:4px 10px;border-radius:999px;border:1px solid transparent;font-size:12px;font-weight:700;${lowTone}">${esc(labelText)}</span>
    <button class="cc-ai-edit" onclick="this.parentElement.querySelector('.field-value').focus()" title="点击编辑" style="justify-self:start;border:1px solid #dbe3ef;background:#fff;color:#334155;border-radius:10px;width:38px;height:38px;display:inline-flex;align-items:center;justify-content:center;cursor:pointer">${pencil}</button>
  </div>`;
}

async function confirmWrite(id) {
  if (!state.currentConfirmationData) return toast("请先点击左侧记录加载详情");
  const base = state.currentConfirmationData;
  const humanResult = JSON.parse(JSON.stringify(base.human_result || base.ai_result || {}));

  const detail = document.getElementById("confirmDetail");
  if (detail) {
    detail.querySelectorAll(".field-value[data-field]").forEach(el => {
      const f = el.dataset.field;
      const raw = el.textContent.trim();
      if (!f) return;
      if (["completed_items", "next_steps", "need_coordination"].includes(f)) {
        humanResult[f] = raw ? raw.split(/[；;]/).map(s => s.trim()).filter(Boolean) : [];
      } else if (f === "achievement_names") {
        const names = raw ? raw.split(/[；;]/).map(s => s.trim()).filter(Boolean) : [];
        humanResult.achievements = names.map((name, i) => ({
          ...(humanResult.achievements?.[i] || {}), name,
          special_project: humanResult.special_project || "",
        }));
      } else {
        humanResult[f] = raw;
      }
    });
  }

  try {
    await api(`/api/confirmations/${id}/confirm`, {
      method: "POST",
      body: JSON.stringify({ operator: getCurrentUserName(), human_result: humanResult }),
    });
    invalidate("tasks", "achievements", "issues", "confirmations");
    toast("已确认写入任务、成果和问题表");
    state.selectedConfirmationId = null;
    state.currentConfirmationData = null;
    renderConfirmations();
  } catch (err) {
    toast(`确认失败：${err.message || "请重试"}`);
  }
}

function rejectConfirmation(id) {
  openModal(`<div class="simple-modal">
    <h3>打回给提交人补充</h3>
    <p class="muted-text">请说明需要补充的内容，提交人补充后可重新提交。</p>
    <textarea id="rejectReasonInput" rows="4" style="width:100%;margin-top:8px;resize:vertical" placeholder="信息不完整，请补充后重新提交"></textarea>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="danger" onclick="doRejectConfirmation(${id})">确认打回</button>
    </div>
  </div>`);
}

async function doRejectConfirmation(id) {
  const reason = document.getElementById("rejectReasonInput")?.value.trim() || "信息不完整，请重新录音后提交";
  try {
    await api(`/api/confirmations/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ reason, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations");
    toast("已打回，提交人需补充后重新提交");
    state.selectedConfirmationId = null;
    renderConfirmations();
  } catch (err) {
    toast(`退回失败：${err.message || "请重试"}`);
  }
}

async function openResubmitModal(id) {
  let d;
  try {
    d = await api(`/api/confirmations/${id}`);
  } catch(e) {
    return toast("加载失败，请重试");
  }
  const humanResult = d.human_result || d.ai_result || {};
  const title = humanResult.title || d.title || "";
  const notes = humanResult.notes || humanResult.supplement_note || "";
  const rejectReason = d.reject_reason || "负责人要求补充信息。";
  openModal(`<div class="simple-modal">
    <h3>补充后重新提交</h3>
    <p class="muted-text" style="margin:0 0 12px">打回原因：${esc(rejectReason)}</p>
    <label style="display:block;margin-bottom:10px">
      <span style="font-size:13px;color:#374151;display:block;margin-bottom:4px">本次提交的标题 / 摘要</span>
      <input id="resubmitTitle" style="width:100%;border:1px solid #d1d5db;border-radius:5px;padding:6px 10px;font-size:13px" value="${esc(title)}">
    </label>
    <label style="display:block;margin-bottom:14px">
      <span style="font-size:13px;color:#374151;display:block;margin-bottom:4px">补充说明（告知负责人具体补充了什么）</span>
      <textarea id="resubmitNote" rows="4" style="width:100%;border:1px solid #d1d5db;border-radius:5px;padding:6px 10px;font-size:13px;resize:vertical" placeholder="请填写补充说明，例如：已更新完成事项，修正了成果描述…">${esc(notes)}</textarea>
    </label>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="success" onclick="doResubmit(${id})">确认重新提交</button>
    </div>
  </div>`);
}

async function doResubmit(id) {
  const note = document.getElementById("resubmitNote")?.value.trim() || "";
  if (!note) return toast("请填写补充说明后再提交");
  try {
    await api(`/api/confirmations/${id}/resubmit`, {
      method: "POST",
      body: JSON.stringify({ supplement_note: note, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations", "updates", "dashboard");
    toast("已重新提交，等待负责人审核");
    state.selectedConfirmationId = null;
    state.confirmationTab = "待审核";
    renderConfirmations();
  } catch (err) {
    toast(`重新提交失败：${err.message || "请重试"}`);
  }
}

async function doInlineResubmit(id) {
  const note = document.getElementById("inlineResubmitNote")?.value.trim() || "";
  if (!note) return toast("请填写补充说明后再提交");

  const base = state.currentConfirmationData;
  const humanResult = JSON.parse(JSON.stringify(base.human_result || base.ai_result || {}));
  const detail = document.getElementById("confirmDetail");
  if (detail) {
    detail.querySelectorAll(".field-value[data-field]").forEach(el => {
      const f = el.dataset.field;
      const raw = el.textContent.trim();
      if (!f) return;
      if (["completed_items", "next_steps", "need_coordination"].includes(f)) {
        humanResult[f] = raw ? raw.split(/[；;]/).map(s => s.trim()).filter(Boolean) : [];
      } else if (f === "achievement_names") {
        const names = raw ? raw.split(/[；;]/).map(s => s.trim()).filter(Boolean) : [];
        humanResult.achievements = names.map((name, i) => ({
          ...(humanResult.achievements?.[i] || {}), name,
          special_project: humanResult.special_project || "",
        }));
      } else {
        humanResult[f] = raw;
      }
    });
  }

  try {
    await api(`/api/confirmations/${id}/resubmit`, {
      method: "POST",
      body: JSON.stringify({ supplement_note: note, human_result: humanResult, operator: getCurrentUserName() }),
    });
    invalidate("confirmations", "updates", "dashboard");
    toast("已重新提交，等待负责人审核");
    state.selectedConfirmationId = null;
    state.currentConfirmationData = null;
    state.confirmationTab = "待审核";
    renderConfirmations();
  } catch (err) {
    toast(`重新提交失败：${err.message || "请重试"}`);
  }
}

async function withdrawSubmission(id) {
  if (!confirm("确认撤回此提交？撤回后可重新修改再提交。")) return;
  try {
    await api(`/api/confirmations/${id}/withdraw`, { method: "POST" });
    invalidate("confirmations");
    toast("已撤回，可在「流转中」tab 重新编辑提交");
    state.selectedConfirmationId = id;
    renderConfirmations();
  } catch (err) {
    toast(`撤回失败：${err.message || "请重试"}`);
  }
}

function transferToCoordinator(id) {
  openModal(`<div class="simple-modal">
    <h3>转交统筹人给意见</h3>
    <p class="muted-text">统筹人将给出意见后返回给负责人处理。</p>
    <textarea id="workflowNoteInput" rows="3" style="width:100%;margin-top:8px;resize:vertical" placeholder="可填写转交说明（选填）"></textarea>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="warn" onclick="doTransferToCoordinator(${id})">确认转交</button>
    </div>
  </div>`);
}

async function doTransferToCoordinator(id) {
  const note = document.getElementById("workflowNoteInput")?.value.trim() || "";
  try {
    await api(`/api/confirmations/${id}/transfer-coordinator`, {
      method: "POST",
      body: JSON.stringify({ note, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations");
    toast("已转交统筹人，等待其反馈意见");
    state.selectedConfirmationId = null;
    renderConfirmations();
  } catch (err) {
    toast(`转交失败：${err.message || "请重试"}`);
  }
}

function coordinatorFeedback(id) {
  openModal(`<div class="simple-modal">
    <h3>反馈意见给负责人</h3>
    <p class="muted-text">请填写你的统筹意见，负责人将据此决定是否入库。</p>
    <textarea id="workflowNoteInput" rows="4" style="width:100%;margin-top:8px;resize:vertical" placeholder="请填写统筹意见..."></textarea>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="success" onclick="doCoordinatorFeedback(${id})">提交意见</button>
    </div>
  </div>`);
}

async function doCoordinatorFeedback(id) {
  const note = document.getElementById("workflowNoteInput")?.value.trim() || "";
  if (!note) return toast("请填写统筹意见后再提交");
  try {
    await api(`/api/confirmations/${id}/coordinator-feedback`, {
      method: "POST",
      body: JSON.stringify({ note, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations");
    toast("已反馈统筹意见，等待负责人处理");
    state.selectedConfirmationId = null;
    renderConfirmations();
  } catch (err) {
    toast(`反馈失败：${err.message || "请重试"}`);
  }
}

function escalateToCeo(id) {
  openModal(`<div class="simple-modal">
    <h3>上报CEO决策</h3>
    <p class="muted-text">涉及风险、预算、方向或跨部门协调时使用。</p>
    <textarea id="workflowNoteInput" rows="3" style="width:100%;margin-top:8px;resize:vertical" placeholder="请说明上报原因..."></textarea>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="warn" onclick="doEscalateToCeo(${id})">确认上报</button>
    </div>
  </div>`);
}

async function doEscalateToCeo(id) {
  const note = document.getElementById("workflowNoteInput")?.value.trim() || "";
  try {
    await api(`/api/confirmations/${id}/escalate-ceo`, {
      method: "POST",
      body: JSON.stringify({ note, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations");
    toast("已上报CEO，等待批示");
    state.selectedConfirmationId = null;
    renderConfirmations();
  } catch (err) {
    toast(`上报失败：${err.message || "请重试"}`);
  }
}

function ceoDecide(id) {
  openModal(`<div class="simple-modal">
    <h3>CEO批示</h3>
    <p class="muted-text">批示后负责人将据此决定是否确认入库。</p>
    <textarea id="workflowNoteInput" rows="4" style="width:100%;margin-top:8px;resize:vertical" placeholder="请填写批示意见..."></textarea>
    <div class="modal-actions">
      <button type="button" onclick="closeModal()">取消</button>
      <button type="button" class="success" onclick="doCeoDecide(${id})">提交批示</button>
    </div>
  </div>`);
}

async function doCeoDecide(id) {
  const note = document.getElementById("workflowNoteInput")?.value.trim() || "";
  if (!note) return toast("请填写批示意见后再提交");
  try {
    await api(`/api/confirmations/${id}/ceo-decide`, {
      method: "POST",
      body: JSON.stringify({ note, operator: getCurrentUserName() }),
    });
    closeModal();
    invalidate("confirmations");
    toast("CEO批示已提交，负责人可据此确认入库");
    state.selectedConfirmationId = null;
    renderConfirmations();
  } catch (err) {
    toast(`批示提交失败：${err.message || "请重试"}`);
  }
}

async function confirmAssign(id) {
  const assignee = document.getElementById("assigneeSelect")?.value;
  if (!assignee) return toast("请先选择责任人");
  await api(`/api/confirmations/${id}/assign`, {
    method: "POST",
    body: JSON.stringify({ assignee, operator: getCurrentUserName() }),
  });
  invalidate("confirmations");
  toast(`已将责任人指定为 ${assignee}，移入待审核队列`);
  state.selectedConfirmationId = null;
  state.confirmationTab = "待审核";
  renderConfirmations();
}

window.sourceTypeMeta = sourceTypeMeta;
window.renderConfirmations = renderConfirmations;
window.confirmTabBtn = confirmTabBtn;
window.setConfirmationTab = setConfirmationTab;
window.confirmationCard = confirmationCard;
window.openConfirmation = openConfirmation;
window.toggleOriginalText = toggleOriginalText;
window.confirmField = confirmField;
window.confirmWrite = confirmWrite;
window.rejectConfirmation = rejectConfirmation;
window.doRejectConfirmation = doRejectConfirmation;
window.openResubmitModal = openResubmitModal;
window.doResubmit = doResubmit;
window.doInlineResubmit = doInlineResubmit;
window.withdrawSubmission = withdrawSubmission;
window.transferToCoordinator = transferToCoordinator;
window.doTransferToCoordinator = doTransferToCoordinator;
window.coordinatorFeedback = coordinatorFeedback;
window.doCoordinatorFeedback = doCoordinatorFeedback;
window.escalateToCeo = escalateToCeo;
window.doEscalateToCeo = doEscalateToCeo;
window.ceoDecide = ceoDecide;
window.doCeoDecide = doCeoDecide;
window.confirmAssign = confirmAssign;
window.getConfirmationStatus = getConfirmationStatus;
window.isReturnedStatus = isReturnedStatus;
window.isStoredStatus = isStoredStatus;
window.isPendingOwnerReview = isPendingOwnerReview;
window.canShowConfirmationAction = canShowConfirmationAction;
