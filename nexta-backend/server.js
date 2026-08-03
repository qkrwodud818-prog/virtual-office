/**
 * 가상오피스 — AI 직원팀 서버 (신트라 방식: 고정 역할 + 총괄AI 구조)
 *
 * 구조 요약 (비전공자용):
 *   대표(사용자)가 업무를 시키면서, 어떤 담당자(들)를 쓸지 고른다.
 *   1) 고른 담당자들이 서로 대화 없이 각자 독립적으로 일한다 (병렬로 동시에).
 *      - 담당자마다 "지난 작업 기억"과 "대표님이 등록해 둔 전문 지식"을 참고해서 일한다.
 *   2) 총괄AI가 모든 담당자의 결과물을 모아서 검사한다.
 *      - 근거가 부실하면 그 담당자에게만 다시 시킨다 (다른 담당자는 그대로 둠).
 *      - 통과하면 대표님 눈높이에 맞게 정리한 보고서 + 저장 위치 추천을 만든다.
 *   3) 대표에게 올려서 승인 또는 보완 요청을 받는다.
 *
 * 진행 상황은 일이 벌어지는 즉시 화면으로 보내진다(SSE).
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
require("dotenv").config();

const { generateCardNews } = require("./social/cardnews");
const { publishCarouselPost, verifyWebhook, handleCommentWebhook } = require("./social/instagram");

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 실제 주소. (테스트할 때만 OPENROUTER_URL 환경변수로 가짜 서버를 가리킬 수 있다)
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MAX_MANAGER_RETRY = 1;  // 총괄AI가 반려했을 때, 그 담당자만 다시 시키는 최대 횟수
const MAX_CEO_ROUNDS = 3;     // 대표가 보완 요청할 수 있는 최대 횟수
const JOB_TTL_MS = 60 * 60 * 1000; // 1시간 지나면 메모리에서 정리

/* ────────────────────────── 공통 유틸 ────────────────────────── */

function parseJSON(raw) {
  if (!raw) return null;
  const cleaned = String(raw).replace(/```json/gi, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch (e) {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch (e2) { /* 아래로 */ }
    }
    return null;
  }
}

function loadModelConfig() {
  const raw = fs.readFileSync(path.join(__dirname, "config", "models.json"), "utf-8");
  return JSON.parse(raw);
}

// 모델 ID를 사람이 보기 좋은 이름으로 (화면에는 회사 이름만 보여준다)
function friendlyModel(entry) {
  return String(entry.provider || "").replace(/\s*\(무료\)\s*/, "").trim() || "AI";
}

/* ────────────────────── 모델 선택(자동 전환) / 호출 ────────────────────── */

/**
 * 신트라처럼: 역할마다 "경제형"과 "품질형" 모델 풀을 두고, 상황에 맞게 자동으로 골라 쓴다.
 * - 담당자(조사·작성 등)는 경제형(무료) 모델을 먼저 쓰고, 실패하면 자동으로 품질 TOP5로 전환한다.
 * - 총괄AI(검수·판단)처럼 신뢰도가 중요한 역할은 처음부터 품질 TOP5를 쓴다.
 * - 여러 담당자가 같은 모델만 쓰지 않도록, 배정된 rank만큼 순서를 회전시켜 자연히 다른 회사
 *   모델(Anthropic/OpenAI/Google/DeepSeek 등)이 섞여 쓰이게 한다 — 신트라의 "모델 풀 자동 전환"과 동일한 방식.
 */
function resolveCandidates(config, roleKey) {
  const assignment = config.역할배정[roleKey];
  if (!assignment) throw new Error("역할 배정이 없습니다: " + roleKey);

  const rotate = (list, startIndex) => {
    if (!list.length) return [];
    const i = ((startIndex % list.length) + list.length) % list.length;
    return list.slice(i).concat(list.slice(0, i));
  };

  const quality = [...config.품질_TOP5]
    .sort((a, b) => a.rank - b.rank)
    .map((r) => ({ model: r.model, provider: r.provider }));

  const qualityFrom = (startRank) => rotate(quality, (startRank || 1) - 1);

  if (assignment.pool === "경제") {
    const economy = config.경제형_모델.map((e) => ({ model: e.model, provider: e.provider }));
    return rotate(economy, (assignment.rank || 1) - 1).concat(qualityFrom(assignment.rank));
  }
  return qualityFrom(assignment.rank);
}

/**
 * OpenRouter 호출.
 * 웹검색은 모델 이름 뒤에 ":online"을 붙이는 방식이 아니라 plugins 파라미터로 지정한다.
 */
async function callOpenRouter(model, prompt, useSearch, maxTokens) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("API_KEY_MISSING");
  }
  const body = {
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens || 1600,
  };
  if (useSearch) {
    body.plugins = [{ id: "web", max_results: 5 }];
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60000);
  let res;
  try {
    res = await fetch(OPENROUTER_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + OPENROUTER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error("OpenRouter 오류(" + res.status + "): " + errText.slice(0, 300));
  }
  const data = await res.json();
  const msg = data.choices && data.choices[0] && data.choices[0].message;
  const text = msg && msg.content;
  if (!text || !String(text).trim()) throw new Error("응답이 비어 있음");

  const citations = (msg.annotations || [])
    .filter((a) => a && a.type === "url_citation" && a.url_citation)
    .map((a) => ({ url: a.url_citation.url, title: a.url_citation.title || a.url_citation.url }));

  return { text: String(text).trim(), citations };
}

async function callWithFallback(config, roleKey, prompt, useSearch, maxTokens) {
  const candidates = resolveCandidates(config, roleKey);
  let lastError = null;
  for (const entry of candidates) {
    try {
      const result = await callOpenRouter(entry.model, prompt, useSearch, maxTokens);
      return { text: result.text, citations: result.citations, modelUsed: friendlyModel(entry), modelId: entry.model };
    } catch (err) {
      if (err.message === "API_KEY_MISSING") throw err;
      lastError = err;
      console.warn("[모델 실패 → 다음 모델로]", entry.model, "-", err.message);
    }
  }
  throw lastError || new Error("모든 모델 호출에 실패했습니다");
}

/* ────────────────────── 저장 공간 (기억 · 전문지식) ──────────────────────
 * 주의: 이 서버가 무료 호스팅(Render 등)에 올라가 있으면, 재배포하거나 서버가
 * 재시작될 때 이 파일들이 초기화될 수 있다. 지금은 "일단 동작하는" 수준으로 두고,
 * 나중에 데이터가 중요해지면 진짜 데이터베이스로 옮기면 된다.
 */
const DATA_DIR = path.join(__dirname, "data");

function ensureDataDir() {
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch (e) { /* 이미 있으면 무시 */ }
}
function loadJSONFile(name, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), "utf-8"));
  } catch (e) {
    return fallback;
  }
}
function saveJSONFile(name, data) {
  ensureDataDir();
  try {
    fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(data, null, 2));
  } catch (e) {
    console.warn("[저장 실패]", name, e.message);
  }
}

/* ────────────────────── 회원 · 로그인(세션) · 크레딧 ──────────────────────
 * 상품형: 여러 고객이 각자 가입해서 자기 크레딧으로 사용한다.
 * ⚠️ 지금은 users.json 파일에 저장한다. 무료 호스팅(Render)은 재배포 시 파일이
 *    초기화될 수 있으므로, 실제 고객을 받기 전에 진짜 데이터베이스로 옮겨야 한다.
 * ⚠️ 실제 결제(돈 받기)는 아직 없다. '충전'은 테스트용으로 크레딧만 올려준다.
 *    나중에 이 자리에 토스페이먼츠 등 결제대행사(PG)를 연결한다. (아래 /api/topup 참고)
 */
const SESSION_SECRET = process.env.SESSION_SECRET || "virtual-office-dev-secret-change-me";
const SIGNUP_BONUS = 300;   // 가입 시 무료로 주는 크레딧
const TEST_TOPUP = 300;     // 테스트 충전 1회당 올려주는 크레딧
const COST_PER_AGENT = 10;  // 담당자 1명당 차감 크레딧
const COST_MANAGER = 20;    // 총괄AI 검수 차감 크레딧
const COST_CARDNEWS = 30;   // 카드뉴스 1건 생성 시 차감 크레딧

// 결제(토스페이먼츠) — 사업자가 실제 가맹 승인을 받으면 .env의 TOSS_CLIENT_KEY / TOSS_SECRET_KEY를
// 라이브 키(live_ck_..., live_sk_...)로 교체하기만 하면 된다. 지금은 테스트 키가 없으면 결제 버튼이
// "준비 중" 안내로 대체되어, 실서비스처럼 보이되 잘못된 키로 결제 시도가 되는 일은 없다.
const TOSS_CLIENT_KEY = process.env.TOSS_CLIENT_KEY || "";
const TOSS_SECRET_KEY = process.env.TOSS_SECRET_KEY || "";
const CREDIT_PACKAGES = {
  small: { credits: 500, amount: 5000, label: "500 크레딧" },
  medium: { credits: 1500, amount: 12000, label: "1,500 크레딧 (20% 더)" },
  large: { credits: 4000, amount: 28000, label: "4,000 크레딧 (30% 더)" },
};

function loadUsers() { return loadJSONFile("users.json", {}); }
function saveUsers(u) { saveJSONFile("users.json", u); }
function loadOrders() { return loadJSONFile("orders.json", {}); }
function saveOrders(o) { saveJSONFile("orders.json", o); }

function hashPassword(password, salt) {
  salt = salt || crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const h = crypto.scryptSync(String(password), salt, 64).toString("hex");
    return h.length === hash.length && crypto.timingSafeEqual(Buffer.from(h), Buffer.from(hash));
  } catch (e) { return false; }
}
function signValue(value) {
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  return value + "." + sig;
}
function unsignValue(signed) {
  if (!signed) return null;
  const i = signed.lastIndexOf(".");
  if (i < 0) return null;
  const value = signed.slice(0, i), sig = signed.slice(i + 1);
  const expect = crypto.createHmac("sha256", SESSION_SECRET).update(value).digest("hex");
  if (sig.length !== expect.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch (e) { return null; }
  return value;
}
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  raw.split(";").forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function setSession(res, userId) {
  const token = encodeURIComponent(signValue(userId));
  res.setHeader("Set-Cookie", "vo_session=" + token + "; HttpOnly; Path=/; Max-Age=" + (60 * 60 * 24 * 30) + "; SameSite=Lax");
}
function clearSession(res) {
  res.setHeader("Set-Cookie", "vo_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax");
}
function currentUser(req) {
  const userId = unsignValue(parseCookies(req).vo_session);
  if (!userId) return null;
  return loadUsers()[userId] || null;
}
function publicUser(u) {
  return {
    email: u.email,
    credits: u.credits,
    ceiling: u.ceiling || u.credits || 1,
    usage: (u.usage || []).slice(-12).reverse(),
    company: u.company || { name: "", logo: "" },
    cardnewsHistory: (u.cardnewsHistory || []).slice(-20).reverse(),
  };
}
function jobCost(agentKeys) {
  return agentKeys.length * COST_PER_AGENT + COST_MANAGER;
}
// 작업이 실제로 끝나(보고서가 나온) 시점에 한 번만 차감한다 — 도중에 오류가 나면 차감하지 않는다.
function chargeUser(userId, amount, meta) {
  const users = loadUsers();
  const u = users[userId];
  if (!u) return null;
  u.credits = Math.max(0, (u.credits || 0) - amount);
  u.usage = u.usage || [];
  u.usage.push(Object.assign({ at: nowKR(), amount }, meta || {}));
  if (u.usage.length > 60) u.usage = u.usage.slice(-60);
  saveUsers(users);
  return u.credits;
}

function getMemoryContext(userId, roleKey) {
  const mem = loadJSONFile("memory.json", {});
  const list = (mem[userId] && mem[userId][roleKey]) || [];
  if (!list.length) return "";
  const recent = list.slice(-5);
  return (
    "[지난 작업 기억 — 예전에 이 담당자가 했던 일이다. 참고만 하고, 이번 지시를 우선한다]\n" +
    recent.map((m, i) => (i + 1) + ". (" + m.date + ") 질문: " + m.question + " → 그때 결과 요약: " + m.summary).join("\n") +
    "\n\n"
  );
}
function addMemory(userId, roleKey, question, summary) {
  const mem = loadJSONFile("memory.json", {});
  if (!mem[userId]) mem[userId] = {};
  if (!mem[userId][roleKey]) mem[userId][roleKey] = [];
  mem[userId][roleKey].push({
    date: nowKR(),
    question: String(question || "").slice(0, 200),
    summary: String(summary || "").slice(0, 300),
  });
  if (mem[userId][roleKey].length > 8) mem[userId][roleKey] = mem[userId][roleKey].slice(-8);
  saveJSONFile("memory.json", mem);
}

function getKnowledgeContext(userId, role) {
  const kb = loadJSONFile("knowledge.json", {});
  const list = (kb[userId] && kb[userId][role]) || [];
  if (!list.length) return "";
  let joined = list.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
  if (joined.length > 6000) joined = joined.slice(0, 6000) + "\n...(자료가 길어 일부만 표시됨)";
  return (
    "[대표님이 미리 등록해 둔 전문 지식/참고자료 — 이 내용을 최우선 참고 자료로 활용한다]\n" +
    joined + "\n\n"
  );
}

// 브랜드 가이드 — 특정 담당자 전용이 아니라 '모든' 담당자가 공통으로 지켜야 하는 말투·금칙어·규칙.
const BRAND_KEY = "브랜드가이드";
function getBrandContext(userId) {
  const kb = loadJSONFile("knowledge.json", {});
  const list = (kb[userId] && kb[userId][BRAND_KEY]) || [];
  if (!list.length) return "";
  let joined = list.map((k) => "▶ " + k.title + "\n" + k.text).join("\n\n");
  if (joined.length > 3000) joined = joined.slice(0, 3000) + "\n...(생략)";
  return (
    "[브랜드 가이드 — 모든 답변에서 반드시 지킬 말투·금칙어·표기 규칙. 이 규칙을 최우선으로 지킨다]\n" +
    joined + "\n\n"
  );
}

/* ────────────────────── 작업(job) 관리 + 실시간 전송 ────────────────────── */

const jobs = new Map();

function createJob(question, agentKeys, userId, cost, quick) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    question,
    agentKeys,
    userId,
    cost: cost || 0,
    quick: !!quick,
    charged: false,
    events: [],
    listeners: [],
    finished: false,
    ceoResolve: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

function nowKR() {
  return new Date().toLocaleTimeString("ko-KR", {
    hour: "2-digit", minute: "2-digit", hour12: true, timeZone: "Asia/Seoul",
  });
}

function emit(job, event) {
  if (!event.time) event.time = nowKR();
  job.events.push(event);
  const payload = "data: " + JSON.stringify(event) + "\n\n";
  for (const res of job.listeners) {
    try { res.write(payload); } catch (e) { /* 끊긴 화면은 무시 */ }
  }
}

function waitForCeo(job) {
  return new Promise((resolve) => { job.ceoResolve = resolve; });
}

setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      for (const res of job.listeners) { try { res.end(); } catch (e) {} }
      jobs.delete(id);
    }
  }
}, 10 * 60 * 1000);

/* ────────────────────────── 담당자(직원) 정의 ──────────────────────────
 * 신트라와 동일하게: 역할이 고정되어 있고, 대표가 이번 업무에 어떤 담당자를 쓸지 고른다.
 * 담당자끼리는 서로 대화하지 않는다 — 전부 총괄AI에게만 결과를 보고한다.
 */
const SPECIALISTS = {
  // 신트라(Sintra) 12명 헬퍼와 1:1로 대응하는 한국어 버전 (Buddy→전략기획, Cassie→고객문의,
  // Commet→이커머스, Dexter→재무분석, Emmie→이메일, Gigi→성장코치, Milli→영업관리,
  // Penn→카피라이터, Scouty→채용, Seomi→SEO, Soshie→SNS콘텐츠, Vizzy→비서)
  전략기획: {
    label: "전략기획 담당",
    roleKey: "전문_전략기획",
    useSearch: true,
    desc: "사업 방향, 신규 아이템, 성장 전략에 대한 조사와 제안을 한다.",
  },
  고객문의: {
    label: "고객문의 응대 담당",
    roleKey: "전문_고객문의",
    useSearch: false,
    desc: "고객이 보낼 법한 문의에 대한 답변 초안을 작성한다 (실제 발송은 하지 않는다).",
  },
  이커머스: {
    label: "이커머스 운영 담당",
    roleKey: "전문_이커머스",
    useSearch: true,
    desc: "온라인 판매채널(스마트스토어, 쿠팡 등) 운영과 관련된 정리·제안을 한다.",
  },
  재무분석: {
    label: "재무분석 담당",
    roleKey: "전문_재무분석",
    useSearch: false,
    desc: "매출·비용·수익성 같은 숫자를 정리하고 분석한다 (실제 회계 처리는 하지 않는다).",
  },
  이메일: {
    label: "이메일 담당",
    roleKey: "전문_이메일",
    useSearch: false,
    desc: "고객·거래처에 보낼 이메일 초안을 작성한다 (실제 발송은 하지 않는다).",
  },
  성장코치: {
    label: "성장 코치",
    roleKey: "전문_성장코치",
    useSearch: false,
    desc: "대표님의 업무 습관, 목표 관리, 우선순위 정리를 돕는다.",
  },
  영업관리: {
    label: "영업관리 담당",
    roleKey: "전문_영업관리",
    useSearch: false,
    desc: "영업 프로세스, 고객 관리, 제안서 구조를 정리한다.",
  },
  카피라이터: {
    label: "카피라이터",
    roleKey: "전문_카피라이터",
    useSearch: false,
    desc: "광고 문구, 제품 설명, 상세페이지 문구를 작성한다.",
  },
  채용: {
    label: "채용 담당",
    roleKey: "전문_채용",
    useSearch: false,
    desc: "채용 공고문 작성과 지원자 서류 검토 기준을 만든다.",
  },
  SEO: {
    label: "SEO 담당",
    roleKey: "전문_SEO",
    useSearch: true,
    desc: "검색 노출을 높이기 위한 키워드와 콘텐츠 구조를 제안한다.",
  },
  SNS콘텐츠: {
    label: "SNS·블로그 콘텐츠 담당",
    roleKey: "전문_SNS콘텐츠",
    useSearch: false,
    desc: "SNS나 블로그에 바로 올릴 수 있는 글 초안을 작성한다 (실제 게시는 하지 않는다).",
  },
  비서: {
    label: "비서 (이미지 기획)",
    roleKey: "전문_비서",
    useSearch: false,
    desc: "이미지가 필요한 곳에 쓸 이미지 기획안(장면 설명, 문구, 구도)을 글로 작성한다. " +
      "실제 이미지 파일 생성은 다음 단계에서 별도 연결 예정.",
  },
};
const SPECIALIST_KEYS = Object.keys(SPECIALISTS);

/* ────────────────────────── 프롬프트 ────────────────────────── */

const 한국어전용 =
  "매우 중요한 규칙: 반드시 100% 한국어로만 답하세요. 영어 단어, 중국어, 일본어, 그 밖의 " +
  "다른 언어를 단 한 글자도 섞지 마세요. 사람·회사·제품의 고유명사도 가능하면 한글로 표기하세요 " +
  "(예: OpenAI → 오픈AI). 이 규칙을 어기면 안 됩니다.\n\n";

function 전문가지시(spec, question, ceoFeedback, reworkFeedback, memoryCtx, knowledgeCtx, brandCtx) {
  return (
    한국어전용 +
    "당신은 1인 사업가(대표)를 돕는 AI 직원이며, 담당 역할은 [" + spec.label + "]입니다.\n" +
    "담당 설명: " + spec.desc + "\n" +
    "중요: 다른 담당자와 이야기를 나누지 않습니다. 오직 당신의 담당 범위 안에서만, 아는 만큼 정확하게 답하세요.\n\n" +
    (brandCtx || "") +
    knowledgeCtx +
    memoryCtx +
    "[대표의 이번 지시]\n" + question + "\n\n" +
    (ceoFeedback ? "[대표님이 직접 보완 요청한 내용 — 반드시 반영]\n" + ceoFeedback + "\n\n" : "") +
    (reworkFeedback ? "[총괄AI의 보완 지시 — 반드시 반영해서 다시 작성]\n" + reworkFeedback + "\n\n" : "") +
    "작성 규칙:\n" +
    "- 담당 역할 범위 안에서만 답한다. 다른 담당자 몫의 일은 하지 않는다.\n" +
    "- 확인된 사실만 쓰고, 확실하지 않으면 '확인 안 됨'이라고 솔직히 쓴다. 지어내지 않는다.\n" +
    "- 숫자나 시점이 있으면 반드시 함께 적는다.\n" +
    "- 전문용어 없이, 처음 듣는 사람도 이해할 쉬운 말로 쓴다.\n" +
    "- 실제로 메일을 보내거나 SNS에 게시하거나 결제·구독을 하지 않는다. 초안/제안만 작성한다.\n\n" +
    "다시 한번 강조: 반드시 100% 한국어로만 작성하세요."
  );
}

function 총괄검수지시(question, ceoFeedback, outputs) {
  const 섹션 = outputs
    .map((o, i) => "[" + (i + 1) + ". 담당자 키 \"" + o.key + "\" (" + o.label + ")의 결과물]\n" + o.text)
    .join("\n\n");
  const keyList = outputs.map((o) => "\"" + o.key + "\"").join(", ");

  return (
    한국어전용 +
    "당신은 AI 직원팀을 총괄하는 '총괄AI'입니다. 아래는 각 담당자가 서로 대화 없이 독립적으로 " +
    "작업한 결과물입니다. 당신이 할 일:\n" +
    "1) 신빙성 검사 — 근거 없이 단정하거나 출처가 부실한 부분이 있는지 확인한다.\n" +
    "2) 대표님(전문 지식이 없는 1인 사업가) 눈높이에 맞게 정리해서 설명한다.\n" +
    "3) 결과물을 어디에 보관하면 좋을지 추천한다 (파일 보관 / 노션 정리 / 디스코드 공유 중 성격에 맞는 것 하나).\n" +
    "4) 담당자별로 통과(approved:true)/반려(approved:false) 판정을 내린다. 대표님을 오래 기다리게 하면 " +
    "안 되므로, 완벽하지 않아도 대표가 판단하기에 충분하면 통과시킨다. 핵심 질문을 아예 다루지 않았거나 " +
    "완전히 지어낸 것으로 보일 때만 반려한다.\n\n" +
    "[대표의 이번 지시]\n" + question + "\n\n" +
    (ceoFeedback ? "[대표님 보완 요청]\n" + ceoFeedback + "\n\n" : "") +
    섹션 + "\n\n" +
    "반드시 아래 담당자 키만 그대로 사용해서 verdicts를 채우세요: " + keyList + "\n" +
    "JSON만 출력하세요. 다른 말은 쓰지 마세요. 모든 문자열 값은 100% 한국어로 쓰세요.\n" +
    '{"verdicts": { "담당자키": {"approved": true 또는 false, "feedback": "반려 시 구체적 보완 지시, 통과면 빈 문자열"} },\n' +
    ' "storage": "파일 보관 / 노션 정리 / 디스코드 공유 중 하나와 이유 한 문장",\n' +
    ' "report": "모든 담당자가 통과했을 때만 작성. 아래 형식을 지킬 것. 통과 전이면 빈 문자열" }\n\n' +
    "report 작성 형식 (모두 통과했을 때만):\n" +
    "## 결론\n(대표가 어떻게 하면 좋은지 2~3문장으로 먼저 말한다)\n\n" +
    "## 담당자별 결과 요약\n(담당자마다 핵심만 3~4줄로. 어느 담당자가 조사·작성했는지 이름을 밝힌다)\n\n" +
    "## 대표님이 지금 결정하실 것\n(선택지를 2~3개 제시하고 각각의 장단점을 한 줄로)\n\n" +
    "## 이런 대안도 있어요\n(대표가 미처 생각 못 했을 다른 방향의 아이디어를 정확히 3가지, 각 한 줄로)\n\n" +
    "## 저장 추천\n(파일/노션/디스코드 중 무엇이 좋은지와 이유)\n\n" +
    "## 아직 확인 못 한 것\n(모르는 건 솔직히 적는다)\n\n" +
    "report 규칙: 전문용어·영어약어 금지, 쉬운 말로. 대표를 '대표님'으로 부른다. 100% 한국어로만 작성."
  );
}

/* ────────────────────────── 전체 업무 진행 ────────────────────────── */

async function runPipeline(job) {
  const config = loadModelConfig();
  const question = job.question;
  const agentKeys = job.agentKeys;
  let ceoFeedback = "";

  try {
    for (let round = 1; round <= MAX_CEO_ROUNDS; round++) {
      emit(job, { type: "round", round, text: round === 1 ? "업무 시작" : "대표님 보완 요청 반영 (" + round + "차)" });

      // 담당자별 최신 결과물 (재작업 시 해당 담당자만 갱신됨)
      const results = {};
      for (const key of agentKeys) results[key] = null;
      let reworkFeedback = {}; // key -> 총괄AI 보완 지시

      async function runSpecialist(key, isRework) {
        const spec = SPECIALISTS[key];
        emit(job, { type: "status", agent: key, state: "working", text: isRework ? "보완 작업 중" : "작업 중" });
        const prompt = 전문가지시(
          spec, question, ceoFeedback, reworkFeedback[key] || "",
          getMemoryContext(job.userId, spec.roleKey), getKnowledgeContext(job.userId, key),
          getBrandContext(job.userId)
        );
        const result = await callWithFallback(config, spec.roleKey, prompt, spec.useSearch, 1800);
        results[key] = { text: result.text, citations: result.citations, modelUsed: result.modelUsed };
        emit(job, { type: "status", agent: key, state: "submit", text: "결과 제출" });
        emit(job, {
          type: "step", agent: key,
          label: spec.label + (isRework ? " 결과 (보완본)" : " 결과"),
          model: result.modelUsed, text: result.text, citations: result.citations,
          kind: isRework ? "rework" : "result",
        });
        emit(job, { type: "status", agent: key, state: "done", text: "검수 대기" });
      }

      // 1) 고른 담당자들이 서로 대화 없이 동시에 작업
      await Promise.all(agentKeys.map((key) => runSpecialist(key, false)));

      // 2) 총괄AI 검수 (반려된 담당자만 재작업, 반복)
      let finalReport = "";
      let storageNote = "";
      let allCitations = agentKeys.reduce((acc, key) => acc.concat(results[key].citations || []), []);

      if (job.quick) {
        // 빠른 모드: 총괄AI 검수를 건너뛰고 담당자 결과를 그대로 모아 전달한다 (아이디어를 빨리 받을 때).
        emit(job, { type: "status", agent: "총괄AI", state: "working", text: "빠른 정리 중" });
        finalReport =
          "## 빠른 모드 결과 (검수 생략)\n" +
          "아이디어를 빠르게 받는 모드라, 총괄AI의 정식 신빙성 검수는 하지 않았습니다. 참고용으로만 봐 주세요.\n\n" +
          agentKeys.map((key) => "## " + SPECIALISTS[key].label + "\n" + results[key].text).join("\n\n");
        emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "대표님께 전달" });
        emit(job, {
          type: "step", agent: "총괄AI", label: "빠른 모드 결과 (검수 생략)",
          model: "빠른 모드", text: finalReport, citations: allCitations, isReport: true,
        });
      } else {
       for (let mAttempt = 1; mAttempt <= MAX_MANAGER_RETRY + 1; mAttempt++) {
        emit(job, { type: "status", agent: "총괄AI", state: "working", text: "전체 결과 검수 중" });

        const outputs = agentKeys.map((key) => ({ key, label: SPECIALISTS[key].label, text: results[key].text }));
        const reviewResult = await callWithFallback(config, "총괄AI_검수", 총괄검수지시(question, ceoFeedback, outputs), false, 2600);
        const reviewJson = parseJSON(reviewResult.text);
        allCitations = agentKeys.reduce((acc, key) => acc.concat(results[key].citations || []), []);

        const verdicts = (reviewJson && reviewJson.verdicts) || {};
        const rejected = agentKeys.filter((key) => verdicts[key] && verdicts[key].approved === false);
        const canRetry = mAttempt <= MAX_MANAGER_RETRY && rejected.length > 0;

        if (canRetry) {
          emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "일부 보완 지시" });
          const 사유목록 = rejected.map((key) => SPECIALISTS[key].label + ": " + (verdicts[key].feedback || "근거 보강 필요")).join("\n");
          emit(job, {
            type: "step", agent: "총괄AI",
            label: "총괄 검수 결과 (" + mAttempt + "차) — 일부 보완 요청",
            model: reviewResult.modelUsed, text: 사유목록, kind: "review",
          });
          rejected.forEach((key) => {
            reworkFeedback[key] = verdicts[key].feedback || "근거를 더 확실히 밝혀서 다시 작성해 주세요.";
          });
          await Promise.all(rejected.map((key) => runSpecialist(key, true)));
          continue;
        }

        emit(job, { type: "status", agent: "총괄AI", state: "submit", text: "대표님께 보고" });
        storageNote = (reviewJson && reviewJson.storage) || "";

        let 미흡 = false;
        if (reviewJson && reviewJson.report && String(reviewJson.report).trim()) {
          finalReport = String(reviewJson.report).trim();
        } else {
          미흡 = true;
          finalReport =
            "## 결론\n총괄AI가 정해진 재작업 횟수 안에 만족할 만한 수준까지 끌어올리지 못했습니다. " +
            "아래는 지금까지 나온 결과이며, 부족한 부분을 함께 적었습니다.\n\n" +
            agentKeys.map((key) => "## " + SPECIALISTS[key].label + "의 결과\n" + results[key].text).join("\n\n") +
            "\n\n## 대표님이 지금 결정하실 것\n" +
            "- 보완 요청: 부족한 점을 적어 다시 시키실 수 있습니다.\n" +
            "- 이대로 승인: 지금 내용만으로 판단하고 마무리합니다.";
        }
        if (storageNote) finalReport += "\n\n## 저장 추천\n" + storageNote;

        emit(job, {
          type: "step", agent: "총괄AI",
          label: 미흡 ? "총괄 검수 — 일부 부족한 상태로 올림" : "총괄 검수 완료 — 대표님께 올림",
          model: reviewResult.modelUsed, text: finalReport, citations: allCitations, isReport: true,
        });
        break;
       }
      }

      // 보고서가 실제로 나온 시점에 딱 한 번만 크레딧을 차감한다 (도중에 오류가 나면 차감 안 함).
      if (!job.charged && job.userId) {
        const remaining = chargeUser(job.userId, job.cost, {
          agents: agentKeys.length,
          question: String(question).slice(0, 60),
        });
        job.charged = true;
        if (remaining !== null) emit(job, { type: "credit", credits: remaining, cost: job.cost });
      }

      // 3) 대표(사용자) 최종 승인
      ["총괄AI"].concat(agentKeys).forEach((n) => emit(job, { type: "status", agent: n, state: "done", text: "승인 대기" }));
      emit(job, { type: "await-approval", round, lastRound: round >= MAX_CEO_ROUNDS, report: finalReport, citations: allCitations });

      const decision = await waitForCeo(job);

      if (decision.action === "approve") {
        // 승인된 내용을 각 담당자의 "기억"으로 남긴다 (다음에 이 담당자를 쓸 때 참고됨)
        agentKeys.forEach((key) => {
          const spec = SPECIALISTS[key];
          if (job.userId) addMemory(job.userId, spec.roleKey, question, results[key].text.slice(0, 300));
        });
        emit(job, { type: "approved", text: "대표님이 승인하셨습니다. 업무를 종료합니다." });
        break;
      }
      if (round >= MAX_CEO_ROUNDS) {
        emit(job, { type: "approved", text: "보완 요청 횟수를 다 썼습니다. 새 업무로 다시 시켜 주세요." });
        break;
      }
      ceoFeedback = decision.feedback || "대표가 보완을 요청했습니다. 더 구체적인 근거와 실행 방법을 채워 주세요.";
      emit(job, { type: "revising", text: "보완 요청을 팀에 전달했습니다." });
    }

    emit(job, { type: "done" });
  } catch (err) {
    const friendly =
      err.message === "API_KEY_MISSING"
        ? "AI 사용 열쇠(API 키)가 설정되지 않았습니다. backend 폴더의 .env 파일에 OPENROUTER_API_KEY를 넣어 주세요."
        : "업무 진행 중 문제가 생겼습니다: " + err.message;
    console.error("[파이프라인 오류]", err);
    emit(job, { type: "error", text: friendly });
  } finally {
    job.finished = true;
    for (const res of job.listeners) { try { res.end(); } catch (e) {} }
    job.listeners = [];
  }
}

/* ────────────────────────── API ────────────────────────── */

app.get("/api/health", (req, res) => {
  const config = loadModelConfig();
  res.json({
    ok: true,
    apiKeySet: Boolean(OPENROUTER_API_KEY),
    modelsUpdatedAt: config.업데이트일,
  });
});

app.get("/api/rankings", (req, res) => {
  res.json(loadModelConfig());
});

app.get("/api/agents", (req, res) => {
  res.json(SPECIALIST_KEYS.map((key) => ({ key, label: SPECIALISTS[key].label, desc: SPECIALISTS[key].desc })));
});

/* ── 회원 · 로그인 ── */
app.post("/api/signup", (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: "이메일 형식이 올바르지 않습니다." });
  if (password.length < 6) return res.status(400).json({ error: "비밀번호는 6자 이상으로 정해 주세요." });

  const users = loadUsers();
  if (Object.values(users).some((u) => u.email === email)) return res.status(409).json({ error: "이미 가입된 이메일입니다." });

  const { salt, hash } = hashPassword(password);
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  users[id] = { id, email, salt, hash, credits: SIGNUP_BONUS, ceiling: SIGNUP_BONUS, usage: [], company: { name: "", logo: "" }, createdAt: nowKR() };
  saveUsers(users);
  setSession(res, id);
  res.json({ ok: true, user: publicUser(users[id]) });
});

app.post("/api/login", (req, res) => {
  const email = String((req.body && req.body.email) || "").trim().toLowerCase();
  const password = String((req.body && req.body.password) || "");
  const users = loadUsers();
  const u = Object.values(users).find((x) => x.email === email);
  if (!u || !verifyPassword(password, u.salt, u.hash)) {
    return res.status(401).json({ error: "이메일 또는 비밀번호가 맞지 않습니다." });
  }
  setSession(res, u.id);
  res.json({ ok: true, user: publicUser(u) });
});

app.post("/api/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

// 로그인 없이 둘러보기 — 임시 체험 계정을 즉시 만들고 로그인 상태로 만든다.
// (비밀번호가 없어 /api/login으로는 못 들어가고, 쿠키로만 유지된다)
app.post("/api/guest", (req, res) => {
  const users = loadUsers();
  const id = "guest_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  users[id] = {
    id, email: "체험 사용자", salt: "", hash: "",
    credits: SIGNUP_BONUS, ceiling: SIGNUP_BONUS, usage: [], guest: true,
    company: { name: "", logo: "" }, createdAt: nowKR(),
  };
  saveUsers(users);
  setSession(res, id);
  res.json({ ok: true, user: publicUser(users[id]) });
});

app.get("/api/me", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  res.json({ user: publicUser(u), costPerAgent: COST_PER_AGENT, costManager: COST_MANAGER });
});

// 테스트 충전. ⚠️ 실제 결제 아님 — 나중에 이 안에서 결제대행사(PG) 결제 성공을 확인한 뒤 크레딧을 올리도록 바꾼다.
app.post("/api/topup", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const users = loadUsers();
  users[u.id].credits = (users[u.id].credits || 0) + TEST_TOPUP;
  users[u.id].ceiling = users[u.id].credits; // 게이지 기준선을 새로 채운 만큼으로 초기화
  saveUsers(users);
  res.json({ ok: true, user: publicUser(users[u.id]) });
});

/* ══════════════════════════════════════════════════════════════
   실제 결제 (토스페이먼츠 결제위젯)
   .env에 TOSS_CLIENT_KEY / TOSS_SECRET_KEY가 없으면 "준비 중"으로 안내하고,
   있으면 실제 결제창이 뜬다. 라이브 키로만 교체하면 그대로 실서비스에 쓸 수 있다.
   ══════════════════════════════════════════════════════════════ */

// 결제 설정 + 상품 목록 (클라이언트 키는 공개해도 되는 키라 그대로 내려줌)
app.get("/api/payment/config", (req, res) => {
  res.json({ enabled: !!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY), clientKey: TOSS_CLIENT_KEY, packages: CREDIT_PACKAGES });
});

// 결제 시작 전, 서버가 먼저 "얼마짜리를 사려는지"를 저장해둔다 (결제창에서 금액을 조작해도 나중에 대조해서 막기 위함)
app.post("/api/payment/create-order", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  if (!(TOSS_CLIENT_KEY && TOSS_SECRET_KEY)) return res.status(400).json({ error: "결제 기능이 아직 준비 중입니다." });

  const pkgKey = String((req.body && req.body.package) || "");
  const pkg = CREDIT_PACKAGES[pkgKey];
  if (!pkg) return res.status(400).json({ error: "존재하지 않는 상품입니다." });

  const orderId = "nexta_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const orders = loadOrders();
  orders[orderId] = { userId: u.id, credits: pkg.credits, amount: pkg.amount, label: pkg.label, status: "pending", createdAt: nowKR() };
  saveOrders(orders);

  res.json({ ok: true, orderId, amount: pkg.amount, orderName: pkg.label, clientKey: TOSS_CLIENT_KEY });
});

// 결제 성공 콜백 — 토스가 돌려준 paymentKey로 "진짜 결제됐는지" 서버 대 서버로 다시 확인(승인)한 뒤에만 크레딧을 준다
app.get("/payment/success", async (req, res) => {
  const { paymentKey, orderId, amount } = req.query;
  const orders = loadOrders();
  const order = orders[orderId];

  if (!order || order.status !== "pending" || String(order.amount) !== String(amount)) {
    return res.status(400).send("<h1>결제 확인 실패</h1><p>주문 정보가 일치하지 않습니다.</p><a href='/'>돌아가기</a>");
  }

  try {
    const resp = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Basic " + Buffer.from(TOSS_SECRET_KEY + ":").toString("base64"),
      },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.message || "결제 승인 실패");

    order.status = "paid";
    saveOrders(orders);

    const users = loadUsers();
    const rec = users[order.userId];
    if (rec) {
      rec.credits = (rec.credits || 0) + order.credits;
      rec.ceiling = rec.credits;
      saveUsers(users);
    }
    res.redirect("/?payment=success");
  } catch (e) {
    res.status(500).send("<h1>결제 승인 중 오류</h1><p>" + e.message + "</p><a href='/'>돌아가기</a>");
  }
});

app.get("/payment/fail", (req, res) => {
  res.redirect("/?payment=fail");
});

// 회사(브랜드) 정보 저장 — 로고·회사명은 사이드바와 보고서 표지에 함께 표시된다.
app.post("/api/company", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });

  const name = String((req.body && req.body.name) || "").trim().slice(0, 40);
  let logo = String((req.body && req.body.logo) || "");
  if (logo && !/^data:image\/(png|jpe?g|webp);base64,/.test(logo)) logo = "";
  if (logo.length > 900000) return res.status(400).json({ error: "로고 이미지 용량이 너무 큽니다." });

  const users = loadUsers();
  const rec = users[u.id];
  if (!rec) return res.status(401).json({ error: "로그인이 필요합니다." });
  rec.company = { name, logo };
  saveUsers(users);
  res.json({ ok: true, user: publicUser(rec) });
});

/* ══════════════════════════════════════════════════════════════
   인스타그램 카드뉴스 자동화 (Zapier·매니챗 없이 메타 공식 API 직접 연동)
   ══════════════════════════════════════════════════════════════ */

// 1) 인스타그램 계정 연결정보 저장 (액세스 토큰·계정ID·댓글 자동응답 규칙)
app.post("/api/social/connect", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { igUserId, accessToken, commentKeyword, dmMessage } = req.body || {};
  if (!igUserId || !accessToken) return res.status(400).json({ error: "igUserId와 accessToken이 필요합니다." });

  const users = loadUsers();
  const rec = users[u.id];
  rec.social = rec.social || {};
  rec.social.instagram = {
    igUserId: String(igUserId),
    accessToken: String(accessToken),
    commentKeyword: String(commentKeyword || "정보"),
    dmMessage: String(dmMessage || "안녕하세요! 요청하신 링크 보내드려요 🙌"),
  };
  saveUsers(users);
  res.json({ ok: true, connected: true });
});

// 2) 상품 정보로 카드뉴스 3장 생성 → 공개 URL 반환 (여기까진 대표님 승인 없이 바로 확인 가능)
app.post("/api/social/cardnews", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const p = req.body || {};
  if (!p.name || !p.hook) return res.status(400).json({ error: "name, hook은 필수입니다." });

  const usersCheck = loadUsers();
  if ((usersCheck[u.id].credits || 0) < COST_CARDNEWS) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 충전 후 다시 시도해 주세요." });
  }

  try {
    const jobId = crypto.randomBytes(6).toString("hex");
    const outDir = path.join(__dirname, "public", "cardnews", jobId);
    const users = loadUsers();
    const social = (users[u.id] && users[u.id].social && users[u.id].social.instagram) || {};

    await generateCardNews(
      {
        name: p.name,
        hook: p.hook,
        tag: p.tag || "오늘의 발견",
        bullets: Array.isArray(p.bullets) ? p.bullets : [],
        price: p.price || "",
        photoUrl: p.photoUrl,
        commentKeyword: p.commentKeyword || social.commentKeyword || "정보",
        cta: p.cta,
        color1: p.color1,
        color2: p.color2,
      },
      outDir
    );

    const base = `${req.protocol}://${req.get("host")}`;
    const urls = ["slide1.png", "slide2.png", "slide3.png"].map((f) => `${base}/cardnews/${jobId}/${f}`);

    const fresh = loadUsers();
    const rec = fresh[u.id];
    rec.credits = Math.max(0, (rec.credits || 0) - COST_CARDNEWS);
    rec.usage = rec.usage || [];
    rec.usage.push({ at: nowKR(), amount: COST_CARDNEWS, kind: "카드뉴스 생성", label: p.name });
    if (rec.usage.length > 60) rec.usage = rec.usage.slice(-60);
    rec.cardnewsHistory = rec.cardnewsHistory || [];
    rec.cardnewsHistory.push({ jobId, name: p.name, hook: p.hook, imageUrls: urls, createdAt: nowKR() });
    saveUsers(fresh);

    res.json({ ok: true, jobId, imageUrls: urls, user: publicUser(rec) });
  } catch (e) {
    res.status(500).json({ error: "카드뉴스 생성 실패: " + e.message });
  }
});

// 3) 생성된 카드뉴스를 실제로 인스타그램에 게시 (완전 자동 업로드)
app.post("/api/social/publish", async (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const { imageUrls, caption } = req.body || {};
  if (!Array.isArray(imageUrls) || !imageUrls.length) return res.status(400).json({ error: "imageUrls가 필요합니다." });

  const users = loadUsers();
  const social = users[u.id] && users[u.id].social && users[u.id].social.instagram;
  if (!social) return res.status(400).json({ error: "먼저 /api/social/connect로 인스타그램 계정을 연결해 주세요." });

  try {
    const result = await publishCarouselPost(social.igUserId, social.accessToken, imageUrls, caption || "");
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: "게시 실패: " + e.message });
  }
});

// 4) 메타 웹훅 — 댓글에 키워드 남기면 자동으로 비공개 답장(DM) 발송 (매니챗 대체, 무료·무제한)
const IG_WEBHOOK_VERIFY_TOKEN = process.env.IG_WEBHOOK_VERIFY_TOKEN || "nexta-verify";
app.get("/webhooks/instagram", (req, res) => {
  const challenge = verifyWebhook(req.query, IG_WEBHOOK_VERIFY_TOKEN);
  if (challenge) return res.status(200).send(challenge);
  res.sendStatus(403);
});
app.post("/webhooks/instagram", async (req, res) => {
  res.sendStatus(200); // 메타는 빠른 200 응답을 기대하므로 먼저 응답하고 뒤에서 처리
  try {
    const igUserId = req.body?.entry?.[0]?.id;
    const users = loadUsers();
    const match = Object.values(users).find(
      (x) => x.social && x.social.instagram && x.social.instagram.igUserId === igUserId
    );
    if (!match) return;
    const social = match.social.instagram;
    await handleCommentWebhook(req.body, {
      keyword: social.commentKeyword,
      replyMessage: social.dmMessage,
      accessToken: social.accessToken,
    });
  } catch (e) {
    console.error("웹훅 처리 오류:", e.message);
  }
});

// 업무 시작 → 작업번호만 즉시 돌려주고, 실제 일은 뒤에서 진행
app.post("/api/start", (req, res) => {
  const user = currentUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요합니다." });

  const question = String((req.body && req.body.question) || "").trim();
  if (!question) return res.status(400).json({ error: "무엇을 알아봐 드릴지 적어 주세요." });
  if (question.length > 2000) return res.status(400).json({ error: "질문이 너무 깁니다. 2000자 이내로 적어 주세요." });

  let agentKeys = Array.isArray(req.body && req.body.agents) ? req.body.agents.filter((k) => SPECIALISTS[k]) : [];
  if (!agentKeys.length) agentKeys = SPECIALIST_KEYS.slice();

  const quick = !!(req.body && req.body.quick);
  // 빠른 모드는 총괄AI 검수를 건너뛰므로 검수 크레딧(20)을 받지 않는다.
  const cost = agentKeys.length * COST_PER_AGENT + (quick ? 0 : COST_MANAGER);
  if ((user.credits || 0) < cost) {
    return res.status(402).json({ error: "크레딧이 부족합니다. 충전 후 다시 시도해 주세요.", need: cost, have: user.credits || 0 });
  }

  const job = createJob(question, agentKeys, user.id, cost, quick);
  res.json({ jobId: job.id, cost });
  runPipeline(job);
});

// 진행 상황 실시간 받기
app.get("/api/stream/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write("retry: 3000\n\n");

  for (const event of job.events) {
    res.write("data: " + JSON.stringify(event) + "\n\n");
  }
  if (job.finished) return res.end();

  job.listeners.push(res);
  const keepAlive = setInterval(() => { try { res.write(": ping\n\n"); } catch (e) {} }, 20000);
  req.on("close", () => {
    clearInterval(keepAlive);
    job.listeners = job.listeners.filter((r) => r !== res);
  });
});

// 결과물에 대한 대표님의 만족도(👍/👎) — 품질 저하를 조기에 감지하려는 용도
app.post("/api/feedback", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const rating = String((req.body && req.body.rating) || "");
  if (rating !== "up" && rating !== "down") return res.status(400).json({ error: "잘못된 값입니다." });
  const fb = loadJSONFile("feedback.json", []);
  fb.push({ userId: u.id, jobId: String((req.body && req.body.jobId) || ""), rating, at: nowKR() });
  if (fb.length > 500) fb.splice(0, fb.length - 500);
  saveJSONFile("feedback.json", fb);
  res.json({ ok: true });
});

// 대표의 결정 (승인 / 보완 요청)
app.post("/api/decide", (req, res) => {
  const { jobId, action, feedback } = req.body || {};
  const job = jobs.get(jobId);
  if (!job) return res.status(404).json({ error: "작업을 찾을 수 없습니다." });
  if (!job.ceoResolve) return res.status(409).json({ error: "아직 승인받을 단계가 아닙니다." });
  if (action !== "approve" && action !== "revise") {
    return res.status(400).json({ error: "승인 또는 보완요청만 가능합니다." });
  }

  const resolve = job.ceoResolve;
  job.ceoResolve = null;
  resolve({ action, feedback: String(feedback || "").slice(0, 2000) });
  res.json({ ok: true });
});

/* ── 담당자별 전문지식 자료 관리 (RAG: 파일을 통째로 학습시키는 대신, 참고자료로 매번 끼워 넣는다) ── */

app.get("/api/knowledge/:role", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  if (!SPECIALISTS[req.params.role] && req.params.role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  const kb = loadJSONFile("knowledge.json", {});
  res.json({ items: (kb[u.id] && kb[u.id][req.params.role]) || [] });
});

app.post("/api/knowledge/:role", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const role = req.params.role;
  if (!SPECIALISTS[role] && role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  const title = String((req.body && req.body.title) || "").trim().slice(0, 80) || "제목 없음";
  const text = String((req.body && req.body.text) || "").trim();
  if (!text) return res.status(400).json({ error: "내용을 입력해 주세요." });
  if (text.length > 20000) return res.status(400).json({ error: "자료가 너무 깁니다. 20000자 이내로 줄여 주세요." });

  const kb = loadJSONFile("knowledge.json", {});
  if (!kb[u.id]) kb[u.id] = {};
  if (!kb[u.id][role]) kb[u.id][role] = [];
  kb[u.id][role].push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    title, text, addedAt: nowKR(),
  });
  saveJSONFile("knowledge.json", kb);
  res.json({ ok: true, items: kb[u.id][role] });
});

app.delete("/api/knowledge/:role/:id", (req, res) => {
  const u = currentUser(req);
  if (!u) return res.status(401).json({ error: "로그인이 필요합니다." });
  const role = req.params.role;
  if (!SPECIALISTS[role] && role !== BRAND_KEY) return res.status(400).json({ error: "알 수 없는 담당자입니다." });
  const kb = loadJSONFile("knowledge.json", {});
  if (kb[u.id] && kb[u.id][role]) kb[u.id][role] = kb[u.id][role].filter((k) => k.id !== req.params.id);
  saveJSONFile("knowledge.json", kb);
  res.json({ ok: true, items: (kb[u.id] && kb[u.id][role]) || [] });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("가상오피스 서버 실행 중 → http://localhost:" + PORT);
  if (!OPENROUTER_API_KEY) {
    console.warn("주의: OPENROUTER_API_KEY가 없습니다. .env 파일에 키를 넣어야 실제로 동작합니다.");
  }
});
