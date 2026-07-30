/**
 * 가상오피스 — AI 직원팀 서버
 *
 * 구조 요약 (비전공자용):
 *   대표(사용자)가 업무를 시키면
 *   1) 이지혜(팀장)가 무엇을 알아봐야 하는지 목록을 만들고
 *   2) 재민·다은이 웹을 검색해 나눠서 조사하고
 *   3) 승효가 그 조사가 믿을 만한지 검사하고 (미흡하면 다시 조사시킴)
 *   4) 이지혜가 전체를 검수해서 보고서를 만들고 (부족하면 팀에 재작업 지시)
 *   5) 마지막으로 대표에게 올려서 승인 또는 보완 요청을 받는다.
 *
 * 진행 상황은 일이 벌어지는 즉시 화면으로 보내진다(SSE). 다 끝날 때까지 기다리지 않는다.
 */

const express = require("express");
const path = require("path");
const fs = require("fs");
require("dotenv").config();

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// 실제 주소. (테스트할 때만 OPENROUTER_URL 환경변수로 가짜 서버를 가리킬 수 있다)
const OPENROUTER_URL = process.env.OPENROUTER_URL || "https://openrouter.ai/api/v1/chat/completions";
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;

const MAX_RESEARCH_RETRY = 3; // 승효가 미흡 판정했을 때 재조사 최대 횟수 (직원 1명당)
const MAX_MANAGER_RETRY = 2;  // 이지혜가 반려했을 때 재작업 최대 횟수
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

/* ────────────────────── 모델 선택 / 호출 ────────────────────── */

/**
 * 역할에 배정된 풀(경제/품질)을 순서대로 시도할 후보 목록으로 만든다.
 * - 경제형 역할(재민·다은)은 무료 모델을 먼저 다 시도하고,
 *   전부 실패하면 품질 TOP5로 자동 전환한다(서비스가 멈추지 않게 하는 안전망).
 * - 재민과 다은이 같은 모델을 쓰지 않도록, 배정된 rank만큼 목록을 회전시킨다.
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
    // 재민(rank1)은 무료 1순위부터, 다은(rank2)은 무료 2순위부터 시작 → 서로 다른 모델을 쓴다
    return rotate(economy, (assignment.rank || 1) - 1).concat(qualityFrom(assignment.rank));
  }
  return qualityFrom(assignment.rank);
}

/**
 * OpenRouter 호출.
 *
 * 웹검색은 모델 이름 뒤에 ":online"을 붙이는 방식이 아니라 plugins 파라미터로 지정한다.
 * (무료 모델은 이름이 ":free"로 끝나므로 ":online"을 덧붙이면 "...:free:online"이라는
 *  존재하지 않는 이름이 되어 100% 실패하고, 매번 비싼 모델로 넘어가 버렸다.)
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
  const timer = setTimeout(() => controller.abort(), 120000); // 2분 넘으면 포기하고 다음 모델로
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

// 후보 목록을 순서대로 시도, 실패하면 다음 모델로 자동 대체
async function callWithFallback(config, roleKey, prompt, useSearch, maxTokens) {
  const candidates = resolveCandidates(config, roleKey);
  let lastError = null;
  for (const entry of candidates) {
    try {
      const result = await callOpenRouter(entry.model, prompt, useSearch, maxTokens);
      return { text: result.text, citations: result.citations, modelUsed: friendlyModel(entry), modelId: entry.model };
    } catch (err) {
      if (err.message === "API_KEY_MISSING") throw err; // 키가 없으면 다른 모델을 시도해도 소용없다
      lastError = err;
      console.warn("[모델 실패 → 다음 모델로]", entry.model, "-", err.message);
    }
  }
  throw lastError || new Error("모든 모델 호출에 실패했습니다");
}

/* ────────────────────── 작업(job) 관리 + 실시간 전송 ────────────────────── */

const jobs = new Map();

function createJob(question) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const job = {
    id,
    question,
    events: [],      // 지금까지 일어난 일 (새로 접속하면 이걸 먼저 다시 보내준다)
    listeners: [],   // 열려 있는 화면들
    finished: false,
    ceoResolve: null,
    createdAt: Date.now(),
  };
  jobs.set(id, job);
  return job;
}

// 서울 시각 기준 "오후 2:23" 같은 사람이 읽기 쉬운 시각 문자열
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

// 대표(사용자)의 결정을 기다린다
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

/* ────────────────────────── 직원별 작업 ────────────────────────── */

// 무료/저가 모델일수록 지시가 약하면 영어·중국어·일본어가 섞여 나오는 경우가 있어,
// 모든 프롬프트 맨 앞뒤에 한국어 전용 지시를 강하게 박아둔다.
const 한국어전용 =
  "매우 중요한 규칙: 반드시 100% 한국어로만 답하세요. 영어 단어, 중국어, 일본어, 그 밖의 " +
  "다른 언어를 단 한 글자도 섞지 마세요. 사람·회사·제품의 고유명사도 가능하면 한글로 표기하세요 " +
  "(예: OpenAI → 오픈AI). 이 규칙을 어기면 안 됩니다.\n\n";

const 조사지시 = (question, task, feedback) =>
  한국어전용 +
  "당신은 1인 사업가를 돕는 조사 담당 직원입니다. 아래 담당 항목을 웹에서 검색해 조사하세요.\n\n" +
  "[대표의 질문]\n" + question + "\n\n" +
  "[내가 맡은 항목]\n" + task + "\n\n" +
  (feedback ? "[지난번에 지적받은 점 — 반드시 고쳐서 다시 조사]\n" + feedback + "\n\n" : "") +
  "작성 규칙:\n" +
  "- 항목마다 소제목을 달고, 확인한 사실만 2~4문장으로 쓴다.\n" +
  "- 숫자나 시점이 있으면 반드시 함께 적는다 (예: 2026년 기준, 월 3만원).\n" +
  "- 추측이면 '확인 안 됨'이라고 솔직히 쓴다. 지어내지 않는다.\n" +
  "- 전문용어를 쓰지 말고, 처음 듣는 사람도 이해할 쉬운 말로 쓴다.\n\n" +
  "다시 한번 강조: 답변 전체를 반드시 한국어로만 작성하세요.";

const 검증지시 = (task, text, urls) =>
  한국어전용 +
  "당신은 동료의 조사 결과를 검사하는 검증 담당 직원입니다. 아래를 냉정하게 검사하세요.\n\n" +
  "검사 기준: (1) 맡은 항목을 실제로 다 다뤘는가 (2) 출처가 붙어 있는가 " +
  "(3) 근거 없이 단정한 부분이 없는가 (4) 숫자·시점이 빠지지 않았는가\n\n" +
  "[맡은 항목]\n" + task + "\n\n[조사 결과]\n" + text + "\n\n[붙어 있는 출처]\n" + (urls || "없음") + "\n\n" +
  "JSON만 출력하세요. 다른 말은 쓰지 마세요. reason과 instruction 값도 반드시 한국어로만 쓰세요.\n" +
  '{"status":"pass 또는 retry","reason":"판정 이유를 쉬운 말 한 문장으로","instruction":"retry라면 무엇을 어떻게 더 조사해야 하는지 구체적으로. pass면 빈 문자열"}';

const 콘텐츠지시 = (question, report) =>
  한국어전용 +
  "당신은 1인 사업가를 돕는 콘텐츠 담당 직원입니다. 대표님이 방금 승인한 보고서를 바탕으로, " +
  "대표님이 SNS나 블로그에 바로 올릴 수 있는 짧은 홍보문구 초안을 만드세요.\n\n" +
  "[대표의 원래 질문]\n" + question + "\n\n[승인된 보고서]\n" + report + "\n\n" +
  "작성 규칙:\n" +
  "- 전체 5~8문장 이내로 짧게.\n" +
  "- 과장·확인 안 된 숫자 금지. 보고서에 있는 내용만 사용한다.\n" +
  "- 해시태그 3~5개를 마지막 줄에 붙인다.\n" +
  "- 전문용어 없이 쉬운 말로. 대표님이 그대로 복사해서 쓸 수 있는 완성된 문장으로 쓴다.\n\n" +
  "다시 한번 강조: 반드시 한국어로만 작성하세요.";

/** 직원 1명: 조사 → 승효 검증 → (미흡하면) 재조사 */
async function researchWithVerification(job, config, agentName, researchRoleKey, task, question) {
  let feedback = "";
  let lastText = "";
  let lastCitations = [];

  for (let attempt = 1; attempt <= MAX_RESEARCH_RETRY; attempt++) {
    emit(job, {
      type: "status",
      agent: agentName,
      state: "working",
      text: attempt === 1 ? "자료 조사 중" : attempt + "차 재조사 중",
    });

    const result = await callWithFallback(config, researchRoleKey, 조사지시(question, task, feedback), true, 2000);
    lastText = result.text;
    lastCitations = result.citations;

    emit(job, { type: "status", agent: agentName, state: "submit", text: "조사 결과 제출" });
    emit(job, {
      type: "step",
      agent: agentName,
      label: attempt === 1 ? "조사 결과" : "조사 결과 (" + attempt + "차 재조사)",
      model: result.modelUsed,
      text: lastText,
      citations: lastCitations,
    });

    // 승효 검증
    emit(job, { type: "status", agent: "승효", state: "working", text: agentName + " 결과 검사 중" });
    let verifyJson;
    let verifyModel = "AI";
    try {
      const verifyResult = await callWithFallback(
        config, "검증_승효",
        검증지시(task, lastText, lastCitations.map((c) => c.url).join(", ")),
        false, 800
      );
      verifyModel = verifyResult.modelUsed;
      verifyJson = parseJSON(verifyResult.text) || { status: "pass", reason: "검사 결과를 읽지 못해 통과 처리했습니다.", instruction: "" };
    } catch (err) {
      if (err.message === "API_KEY_MISSING") throw err;
      verifyJson = { status: "pass", reason: "검사를 진행하지 못해 통과 처리했습니다.", instruction: "" };
    }

    emit(job, { type: "status", agent: "승효", state: "submit", text: "검사 완료" });
    emit(job, {
      type: "step",
      agent: "승효",
      label: "검사 결과 — " + agentName + " " + attempt + "차 (" + (verifyJson.status === "pass" ? "통과" : "다시 조사") + ")",
      model: verifyModel,
      text: verifyJson.reason + (verifyJson.status !== "pass" && verifyJson.instruction ? "\n\n보완 요청: " + verifyJson.instruction : ""),
    });

    if (verifyJson.status === "pass") {
      emit(job, { type: "status", agent: agentName, state: "done", text: "조사 완료" });
      return { text: lastText, citations: lastCitations, verified: true };
    }

    feedback = verifyJson.instruction || "출처를 더 확실히 붙이고, 빠진 항목을 채워 주세요.";
    if (attempt === MAX_RESEARCH_RETRY) {
      emit(job, { type: "status", agent: agentName, state: "done", text: "조사 완료(일부 부족)" });
      return { text: lastText, citations: lastCitations, verified: false };
    }
  }
}

/* ────────────────────────── 전체 업무 진행 ────────────────────────── */

async function runPipeline(job) {
  const config = loadModelConfig();
  const question = job.question;
  let ceoFeedback = "";

  try {
    for (let round = 1; round <= MAX_CEO_ROUNDS; round++) {
      emit(job, { type: "round", round, text: round === 1 ? "업무 시작" : "대표님 보완 요청 반영 (" + round + "차)" });

      // 1) 이지혜 — 무엇을 알아봐야 하는지 목록 만들기
      emit(job, { type: "status", agent: "이지혜", state: "working", text: "업무 지시서 작성 중" });
      const checklistResult = await callWithFallback(
        config, "체크리스트_팀장",
        한국어전용 +
        "당신은 1인 사업가(대표)를 돕는 AI 팀의 팀장입니다. 대표가 아래 질문을 시켰습니다.\n\n" +
        "[대표의 질문]\n" + question + "\n\n" +
        (ceoFeedback ? "[대표님이 직접 보완을 요청한 내용 — 이번엔 반드시 반영]\n" + ceoFeedback + "\n\n" : "") +
        "가장 중요한 원칙: 대표가 실제로 물어본 것에만 답하세요. " +
        "질문에 '사업', '창업', '시작해도 될까', '수익성' 같은 말이 없다면, " +
        "임의로 '이 사업이 돈이 될까'로 바꿔서 해석하지 마세요. " +
        "예를 들어 '강북횡단선 언제 완공돼?'라고 물으면 완공 예정 시기·현재 공사 진행 상황만 조사하면 되고, " +
        "그걸 사업 아이템으로 오해해서 시장성·수익성을 조사하면 안 됩니다. " +
        "반대로 정말 '이 사업 아이템이 괜찮을지' 물었을 때만 시장 규모·경쟁·수익성 같은 사업 조사를 하세요.\n\n" +
        "위 원칙에 따라, 이 질문에 제대로 답하려면 무엇을 조사해야 하는지 핵심 항목을 4개로 정리하세요.\n" +
        "규칙: 번호를 매긴 4줄 목록만 출력. 각 줄은 한 문장. 전문용어 금지. 설명이나 인사말 없이 목록만. 반드시 한국어로만 작성.",
        false, 700
      );
      const checklist = checklistResult.text;
      emit(job, { type: "status", agent: "이지혜", state: "submit", text: "지시서 전달" });
      emit(job, {
        type: "step", agent: "이지혜", label: "업무 지시서",
        model: checklistResult.modelUsed, text: checklist,
      });

      // 2~4) 조사 → 검증 → 팀장 검수 (반려되면 재작업)
      let managerFeedback = "";
      let finalReport = "";
      let allCitations = [];

      for (let mAttempt = 1; mAttempt <= MAX_MANAGER_RETRY + 1; mAttempt++) {
        const 공통 = (부분) =>
          "전체 지시서:\n" + checklist + "\n\n내가 맡은 부분: " + 부분 +
          (ceoFeedback ? "\n\n대표님 요청사항: " + ceoFeedback : "") +
          (managerFeedback ? "\n\n팀장 보완 지시: " + managerFeedback : "");

        const [w1, w2] = await Promise.all([
          researchWithVerification(job, config, "재민", "조사_재민", 공통("1번과 2번 항목"), question),
          researchWithVerification(job, config, "다은", "조사_다은", 공통("3번과 4번 항목"), question),
        ]);

        emit(job, { type: "status", agent: "이지혜", state: "working", text: "전체 검수 중" });
        const reviewResult = await callWithFallback(
          config, "최종승인_이지혜",
          한국어전용 +
          "당신은 1인 사업가(대표)를 돕는 AI 팀의 팀장입니다. 팀원 두 명의 조사 결과를 검수하고, " +
          "대표에게 올릴 보고서를 작성하세요. 대표는 개발이나 전문 분야를 모르는 1인 사업가입니다.\n\n" +
          "[대표의 질문]\n" + question + "\n\n" +
          (ceoFeedback ? "[대표님 보완 요청]\n" + ceoFeedback + "\n\n" : "") +
          "[재민의 조사" + (w1.verified ? " (검사 통과)" : " (일부 부족)") + "]\n" + w1.text + "\n\n" +
          "[다은의 조사" + (w2.verified ? " (검사 통과)" : " (일부 부족)") + "]\n" + w2.text + "\n\n" +
          "판단 기준: 대표의 질문에 실제로 답이 되는가, 근거가 있는가, 대표가 이걸 보고 결정을 내릴 수 있는가.\n" +
          "부족하면 반려하고 무엇을 더 조사해야 하는지 지시하세요.\n\n" +
          "JSON만 출력하세요. 다른 말은 쓰지 마세요.\n" +
          '{"approved":true 또는 false,' +
          '"feedback":"반려할 때 팀원에게 줄 구체적 보완 지시. 승인이면 빈 문자열",' +
          '"report":"승인일 때만 작성. 아래 형식을 반드시 지킬 것"}\n\n' +
          "report 작성 형식 (승인일 때만):\n" +
          "## 결론\n(대표가 어떻게 하면 좋은지 2~3문장으로 먼저 말한다)\n\n" +
          "## 왜 그렇게 판단했나\n(근거를 3~4개 항목으로. 숫자와 시점을 넣는다)\n\n" +
          "## 대표님이 지금 결정하실 것\n(선택지를 2~3개 제시하고 각각의 장단점을 한 줄로)\n\n" +
          "## 아직 확인 못 한 것\n(모르는 건 솔직히 적는다)\n\n" +
          "report 규칙: 전문용어·영어약어 금지. 쉬운 말로. 대표를 '대표님'으로 부른다. " +
          "report와 feedback 모두 반드시 100% 한국어로만 작성 (영어·중국어·일본어 금지).",
          false, 2500
        );

        const reviewJson = parseJSON(reviewResult.text);
        allCitations = [...w1.citations, ...w2.citations];

        const 반려 = reviewJson && reviewJson.approved === false && mAttempt <= MAX_MANAGER_RETRY;
        if (반려) {
          managerFeedback = reviewJson.feedback || "근거를 더 보강해 주세요.";
          emit(job, { type: "status", agent: "이지혜", state: "submit", text: "반려, 재작업 지시" });
          emit(job, {
            type: "step", agent: "이지혜", label: "검수 결과 — 다시 작업 (" + mAttempt + "차)",
            model: reviewResult.modelUsed, text: managerFeedback,
          });
          emit(job, { type: "status", agent: "재민", state: "idle", text: "재작업 대기" });
          emit(job, { type: "status", agent: "다은", state: "idle", text: "재작업 대기" });
          continue;
        }

        // 보고서 만들기.
        // 팀장이 재작업 한도를 다 쓰고도 만족하지 못한 경우가 있어서, 그때도 대표님이
        // 읽을 수 있는 형태로 정리해서 올린다. (예전에는 내부 데이터가 그대로 노출됐다)
        let 미흡 = false;
        if (reviewJson && reviewJson.report && String(reviewJson.report).trim()) {
          finalReport = String(reviewJson.report).trim();
        } else if (reviewJson) {
          미흡 = true;
          finalReport =
            "## 결론\n팀장이 정해진 재작업 횟수 안에 만족할 만한 수준까지 끌어올리지 못했습니다. " +
            "아래는 지금까지 조사된 내용이며, 부족한 부분을 함께 적었습니다.\n\n" +
            "## 팀장이 아직 부족하다고 본 점\n" + (reviewJson.feedback || "구체적인 사유가 전달되지 않았습니다.") + "\n\n" +
            "## 재민이 조사한 내용\n" + w1.text + "\n\n" +
            "## 다은이 조사한 내용\n" + w2.text + "\n\n" +
            "## 대표님이 지금 결정하실 것\n" +
            "- 보완 요청: 위 부족한 점을 적어 다시 시키실 수 있습니다.\n" +
            "- 이대로 승인: 지금 내용만으로 판단하고 마무리합니다.";
        } else {
          // 팀장이 정해진 형식을 안 지킨 경우 — 글 자체는 쓸 수 있으니 그대로 올린다
          finalReport = reviewResult.text;
        }

        emit(job, { type: "status", agent: "이지혜", state: "submit", text: "대표님께 보고" });
        emit(job, {
          type: "step", agent: "이지혜",
          label: 미흡 ? "팀장 검수 — 일부 부족한 상태로 올림" : "팀장 검수 완료 — 대표님께 올림",
          model: reviewResult.modelUsed, text: finalReport, citations: allCitations, isReport: true,
        });
        break;
      }

      // 5) 대표(사용자) 최종 승인
      ["재민", "다은", "승효", "이지혜"].forEach((n) =>
        emit(job, { type: "status", agent: n, state: "done", text: "승인 대기" })
      );
      emit(job, {
        type: "await-approval",
        round,
        lastRound: round >= MAX_CEO_ROUNDS,
        report: finalReport,
        citations: allCitations,
      });

      const decision = await waitForCeo(job);

      if (decision.action === "approve") {
        // 승인된 보고서로 콘텐츠팀(하늘)이 바로 쓸 수 있는 홍보문구 초안을 만든다
        emit(job, { type: "status", agent: "하늘", state: "working", text: "승인된 내용으로 콘텐츠 초안 작성 중" });
        try {
          const contentResult = await callWithFallback(config, "콘텐츠_하늘", 콘텐츠지시(question, finalReport), false, 900);
          emit(job, { type: "status", agent: "하늘", state: "submit", text: "콘텐츠 초안 제출" });
          emit(job, {
            type: "step", agent: "하늘", label: "콘텐츠팀 초안 — 바로 쓰는 홍보문구",
            model: contentResult.modelUsed, text: contentResult.text, isContent: true,
          });
        } catch (err) {
          if (err.message === "API_KEY_MISSING") throw err;
          console.warn("[콘텐츠 초안 생략]", err.message);
        }
        emit(job, { type: "status", agent: "하늘", state: "done", text: "대기 중" });
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

// 업무 시작 → 작업번호만 즉시 돌려주고, 실제 일은 뒤에서 진행
app.post("/api/start", (req, res) => {
  const question = String((req.body && req.body.question) || "").trim();
  if (!question) return res.status(400).json({ error: "무엇을 알아봐 드릴지 적어 주세요." });
  if (question.length > 2000) return res.status(400).json({ error: "질문이 너무 깁니다. 2000자 이내로 적어 주세요." });

  const job = createJob(question);
  res.json({ jobId: job.id });
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

  // 화면을 새로 열거나 새로고침해도 지금까지의 진행을 그대로 복원
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("가상오피스 서버 실행 중 → http://localhost:" + PORT);
  if (!OPENROUTER_API_KEY) {
    console.warn("주의: OPENROUTER_API_KEY가 없습니다. .env 파일에 키를 넣어야 실제로 동작합니다.");
  }
});
