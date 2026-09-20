/* DEEP 파이썬 워커.
   Pyodide를 웹 워커 안에서 띄우고, kernel.py의 handle() 하나만 호출한다.
   서버는 없다. 여기서 도는 모든 계산은 사용자의 브라우저 안에서 끝난다. */

const PYODIDE_VERSION = '314.0.7';

/* 같은 사이트 안에 Pyodide가 들어 있으면 그것을 먼저 쓴다.
   tools/fetch_pyodide.py 로 vendor/pyodide/ 에 넣어 두면 바깥 연결이 아예 없어져
   학교망에서 CDN이 막혀 있어도, 교사 노트북에서 교내로 띄워도 그대로 돈다. */
const LOCAL_BASE = new URL('../vendor/pyodide/', self.location.href).href;
const CDN_BASES = [
  `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
  `https://fastly.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`,
];

async function hasLocalPyodide() {
  try {
    const response = await fetch(`${LOCAL_BASE}pyodide-lock.json`, { method: 'GET' });
    return response.ok;
  } catch (error) {
    return false;
  }
}

// 명령마다 필요한 파이썬 꾸러미. 무거운 것은 처음 쓸 때만 받는다.
const PACKAGES_FOR = {
  base: ['numpy', 'pandas'],
  regression: ['scipy', 'scikit-learn', 'statsmodels'],
  cluster: ['scipy', 'scikit-learn'],
  classification: ['scipy', 'scikit-learn'],
  kmeans_label: ['scipy', 'scikit-learn'],
};

let pyodide = null;
let handle = null;
const loaded = new Set();

function notify(stage, detail) {
  self.postMessage({ type: 'status', stage, detail });
}

async function bootPyodide() {
  let lastError = null;
  const bases = (await hasLocalPyodide()) ? [LOCAL_BASE, ...CDN_BASES] : CDN_BASES;
  for (const base of bases) {
    try {
      // ES 모듈로 불러온다. importScripts는 no-cors 요청이라 CDN이 막히는 환경이 있다.
      const { loadPyodide } = await import(/* @vite-ignore */ `${base}pyodide.mjs`);
      const instance = await loadPyodide({ indexURL: base });
      return instance;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(
    `Pyodide를 내려받지 못했습니다. 인터넷 연결을 확인해 주세요. (${lastError})`
  );
}

async function ensurePackages(names) {
  const missing = names.filter((name) => !loaded.has(name));
  if (!missing.length) return;
  notify('packages', missing.join(', '));
  await pyodide.loadPackage(missing);
  missing.forEach((name) => loaded.add(name));
}

async function init() {
  notify('pyodide', `Pyodide ${PYODIDE_VERSION}`);
  pyodide = await bootPyodide();
  await ensurePackages(PACKAGES_FOR.base);
  notify('kernel', '분석 커널');
  const source = await (await fetch(new URL('./kernel.py', self.location.href))).text();
  pyodide.FS.writeFile('/kernel.py', source, { encoding: 'utf8' });
  await pyodide.runPythonAsync(
    'import sys\nsys.path.insert(0, "/")\nimport kernel\n'
  );
  handle = pyodide.runPython('kernel.handle');
  notify('ready', await pyodide.runPythonAsync('import sys; sys.version.split()[0]'));
}

async function packagesFor(cmd, payload) {
  if (cmd === 'analyze') return PACKAGES_FOR[payload.kind] || [];
  if (cmd === 'rebuild') {
    const ops = new Set((payload.steps || []).map((step) => step.op));
    const needed = [];
    ops.forEach((op) => (PACKAGES_FOR[op] || []).forEach((name) => needed.push(name)));
    return [...new Set(needed)];
  }
  return [];
}

self.onmessage = async (event) => {
  const { id, cmd, payload } = event.data || {};
  if (cmd === '__preload__') {
    // 수업 시작 전에 분석 꾸러미까지 미리 받아 둔다.
    // 쉬는 시간에 한 번 눌러 두면 그 수업 내내 네트워크를 타지 않는다.
    try {
      const all = [...new Set(Object.values(PACKAGES_FOR).flat())];
      await ensurePackages(all);
      self.postMessage({ id, ok: true, result: { loaded: [...loaded] } });
    } catch (error) {
      self.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }
  if (cmd === '__init__') {
    try {
      await init();
      self.postMessage({ id, ok: true, result: { ready: true } });
    } catch (error) {
      self.postMessage({ id, ok: false, error: String(error && error.message ? error.message : error) });
    }
    return;
  }
  if (!handle) {
    self.postMessage({ id, ok: false, error: '분석 커널이 아직 준비되지 않았습니다.' });
    return;
  }
  try {
    const extra = await packagesFor(cmd, payload || {});
    if (extra.length) await ensurePackages(extra);
    const text = handle(cmd, JSON.stringify(payload || {}));
    self.postMessage({ id, ...JSON.parse(text) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: String(error && error.message ? error.message : error),
    });
  }
};
