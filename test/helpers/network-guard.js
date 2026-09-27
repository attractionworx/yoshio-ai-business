// 検証専用。アプリの外向き通信をソケット接続前にも拒否します。
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';

export const blockedConnections = [];
const local = host => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(host);
function reject(host) { blockedConnections.push(String(host)); throw new Error('テストでは外部通信を禁止しています。'); }
const originalFetch = globalThis.fetch;
globalThis.fetch = function guardedFetch(input, ...args) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!local(url.hostname)) reject(url.hostname);
  return originalFetch.call(this, input, ...args);
};
for (const module of [http, https]) for (const method of ['request', 'get']) {
  const original = module[method];
  module[method] = function guardedRequest(input, ...args) {
    const host = typeof input === 'string' || input instanceof URL ? new URL(input).hostname : input.hostname || input.host || 'localhost';
    if (!local(host)) reject(host);
    return original.call(this, input, ...args);
  };
}
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedConnect(...args) {
  const normalized = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host = typeof normalized === 'object' ? normalized.host || 'localhost' : typeof args[1] === 'string' ? args[1] : 'localhost';
  if (!local(host)) reject(host);
  return originalConnect.apply(this, args);
};
syncBuiltinESMExports();
process.on('beforeExit', () => {
  if (blockedConnections.length) {
    console.error('外部通信の試行を検出したため検証を失敗にします。');
    process.exitCode = 1;
  }
});
