const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = Number(process.env.PORT || 8787);
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, "data");
const DATA_FILE = path.join(DATA_DIR, "state.json");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;
    const key = match[1];
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(path.join(ROOT, ".env"));

const AI_BASE_URL = (process.env.OPENAI_BASE_URL || process.env.AI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
const AI_API_KEY = process.env.OPENAI_API_KEY || process.env.AI_API_KEY || "";
const AI_MODEL = process.env.OPENAI_MODEL || process.env.AI_MODEL || "gpt-4.1-mini";
const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 20000);
const AI_RESPONSE_FORMAT_JSON = String(process.env.AI_RESPONSE_FORMAT_JSON || "1") !== "0";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "";

const seedSubmissions = [
  { sessionId: "S-1042", profileType: "AI 尝鲜者", scenario: "会议纪要", concern: "不会提问", status: "已完成", answers: ["试过豆包", "偶尔用", "会议纪要", "不会写提示词"] },
  { sessionId: "S-1041", profileType: "AI 效率提升者", scenario: "文档/报告", concern: "准确性", status: "已完成", answers: ["用过 Kimi", "每周使用", "报告初稿", "担心准确性"] },
  { sessionId: "S-1040", profileType: "AI 旁观者", scenario: "培训入门", concern: "数据安全", status: "进行中", answers: ["很少用", "想先学基础"] },
  { sessionId: "S-1039", profileType: "AI 场景实践者", scenario: "数据分析", concern: "工具限制", status: "已完成", answers: ["每天用", "数据分析", "流程自动化"] }
];

const promptTemplates = {
  answerExtract: {
    version: "answer-extract-v1",
    content: [
      "你是企业大会现场的 AI 调研结构化助手。",
      "请基于单个问题和回答，提取用于大屏聚合的结构化标签。",
      "只返回 JSON，不要 Markdown，不要解释。",
      "字段必须为：summary, usageFrequency, willingness, capabilityTags, wishTags, concernTags, confidence。",
      "usageFrequency 从 从未使用、偶尔使用、每周使用、每天使用、未提及 中选择。",
      "willingness 从 期待、观望、担心、未提及 中选择。",
      "capabilityTags 表示用户认为 AI 已经能做什么；wishTags 表示用户希望 AI 做到什么；concernTags 表示顾虑。",
      "每个 tags 数组最多 4 个短词。confidence 为 0-1 数字。"
    ].join("\n")
  },
  profileGenerate: {
    version: "profile-generate-v1",
    content: "根据用户回答和单题结构化总结，输出画像类型、四项评分、100-150 字解读和 3 条行动建议。模型失败时使用模板兜底。"
  },
  groupInsight: {
    version: "group-insight-v1",
    content: [
      "你是企业大会讲师大屏的洞察撰写助手。",
      "请基于现场聚合数据生成一段适合大屏展示的全场洞察。",
      "语气专业、积极、面向讲师可直接口播。",
      "只返回 JSON，不要 Markdown，不要解释。字段必须为：insight。",
      "insight 控制在 80-140 个中文字符。"
    ].join("\n")
  }
};

const defaults = {
  eventName: "AI 互动调研与实时画像系统",
  eventUrl: "https://crilyk.github.io/YFtest/audience-h5.html",
  publicApiBase: (process.env.PUBLIC_API_BASE || "").replace(/\/$/, ""),
  activityState: "进行中",
  durationMinutes: 10,
  targetCapacity: 300,
  secondsLeft: 522,
  visits: 238,
  started: 216,
  done: 184,
  questions: [
    { text: "你觉得 AI 目前对你的工作影响大吗？", quick: ["影响很大", "有一些影响", "暂时不明显"] },
    { text: "你是否用过 ChatGPT、通义、Kimi、豆包等 AI 工具？", quick: ["经常用", "偶尔试过", "基本没用过"] },
    { text: "你大概多久用一次 AI？", quick: ["每天", "每周", "偶尔", "几乎不用"] },
    { text: "你最希望 AI 帮你解决哪类工作问题？", quick: ["文档/报告", "会议纪要", "数据分析", "知识检索"] },
    { text: "你不常使用 AI 的主要原因是什么？", quick: ["准确性", "数据安全", "不会提问", "缺少案例"] },
    { text: "你对 AI 进入企业工作流是期待、观望还是担心？", quick: ["期待", "观望", "担心"] },
    { text: "你最想学习哪类 AI 能力？", quick: ["提示词", "场景案例", "结果校验", "流程嵌入"] }
  ],
  prompt: "根据用户回答，输出画像类型、四项评分、100-150 字解读和 3 条行动建议。模型失败时使用模板兜底。",
  promptTemplates,
  dashboardFields: ["counts", "profile", "usage", "scenario", "concern", "keyword", "insight"],
  submissions: seedSubmissions,
  sessionDrafts: {},
  dashboardSnapshot: null,
  startedSessionIds: [],
  submittedSessionIds: [],
  timerUpdatedAt: new Date().toISOString()
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) writeState(clone(defaults));
}

function readState() {
  ensureDataFile();
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    const mergedPrompts = normalizePromptTemplates(parsed.promptTemplates, parsed.prompt);
    return {
      ...clone(defaults),
      ...parsed,
      questions: Array.isArray(parsed.questions) && parsed.questions.length ? parsed.questions : clone(defaults.questions),
      promptTemplates: mergedPrompts,
      dashboardFields: Array.isArray(parsed.dashboardFields) ? parsed.dashboardFields : clone(defaults.dashboardFields),
      submissions: Array.isArray(parsed.submissions) ? parsed.submissions : clone(seedSubmissions),
      sessionDrafts: parsed.sessionDrafts && typeof parsed.sessionDrafts === "object" ? parsed.sessionDrafts : {},
      dashboardSnapshot: parsed.dashboardSnapshot || null,
      startedSessionIds: Array.isArray(parsed.startedSessionIds) ? parsed.startedSessionIds : [],
      submittedSessionIds: Array.isArray(parsed.submittedSessionIds) ? parsed.submittedSessionIds : []
    };
  } catch (error) {
    return clone(defaults);
  }
}

function writeState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(state, null, 2), "utf8");
}

function normalizePromptTemplates(input, legacyPrompt = "") {
  const source = input && typeof input === "object" ? input : {};
  const normalized = clone(defaults.promptTemplates);
  for (const key of Object.keys(normalized)) {
    normalized[key] = {
      ...normalized[key],
      ...(source[key] && typeof source[key] === "object" ? source[key] : {})
    };
  }
  if (legacyPrompt && (!source.profileGenerate || !source.profileGenerate.content)) {
    normalized.profileGenerate.content = legacyPrompt;
  }
  return normalized;
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeTimer(state) {
  const durationSeconds = clamp(Number(state.durationMinutes) || defaults.durationMinutes, 1, 30) * 60;
  if (state.activityState === "未开始") {
    state.secondsLeft = durationSeconds;
    state.timerUpdatedAt = new Date().toISOString();
    return state;
  }
  if (state.activityState === "已结束") {
    state.secondsLeft = 0;
    state.timerUpdatedAt = new Date().toISOString();
    return state;
  }
  if (state.activityState !== "进行中") return state;

  const now = Date.now();
  const then = Date.parse(state.timerUpdatedAt || "");
  if (!Number.isFinite(state.secondsLeft)) state.secondsLeft = durationSeconds;
  if (!Number.isFinite(then)) {
    state.timerUpdatedAt = new Date(now).toISOString();
    return state;
  }
  const elapsed = Math.max(Math.floor((now - then) / 1000), 0);
  if (elapsed > 0) {
    state.secondsLeft = Math.max(Number(state.secondsLeft) - elapsed, 0);
    state.timerUpdatedAt = new Date(now).toISOString();
    if (state.secondsLeft === 0) state.activityState = "已结束";
  }
  return state;
}

function publicState(state) {
  const copy = clone(state);
  delete copy.startedSessionIds;
  delete copy.submittedSessionIds;
  delete copy.timerUpdatedAt;
  return copy;
}

function safeSessionId(value) {
  return String(value || `S-${crypto.randomInt(1000, 9999)}`).slice(0, 40);
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token,Authorization"
  });
  res.end(body);
}

function sendText(res, status, text, type = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PUT,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,X-Admin-Token,Authorization"
  });
  res.end(text);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2_000_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function isAdminAuthorized(req) {
  if (!ADMIN_TOKEN) return true;
  const headerToken = req.headers["x-admin-token"];
  const auth = req.headers.authorization || "";
  const bearerToken = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";
  return headerToken === ADMIN_TOKEN || bearerToken === ADMIN_TOKEN;
}

function mergeConfig(state, body) {
  const configKeys = [
    "eventName",
    "eventUrl",
    "publicApiBase",
    "activityState",
    "durationMinutes",
    "targetCapacity",
    "secondsLeft",
    "visits",
    "started",
    "done",
    "questions",
    "prompt",
    "promptTemplates",
    "dashboardFields",
    "submissions",
    "dashboardSnapshot"
  ];
  const next = { ...state };
  for (const key of configKeys) {
    if (Object.prototype.hasOwnProperty.call(body, key)) next[key] = body[key];
  }
  next.durationMinutes = clamp(Number(next.durationMinutes) || defaults.durationMinutes, 1, 30);
  next.targetCapacity = clamp(Number(next.targetCapacity) || defaults.targetCapacity, 10, 1000);
  next.publicApiBase = String(next.publicApiBase || "").trim().replace(/\/$/, "");
  next.visits = Math.max(Number(next.visits) || 0, 0);
  next.started = Math.max(Number(next.started) || 0, 0);
  next.done = Math.max(Number(next.done) || 0, 0);
  if (!Array.isArray(next.questions) || !next.questions.length) next.questions = clone(defaults.questions);
  next.promptTemplates = normalizePromptTemplates(next.promptTemplates, next.prompt);
  next.prompt = next.promptTemplates.profileGenerate && next.promptTemplates.profileGenerate.content ? next.promptTemplates.profileGenerate.content : (next.prompt || defaults.prompt);
  if (!Array.isArray(next.dashboardFields)) next.dashboardFields = clone(defaults.dashboardFields);
  if (!Array.isArray(next.submissions)) next.submissions = [];
  next.submissions = next.submissions.slice(0, 200);
  next.timerUpdatedAt = new Date().toISOString();
  return normalizeTimer(next);
}

function addMockSubmissions(state, count) {
  const profiles = ["AI 旁观者", "AI 尝鲜者", "AI 效率提升者", "AI 场景实践者", "AI 推动者"];
  const scenarios = ["文档/报告", "会议纪要", "数据分析", "知识检索", "研发/营销"];
  const concerns = ["准确性", "数据安全", "不会提问", "工具限制", "缺少案例"];
  const tags = ["会议纪要", "提示词", "数据安全", "报告初稿", "准确性", "知识库", "效率提升", "流程嵌入", "不会提问"];
  for (let i = 0; i < count; i += 1) {
    const profileType = profiles[Math.floor(Math.random() * profiles.length)];
    const scenario = scenarios[Math.floor(Math.random() * scenarios.length)];
    const concern = concerns[Math.floor(Math.random() * concerns.length)];
    const sessionId = `S-${crypto.randomInt(1000, 9999)}`;
    state.submissions.unshift({
      sessionId,
      eventId: "yanfeng-demo-2026",
      enterTime: new Date().toISOString(),
      submitTime: new Date().toISOString(),
      profileType,
      scenario,
      concern,
      status: "已完成",
      derivedTags: [scenario, concern, tags[Math.floor(Math.random() * tags.length)]],
      usageFrequency: ["偶尔使用", "每周使用", "每天使用"][Math.floor(Math.random() * 3)],
      willingness: ["期待", "观望", "担心"][Math.floor(Math.random() * 3)],
      capabilityTags: [scenario, "效率提升"],
      wishTags: ["提示词模板", "结果校验", "流程自动化"].slice(0, 2 + Math.floor(Math.random() * 2)),
      concernTags: [concern],
      answerInsights: [
        {
          summary: `希望 AI 帮助${scenario}`,
          usageFrequency: "每周使用",
          willingness: "期待",
          capabilityTags: [scenario],
          wishTags: ["提示词模板", "结果校验"],
          concernTags: [concern],
          confidence: 0.75,
          aiGenerated: false,
          model: "mock"
        }
      ],
      answers: [`希望 AI 帮助${scenario}`, `主要顾虑是${concern}`]
    });
    state.submittedSessionIds.push(sessionId);
  }
  state.visits += count;
  state.started += count;
  state.done += count;
  state.submissions = state.submissions.slice(0, 200);
  state.dashboardSnapshot = null;
  return state;
}

function includesAny(text, words) {
  const source = String(text || "");
  return words.some(word => source.includes(word));
}

function textOfAnswers(answers) {
  return (Array.isArray(answers) ? answers : []).map(item => {
    if (typeof item === "string") return item;
    return item && item.answer ? item.answer : "";
  }).join(" ");
}

function inferProfileFromText(text) {
  if (includesAny(text, ["推动", "培训", "分享", "团队", "推广"])) return "AI 推动者";
  if (includesAny(text, ["每天", "经常", "流程", "自动", "知识库", "研发", "数据分析"])) return "AI 场景实践者";
  if (includesAny(text, ["用过", "报告", "会议", "总结", "文档", "效率", "每周"])) return "AI 效率提升者";
  if (includesAny(text, ["偶尔", "试过", "豆包", "Kimi", "通义", "ChatGPT"])) return "AI 尝鲜者";
  return "AI 旁观者";
}

function inferScenarioFromText(text) {
  const candidates = [
    ["会议纪要", ["会议", "纪要"]],
    ["文档/报告", ["文档", "报告", "邮件", "初稿"]],
    ["数据分析", ["数据", "分析", "报表"]],
    ["知识检索", ["检索", "搜索", "资料", "知识库"]],
    ["研发/营销", ["研发", "营销", "客服", "代码"]]
  ];
  const found = candidates.find(([, words]) => includesAny(text, words));
  return found ? found[0] : "培训入门";
}

function inferConcernFromText(text) {
  const candidates = [
    ["准确性", ["准确", "可靠", "错误", "幻觉"]],
    ["数据安全", ["安全", "隐私", "敏感", "保密"]],
    ["不会提问", ["不会", "提示词", "提问", "怎么问"]],
    ["工具限制", ["限制", "权限", "打不开", "账号"]],
    ["缺少案例", ["案例", "不知道", "不清楚"]]
  ];
  const found = candidates.find(([, words]) => includesAny(text, words));
  return found ? found[0] : "缺少案例";
}

function fallbackProfileContent(type) {
  const map = {
    "AI 推动者": {
      text: "你已经具备把 AI 经验扩散给他人的潜力，关注点从个人效率延伸到团队协作和方法沉淀。接下来适合学习场景评估、最佳实践包装和企业内部推广节奏，让 AI 能力在团队中稳定复制。",
      scores: [92, 88, 90, 94],
      actions: ["沉淀一套可分享的高频场景案例。", "建立团队提示词模板与输出校验标准。", "用小范围试点验证 AI 工作流的真实收益。"]
    },
    "AI 场景实践者": {
      text: "你已经能把 AI 与具体业务问题联系起来，关注的不只是工具本身，而是如何把它嵌入稳定流程。接下来适合学习任务拆解、知识库和结果校验，让 AI 从个人效率工具升级为协作能力。",
      scores: [86, 82, 88, 84],
      actions: ["把重复任务拆成可交给 AI 协作的步骤。", "尝试建立私有知识素材与提示词组合。", "为关键输出设置人工复核和事实校验点。"]
    },
    "AI 效率提升者": {
      text: "你已经意识到 AI 可以帮助提升工作效率，并可能在资料整理、内容生成、信息检索等场景中有所尝试。你目前最需要的是把零散使用沉淀为固定场景、提示词模板和可靠的输出校验方法。",
      scores: [76, 68, 72, 78],
      actions: ["把 AI 用于会议纪要、报告初稿、资料总结等高频任务。", "学习如何写出清晰提示词，并沉淀可复用模板。", "建立输出校验习惯，区分可直接使用和需要复核的结果。"]
    },
    "AI 尝鲜者": {
      text: "你对 AI 有兴趣，也可能已经试用过一些工具，但还没有形成稳定习惯。建议从低风险、高频率的日常任务开始，例如会议纪要、资料摘要和邮件初稿，先建立可感知的小胜利。",
      scores: [62, 48, 55, 66],
      actions: ["选择一个不涉及敏感信息的日常任务开始。", "用课程中的模板完成一次完整提示词练习。", "每周固定复盘一次 AI 输出是否真的节省时间。"]
    },
    "AI 旁观者": {
      text: "你对 AI 的价值仍在观察，可能担心准确性、数据安全或不知道如何开始。建议先从课程中的基础案例入手，用不涉及敏感信息的任务体验 AI，再逐步理解提示词和校验方法。",
      scores: [42, 28, 36, 48],
      actions: ["先理解 AI 能做什么和不能做什么。", "从资料摘要、改写润色等低风险任务体验。", "重点学习数据安全边界和结果校验方法。"]
    }
  };
  return map[type] || map["AI 旁观者"];
}

function extractKeywordsFromText(text) {
  const dict = ["会议纪要", "提示词", "数据安全", "报告初稿", "准确性", "知识库", "效率提升", "流程嵌入", "不会提问", "数据分析", "培训入门", "结果校验"];
  const found = dict.filter(word => text.includes(word.replace("/", "")) || text.includes(word));
  return found.length ? found : ["会议纪要", "提示词", "准确性"];
}

function fallbackAiProfile(answers) {
  const text = textOfAnswers(answers);
  const profileType = inferProfileFromText(text);
  const content = fallbackProfileContent(profileType);
  return {
    profileType,
    profileText: content.text,
    scores: content.scores,
    actions: content.actions,
    scenario: inferScenarioFromText(text),
    concern: inferConcernFromText(text),
    derivedTags: extractKeywordsFromText(text),
    aiGenerated: false,
    model: "local-fallback"
  };
}

function clampScore(value, fallback) {
  const score = Number(value);
  if (!Number.isFinite(score)) return fallback;
  return clamp(Math.round(score), 0, 100);
}

function sanitizeAiProfile(raw, answers) {
  const fallback = fallbackAiProfile(answers);
  const profileTypes = ["AI 旁观者", "AI 尝鲜者", "AI 效率提升者", "AI 场景实践者", "AI 推动者"];
  const scenarios = ["文档/报告", "会议纪要", "数据分析", "知识检索", "研发/营销", "培训入门"];
  const concerns = ["准确性", "数据安全", "不会提问", "工具限制", "缺少案例"];
  const scores = Array.isArray(raw.scores) ? raw.scores : [];
  const actions = Array.isArray(raw.actions) ? raw.actions : [];
  const derivedTags = Array.isArray(raw.derivedTags) ? raw.derivedTags : [];
  const profileType = profileTypes.includes(raw.profileType) ? raw.profileType : fallback.profileType;
  return {
    profileType,
    profileText: String(raw.profileText || fallback.profileText).slice(0, 260),
    scores: [0, 1, 2, 3].map(index => clampScore(scores[index], fallback.scores[index])),
    actions: [0, 1, 2].map(index => String(actions[index] || fallback.actions[index]).slice(0, 80)),
    scenario: scenarios.includes(raw.scenario) ? raw.scenario : fallback.scenario,
    concern: concerns.includes(raw.concern) ? raw.concern : fallback.concern,
    derivedTags: (derivedTags.length ? derivedTags : fallback.derivedTags).map(item => String(item).slice(0, 16)).slice(0, 6),
    aiGenerated: true,
    model: AI_MODEL
  };
}

function extractJsonObject(text) {
  const source = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(source);
  } catch (error) {
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start >= 0 && end > start) return JSON.parse(source.slice(start, end + 1));
    throw error;
  }
}

async function callAiJson(systemPrompt, payload) {
  if (!AI_API_KEY) return null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  try {
    const requestBody = {
      model: AI_MODEL,
      temperature: 0.35,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload, null, 2) }
      ]
    };
    if (AI_RESPONSE_FORMAT_JSON) requestBody.response_format = { type: "json_object" };
    const response = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal
    });
    if (!response.ok) {
      const message = await response.text().catch(() => "");
      throw new Error(message || `AI HTTP ${response.status}`);
    }
    const data = await response.json();
    const content = data && data.choices && data.choices[0] && data.choices[0].message ? data.choices[0].message.content : "";
    return extractJsonObject(content);
  } finally {
    clearTimeout(timeout);
  }
}

function fallbackAnswerInsight(question, answer) {
  const text = `${question || ""} ${answer || ""}`;
  const usageFrequency = includesAny(text, ["每天", "经常", "高频"]) ? "每天使用"
    : includesAny(text, ["每周", "一周"]) ? "每周使用"
    : includesAny(text, ["偶尔", "试过", "很少"]) ? "偶尔使用"
    : includesAny(text, ["不用", "没用", "从未"]) ? "从未使用"
    : "未提及";
  const willingness = includesAny(text, ["期待", "愿意", "希望", "想学", "推动"]) ? "期待"
    : includesAny(text, ["担心", "顾虑", "风险", "安全", "准确"]) ? "担心"
    : includesAny(text, ["观望", "看看", "不确定"]) ? "观望"
    : "未提及";
  const capabilityTags = extractKeywordsFromText(text).filter(tag => ["会议纪要", "报告初稿", "数据分析", "知识库", "效率提升"].includes(tag)).slice(0, 4);
  const wishTags = extractKeywordsFromText(text).filter(tag => ["提示词", "流程嵌入", "结果校验", "场景案例", "知识库"].includes(tag)).slice(0, 4);
  const concernTags = ["准确性", "数据安全", "不会提问", "工具限制", "缺少案例"].filter(tag => text.includes(tag)).slice(0, 4);
  return {
    summary: String(answer || "").slice(0, 80) || "用户跳过了该问题。",
    usageFrequency,
    willingness,
    capabilityTags: capabilityTags.length ? capabilityTags : [],
    wishTags: wishTags.length ? wishTags : [],
    concernTags,
    confidence: 0.68,
    aiGenerated: false,
    model: "local-fallback"
  };
}

function sanitizeAnswerInsight(raw, question, answer) {
  const fallback = fallbackAnswerInsight(question, answer);
  const usageValues = ["从未使用", "偶尔使用", "每周使用", "每天使用", "未提及"];
  const willingnessValues = ["期待", "观望", "担心", "未提及"];
  const tags = value => (Array.isArray(value) ? value : []).map(item => String(item).slice(0, 16)).filter(Boolean).slice(0, 4);
  return {
    summary: String(raw.summary || fallback.summary).slice(0, 120),
    usageFrequency: usageValues.includes(raw.usageFrequency) ? raw.usageFrequency : fallback.usageFrequency,
    willingness: willingnessValues.includes(raw.willingness) ? raw.willingness : fallback.willingness,
    capabilityTags: tags(raw.capabilityTags).length ? tags(raw.capabilityTags) : fallback.capabilityTags,
    wishTags: tags(raw.wishTags).length ? tags(raw.wishTags) : fallback.wishTags,
    concernTags: tags(raw.concernTags).length ? tags(raw.concernTags) : fallback.concernTags,
    confidence: clamp(Number(raw.confidence) || fallback.confidence, 0, 1),
    aiGenerated: true,
    model: AI_MODEL
  };
}

async function callAiAnswerInsight(body, state) {
  const question = body.question || "";
  const answer = body.answer || "";
  if (!AI_API_KEY) return fallbackAnswerInsight(question, answer);
  const template = state.promptTemplates && state.promptTemplates.answerExtract ? state.promptTemplates.answerExtract : defaults.promptTemplates.answerExtract;
  const raw = await callAiJson(template.content, {
    sessionId: body.sessionId,
    questionIndex: body.questionIndex,
    question,
    answer,
    skipped: !!body.skipped
  });
  return sanitizeAnswerInsight(raw || {}, question, answer);
}

async function callAiProfile(body, state) {
  if (!AI_API_KEY) {
    const fallback = fallbackAiProfile(body.answers);
    fallback.reason = "missing_api_key";
    return fallback;
  }

  const answers = Array.isArray(body.answers) ? body.answers : [];
  const questions = Array.isArray(state.questions) ? state.questions.map(item => item.text || item).filter(Boolean) : [];
  const userPayload = {
    sessionId: body.sessionId,
    questions,
    answers,
    answerInsights: Array.isArray(body.answerInsights) ? body.answerInsights : [],
    profileTypes: ["AI 旁观者", "AI 尝鲜者", "AI 效率提升者", "AI 场景实践者", "AI 推动者"],
    scenarios: ["文档/报告", "会议纪要", "数据分析", "知识检索", "研发/营销", "培训入门"],
    concerns: ["准确性", "数据安全", "不会提问", "工具限制", "缺少案例"]
  };
  const template = state.promptTemplates && state.promptTemplates.profileGenerate ? state.promptTemplates.profileGenerate : defaults.promptTemplates.profileGenerate;
  const systemPrompt = [
    "你是企业大会现场的 AI 调研画像分析助手。",
    "请基于观众对 AI 使用现状的回答，生成一个简洁、积极、可行动的个人 AI 工作力画像。",
    template.content || state.prompt || defaults.prompt,
    "只返回 JSON，不要 Markdown，不要解释。JSON 字段必须为：profileType, profileText, scores, actions, scenario, concern, derivedTags。",
    "profileType 必须从 AI 旁观者、AI 尝鲜者、AI 效率提升者、AI 场景实践者、AI 推动者中选择。",
    "scores 是 4 个 0-100 整数，依次代表 AI 认知度、使用成熟度、场景清晰度、行动意愿。",
    "actions 必须正好 3 条，每条不超过 40 个中文字符。profileText 100-150 个中文字符。"
  ].join("\n");
  const raw = await callAiJson(systemPrompt, userPayload);
  return sanitizeAiProfile(raw || {}, answers);
}

function questionShouldExtract(state, questionIndex) {
  const question = Array.isArray(state.questions) ? state.questions[questionIndex] : null;
  if (question && Object.prototype.hasOwnProperty.call(question, "aiExtractEnabled")) return !!question.aiExtractEnabled;
  return [2, 3, 5, 6].includes(Number(questionIndex));
}

function ensureDraft(state, sessionId) {
  if (!state.sessionDrafts || typeof state.sessionDrafts !== "object") state.sessionDrafts = {};
  if (!state.sessionDrafts[sessionId]) {
    state.sessionDrafts[sessionId] = {
      sessionId,
      eventId: "yanfeng-demo-2026",
      enterTime: new Date().toISOString(),
      answers: [],
      answerInsights: [],
      status: "进行中"
    };
  }
  return state.sessionDrafts[sessionId];
}

function mergeAnswerIntoDraft(draft, answerRecord, insight) {
  const existingIndex = draft.answers.findIndex(item => Number(item.questionIndex) === Number(answerRecord.questionIndex));
  if (existingIndex >= 0) draft.answers.splice(existingIndex, 1, answerRecord);
  else draft.answers.push(answerRecord);
  draft.answers.sort((a, b) => Number(a.questionIndex) - Number(b.questionIndex));
  if (insight) {
    const insightRecord = { questionIndex: answerRecord.questionIndex, question: answerRecord.question, answer: answerRecord.answer, ...insight };
    const insightIndex = draft.answerInsights.findIndex(item => Number(item.questionIndex) === Number(answerRecord.questionIndex));
    if (insightIndex >= 0) draft.answerInsights.splice(insightIndex, 1, insightRecord);
    else draft.answerInsights.push(insightRecord);
    draft.answerInsights.sort((a, b) => Number(a.questionIndex) - Number(b.questionIndex));
  }
  draft.updatedAt = new Date().toISOString();
}

function mostFrequent(values, fallback) {
  const counts = new Map();
  values.filter(Boolean).forEach(value => counts.set(value, (counts.get(value) || 0) + 1));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? top[0] : fallback;
}

function mergeTags(...groups) {
  const counts = new Map();
  groups.flat().filter(Boolean).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(item => item[0]).slice(0, 8);
}

function enrichSubmissionWithInsights(submission, answerInsights) {
  const insights = Array.isArray(answerInsights) ? answerInsights : [];
  const usageFrequency = mostFrequent(insights.map(item => item.usageFrequency).filter(item => item && item !== "未提及"), "");
  const willingness = mostFrequent(insights.map(item => item.willingness).filter(item => item && item !== "未提及"), "");
  const capabilityTags = mergeTags(...insights.map(item => item.capabilityTags || []));
  const wishTags = mergeTags(...insights.map(item => item.wishTags || []));
  const concernTags = mergeTags(...insights.map(item => item.concernTags || []));
  return {
    ...submission,
    answerInsights: insights,
    usageFrequency: usageFrequency || submission.usageFrequency || "",
    willingness: willingness || submission.willingness || "",
    capabilityTags: capabilityTags.length ? capabilityTags : (submission.capabilityTags || []),
    wishTags: wishTags.length ? wishTags : (submission.wishTags || []),
    concernTags: concernTags.length ? concernTags : (submission.concernTags || [])
  };
}

async function completeSession(state, body) {
  const sessionId = safeSessionId(body.sessionId);
  const draft = ensureDraft(state, sessionId);
  const answers = Array.isArray(body.answers) && body.answers.length ? body.answers : draft.answers;
  const answerInsights = Array.isArray(body.answerInsights) && body.answerInsights.length ? body.answerInsights : draft.answerInsights;
  const profile = await callAiProfile({ ...body, sessionId, answers, answerInsights }, state);
  const baseType = profile && profile.profileType ? profile.profileType : fallbackAiProfile(answers).profileType;
  const baseContent = fallbackProfileContent(baseType);
  const submission = enrichSubmissionWithInsights({
    sessionId,
    eventId: "yanfeng-demo-2026",
    enterTime: body.enterTime || draft.enterTime || new Date().toISOString(),
    submitTime: new Date().toISOString(),
    answers,
    derivedTags: profile && Array.isArray(profile.derivedTags) ? profile.derivedTags : extractKeywordsFromText(textOfAnswers(answers)),
    profileType: baseType,
    profileText: profile && profile.profileText ? profile.profileText : baseContent.text,
    scores: profile && Array.isArray(profile.scores) ? profile.scores : baseContent.scores,
    actions: profile && Array.isArray(profile.actions) ? profile.actions : baseContent.actions,
    scenario: profile && profile.scenario ? profile.scenario : inferScenarioFromText(textOfAnswers(answers)),
    concern: profile && profile.concern ? profile.concern : inferConcernFromText(textOfAnswers(answers)),
    aiGenerated: !!(profile && profile.aiGenerated),
    aiModel: profile && profile.model ? profile.model : "local-fallback",
    status: "已完成"
  }, answerInsights);

  const existingIndex = state.submissions.findIndex(item => item.sessionId === sessionId);
  if (existingIndex >= 0) state.submissions.splice(existingIndex, 1);
  state.submissions.unshift(submission);
  state.submissions = state.submissions.slice(0, 200);
  draft.status = "已完成";
  draft.submitTime = submission.submitTime;
  if (!state.submittedSessionIds.includes(sessionId)) {
    state.submittedSessionIds.push(sessionId);
    state.done += 1;
  }
  if (!state.startedSessionIds.includes(sessionId)) {
    state.startedSessionIds.push(sessionId);
    state.started = Math.max(state.started, state.done);
    state.visits = Math.max(state.visits, state.started);
  }
  state.dashboardSnapshot = null;
  return submission;
}

function countEntries(items, getter, fallback = "未识别") {
  const map = new Map();
  items.forEach(item => {
    const value = getter(item) || fallback;
    if (!value || value === "未提及") return;
    map.set(value, (map.get(value) || 0) + 1);
  });
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function percentDistribution(entries, preferred) {
  const total = entries.reduce((sum, item) => sum + item[1], 0) || 1;
  const map = new Map(entries);
  return preferred.map(label => [label, Math.round((map.get(label) || 0) / total * 100)]);
}

function wordCloudEntries(items, key, fallback) {
  const map = new Map();
  items.forEach(item => {
    const values = Array.isArray(item[key]) ? item[key] : [];
    values.forEach(value => map.set(value, (map.get(value) || 0) + 1));
  });
  const entries = [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12);
  return entries.length ? entries : fallback;
}

function buildDashboardSummary(state) {
  const completed = state.submissions.filter(item => item.status === "已完成");
  const maturityDistribution = percentDistribution(
    countEntries(completed, item => item.profileType, "AI 尝鲜者"),
    ["AI 旁观者", "AI 尝鲜者", "AI 效率提升者", "AI 场景实践者", "AI 推动者"]
  );
  const usageDistribution = percentDistribution(
    countEntries(completed, item => item.usageFrequency || fallbackAnswerInsight("", textOfAnswers(item.answers)).usageFrequency, "偶尔使用"),
    ["从未使用", "偶尔使用", "每周使用", "每天使用"]
  );
  const willingnessDistribution = percentDistribution(
    countEntries(completed, item => item.willingness || fallbackAnswerInsight("", textOfAnswers(item.answers)).willingness, "观望"),
    ["期待", "观望", "担心"]
  );
  const capabilityWordCloud = wordCloudEntries(completed, "capabilityTags", [["会议纪要", 9], ["报告生成", 8], ["数据分析", 7], ["知识检索", 6], ["效率提升", 6]]);
  const wishWordCloud = wordCloudEntries(completed, "wishTags", [["流程自动化", 9], ["智能助手", 8], ["知识库问答", 7], ["结果校验", 7], ["提示词模板", 6]]);
  const leadProfile = maturityDistribution.slice().sort((a, b) => b[1] - a[1])[0]?.[0] || "AI 尝鲜者";
  const leadCapability = capabilityWordCloud[0] ? capabilityWordCloud[0][0] : "会议纪要";
  const leadWish = wishWordCloud[0] ? wishWordCloud[0][0] : "提示词模板";
  const fallbackInsight = `当前现场人群以“${leadProfile}”为主，大家最认可 AI 在“${leadCapability}”上的价值，并期待进一步实现“${leadWish}”。讲师可用高频工作案例建立信心，再引导形成可复用的方法。`;
  return {
    counts: {
      visits: state.visits,
      started: state.started,
      done: state.done,
      completionRate: Math.round(state.done / Math.max(state.started, 1) * 100)
    },
    timer: {
      activityState: state.activityState,
      durationMinutes: state.durationMinutes,
      secondsLeft: state.secondsLeft
    },
    maturityDistribution,
    usageDistribution,
    willingnessDistribution,
    capabilityWordCloud,
    wishWordCloud,
    groupInsight: state.dashboardSnapshot && state.dashboardSnapshot.groupInsight ? state.dashboardSnapshot.groupInsight : fallbackInsight,
    generatedAt: state.dashboardSnapshot && state.dashboardSnapshot.generatedAt ? state.dashboardSnapshot.generatedAt : new Date().toISOString()
  };
}

async function generateGroupInsight(state) {
  const summary = buildDashboardSummary(state);
  if (!AI_API_KEY) return summary.groupInsight;
  const template = state.promptTemplates && state.promptTemplates.groupInsight ? state.promptTemplates.groupInsight : defaults.promptTemplates.groupInsight;
  const raw = await callAiJson(template.content, summary);
  return String(raw && raw.insight ? raw.insight : summary.groupInsight).slice(0, 220);
}

async function handleApi(req, res, url) {
  if (req.method === "OPTIONS") return sendText(res, 204, "");

  if (url.pathname === "/api/health" && req.method === "GET") {
    return sendJson(res, 200, { ok: true });
  }

  if (url.pathname === "/api/state" && req.method === "GET") {
    const state = normalizeTimer(readState());
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/state" && req.method === "PUT") {
    if (!isAdminAuthorized(req)) return sendJson(res, 401, { error: "Admin token required" });
    const body = await readBody(req);
    const state = mergeConfig(normalizeTimer(readState()), body);
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/admin/prompts" && req.method === "PUT") {
    if (!isAdminAuthorized(req)) return sendJson(res, 401, { error: "Admin token required" });
    const body = await readBody(req);
    const state = normalizeTimer(readState());
    state.promptTemplates = normalizePromptTemplates({
      ...(state.promptTemplates || {}),
      ...(body.promptTemplates || {})
    }, body.prompt || state.prompt);
    if (body.answerExtract) state.promptTemplates.answerExtract.content = String(body.answerExtract);
    if (body.profileGenerate) state.promptTemplates.profileGenerate.content = String(body.profileGenerate);
    if (body.groupInsight) state.promptTemplates.groupInsight.content = String(body.groupInsight);
    state.prompt = state.promptTemplates.profileGenerate.content || state.prompt || defaults.prompt;
    state.dashboardSnapshot = null;
    state.timerUpdatedAt = new Date().toISOString();
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/sessions/start" && req.method === "POST") {
    const body = await readBody(req);
    const state = normalizeTimer(readState());
    const sessionId = safeSessionId(body.sessionId);
    const draft = ensureDraft(state, sessionId);
    draft.enterTime = body.enterTime || draft.enterTime || new Date().toISOString();
    if (!state.startedSessionIds.includes(sessionId)) {
      state.startedSessionIds.push(sessionId);
      state.visits += 1;
      state.started += 1;
    }
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/answers" && req.method === "POST") {
    const body = await readBody(req);
    const state = normalizeTimer(readState());
    const sessionId = safeSessionId(body.sessionId);
    const questionIndex = Number(body.questionIndex) || 0;
    const question = body.question || (state.questions[questionIndex] ? state.questions[questionIndex].text : "");
    const answer = String(body.answer || "");
    const answerRecord = {
      questionIndex,
      question,
      answer,
      skipped: !!body.skipped,
      answeredAt: new Date().toISOString()
    };
    let insight = null;
    if (!body.skipped && questionShouldExtract(state, questionIndex)) {
      try {
        insight = await callAiAnswerInsight({ ...body, sessionId, questionIndex, question, answer }, state);
      } catch (error) {
        insight = fallbackAnswerInsight(question, answer);
        insight.reason = "ai_extract_failed";
      }
    }
    const draft = ensureDraft(state, sessionId);
    mergeAnswerIntoDraft(draft, answerRecord, insight);
    writeState(state);
    return sendJson(res, 200, { ok: true, sessionId, answer: answerRecord, answerInsight: insight });
  }

  if (url.pathname === "/api/ai/profile" && req.method === "POST") {
    const body = await readBody(req);
    const state = normalizeTimer(readState());
    const profile = await callAiProfile(body, state);
    return sendJson(res, 200, profile);
  }

  if (url.pathname === "/api/sessions/complete" && req.method === "POST") {
    const body = await readBody(req);
    const state = normalizeTimer(readState());
    const submission = await completeSession(state, body);
    writeState(state);
    return sendJson(res, 200, { submission, state: publicState(state) });
  }

  if (url.pathname === "/api/submissions" && req.method === "POST") {
    const body = await readBody(req);
    let submission = body.submission || body;
    const state = normalizeTimer(readState());
    submission.sessionId = safeSessionId(submission.sessionId);
    submission = enrichSubmissionWithInsights(submission, submission.answerInsights || []);
    submission.status = "已完成";
    submission.submitTime = submission.submitTime || new Date().toISOString();
    const existingIndex = state.submissions.findIndex(item => item.sessionId === submission.sessionId);
    if (existingIndex >= 0) state.submissions.splice(existingIndex, 1);
    state.submissions.unshift(submission);
    state.submissions = state.submissions.slice(0, 200);
    if (!state.submittedSessionIds.includes(submission.sessionId)) {
      state.submittedSessionIds.push(submission.sessionId);
      state.done += 1;
    }
    if (!state.startedSessionIds.includes(submission.sessionId)) {
      state.startedSessionIds.push(submission.sessionId);
      state.started = Math.max(state.started, state.done);
      state.visits = Math.max(state.visits, state.started);
    }
    state.dashboardSnapshot = null;
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/dashboard/summary" && req.method === "GET") {
    const state = normalizeTimer(readState());
    const summary = buildDashboardSummary(state);
    writeState(state);
    return sendJson(res, 200, summary);
  }

  if (url.pathname === "/api/dashboard/insight/regenerate" && req.method === "POST") {
    const state = normalizeTimer(readState());
    const groupInsight = await generateGroupInsight(state).catch(() => buildDashboardSummary(state).groupInsight);
    state.dashboardSnapshot = {
      ...buildDashboardSummary(state),
      groupInsight,
      generatedAt: new Date().toISOString()
    };
    writeState(state);
    return sendJson(res, 200, buildDashboardSummary(state));
  }

  if (url.pathname === "/api/admin/clear" && req.method === "POST") {
    if (!isAdminAuthorized(req)) return sendJson(res, 401, { error: "Admin token required" });
    const state = normalizeTimer(readState());
    state.visits = 0;
    state.started = 0;
    state.done = 0;
    state.submissions = [];
    state.sessionDrafts = {};
    state.dashboardSnapshot = null;
    state.startedSessionIds = [];
    state.submittedSessionIds = [];
    state.secondsLeft = clamp(Number(state.durationMinutes) || defaults.durationMinutes, 1, 30) * 60;
    state.timerUpdatedAt = new Date().toISOString();
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  if (url.pathname === "/api/admin/mock" && req.method === "POST") {
    if (!isAdminAuthorized(req)) return sendJson(res, 401, { error: "Admin token required" });
    const body = await readBody(req);
    const state = addMockSubmissions(normalizeTimer(readState()), clamp(Number(body.count) || 10, 1, 100));
    writeState(state);
    return sendJson(res, 200, publicState(state));
  }

  return sendJson(res, 404, { error: "API not found" });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".svg": "image/svg+xml; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function serveStatic(req, res, url) {
  const requested = decodeURIComponent(url.pathname === "/" ? "/index.html" : url.pathname);
  const filePath = path.normalize(path.join(ROOT, requested));
  if (!filePath.startsWith(ROOT)) return sendText(res, 403, "Forbidden");
  fs.readFile(filePath, (error, data) => {
    if (error) return sendText(res, 404, "Not found");
    const headers = { "Content-Type": contentType(filePath) };
    if (path.extname(filePath).toLowerCase() === ".html") {
      headers["Cache-Control"] = "no-store, no-cache, must-revalidate, proxy-revalidate";
      headers["Pragma"] = "no-cache";
      headers["Expires"] = "0";
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `localhost:${PORT}`}`);
  try {
    if (url.pathname.startsWith("/api/")) {
      await handleApi(req, res, url);
    } else {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message || "Server error" });
  }
});

server.listen(PORT, () => {
  ensureDataFile();
  console.log(`延锋大会 Demo backend running at http://localhost:${PORT}`);
});
