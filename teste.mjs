// Teste da checagem de certificado (a parte de segurança que não depende de navegador).
// Uso: node teste.mjs   — sai 1 se algum caso falhar.
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('./index.html', import.meta.url), 'utf8');
const trecho = html.match(/const fpUnico = sdp[\s\S]*?const confere = .*\n/)[0];
const confere = new Function(trecho + 'return confere;')();

const k = 'ab'.repeat(32), atacante = 'cd'.repeat(32);
const linha = (alg, h) => `a=fingerprint:${alg} ${h.match(/../g).join(':').toUpperCase()}\r\n`;
const casos = [
  ['legítimo, 1 linha', 'v=0\r\n' + linha('sha-256', k), true],
  ['legítimo, bundle com 2 linhas iguais', 'v=0\r\n' + linha('sha-256', k) + 'm=video\r\n' + linha('sha-256', k), true],
  ['isca: sha-512 extra', 'v=0\r\n' + linha('sha-256', k) + linha('sha-512', atacante), false],
  ['isca: SHA-256 maiúsculo', 'v=0\r\n' + linha('sha-256', k) + linha('SHA-256', atacante), false],
  ['isca: dentro de outra linha', 'v=0\r\na=x-isca:' + linha('sha-256', k) + linha('Sha-256', atacante), false],
  ['sem fingerprint', 'v=0\r\n', false],
  ['k ausente', 'v=0\r\n' + linha('sha-256', k), false, null],
];
let falhas = 0;
for (const [nome, sdp, esperado, kk = k] of casos) {
  const ok = confere(sdp, kk) === esperado;
  if (!ok) falhas++;
  console.log((ok ? 'ok    ' : 'FALHOU') + ' ' + nome);
}
process.exit(falhas ? 1 : 0);
