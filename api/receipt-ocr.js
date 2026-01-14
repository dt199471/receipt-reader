// Vercel Serverless Function: /api/receipt-ocr
// OpenAI APIキーは Vercel の環境変数 OPENAI_API_KEY に設定してください。

const OPENAI_API_URL = 'https://api.openai.com/v1/chat/completions';

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'OPENAI_API_KEY is not set on the server.' });
    return;
  }

  try {
    const { imageSrc } = req.body || {};

    if (!imageSrc || typeof imageSrc !== 'string') {
      res.status(400).json({ error: 'imageSrc is required.' });
      return;
    }

    const body = {
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: [
            {
              type: 'text',
              text:
                'あなたは日本のレシートを読み取るOCRエンジン兼パーサーです。' +
                '画像から読み取った内容を、家計簿アプリでそのまま使えるJSONに変換してください。' +
                '必ず次の形式のJSONのみを返してください（追加の文章は禁止）：\n' +
                '{\n' +
                '  "storeName": "店舗名（日本語）",\n' +
                '  "date": "YYYY年M月D日 HH:mm 形式の日本語日時（分まで）",\n' +
                '  "total": "カンマ区切りの合計金額（例: 2,580）",\n' +
                '  "categoryId": "food|transport|daily|entertainment|medical|education|other のいずれか（レシート全体の主なカテゴリ）",\n' +
                '  "items": [\n' +
                '    {\n' +
                '      "name": "品目名",\n' +
                '      "price": "カンマ区切りの金額",\n' +
                '      "categoryId": "food|transport|daily|entertainment|medical|education|other のいずれか（その品目のカテゴリ）"\n' +
                '    }\n' +
                '  ]\n' +
                '}\n' +
                'カテゴリは日本の一般的な家計簿アプリを想定して適切に分類してください。' +
                'レシートが不鮮明な場合も、できる範囲で推測して埋めてください。'
            }
          ]
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'このレシート画像から、指定したJSON形式だけを返してください。'
            },
            {
              type: 'image_url',
              image_url: { url: imageSrc }
            }
          ]
        }
      ],
      response_format: { type: 'json_object' }
    };

    const response = await fetch(OPENAI_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    });

    const text = await response.text();

    if (!response.ok) {
      let errorMessage = `OpenAI API エラー (${response.status})`;
      try {
        const errorJson = JSON.parse(text);
        if (errorJson.error?.message) {
          errorMessage += `: ${errorJson.error.message}`;
        } else {
          errorMessage += `: ${text}`;
        }
      } catch {
        errorMessage += `: ${text}`;
      }
      console.error('OpenAI API エラー詳細:', { status: response.status, body: text });
      res.status(response.status).json({ error: errorMessage });
      return;
    }

    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      console.error('OpenAI レスポンス JSON パースエラー:', e, text);
      res.status(500).json({ error: 'Failed to parse OpenAI JSON response.' });
      return;
    }

    const content = json.choices?.[0]?.message?.content;
    if (!content) {
      console.error('レスポンス構造が想定外:', json);
      res.status(500).json({ error: 'Unexpected OpenAI response format.' });
      return;
    }

    let data;
    try {
      data = JSON.parse(content);
    } catch (e) {
      console.error('content JSON パースエラー:', e, content);
      res.status(500).json({ error: 'Failed to parse OpenAI content as JSON.' });
      return;
    }

    // 最低限のフォールバック整形（フロントの callOpenAiReceiptOcr と同じ形式）
    const safeStoreName = data.storeName || '店舗名不明';
    const safeDate =
      data.date ||
      new Date().toLocaleString('ja-JP', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });

    const rawTotal = (data.total || '0').toString().replace(/[,，]/g, '');
    const numericTotal = isNaN(parseInt(rawTotal, 10)) ? 0 : parseInt(rawTotal, 10);

    const items = Array.isArray(data.items) ? data.items : [];
    const mappedItems = items
      .filter((item) => item && item.name)
      .map((item) => {
        const itemRaw = (item.price || '0').toString().replace(/[,，]/g, '');
        const itemPrice = isNaN(parseInt(itemRaw, 10)) ? 0 : parseInt(itemRaw, 10);
        return {
          name: item.name,
          price: itemPrice.toLocaleString('ja-JP'),
          categoryId: item.categoryId || data.categoryId || 'other'
        };
      });

    const categoryId =
      data.categoryId &&
      ['food', 'transport', 'daily', 'entertainment', 'medical', 'education', 'other'].includes(data.categoryId)
        ? data.categoryId
        : 'other';

    const result = {
      storeName: safeStoreName,
      date: safeDate,
      total: numericTotal.toLocaleString('ja-JP'),
      categoryId,
      items:
        mappedItems.length > 0
          ? mappedItems
          : [
              {
                name: '商品',
                price: numericTotal.toLocaleString('ja-JP'),
                categoryId
              }
            ]
    };

    res.status(200).json(result);
  } catch (error) {
    console.error('サーバー側 OCR 処理エラー:', error);
    res.status(500).json({ error: error.message || 'Unknown server error' });
  }
};

