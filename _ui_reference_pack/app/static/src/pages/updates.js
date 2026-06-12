function updateSummaryItem(row) {
  const status = row.confirm_status || "待确认";
  const human = (() => {
    try { return JSON.parse(row.human_result_json || "{}"); } catch { return {}; }
  })();
  const project = normalizeProject(human.special_project || "");
  const relation = project ? currentUserProjectRelation(project) : "";
  const updated = row.updated_at || row.created_at || "";
  const note = row.reject_reason ? `驳回：${row.reject_reason}` : row.confirmed_by ? `处理人：${row.confirmed_by}` : "";
  return `<article class="home-list-item update-item">
    <span></span>
    <div><strong>${esc(row.title || "未命名提交")}</strong><p>${esc(project || "未归属专项")} · ${esc(updated ? formatWaitText(updated) : "-")}${note ? ` · ${esc(note)}` : ""}</p></div>
    <div style="display:flex;gap:4px;flex-wrap:wrap;align-items:flex-start">${relation ? badge(relation) : ""}${badge(status)}</div>
  </article>`;
}

function renderUpdates() {
  if (!canUseMeetingMode() && state.updateInputMode === "meeting") state.updateInputMode = "voice";
  const mode = state.updateInputMode || "voice";
  let myUpdates = [];
  fetchCached("updates", "/api/updates").then(rows => {
    const currentUser = getCurrentUserName();
    myUpdates = rows.filter(row => row.submitter === currentUser).slice(0, 6);
    const panel = document.getElementById("myUpdateFeed");
    if (panel) panel.innerHTML = myUpdates.map(updateSummaryItem).join("") || emptyState("暂无提交记录", "你提交的进度会在这里显示状态。");
    const counter = document.getElementById("myUpdateFeedCount");
    if (counter) counter.textContent = `${myUpdates.length}项`;
  }).catch(() => {
    const panel = document.getElementById("myUpdateFeed");
    if (panel) panel.innerHTML = emptyState("暂无提交记录", "你提交的进度会在这里显示状态。");
  });
  document.getElementById("updates").innerHTML = `
    <div class="update-workbench">
      <div class="update-title">
        <h3>提交进度更新</h3>
        <p>选择更新方式，AI 自动提取字段，确认后写入工作推进表、成果表和问题表。</p>
      </div>
      <div class="update-mode-tabs">
        ${updateModeTab("voice", "语音更新")}
        ${canUseMeetingMode() ? updateModeTab("meeting", "会议纪要") : ""}
        ${updateModeTab("text", "文字粘贴")}
      </div>
      <div class="llm-provider-bar">
        <span class="llm-provider-label">AI引擎</span>
        ${[["rules","规则引擎"], ..._enabledProviders.map(p => [p.provider, p.display_name])].map(([v,l]) =>
          `<button class="llm-provider-btn${state.llmProvider===v?" active":""}" onclick="setLlmProvider('${v}')">${esc(l)}</button>`
        ).join("")}
      </div>
      <div class="update-two-col">
        <section class="update-input-panel">
          <div class="update-panel-head">
            <h3>${mode === "voice" ? "语音录入" : mode === "meeting" ? "会议纪要导入" : "文字粘贴"}</h3>
            <p>${mode === "voice" ? "使用浏览器语音识别或直接粘贴转写文本，AI 只基于真实转写内容提取信息" : mode === "meeting" ? "粘贴真实会议纪要，校对后再发布到确认中心" : "粘贴豆包、飞书妙记或人工整理后的真实文本"}</p>
          </div>
          ${guideQuestions()}
          <form id="updateForm" class="update-form">
            <input type="hidden" name="source_type" value="${mode === "meeting" ? "meeting" : mode === "voice" ? "voice_update" : "text_update"}">
            ${modeInputArea(mode)}
            <div class="submitter-row"><span>提交人</span><input name="submitter" value="${esc(document.getElementById("roleSwitch").value)}"></div>
            <input type="hidden" name="title" value="${mode === "meeting" ? "AI升级项目会议纪要" : "本周AI升级项目进度"}">
            <button type="button" class="generate-btn" onclick="extractUpdate()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 17l-6.2 4.3 2.4-7.4L2 9.4h7.6z"/></svg> 生成 AI 提取建议</button>
          </form>
        </section>
        <section class="update-result-panel" id="suggestionPanel">
          <h3>AI 提取结果</h3>
          <p>请核对以下字段，修改后点击确认写入</p>
          <div class="waiting-box">等待生成...</div>
        </section>
      </div>
      <section class="home-list-panel update-history-panel">
        <div class="home-list-head"><h3><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> 我的最近提交</h3><b id="myUpdateFeedCount">0项</b></div>
        <div class="home-list" id="myUpdateFeed">${emptyState("暂无提交记录", "你提交的进度会在这里显示状态。")}</div>
      </section>
    </div>`;
  if (state.previewSuggestion) renderSuggestionPanel(state.previewSuggestion);
  refreshRecordingUI();
}

function updateModeTab(id, label) {
  const svgs = {
    voice: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`,
    meeting: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
    text: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/></svg>`,
  };
  return `<button class="${state.updateInputMode === id ? "active" : ""}" onclick="setUpdateMode('${id}')">${svgs[id] || ""}${esc(label)}</button>`;
}

function setUpdateMode(mode) {
  if (mode === "meeting" && !canUseMeetingMode()) {
    toast("当前身份不能使用会议纪要导入");
    return;
  }
  stopSpeechRecognition(true);
  state.updateInputMode = mode;
  state.previewPayload = null;
  state.previewSuggestion = null;
  renderUpdates();
}

function setLlmProvider(provider) {
  state.llmProvider = provider;
  renderUpdates();
}

function guideQuestions() {
  const qs = ["本周完成了什么？", "形成了什么成果？（文件、工具、机制）", "当前有什么问题或卡点？需要谁协调？", "下周计划做什么？"];
  return `<div class="guide-questions">
    <p><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 说话前请依次回答以下四个问题</p>
    ${qs.map((q, i) => `<div><span>${i + 1}</span>${esc(q)}</div>`).join("")}
  </div>`;
}

function modeInputArea(mode) {
  if (mode === "voice") {
    const micIcon = `<svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
    const stopIcon = `<svg width="26" height="26" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    return `
      <label class="wide"><span>语音转写文本</span>
        <textarea name="transcript_text" rows="10" placeholder="点击「开始录音」后直接说话，转写内容自动填入；也可将外部转写结果直接粘贴至此。"></textarea>
      </label>
      <div class="record-box">
        <button type="button" class="record-button ${state.isRecording ? "recording" : ""}" onclick="toggleRecording()" title="${state.isRecording ? "点击停止" : "点击开始录音"}">
          ${state.isRecording ? stopIcon : micIcon}
        </button>
        <div class="record-status">
          <p>${state.isRecording ? "正在录音，再次点击停止…" : state.speechRecognitionSupported ? "点击麦克风开始实时语音识别" : "浏览器不支持语音识别，请直接粘贴转写文本"}</p>
          <strong id="recordTimer" class="${state.isRecording ? "timer-active" : ""}">${formatSeconds(state.recordingSeconds)}</strong>
        </div>
      </div>
      <p class="input-hint"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 若已有音频转写文本（豆包、飞书妙记等），可直接粘贴到上方文本框。</p>`;
  }
  if (mode === "meeting") {
    return `
      <label class="wide"><span>会议纪要文本</span>
        <textarea name="transcript_text" rows="12" placeholder="粘贴完整会议纪要。建议包含：会议主题、参会人员、本周完成事项、形成成果、问题与风险、待决策事项、下一步安排。"></textarea>
      </label>
      <div class="review-flow">
        <div class="review-status" id="reviewStatus">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="#94a3b8" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
          <span>发布前请先完成内容校对</span>
        </div>
        <button type="button" class="review-btn" onclick="markMeetingReviewed()">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          完成校对
        </button>
        <button type="button" id="publishMeetingBtn" class="publish-btn" onclick="publishMeeting()" disabled>发布到确认中心</button>
      </div>`;
  }
  return `
    <label class="wide"><span>转写 / 整理文本</span>
      <textarea name="transcript_text" rows="14" placeholder="粘贴个人进度说明、豆包转写、飞书妙记导出或人工整理后的文本均可。AI 只基于你填写的内容提取信息，不会自动补充。"></textarea>
    </label>
    <p class="input-hint"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> 建议包含：本周完成了什么、形成了什么成果、遇到什么问题、下周计划。</p>`;
}

function toggleRecording() {
  const textarea = document.querySelector('#updateForm textarea[name="transcript_text"]');
  if (!textarea) return;
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    toast("当前浏览器不支持语音识别，请直接粘贴转写文本。");
    textarea.focus();
    return;
  }
  if (state.isRecording) {
    stopSpeechRecognition();
    return;
  }
  if (!state.speechRecognition) {
    const recognition = new SpeechRecognition();
    recognition.lang = "zh-CN";
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = event => {
      const chunks = [];
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index];
        if (result.isFinal) chunks.push(result[0].transcript.trim());
      }
      if (!chunks.length) return;
      const existing = textarea.value.trim();
      textarea.value = [existing, chunks.join("\n")].filter(Boolean).join(existing ? "\n" : "");
    };
    recognition.onerror = () => {
      stopSpeechRecognition();
      toast("语音识别中断，请检查麦克风权限后重试。");
    };
    recognition.onend = () => {
      if (state.isRecording) stopSpeechRecognition();
    };
    state.speechRecognition = recognition;
  }
  state.isRecording = true;
  state.recordingTimer = setInterval(() => {
    state.recordingSeconds += 1;
    refreshRecordingUI();
  }, 1000);
  state.speechRecognition.start();
  refreshRecordingUI();
}

function stopRecordingTimer(reset = false) {
  if (state.recordingTimer) clearInterval(state.recordingTimer);
  state.recordingTimer = null;
  state.isRecording = false;
  if (reset) state.recordingSeconds = 0;
}

function stopSpeechRecognition(reset = false) {
  if (state.speechRecognition) {
    try {
      state.speechRecognition.onend = null;
      state.speechRecognition.stop();
    } catch {}
  }
  stopRecordingTimer(reset);
  refreshRecordingUI();
}

function refreshRecordingUI() {
  const timer = document.getElementById("recordTimer");
  if (timer) timer.textContent = formatSeconds(state.recordingSeconds);
  const btn = document.querySelector(".record-button");
  if (btn) btn.classList.toggle("recording", state.isRecording);
}

function formatSeconds(total = 0) {
  const m = String(Math.floor(total / 60)).padStart(2, "0");
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

function markMeetingReviewed() {
  if (!canUseMeetingMode()) {
    toast("当前身份不能校对会议纪要");
    return;
  }
  const statusEl = document.getElementById("reviewStatus");
  if (statusEl) {
    statusEl.innerHTML = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--green)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg><span style="color:var(--green);font-weight:600">校对完成</span>`;
  }
  const btn = document.getElementById("publishMeetingBtn");
  if (btn) btn.disabled = false;
  toast("校对完成，可点击「发布到确认中心」提交。");
}

function sourceTypeMeta(sourceType) {
  if (sourceType === "meeting") return { label: "会议纪要", chipClass: "meeting" };
  if (sourceType === "text_update") return { label: "文字粘贴", chipClass: "text" };
  return { label: "语音更新", chipClass: "voice" };
}

async function publishMeeting() {
  if (!canUseMeetingMode()) {
    toast("当前身份不能发布会议纪要");
    return;
  }
  const form = document.getElementById("updateForm");
  if (!form) return toast("未找到表单");
  const payload = readForm(form);
  if (!payload.transcript_text?.trim()) return toast("请先填写会议纪要文本");
  try {
    await api("/api/updates", {
      method: "POST",
      body: JSON.stringify({
        source_type: "meeting",
        transcript_text: payload.transcript_text,
        submitter: payload.submitter || getCurrentUserName(),
        title: payload.title || "AI升级项目会议纪要",
        human_result: state.previewSuggestion || null,
      }),
    });
    invalidate("updates", "confirmations");
    toast("会议纪要已发布，已进入AI确认中心");
    switchPage("confirmations");
  } catch (err) {
    toast(`发布失败：${err.message || "请重试"}`);
  }
}

async function extractUpdate() {
  const payload = readForm(document.getElementById("updateForm"));
  if (!payload.transcript_text.trim()) return toast("请先提供转写文本或录音内容");
  payload.llm_provider = state.llmProvider || "rules";
  const providerLabel = {"rules":"规则引擎","anthropic":"Claude","dashscope":"通义千问","deepseek":"DeepSeek","glm":"智谱GLM"}[payload.llm_provider] || payload.llm_provider;
  toast(`正在使用 ${providerLabel} 提取…`);
  let suggestion;
  try {
    const res = await api("/api/updates/extract", { method: "POST", body: JSON.stringify(payload) });
    suggestion = res.suggestion;
  } catch (error) {
    toast(`AI提取失败：${error.message || "服务暂时不可用，请稍后重试"}`);
    return;
  }
  state.previewPayload = payload;
  state.previewSuggestion = suggestion;
  renderSuggestionPanel(suggestion);
}

function renderSuggestionPanel(s) {
  const node = document.getElementById("suggestionPanel");
  if (!node) return;
  const project = normalizeProject(s.special_project);
  const confidence = Number.isFinite(Number(s.confidence)) ? Math.round(Number(s.confidence) * 100) : 0;
  const submitLabel = canViewConfirmationCenter() ? "提交确认" : "提交进度";
  const fallbackNote = s.fallback_reason ? `<div class="extract-notice">${esc(s.fallback_reason)}</div>` : "";
  const issues = s.issues || [];
  const issueText = issues.map(i => i.description).join("；");
  node.innerHTML = `
    <div class="extract-panel-head">
      <div>
        <span class="extract-panel-title">AI 提取结果预览</span>
        <span class="extract-engine-chip">${esc(s.engine_label || "规则引擎")} · ${s.llm_used ? "AI模型" : "规则提取"}</span>
      </div>
      <button class="edit-all-btn" id="editAllBtn" onclick="toggleExtractEdit()">编辑全部</button>
    </div>
    ${fallbackNote}
    <div class="extract-field-list">
      ${extractProjectRow(project)}
      ${extractRow("关联任务", "related_task", s.related_task || "")}
      ${extractRow("完成事项", "completed_items", (s.completed_items || []).join("；"))}
      ${extractRow("成果", "achievements", (s.achievements || []).map(a => a.name).join("；"))}
      ${extractRow("问题", "issues", issueText)}
      ${extractRow("下周计划", "next_steps", (s.next_steps || []).join("；"))}
      ${extractRow("需协调人", "need_coordination", (s.need_coordination || []).join("、"))}
      ${extractRow("额外补充", "extra_note", s.extra_note || "")}
    </div>
    <div class="extract-meta-row">
      ${extractStatusChip(s.status_suggestion)}
      <span class="extract-confidence-val">置信度 <b>${confidence}%</b></span>
    </div>
    <div class="extract-confirm-section">
      <div class="extract-confirm-head">
        <strong>关联与确认</strong>
        <span class="extract-warn-note"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg> AI 仅生成建议，需负责人确认后写入</span>
      </div>
      <div class="extract-confirm-fields">
        <label><span>负责人</span>
          <select id="extractOwnerSelect">${_ownerOptions(project)}</select>
        </label>
      </div>
      <div class="extract-actions">
        <button onclick="saveAsDraft()">保存草稿</button>
        <button class="success" onclick="submitPreview()">${esc(submitLabel)}</button>
        <button onclick="extractUpdate()">重新生成</button>
        <button class="danger" onclick="discardPreview()">放弃</button>
      </div>
    </div>`;
}

function extractProjectRow(value) {
  const isEmpty = !value;
  const opts = PROJECTS.map(p => {
    const area = projectAreas.find(a => normalizeProject(a.name) === normalizeProject(p));
    const owners = area ? splitPeople(area.owner).join("、") : "";
    const lbl = owners ? `${p}（负责人：${owners}）` : p;
    return `<option value="${esc(p)}"${value === p ? " selected" : ""}>${esc(lbl)}</option>`;
  }).join("");
  return `<div class="extract-row ${isEmpty ? "extract-row-required" : ""}" data-field="special_project">
    <span class="extract-label">所属专项${isEmpty ? '<i class="req-mark">必填</i>' : ""}</span>
    <div class="extract-value">
      <div class="extract-value-inner">
        <select data-field-value="true" data-is-select="true" onchange="onProjectSelectChange(this)">
          <option value="">— 未识别，请手动选择 —</option>
          ${opts}
        </select>
        <div id="projectDetailRow">${value ? _projectInfoCard(value) : ""}</div>
        ${isEmpty ? `<p class="extract-warn-text">AI 未能识别所属专项，请选择后才能提交。</p>` : ""}
      </div>
    </div>
  </div>`;
}

function extractRow(label, field, value) {
  const isEmpty = !value;
  const pencil = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>`;
  return `<div class="extract-row" data-field="${esc(field)}">
    <span class="extract-label">${esc(label)}</span>
    <div class="extract-value">
      <p class="extract-display${isEmpty ? " extract-empty" : ""}" data-field-value="true" contenteditable="false">${esc(isEmpty ? "未识别，可手动补充" : value)}</p>
      <button class="extract-edit-btn" onclick="editExtractRow(this)" title="编辑此项">${pencil}</button>
    </div>
  </div>`;
}

function extractStatusChip(status) {
  const s = status || "进行中";
  const color = ["已完成"].includes(s) ? "green" : ["延期", "暂缓"].includes(s) ? "red" : "blue";
  return `<span class="extract-status-chip"><span class="status-dot ${color}"></span>${esc(s)}</span>`;
}

function _ownerOptions(project) {
  const area = project ? projectAreas.find(a => normalizeProject(a.name) === normalizeProject(project)) : null;
  const projectOwners = area ? splitPeople(area.owner) : [];
  const all = [...new Set([...projectOwners, ...members.map(m => m.name)])].filter(Boolean);
  return `<option value="">— 选择负责人 —</option>` + all.map(n => `<option value="${esc(n)}"${projectOwners.includes(n) ? " selected" : ""}>${esc(n)}</option>`).join("");
}

function editExtractRow(btn) {
  const row = btn.closest(".extract-row");
  const p = row?.querySelector("[data-field-value]");
  if (!p || p.dataset.isSelect === "true") return;
  if (p.classList.contains("extract-empty")) p.textContent = "";
  p.classList.remove("extract-empty");
  p.contentEditable = "true";
  p.classList.add("editing");
  btn.style.display = "none";
  p.focus();
  const range = document.createRange();
  range.selectNodeContents(p);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
}

function toggleExtractEdit() {
  const btn = document.getElementById("editAllBtn");
  const isEditing = btn?.dataset.editing === "true";
  document.querySelectorAll("#suggestionPanel .extract-row[data-field]").forEach(row => {
    const p = row.querySelector("[data-field-value]");
    if (!p || p.dataset.isSelect === "true") return;
    const editBtn = row.querySelector(".extract-edit-btn");
    if (!isEditing) {
      if (p.classList.contains("extract-empty")) p.textContent = "";
      p.classList.remove("extract-empty");
      p.contentEditable = "true";
      p.classList.add("editing");
      if (editBtn) editBtn.style.display = "none";
    } else {
      p.contentEditable = "false";
      p.classList.remove("editing");
      if (editBtn) editBtn.style.display = "";
    }
  });
  if (btn) {
    btn.dataset.editing = isEditing ? "" : "true";
    btn.textContent = isEditing ? "编辑全部" : "完成编辑";
  }
}

async function saveAsDraft() {
  if (!state.previewPayload) return toast("请先生成AI建议");
  if (state.submitting) return;
  state.submitting = true;
  const btns = document.querySelectorAll(".extract-actions button");
  btns.forEach(b => { b.disabled = true; });
  const editedSuggestion = readEditedSuggestion();
  try {
    await api("/api/updates", {
      method: "POST",
      body: JSON.stringify({ ...state.previewPayload, human_result: editedSuggestion, edited_suggestion: editedSuggestion }),
    });
    state.previewPayload = null;
    state.previewSuggestion = null;
    invalidate("updates", "confirmations");
    toast("已保存草稿，可在下方最近提交中查看");
    fetchCached("updates", "/api/updates").then(rows => {
      const currentUser = getCurrentUserName();
      const myUpdates = rows.filter(r => r.submitter === currentUser).slice(0, 6);
      const panel = document.getElementById("myUpdateFeed");
      if (panel) panel.innerHTML = myUpdates.map(updateSummaryItem).join("") || emptyState("暂无提交记录", "你提交的进度会在这里显示状态。");
    }).catch(() => {});
  } catch (err) {
    toast(`保存失败：${err.message}`);
    btns.forEach(b => { b.disabled = false; });
  } finally {
    state.submitting = false;
  }
}

function aiField(label, value, confidence = "中", field = "") {
  const cls = confidence === "高" ? "high" : confidence === "低" ? "low" : "mid";
  return `<div class="ai-field-card" data-field="${esc(field)}">
    <div><span>${esc(label)}</span><em class="${cls}">${esc(confidence)}</em></div>
    <p contenteditable="true" data-field-value="true">${esc(value || "未识别，可手动补充")}</p>
  </div>`;
}

function aiProjectField(value, confidence = "高") {
  const isEmpty = !value;
  const cls = isEmpty ? "low" : confidence === "高" ? "high" : confidence === "低" ? "low" : "mid";
  const knownProjects = PROJECTS;
  const isNew = value && !knownProjects.includes(value);
  const newTag = isNew ? `<span class="ai-new-tag">新增</span>` : "";
  const requiredTag = isEmpty ? `<span class="ai-required-tag">必填</span>` : "";
  const options = knownProjects.map(p => {
    const area = projectAreas.find(a => normalizeProject(a.name) === normalizeProject(p));
    const owners = area ? splitPeople(area.owner).join("、") : "";
    const label = owners ? `${p}（负责人：${owners}）` : p;
    return `<option value="${esc(p)}"${value === p ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
  const unknownOption = isNew ? `<option value="${esc(value)}" selected>${esc(value)}</option>` : "";
  const infoHtml = value ? _projectInfoCard(value) : "";
  return `<div class="ai-field-card ${isEmpty ? "ai-field-required" : ""}" data-field="special_project">
    <div><span>所属专项${newTag}${requiredTag}</span><em class="${cls}">${isEmpty ? "未识别" : esc(confidence)}</em></div>
    <select data-field-value="true" data-is-select="true" onchange="onProjectSelectChange(this)">
      <option value="">— 未识别，请手动选择 —</option>
      ${unknownOption}${options}
    </select>
    ${isEmpty ? `<p class="ai-field-warn">AI 未能识别所属专项，请选择后才能提交。</p>` : ""}
    <div class="ai-project-info-wrap">${infoHtml}</div>
  </div>`;
}

function _projectInfoCard(projectName) {
  const area = projectAreas.find(a => normalizeProject(a.name) === normalizeProject(projectName));
  if (!area) return "";
  const owners = splitPeople(area.owner).join("、") || "—";
  const coordinator = area.coordinator || "—";
  const collabs = Array.isArray(area.collaborators) ? area.collaborators.join("、") : (area.collaborators || "—");
  return `<div class="ai-project-detail">
    <span><b>统筹：</b>${esc(coordinator)}</span>
    <span><b>负责人：</b>${esc(owners)}</span>
    ${collabs && collabs !== "—" ? `<span><b>协同：</b>${esc(collabs)}</span>` : ""}
  </div>`;
}

function onProjectSelectChange(sel) {
  // Support both new .extract-row structure and legacy .ai-field-card
  const row = sel.closest(".extract-row") || sel.closest(".ai-field-card");
  if (!row) return;
  const detailEl = document.getElementById("projectDetailRow") || row.querySelector(".ai-project-info-wrap");
  const warnEl = row.querySelector(".extract-warn-text") || row.querySelector(".ai-field-warn");
  if (sel.value) {
    row.classList.remove("extract-row-required", "ai-field-required");
    if (warnEl) warnEl.style.display = "none";
    if (detailEl) detailEl.innerHTML = _projectInfoCard(sel.value);
  } else {
    row.classList.add("extract-row-required");
    if (detailEl) detailEl.innerHTML = "";
    if (warnEl) warnEl.style.display = "";
  }
  const ownerSel = document.getElementById("extractOwnerSelect");
  if (ownerSel) ownerSel.innerHTML = _ownerOptions(sel.value);
}

function insight(label, value) {
  return `<div class="insight"><span>${label}</span><p>${esc(value || "未识别，可在确认中心补充")}</p></div>`;
}

function discardPreview() {
  state.previewPayload = null;
  state.previewSuggestion = null;
  document.getElementById("suggestionPanel").innerHTML = `<h3>AI 提取结果</h3><p>请核对以下字段，修改后点击确认写入</p><div class="waiting-box">等待生成...</div>`;
}

function splitEditedList(value) {
  return String(value || "").split(/[；;\n]+/).map(item => item.trim()).filter(Boolean);
}

function readEditedSuggestion() {
  const suggestion = typeof structuredClone === "function" ? structuredClone(state.previewSuggestion || {}) : JSON.parse(JSON.stringify(state.previewSuggestion || {}));
  const values = {};
  document.querySelectorAll("#suggestionPanel .extract-row[data-field], #suggestionPanel .ai-field-card[data-field]").forEach(card => {
    const field = card.dataset.field;
    if (!field) return;
    const el = card.querySelector("[data-field-value]");
    values[field] = el ? (el.dataset.isSelect === "true" ? el.value : el.textContent.trim()) : "";
  });

  if (Object.prototype.hasOwnProperty.call(values, "special_project")) {
    suggestion.special_project = normalizeProject(values.special_project);
    if (suggestion.task) suggestion.task.special_project = suggestion.special_project;
    (suggestion.achievements || []).forEach(item => item.special_project = suggestion.special_project);
    (suggestion.issues || []).forEach(item => item.special_project = suggestion.special_project);
  }
  if (Object.prototype.hasOwnProperty.call(values, "related_task")) {
    suggestion.related_task = values.related_task;
    suggestion.task = { ...(suggestion.task || {}), key_task: values.related_task };
  }
  if (Object.prototype.hasOwnProperty.call(values, "completed_items")) {
    suggestion.completed_items = splitEditedList(values.completed_items);
  }
  if (Object.prototype.hasOwnProperty.call(values, "achievements")) {
    const names = splitEditedList(values.achievements);
    const existing = suggestion.achievements || [];
    suggestion.achievements = names.map((name, index) => ({
      ...(existing[index] || {}),
      name,
      special_project: (existing[index] || {}).special_project || suggestion.special_project || "",
    }));
    if (suggestion.task && names[0]) suggestion.task.key_achievement = names[0];
  }
  if (Object.prototype.hasOwnProperty.call(values, "next_steps")) {
    suggestion.next_steps = splitEditedList(values.next_steps);
  }
  if (Object.prototype.hasOwnProperty.call(values, "need_coordination")) {
    suggestion.need_coordination = splitEditedList(values.need_coordination);
    suggestion.coordinator_needed = values.need_coordination;
  }
  if (Object.prototype.hasOwnProperty.call(values, "extra_note")) {
    suggestion.extra_note = values.extra_note;
  }

  const ownerSel = document.getElementById("extractOwnerSelect");
  if (ownerSel && ownerSel.value) {
    const ownerName = ownerSel.value;
    suggestion.owner = ownerName;
    if (suggestion.task) suggestion.task.owner = ownerName;
    (suggestion.achievements || []).forEach(item => { if (!item.owner) item.owner = ownerName; });
  }

  return suggestion;
}

async function submitPreview() {
  if (!state.previewPayload) return toast("请先生成AI建议");
  if (state.submitting) return;
  const editedSuggestion = readEditedSuggestion();
  if (!editedSuggestion.special_project) {
    const card = document.querySelector('#suggestionPanel [data-field="special_project"]');
    if (card) {
      card.classList.add("extract-row-required", "ai-field-required");
      card.scrollIntoView({ behavior: "smooth", block: "center" });
    }
    return toast("请先选择所属专项，再提交");
  }
  state.submitting = true;
  const btns = document.querySelectorAll(".extract-actions button");
  btns.forEach(b => { b.disabled = true; });
  try {
    await api("/api/updates", {
      method: "POST",
      body: JSON.stringify({
        ...state.previewPayload,
        human_result: editedSuggestion,
        edited_suggestion: editedSuggestion,
      }),
    });
    state.previewPayload = null;
    state.previewSuggestion = null;
    invalidate("updates", "confirmations");
    if (canViewConfirmationCenter()) {
      toast("已提交确认中心，负责人确认后将写入任务、成果和问题表。");
      switchPage("confirmations");
    } else {
      toast("已提交进度更新，等待负责人处理。");
      renderUpdates();
    }
  } catch (err) {
    toast(`提交失败：${err.message}`);
    btns.forEach(b => { b.disabled = false; });
  } finally {
    state.submitting = false;
  }
}
