// 外側の文章だけを除去します。内容を推測するJSON修復やコード実行はしません。
const fail = message => Object.assign(new Error(message), { status: 400 });

function extractObject(raw) {
  const candidates = [];
  let start = -1, quoted = false, escaped = false;
  const stack = [];
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (start < 0) {
      if (ch === '}' || ch === ']') throw fail('JSONの閉じ括弧が余分にあります。回答を確認してください。');
      if (ch !== '{' && ch !== '[') continue;
      start = i;
    }
    if (quoted) {
      // コピー時の折り返しがエスケープの途中に入っても、状態を保持します。
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r' && raw[i + 1] === '\n') i++;
        while (raw[i + 1] === ' ' || raw[i + 1] === '\t') i++;
        continue;
      }
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === '{' || ch === '[') {
      stack.push(ch);
      if (stack.length > 64) throw fail('JSONの入れ子が深すぎます。指定の出力形式で回答し直してください。');
    } else if (ch === '}' || ch === ']') {
      if (stack.pop() !== (ch === '}' ? '{' : '[')) throw fail('JSONの括弧が対応していません。省略されていない回答をコピーしてください。');
      if (!stack.length) { candidates.push(raw.slice(start, i + 1)); start = -1; }
    }
  }
  if (start >= 0) throw fail('JSONが途中で切れているか、引用符・括弧が閉じていません。回答全体をコピーしてください。');
  if (candidates.length !== 1) throw fail(candidates.length ? 'JSON候補が複数あります。取り込む回答を1つだけ貼り付けてください。' : 'JSONが見つかりません。半角の { から } を含む回答を貼り付けてください。');
  const suffix = raw.slice(raw.indexOf(candidates[0]) + candidates[0].length).trim();
  if (/^[,:;"'0-9]/.test(suffix) || /^(true|false|null)\b/.test(suffix)) throw fail('JSONの後ろに余分な記号や値があります。回答を確認してください。');
  if (candidates[0][0] !== '{') throw fail('JSONは配列ではなく、企画IDと7項目を含む1つのオブジェクトにしてください。');
  return candidates[0];
}

function unwrapLines(text) {
  let quoted = false, escaped = false, count = 0, normalized = '';
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted && (ch === '\n' || ch === '\r')) {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      while (text[i + 1] === ' ' || text[i + 1] === '\t') i++;
      count++;
      continue;
    }
    normalized += ch;
    if (quoted && escaped) escaped = false;
    else if (quoted && ch === '\\') escaped = true;
    else if (ch === '"') quoted = !quoted;
  }
  return { normalized, count };
}

// JSON.parseが最後の値で上書きする同名キーも、曖昧な入力として拒否します。
function rejectDuplicateKeys(text) {
  const stack = [];
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') stack.push(new Set());
    else if (text[i] === '[') stack.push(null);
    else if (text[i] === '}' || text[i] === ']') stack.pop();
    else if (text[i] === '"') {
      const start = i++;
      while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
      let next = i + 1;
      while (/\s/.test(text[next] || '') && next < text.length) next++;
      if (text[next] === ':' && stack.at(-1)) {
        const key = JSON.parse(text.slice(start, i + 1));
        if (stack.at(-1).has(key)) throw fail('JSONに同じ項目名が重複しています。各項目を1つにした回答を取得してください。');
        stack.at(-1).add(key);
      }
    }
  }
}

export function readImportJson(raw) {
  if (typeof raw !== 'string' || raw.length > 400000) throw fail('生成結果は400,000文字以内にしてください。');
  const trimmed = raw.trim();
  // JSONとして有効な配列やJSON文字列から、内部のオブジェクトを拾わない。
  let whole;
  try { whole = JSON.parse(trimmed); } catch { /* 外側の説明文・折り返しを検査 */ }
  if (whole !== undefined && (!whole || typeof whole !== 'object' || Array.isArray(whole))) throw fail('企画IDと7項目を含むJSONオブジェクトを貼り付けてください。');
  const candidate = extractObject(trimmed);
  let value, normalized = candidate, count = 0;
  try { value = JSON.parse(candidate); }
  catch {
    ({ normalized, count } = unwrapLines(candidate));
    try { value = JSON.parse(normalized); }
    catch (error) {
      const position = /position (\d+)/.exec(error.message)?.[1];
      const before = position ? normalized.slice(0, Number(position)) : '';
      const location = position ? `（JSON部分の${before.split('\n').length}行目付近）` : '';
      throw fail(`JSONの構文が正しくありません${location}。引用符・カンマ・エスケープなどを確認してください。折り返し以外は自動修正しません。`);
    }
  }
  rejectDuplicateKeys(normalized);
  return { value, normalization: count ? { kind: 'joined-string-line-wraps', count } : null };
}
