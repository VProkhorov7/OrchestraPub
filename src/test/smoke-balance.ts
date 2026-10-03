/**
 * DeepSeek low balance yellow light:
 *  - yellow only when EVERY wallet is under 1 unit («мало денег», the «баланс:» detail kept);
 *  - a funded wallet keeps the light green; is_available=false wins with «исчерпан»; a failing balance request leaves the light unchanged.
 */
import * as http from 'http';
import { checkOne, balanceStatus, LOW_BALANCE } from '../main/health';
import { fromPreset } from '../main/catalog';
import { check, testConfig } from './helpers';

const MSG = { id: 'm', type: 'message', role: 'assistant', model: 'deepseek-v4-pro', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } };

async function startServer() {
  let balance: any = {};
  let balanceCode = 200;
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/user/balance') {
      if (balanceCode !== 200) {
        res.writeHead(balanceCode);
        res.end('boom');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(balance));
      return;
    }
    if (req.method === 'POST' && req.url === '/anthropic/v1/messages') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(MSG));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as any).port;
  const cfg = testConfig('');
  const one = async (body: any, code = 200) => {
    balance = body;
    balanceCode = code;
    return checkOne(fromPreset('deepseek', { baseUrl: `http://127.0.0.1:${port}/anthropic`, token: 'k' }), cfg);
  };
  return { one, close: () => srv.close() };
}

(async () => {
  const srv = await startServer();

  let h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.29' }, { currency: 'CNY', total_balance: '0.00' }] });
  check(h.light === 'green', `(a) funded wallet keeps green: ${h.light} (${h.text})`);

  h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.99' }] });
  check(h.light === 'yellow' && h.text.includes('0.99') && h.text.includes('USD'), `(b) low balance yellow: ${h.text}`);

  h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '1.00' }] });
  check(h.light === 'green', `(c) exactly 1.00 not low: ${h.light} (${h.text})`);

  h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.50' }, { currency: 'CNY', total_balance: '0.00' }] });
  check(h.light === 'yellow' && h.text.includes('0.5'), `(d) every wallet low: ${h.text}`);

  h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '0.00' }, { currency: 'CNY', total_balance: '0.00' }] });
  check(h.light === 'yellow', `(e) all zero low: ${h.light} (${h.text})`);

  h = await srv.one({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '10.00' }, { currency: 'CNY', total_balance: '0.5' }] });
  check(h.light === 'green', `(f) funded wallet wins: ${h.light} (${h.text})`);

  h = await srv.one({ is_available: false, balance_infos: [{ currency: 'USD', total_balance: '0.00' }] });
  check(h.light === 'yellow' && h.text.includes('исчерпан'), `(g) is_available keeps priority: ${h.text}`);

  h = await srv.one({}, 500);
  check(h.light === 'green', `(h) failing balance request leaves light: ${h.light} (${h.text})`);

  let b = balanceStatus([]);
  check(b.low === false && b.best === undefined, '(i) empty infos not low, no best');
  b = balanceStatus([{ currency: 'USD', total_balance: 'abc' }]);
  check(b.low === false && b.best === undefined, '(i) unparsable-only not low');
  b = balanceStatus([{ currency: 'USD', total_balance: '0' }]);
  check(b.low === true && b.best?.amount === 0, `(i) zero is low, best amount: ${b.best?.amount}`);
  b = balanceStatus([{ currency: 'USD', total_balance: '2' }, { currency: 'CNY', total_balance: '7' }]);
  check(b.low === false && b.best?.currency === 'CNY', `(i) best is CNY: ${b.best?.currency}`);

  srv.close();
  console.log(`SMOKE-BALANCE OK (порог ${LOW_BALANCE})`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
