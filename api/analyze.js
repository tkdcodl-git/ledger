// Vercel 서버리스 함수: 카드내역 이미지/PDF 1건 → 거래 JSON
// 환경변수: ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_ANON_KEY, (선택) CLAUDE_MODEL
module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  try {
    // 로그인한 사용자만 허용 (API 키 남용 방지)
    const token = (req.headers.authorization || '').replace('Bearer ', '');
    const who = await fetch(process.env.SUPABASE_URL + '/auth/v1/user', {
      headers: { Authorization: 'Bearer ' + token, apikey: process.env.SUPABASE_ANON_KEY }
    });
    if (!who.ok) return res.status(401).json({ error: '로그인이 필요합니다' });

    const { media_type, data, categories } = req.body || {};
    if (!media_type || !data) return res.status(400).json({ error: '파일 데이터가 없습니다' });
    const isPdf = media_type === 'application/pdf';
    const block = isPdf
      ? { type: 'document', source: { type: 'base64', media_type, data } }
      : { type: 'image', source: { type: 'base64', media_type, data } };

    const prompt = `이 카드 이용내역에서 모든 거래를 추출해 JSON 배열로만 답하세요. 설명·코드블록 금지.
각 항목: {"date":"YYYY-MM-DD","merchant":"가맹점명","amount":정수(원),"category":"..."}
- 연도가 2자리(예: 26. 9. 30)면 20XX로 변환. 취소/환불은 amount를 음수로.
- 합계·소계·안내 문구는 제외, 보이는 거래만 포함. 잘린 행은 제외.
- category는 반드시 다음 중 하나: ${(categories || []).join(', ')}`;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: process.env.CLAUDE_MODEL || 'claude-sonnet-5-5',
        max_tokens: 8000,
        messages: [{ role: 'user', content: [block, { type: 'text', text: prompt }] }]
      })
    });
    const j = await r.json();
    if (!r.ok) return res.status(502).json({ error: j.error?.message || 'AI 호출 실패' });
    const text = (j.content || []).map(c => c.text || '').join('');
    const m = text.match(/\[[\s\S]*\]/);
    const list = m ? JSON.parse(m[0]) : [];
    const transactions = list
      .filter(t => t && t.date && t.merchant && Number.isFinite(Number(t.amount)))
      .map(t => ({ date: t.date, merchant: String(t.merchant).trim(), amount: Math.round(Number(t.amount)), category: t.category }));
    res.status(200).json({ transactions });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
};
