// ══════════════════════════════════════════════════════════════
// 카드뉴스 자동 생성 (Node/sharp 버전 — Nexta 서버에 그대로 얹을 수 있게 Python 의존성 없이 작성)
// 템플릿에 상품 정보(이름/특징/가격/사진)만 채워 넣는 방식. 매번 새로 "그리는" 게 아니라
// SVG 틀에 값을 꽂아 렌더링하는 거라 빠르고(장당 수백ms) 결과가 항상 일관됨.
// ══════════════════════════════════════════════════════════════
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const W = 1080, H = 1350;
const FONT = "Noto Sans CJK KR"; // 서버에 이 폰트가 설치돼 있어야 함 (아래 README 참고)

function esc(s) {
  return String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

// 긴 줄을 여러 줄로 감싸기 (한글 기준 대략 글자수로 계산)
function wrap(text, maxChars) {
  const out = [];
  for (const rawLine of String(text).split("\n")) {
    let line = "";
    for (const ch of rawLine) {
      line += ch;
      if (line.length >= maxChars) { out.push(line); line = ""; }
    }
    if (line) out.push(line);
  }
  return out;
}

function multilineTspans(text, x, startY, lineHeight, maxChars) {
  return wrap(text, maxChars)
    .map((line, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${esc(line)}</tspan>`)
    .join("");
}

// ── 슬라이드 1: 후킹형 (제품사진 원형 + "~~의 비밀" 카피) ──
async function renderHookSlide({ hook, tag, photoBuffer, color1, color2 }, outPath) {
  let photoDataUri = null;
  if (photoBuffer) {
    const side = 620;
    const circleMask = Buffer.from(
      `<svg width="${side}" height="${side}"><circle cx="${side / 2}" cy="${side / 2}" r="${side / 2}" fill="#fff"/></svg>`
    );
    const cropped = await sharp(photoBuffer)
      .resize(side, side, { fit: "cover" })
      .modulate({ brightness: 0.55 })
      .composite([{ input: circleMask, blend: "dest-in" }])
      .png()
      .toBuffer();
    photoDataUri = `data:image/png;base64,${cropped.toString("base64")}`;
  }

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color1}"/>
        <stop offset="100%" stop-color="${color2}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg)"/>
    <g font-family="${FONT}">
      <rect x="${W / 2 - 140}" y="40" width="280" height="72" rx="36" fill="#fff"/>
      <text x="${W / 2}" y="86" font-size="34" font-weight="900" fill="${color1}" text-anchor="middle">${esc(tag)}</text>
      ${photoDataUri ? `
        <circle cx="${W / 2}" cy="400" r="316" fill="none" stroke="#fff" stroke-width="8"/>
        <image href="${photoDataUri}" x="${W / 2 - 310}" y="90" width="620" height="620"/>
      ` : ""}
      <text x="${W / 2}" y="800" font-size="66" font-weight="900" fill="#fff" text-anchor="middle">
        ${multilineTspans(hook, W / 2, 800, 82, 13)}
      </text>
      <text x="${W / 2}" y="${H - 90}" font-size="32" fill="#fff" text-anchor="middle">다음 장에서 바로 확인 →</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ── 슬라이드 2: 상품 정보 (특징 불릿 + 가격) ──
async function renderInfoSlide({ title, bullets, price, color1 }, outPath) {
  const bulletSvg = bullets
    .map((b, i) => {
      const y = 380 + i * 110;
      return `<circle cx="115" cy="${y - 12}" r="14" fill="${color1}"/>
              <text x="160" y="${y}" font-size="40" font-weight="700" fill="#323240">${esc(b)}</text>`;
    })
    .join("\n");

  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${W}" height="${H}" fill="#f5f6fa"/>
    <rect width="${W}" height="16" fill="${color1}"/>
    <g font-family="${FONT}">
      <text x="${W / 2}" y="150" font-size="56" font-weight="900" fill="#1a1a2e" text-anchor="middle">
        ${multilineTspans(title, W / 2, 150, 70, 14)}
      </text>
      ${bulletSvg}
      <rect x="100" y="${H - 260}" width="${W - 200}" height="120" rx="24" fill="${color1}"/>
      <text x="${W / 2}" y="${H - 185}" font-size="52" font-weight="900" fill="#fff" text-anchor="middle">${esc(price)}</text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

// ── 슬라이드 3: CTA (댓글 유도 + 쿠팡파트너스 고지문구) ──
async function renderCtaSlide({ ctaText, commentKeyword, color1, color2 }, outPath) {
  const disclosure = "이 포스팅은 쿠팡 파트너스 활동의 일환으로, 이에 따른 일정액의 수수료를 제공받습니다.";
  const badge = `댓글에 '${commentKeyword}' 남기면 DM으로 링크 드려요`;
  const svg = `
  <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg2" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${color2}"/>
        <stop offset="100%" stop-color="${color1}"/>
      </linearGradient>
    </defs>
    <rect width="${W}" height="${H}" fill="url(#bg2)"/>
    <g font-family="${FONT}">
      <text x="${W / 2}" y="500" font-size="60" font-weight="900" fill="#fff" text-anchor="middle">
        ${multilineTspans(ctaText, W / 2, 500, 78, 14)}
      </text>
      <rect x="${W / 2 - 420}" y="780" width="840" height="90" rx="45" fill="#fff"/>
      <text x="${W / 2}" y="836" font-size="32" font-weight="700" fill="${color1}" text-anchor="middle">${esc(badge)}</text>
      <text x="${W / 2}" y="${H - 150}" font-size="24" fill="#ffffffcc" text-anchor="middle">
        ${multilineTspans(disclosure, W / 2, H - 150, 34, 34)}
      </text>
    </g>
  </svg>`;
  await sharp(Buffer.from(svg)).png().toFile(outPath);
}

/**
 * 카드뉴스 3장 생성 (핵심 함수 — server.js 라우트에서 이거 하나만 호출하면 됨)
 * @param {object} product { name, hook, tag, bullets:[], price, photoUrl 또는 photoBuffer, commentKeyword }
 * @param {string} outDir  이미지를 저장할 폴더 (public 하위, 밖에서 URL로 접근 가능해야 함)
 */
async function generateCardNews(product, outDir) {
  fs.mkdirSync(outDir, { recursive: true });

  let photoBuffer = null;
  if (product.photoBuffer) {
    photoBuffer = product.photoBuffer;
  } else if (product.photoUrl) {
    const res = await fetch(product.photoUrl);
    if (res.ok) photoBuffer = Buffer.from(await res.arrayBuffer());
  }

  const color1 = product.color1 || "#ff7a59";
  const color2 = product.color2 || "#ff578c";

  const p1 = path.join(outDir, "slide1.png");
  const p2 = path.join(outDir, "slide2.png");
  const p3 = path.join(outDir, "slide3.png");

  await renderHookSlide(
    { hook: product.hook, tag: product.tag, photoBuffer, color1, color2 },
    p1
  );
  await renderInfoSlide(
    { title: product.name, bullets: product.bullets, price: product.price, color1 },
    p2
  );
  await renderCtaSlide(
    { ctaText: product.cta || `이거 하나면\n고민 끝`, commentKeyword: product.commentKeyword || "정보", color1, color2 },
    p3
  );

  return [p1, p2, p3];
}

module.exports = { generateCardNews };
