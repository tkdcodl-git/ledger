// Vercel 서버리스 함수: 카드내역 이미지/PDF/CSV 텍스트 1건 → 거래 JSON (Google Gemini 무료 티어)
// 환경변수: GEMINI_API_KEY, (선택) GEMINI_MODEL
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    const { media_type, data, text, categories } = req.body || {};
    if (!data && !text) return res.status(400).json({ error: '파일 데이터가 없습니다' });
    if (!process.env.GEMINI_API_KEY) return res.status(500).json({ error: 'GEMINI_API_KEY 환경변수가 없습니다' });

    const prompt = `이 카드 이용내역에서 모든 거래를 추출해 JSON 배열로만 답하세요.
각 항목: {"date":"YYYY-MM-DD","merchant":"가맹점명","amount":정수(원),"category":"..."}
- 연도가 2자리(예: 26. 9. 30)면 20XX로 변환, 연도가 없으면 올해로 추정. 취소/환불은 amount를 음수로.
- 합계·소계·안내 문구·헤더는 제외, 보이는 거래만 포함. 잘린 행은 제외.
- CSV는 열 이름을 보고 이용일·가맹점·이용금액 열을 판단하세요.
- category는 반드시 다음 중 하나: ${(categories || []).join(', ')}`;

    const parts = text
      ? [{ text: prompt + '\n\n[내역 데이터]\n' + text }]
      : [{ inline_data: { mime_type: media_type, data } }, { text: prompt }];

    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY, 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts }],
        generationConfig: { temperature: 0, responseMimeType: 'application/json', maxOutputTokens: 16000 }
      })
    });
    const j = await r.json();
    if (!r.ok) {
      const msg = r.status === 429 ? '무료 사용 한도에 도달했어요. 잠시 후 다시 시도하세요.' : (j.error?.message || 'AI 호출 실패');
      return res.status(r.status === 429 ? 429 : 502).json({ error: msg });
    }
    const out = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
    const m = out.match(/\[[\s\S]*\]/);
    const list = m ? JSON.parse(m[0]) : [];
    const transactions = list
      .filter(t => t && t.date && t.merchant && Number.isFinite(Number(t.amount)))
      .map(t => ({ date: t.date, merchant: String(t.merchant).trim(), amount: Math.round(Number(t.amount)), category: t.category }));
    res.status(200).json({ transactions });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
