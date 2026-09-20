/* 테스트 전용 워커 대역. assets/worker.js 자리에 복사해 쓴다.
   Pyodide 대신 같은 kernel.py를 CPython으로 돌리는 로컬 서버에 물어본다. */

self.onmessage = async (event) => {
  const { id, cmd, payload } = event.data || {};
  if (cmd === '__preload__') {
    self.postMessage({ id, ok: true, result: { loaded: ['bridge'] } });
    return;
  }
  if (cmd === '__init__') {
    // 대역 서버는 커널 상태를 한 벌만 갖고 있으므로 새 탭마다 비운다.
    await fetch('/__reset', { method: 'POST' });
    self.postMessage({ type: 'status', stage: 'ready', detail: 'bridge' });
    self.postMessage({ id, ok: true, result: { ready: true } });
    return;
  }
  try {
    const response = await fetch('/__call', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cmd, payload }),
    });
    const data = await response.json();
    self.postMessage({ id, ...data });
  } catch (error) {
    self.postMessage({ id, ok: false, error: String(error) });
  }
};
