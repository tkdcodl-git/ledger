// Vercel 서버리스 함수: 카드내역 이미지/PDF/CSV 텍스트 1건 → 거래 JSON (Google Gemini 무료 티어)
// 환경변수: GEMINI_API_KEY, (선택) GEMINI_MODEL
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { media_type, data, text, categories, model: reqModel } = req.body || {};
    if (!data && !text) return res.status(400).json({ error: '파일 데이터가 없습니다' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 없습니다' });

    const prompt = `이 카드 이용내역에서 모든 거래를 추출해 JSON 배열로만 답하세요.
JSON 배열 외의 설명이나 코드블록은 쓰지 마세요.
각 항목: {"date":"YYYY-MM-DD","merchant":"가맹점명","amount":정수(원),"category":"..."}
- 연도가 2자리(예: 26. 9. 30)면 20XX로 변환, 연도가 없으면 올해로 추정. 취소/환불은 amount를 음수로.
- 합계·소계·안내 문구·헤더는 제외, 보이는 거래만 포함. 잘린 행은 제외.
- CSV는 열 이름을 보고 이용일·가맹점·이용금액 열을 판단하세요.
- category는 반드시 다음 중 하나: ${(categories || []).join(', ')}`;

    const parts = text
      ? [{ text: prompt + '\n\n[내역 데이터]\n' + text }]
      : [{ inline_data: { mime_type: media_type, data } }, { text: prompt }];

    // 화면에서 느릴 때 다른 모델로 재시도할 수 있게 모델명을 받음 (gemini-* 만 허용)
    const model = /^gemini-[\w.\-]+$/.test(reqModel || '') ? reqModel : (process.env.GEMINI_MODEL || 'gemini-3.8-flash');
    const fallback = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash';
    const deadline = Date.now() + 55000, sleep = ms => new Promise(r => setTimeout(r, ms));
    const call = (mdl, cfg) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${mdl}:generateContent`, {
      method: 'POST',
      signal: AbortSignal.timeout(Math.max(3000, deadline - Date.now())),
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts }], generationConfig: cfg })
    });
    // JSON으로만 답하게 하고, 생각(thinking)을 낮춰 속도를 높임. 지원하지 않는 옵션이면 400 → 옵션을 줄여 재시도
    const base = { temperature: 0, maxOutputTokens: 8192, responseMimeType: 'application/json' };
    const callModel = async mdl => {
      let r = await call(mdl, { ...base, thinkingConfig: { thinkingLevel: 'low' } });
      if (r.status === 400) r = await call(mdl, base);
      if (r.status === 400) r = await call(mdl, { temperature: 0, maxOutputTokens: 8192 });
      return r;
    };
    const busy = st => st === 503 || st === 500 || st === 502 || st === 504;
    // 과부하(503 등)면 잠깐 쉬고 같은 모델로 재시도, 그래도 안 되면 대체 모델로 시도
    let r = await callModel(model);
    for (let i = 0; i < 2 && busy(r.status) && deadline - Date.now() > 12000; i++) {
      await sleep(1500 * (i + 1));
      r = await callModel(model);
    }
    if (busy(r.status) && fallback && fallback !== model && deadline - Date.now() > 8000) {
      const r2 = await callModel(fallback);
      if (r2.ok) r = r2;
    }
    const j = await r.json();
    if (!r.ok) {
      const msg = r.status === 429 ? '무료 사용 한도에 도달했어요. 잠시 후 다시 시도하세요.' : (j.error?.message || 'AI 호출 실패');
      return res.status(r.status === 429 ? 429 : busy(r.status) ? 503 : 502).json({ error: msg });
    }
    const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const list = parseList(out);
    const transactions = list
      .filter(t => t && t.date && t.merchant && Number.isFinite(Number(t.amount)))
      .map(t => ({ date: t.date, merchant: String(t.merchant).trim(), amount: Math.round(Number(t.amount)), category: t.category }));
    res.status(200).json({ transactions });
  } catch (e) {
    const timeout = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    res.status(timeout ? 504 : 500).json({ error: timeout ? 'AI 응답이 55초 안에 오지 않았어요. 파일을 나눠서 다시 올려보세요.' : String(e.message || e) });
  }
};

// 응답이 길어서 중간에 잘렸거나 형식이 깨져도, 끝까지 완성된 거래 항목은 건져서 사용
function parseList(out) {
  const m = out.match(/\[[\s\S]*\]/);
  if (m) { try { return JSON.parse(m[0]); } catch (_) { /* 아래에서 항목 단위로 복구 */ } }
  return (out.match(/\{[^{}]*\}/g) || []).map(s => { try { return JSON.parse(s); } catch (_) { return null; } }).filter(Boolean);
}
