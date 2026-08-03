// ══════════════════════════════════════════════════════════════
// 인스타그램 Graph API 직접 연동 (Zapier·매니챗 같은 중개 도구 없이, 메타 공식 API를 서버가 직접 호출)
// 비용: 게시·DM 전부 무료(메타가 과금하지 않음). 단 이미지·SEO 조사 등에 쓰는 OpenRouter 호출 비용은 별개.
// ══════════════════════════════════════════════════════════════
const GRAPH = "https://graph.facebook.com/v21.0";

/**
 * 카드뉴스(여러 장) 캐러셀 게시 — 완전 자동 업로드
 * @param {string} igUserId       인스타그램 비즈니스 계정 ID (Graph API 탐색기 /me/accounts 로 확인)
 * @param {string} accessToken    장기 액세스 토큰
 * @param {string[]} imageUrls    공개적으로 접근 가능한 이미지 URL 배열 (Nexta 서버의 /public 경로 등)
 * @param {string} caption        게시글 본문
 */
async function publishCarouselPost(igUserId, accessToken, imageUrls, caption) {
  // 1) 이미지마다 "캐러셀 아이템" 컨테이너 생성
  const childIds = [];
  for (const url of imageUrls) {
    const res = await fetch(`${GRAPH}/${igUserId}/media`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_url: url, is_carousel_item: true, access_token: accessToken }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error("이미지 컨테이너 생성 실패: " + JSON.stringify(data));
    childIds.push(data.id);
  }

  // 2) 캐러셀 컨테이너 생성 (여러 아이템을 하나로 묶기)
  const carouselRes = await fetch(`${GRAPH}/${igUserId}/media`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      media_type: "CAROUSEL",
      children: childIds,
      caption,
      access_token: accessToken,
    }),
  });
  const carouselData = await carouselRes.json();
  if (!carouselRes.ok) throw new Error("캐러셀 컨테이너 생성 실패: " + JSON.stringify(carouselData));

  // 3) 게시 (실제로 인스타그램에 올라가는 시점)
  const publishRes = await fetch(`${GRAPH}/${igUserId}/media_publish`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ creation_id: carouselData.id, access_token: accessToken }),
  });
  const publishData = await publishRes.json();
  if (!publishRes.ok) throw new Error("게시 실패: " + JSON.stringify(publishData));

  return publishData; // { id: "게시된_미디어_ID" }
}

/**
 * 웹훅 검증 (메타가 서버에 처음 연결할 때 GET으로 확인 요청을 보냄)
 */
function verifyWebhook(query, verifyToken) {
  if (query["hub.mode"] === "subscribe" && query["hub.verify_token"] === verifyToken) {
    return query["hub.challenge"];
  }
  return null;
}

/**
 * 댓글에 키워드가 있으면 "비공개 답장(Private Reply)"으로 DM 발송 — 매니챗 대체 기능, 무료·무제한
 * @param {string} commentId
 * @param {string} accessToken
 * @param {string} message
 */
async function sendPrivateReply(commentId, accessToken, message) {
  const res = await fetch(`${GRAPH}/${commentId}/private_replies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, access_token: accessToken }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error("비공개 답장 실패: " + JSON.stringify(data));
  return data;
}

/**
 * 웹훅으로 들어온 댓글 이벤트를 처리 — 키워드 매칭되면 자동으로 sendPrivateReply 호출
 * @param {object} body            메타가 보낸 웹훅 payload
 * @param {object} rule            { keyword, replyMessage, accessToken }
 */
async function handleCommentWebhook(body, rule) {
  const results = [];
  const entries = body.entry || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const change of changes) {
      if (change.field !== "comments") continue;
      const value = change.value || {};
      const text = String(value.text || "");
      const commentId = value.id;
      if (commentId && text.includes(rule.keyword)) {
        try {
          const r = await sendPrivateReply(commentId, rule.accessToken, rule.replyMessage);
          results.push({ commentId, ok: true, r });
        } catch (e) {
          results.push({ commentId, ok: false, error: e.message });
        }
      }
    }
  }
  return results;
}

module.exports = { publishCarouselPost, verifyWebhook, sendPrivateReply, handleCommentWebhook };
