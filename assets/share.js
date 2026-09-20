/* 작업을 밖으로 내보내는 세 가지 길.

   1) 프로젝트 파일 (.deep.json) — 데이터까지 전부. 학생이 제출하고 교사가 열어 본다.
   2) 과제 링크 — 교사가 데이터와 안내문을 담아 학생에게 준다. 열면 바로 뜬다.
   3) 레시피 링크 — 설정만. 받은 사람이 자기 CSV를 올려 같은 분석을 돌린다.

   어느 쪽도 서버를 거치지 않는다. 파일은 내려받기고, 링크는 주소창 안에 압축해 담는다. */

const FORMAT_VERSION = 1;

/* ------------------------------------------------------------------ 압축 */

function toBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(index, index + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '==='.slice((padded.length + 3) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function squeeze(bytes) {
  if (typeof CompressionStream === 'undefined') return { bytes, compressed: false };
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  return { bytes: new Uint8Array(await new Response(stream).arrayBuffer()), compressed: true };
}

async function unsqueeze(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/* ------------------------------------------------------- 무엇을 담을까 */

function settings(state) {
  return {
    title: state.title,
    author: state.author || '',
    note: state.note || '',
    steps: state.steps,
    charts: state.charts.map(({ editing, ...rest }) => rest),
    analyses: state.analyses.map(({ editing, result, ...rest }) => rest),
  };
}

function sourceList(state) {
  return state.tables
    .filter((table) => table.isSource)
    .map((table) => ({
      name: table.name,
      columns: table.columns.map((column) => column.name),
      rows: table.rows,
    }));
}

/** 데이터까지 전부 담은 프로젝트. 학생 제출물이자 교사의 과제 파일. */
export function buildProject(state) {
  return {
    kind: 'deep-project',
    v: FORMAT_VERSION,
    savedAt: new Date().toISOString(),
    ...settings(state),
    sources: sourceList(state),
    data: { ...state.sources },
  };
}

/** 설정만 담은 레시피. 받은 사람이 자기 데이터를 올린다. */
export function buildRecipe(state) {
  return {
    kind: 'deep-recipe',
    v: FORMAT_VERSION,
    ...settings(state),
    sources: sourceList(state),
  };
}

export function hasData(payload) {
  return Boolean(payload && payload.data && Object.keys(payload.data).length);
}

export function dataBytes(state) {
  return Object.values(state.sources || {}).reduce(
    (total, text) => total + new Blob([text]).size,
    0
  );
}

/* ------------------------------------------------------------------ 링크 */

export async function encodePayload(payload) {
  const json = new TextEncoder().encode(JSON.stringify(payload));
  const { bytes, compressed } = await squeeze(json);
  return (compressed ? 'z' : 'p') + toBase64Url(bytes);
}

export async function decodePayload(token) {
  const mode = token[0];
  const bytes = fromBase64Url(token.slice(1));
  const json = mode === 'z' ? await unsqueeze(bytes) : bytes;
  return JSON.parse(new TextDecoder().decode(json));
}

export async function linkFor(payload) {
  const base = location.href.split('#')[0];
  return `${base}#d=${await encodePayload(payload)}`;
}

export function tokenFromHash() {
  const match = location.hash.match(/[#&](?:d|r)=([^&]+)/);
  return match ? match[1] : null;
}

/* ------------------------------------------------------------------ 파일 */

function safeName(text) {
  return (text || '분석').replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
}

export function downloadJson(payload, suffix = 'deep') {
  const parts = [payload.author, payload.title].filter(Boolean).join('_');
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${safeName(parts)}.${suffix}.json`;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

export async function readJsonFile(file) {
  const payload = JSON.parse(await file.text());
  if (payload.kind !== 'deep-project' && payload.kind !== 'deep-recipe') {
    throw new Error('DEEP에서 저장한 파일이 아닙니다.');
  }
  return payload;
}
