// 全局状态单例 & 基础数据
// 依赖：currentMonthStr() (components.js)，须在 components.js 之后加载

const pages = [
  ["dashboard", "驾驶舱"],
  ["updates", "提交进度更新"],
  ["confirmations", "AI确认中心"],
  ["tasks", "工作推进表"],
  ["achievements", "成果库"],
  ["issues", "问题与决策"],
  ["people", "组织与分工"],
];
const adminPages = [["settings", "系统设置"]];

let state = {
  previewPayload: null,
  previewSuggestion: null,
  updateInputMode: "voice",
  isRecording: false,
  recordingSeconds: 0,
  recordingTimer: null,
  selectedConfirmationId: null,
  dashboardFilters: { project: "", owner: "", status: "", month: currentMonthStr() },
  selectedTaskProject: "",
  taskFilters: { project: "", status: "", owner: "", month: "" },
  selectedAchievementProject: "",
  achievementFilters: { project: "", type: "", reuse: "", owner: "" },
  confirmationTab: "待审核",
  llmProvider: "rules",
  settingsTab: "projects",
  issueTab: "all",
  issueFilters: { priority: "", project: "", owner: "", status: "" },
  orgViewMode: "project",
  selectedOrgProjectId: "",
  selectedOrgMember: "",
  hoveredOrgProjectId: "",
  hoveredOrgMember: "",
  userContext: null,
  speechRecognition: null,
  speechRecognitionSupported: typeof window !== "undefined" && !!(window.SpeechRecognition || window.webkitSpeechRecognition),
};

let projectAreas = [
  {
    id: "knowledge-assets",
    name: "知识资产AI化",
    code: "ZS",
    coordinator: "刘万超",
    owner: "杨宇帆",
    collaborators: ["袁金玉", "郭熠彬", "吴肖"],
    taskCount: 4,
    riskCount: 0,
  },
  {
    id: "consultant-work",
    name: "顾问作业AI化",
    code: "GW",
    coordinator: "刘万超",
    owner: "许明良",
    collaborators: ["全体顾问", "郭熠彬", "吴肖"],
    taskCount: 4,
    riskCount: 0,
  },
  {
    id: "delivery-flow",
    name: "交付流程AI化",
    code: "JF",
    coordinator: "刘万超",
    owner: "温会林",
    collaborators: ["各项目经理", "郭熠彬", "吴肖", "袁金玉"],
    taskCount: 5,
    riskCount: 0,
  },
  {
    id: "service-product",
    name: "咨询服务产品化",
    code: "CP",
    coordinator: "邹奇敏",
    owner: "彭超凡",
    collaborators: ["刘万超", "温会林", "市场部"],
    taskCount: 5,
    riskCount: 0,
  },
  {
    id: "tech-platform",
    name: "技术底座与平台预研",
    code: "JS",
    coordinator: "冯海林",
    owner: "吴肖、郭熠彬",
    collaborators: ["刘万超", "邹奇敏"],
    taskCount: 5,
    riskCount: 0,
  },
];

let members = [
  {
    id: "feng-hailin",
    name: "冯海林",
    role: "组长",
    isAdmin: false,
    responsibleArea: [],
    responsibility: "方向判断、项目统筹、重大决策、阶段验收；把握AI升级与企业管理辅导主航道的关系",
  },
  {
    id: "liu-wanchao",
    name: "刘万超",
    role: "统筹",
    isAdmin: false,
    responsibleArea: ["知识资产AI化", "顾问作业AI化", "交付流程AI化"],
    responsibility: "统筹知识资产AI化、顾问作业AI化、交付流程AI化；组织咨询部沉淀方法论、案例、模板和项目经验",
  },
  {
    id: "zou-qimin",
    name: "邹奇敏",
    role: "统筹",
    isAdmin: false,
    responsibleArea: ["咨询服务产品化"],
    responsibility: "统筹咨询服务产品化、产品表达、客户验证和训练营落地",
  },
  {
    id: "wen-huilin",
    name: "温会林",
    role: "负责",
    isAdmin: false,
    responsibleArea: ["交付流程AI化"],
    responsibility: "推动鲁邦通实践转化、样板项目复盘、Agent体系案例沉淀",
  },
  {
    id: "yuan-jinyu",
    name: "袁金玉",
    role: "过程保障",
    isAdmin: false,
    responsibleArea: [],
    responsibility: "负责资料管理、过程跟踪、培训组织、规则保障、会议记录和归档",
  },
  {
    id: "yang-yufan",
    name: "杨宇帆",
    role: "负责",
    isAdmin: false,
    responsibleArea: ["知识资产AI化"],
    responsibility: "推进知识库框架、知识资产目录、方法论/案例/模板入库和调用测试",
  },
  {
    id: "xu-mingliang",
    name: "许明良",
    role: "负责",
    isAdmin: false,
    responsibleArea: ["顾问作业AI化"],
    responsibility: "推进顾问高频作业场景梳理、Prompt工具包、作业SOP和顾问使用复盘",
  },
  {
    id: "peng-chaofan",
    name: "彭超凡",
    role: "负责",
    isAdmin: false,
    responsibleArea: ["咨询服务产品化"],
    responsibility: "推进产品一页纸、销售材料、训练营物料和客户验证反馈整理",
  },
  {
    id: "guo-yibin",
    name: "郭熠彬",
    role: "AI应用工程师",
    isAdmin: false,
    responsibleArea: ["技术底座与平台预研"],
    responsibility: "AI应用、Agent原型、工具测试、自动化流程、项目应用支持",
  },
  {
    id: "wu-xiao",
    name: "吴肖",
    role: "AI应用工程师",
    isAdmin: false,
    responsibleArea: ["技术底座与平台预研"],
    responsibility: "知识工程、知识库调用测试、Agent运营支持、平台预研支持",
  },
];

const SYSTEM_ADMIN = "mowasyadmin";

// 登录后由 initApp() 写入，供后续所有模块读取
let _sessionUsername = "";

// PROJECTS 始终从 projectAreas 实时派生（loadDynamicOrgData 更新后自动生效）
Object.defineProperty(window, "PROJECTS", {
  get() { return projectAreas.map(a => a.name); },
  configurable: true,
});
